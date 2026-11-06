/**
 * DB-2：数据库位置迁移引擎（一致性快照 → 复制附件 → 校验 → 切换 → 回滚）。
 *
 * 口径（父卡 DB-HOME，子卡 `ba5a953a`）：
 * - **前置检查**：目标目录可写、剩余空间 ≥ (db + -wal + -shm + attachments) × 1.2、目标已有同名库时必须显式覆盖；
 * - **一致性**：SQLite 用 `VACUUM INTO`（会带上 WAL 里未 checkpoint 的内容，等价于 checkpoint 后复制，
 *   但不需要改动源库）；`-wal` / `-shm` **成对处理**，绝不「只拷主文件」；
 * - **附件**：整目录复制 + **逐文件 sha256 校验**（文件数 + 总字节都要对上）；
 * - **切换**：只写设置（持久化键是 `dbPath`；对外 API 名是 `db_path`）→ 由调用方重启 →
 *   启动后自检（表数/卡数/附件数）→ 成功后保留 `.bak-<ts>` 才清理旧文件；
 * - **失败**：任一校验失败 → 旧路径不变 + 固定错误码 + 可重试 + `pending` 标记（不半写）。
 *
 * 命名边界：本文件的快照/备份属**数据库迁移域**；B6 的 `security/<uuid>` 属**设备身份域**；
 * B4S-2 的 `ClientSnapshotManifest` 属**客户端账号域**。三者不复用类型、不互相 import。
 */
import { createHash } from 'node:crypto';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { statfs } from 'node:fs/promises';
import { basename, dirname, join, relative } from 'node:path';

export const DB_MIGRATION_SPACE_MARGIN = 1.2;
/** SQLite 主库的成对文件后缀（迁移必须一起处理） */
export const DB_SIDECAR_SUFFIXES = ['-wal', '-shm'] as const;

export type DbMigrationErrorCode =
  /** 目标目录不可写 */
  | 'DB_MIGRATION_TARGET_UNWRITABLE'
  /** 剩余空间不足（含 1.2 余量） */
  | 'DB_MIGRATION_NO_SPACE'
  /** 目标已存在同名库且未显式确认覆盖 */
  | 'DB_MIGRATION_TARGET_EXISTS'
  /** 一致性快照失败（VACUUM INTO / 复制中断） */
  | 'DB_MIGRATION_COPY_FAILED'
  /** 校验失败（附件文件数/字节/sha256 或库文件大小不符） */
  | 'DB_MIGRATION_VERIFY_FAILED';

export interface DbMigrationPlan {
  fromDbPath: string;
  toDbPath: string;
  fromAttachmentsDir: string;
  toAttachmentsDir: string;
  /** 需要复制的总字节（db + sidecars + 附件） */
  totalBytes: number;
  attachmentFiles: number;
  /** 是否覆盖已存在的目标库 */
  overwrite: boolean;
}

export interface DbMigrationResult {
  ok: boolean;
  code: DbMigrationErrorCode | null;
  message: string;
  /** 成功时的备份目录（`.bak-<ts>`）；失败为 null */
  backupDir: string | null;
  /** 失败时是否可重试（全部失败态都可重试；这里显式给出便于 UI 展示） */
  retryable: boolean;
  copiedBytes: number;
  attachmentFiles: number;
}

const sha256 = (buffer: Buffer): string => createHash('sha256').update(buffer).digest('hex');

/** 递归列出目录下所有文件（相对路径 + 字节数） */
export function listFilesRecursive(root: string): Array<{ path: string; bytes: number }> {
  if (!existsSync(root)) return [];
  const out: Array<{ path: string; bytes: number }> = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile()) out.push({ path: relative(root, full).replace(/\\/g, '/'), bytes: statSync(full).size });
    }
  };
  walk(root);
  return out.sort((a, b) => a.path.localeCompare(b.path));
}

/** 汇总「要搬的东西有多大」：主库 + -wal + -shm + 附件 */
export function measureMigrationSource(fromDbPath: string, fromAttachmentsDir: string): { totalBytes: number; attachmentFiles: number } {
  let totalBytes = 0;
  if (existsSync(fromDbPath)) totalBytes += statSync(fromDbPath).size;
  for (const suffix of DB_SIDECAR_SUFFIXES) {
    const sidecar = `${fromDbPath}${suffix}`;
    if (existsSync(sidecar)) totalBytes += statSync(sidecar).size;
  }
  const attachments = listFilesRecursive(fromAttachmentsDir);
  totalBytes += attachments.reduce((sum, file) => sum + file.bytes, 0);
  return { totalBytes, attachmentFiles: attachments.length };
}

export interface PreflightOptions {
  fromDbPath: string;
  toDbPath: string;
  fromAttachmentsDir: string;
  toAttachmentsDir?: string;
  overwrite?: boolean;
  /** 测试注入：剩余空间 */
  freeBytes?: (dir: string) => Promise<number | null>;
}

export type PreflightResult =
  | { ok: true; plan: DbMigrationPlan }
  | { ok: false; code: DbMigrationErrorCode; message: string };

/**
 * 前置检查：目标目录可写 / 空间足够（×1.2）/ 目标同名库需显式覆盖。
 * 任何一项不满足都**不动源数据**。
 */
export async function preflightMigration(options: PreflightOptions): Promise<PreflightResult> {
  const toAttachmentsDir = options.toAttachmentsDir ?? join(dirname(options.toDbPath), 'attachments');
  const targetDir = dirname(options.toDbPath);
  try {
    mkdirSync(targetDir, { recursive: true });
    // 可写探测：写一个临时文件再删
    const probe = join(targetDir, `.agentboard-write-probe-${process.pid}`);
    writeFileSync(probe, 'ok');
    rmSync(probe, { force: true });
  } catch (error) {
    return { ok: false, code: 'DB_MIGRATION_TARGET_UNWRITABLE', message: `目标目录不可写（${targetDir}）：${error instanceof Error ? error.message : String(error)}` };
  }
  if (existsSync(options.toDbPath) && options.overwrite !== true) {
    return { ok: false, code: 'DB_MIGRATION_TARGET_EXISTS', message: `目标已存在同名数据库：${options.toDbPath}（需显式 overwrite=true）` };
  }
  const { totalBytes, attachmentFiles } = measureMigrationSource(options.fromDbPath, options.fromAttachmentsDir);
  const free = await (options.freeBytes ?? (async (dir: string) => {
    try {
      const stats = await statfs(dir);
      return Number(stats.bavail) * Number(stats.bsize);
    } catch {
      return null;
    }
  }))(targetDir);
  const need = Math.ceil(totalBytes * DB_MIGRATION_SPACE_MARGIN);
  if (free !== null && free < need) {
    return { ok: false, code: 'DB_MIGRATION_NO_SPACE', message: `目标剩余 ${free} 字节，迁移约需 ${need} 字节（含 ${DB_MIGRATION_SPACE_MARGIN} 倍余量）` };
  }
  return {
    ok: true,
    plan: {
      fromDbPath: options.fromDbPath,
      toDbPath: options.toDbPath,
      fromAttachmentsDir: options.fromAttachmentsDir,
      toAttachmentsDir,
      totalBytes,
      attachmentFiles,
      overwrite: options.overwrite === true,
    },
  };
}

/** SQLite 一致性快照：`VACUUM INTO` 会把 WAL 里未 checkpoint 的内容一并写进新库 */
export function vacuumInto(sourceDb: { exec: (sql: string) => unknown }, targetPath: string): void {
  mkdirSync(dirname(targetPath), { recursive: true });
  // VACUUM INTO 目标必须是「不存在的文件」，否则 SQLite 报错
  if (existsSync(targetPath)) rmSync(targetPath, { force: true });
  sourceDb.exec(`VACUUM INTO '${targetPath.replace(/'/g, "''")}'`);
}

export interface AttachmentCopySummary {
  files: number;
  bytes: number;
  mismatches: string[];
}

/** 复制附件目录并逐文件 sha256 校验（数量与总字节都要对上） */
export function copyAttachmentsVerified(fromDir: string, toDir: string): AttachmentCopySummary {
  const source = listFilesRecursive(fromDir);
  mkdirSync(toDir, { recursive: true });
  let bytes = 0;
  const mismatches: string[] = [];
  for (const file of source) {
    const from = join(fromDir, file.path);
    const to = join(toDir, file.path);
    mkdirSync(dirname(to), { recursive: true });
    copyFileSync(from, to);
    bytes += file.bytes;
    const expected = sha256(readFileSync(from));
    const actual = existsSync(to) ? sha256(readFileSync(to)) : '';
    if (actual !== expected) mismatches.push(`${file.path}（期望 ${expected.slice(0, 8)}，实际 ${actual.slice(0, 8) || '缺失'}）`);
  }
  // 数量/字节复核
  const copied = listFilesRecursive(toDir);
  if (copied.length !== source.length) mismatches.push(`附件文件数不符：源 ${source.length}，目标 ${copied.length}`);
  const copiedBytes = copied.reduce((sum, file) => sum + file.bytes, 0);
  if (copiedBytes !== bytes) mismatches.push(`附件总字节不符：源 ${bytes}，目标 ${copiedBytes}`);
  return { files: source.length, bytes, mismatches };
}

export interface RunMigrationOptions extends PreflightOptions {
  /** 源库句柄（用于 VACUUM INTO）；缺省用 copyFileSync + sidecar 成对复制 */
  sourceDb?: { exec: (sql: string) => unknown };
  /** 测试注入：附件复制（缺省 copyAttachmentsVerified） */
  copyAttachments?: (fromDir: string, toDir: string) => AttachmentCopySummary;
  now?: () => number;
}

/**
 * 执行迁移（不含重启）：快照 → 附件复制校验 → 写 `.bak-<ts>` 标记 → 返回结果。
 * **失败时目标侧半成品会被清掉、源库与设置都不动**（旧路径不变）。
 */
export async function runDbMigration(options: RunMigrationOptions): Promise<DbMigrationResult> {
  const preflight = await preflightMigration(options);
  if (!preflight.ok) {
    return { ok: false, code: preflight.code, message: preflight.message, backupDir: null, retryable: true, copiedBytes: 0, attachmentFiles: 0 };
  }
  const plan = preflight.plan;
  const stamp = new Date((options.now ?? Date.now)()).toISOString().replace(/[:.]/g, '-');
  const backupDir = `${plan.toDbPath}.bak-${stamp}`;
  let copiedBytes = 0;
  try {
    // 1) 一致性快照（VACUUM INTO 优先；没有句柄时退化为 copyFileSync + sidecar 成对复制）
    if (options.sourceDb !== undefined) {
      vacuumInto(options.sourceDb, plan.toDbPath);
    } else {
      copyFileSync(plan.fromDbPath, plan.toDbPath);
      for (const suffix of DB_SIDECAR_SUFFIXES) {
        const from = `${plan.fromDbPath}${suffix}`;
        if (existsSync(from)) copyFileSync(from, `${plan.toDbPath}${suffix}`);
      }
    }
    if (!existsSync(plan.toDbPath)) throw new Error('快照未生成目标库');
    copiedBytes += statSync(plan.toDbPath).size;
    // 2) 附件复制 + 逐文件 sha256 校验
    const attachmentSummary = (options.copyAttachments ?? copyAttachmentsVerified)(plan.fromAttachmentsDir, plan.toAttachmentsDir);
    copiedBytes += attachmentSummary.bytes;
    if (attachmentSummary.mismatches.length > 0) {
      throw Object.assign(new Error(`附件校验失败：${attachmentSummary.mismatches.slice(0, 3).join('；')}`), { code: 'DB_MIGRATION_VERIFY_FAILED' });
    }
    // 3) 记录备份标记（真正的旧文件清理由调用方在「重启 + 自检通过」后做）
    mkdirSync(dirname(backupDir), { recursive: true });
    writeFileSync(`${backupDir}.json`, `${JSON.stringify({ from: plan.fromDbPath, to: plan.toDbPath, createdAt: (options.now ?? Date.now)(), bytes: copiedBytes }, null, 2)}\n`, 'utf8');
    return { ok: true, code: null, message: `迁移完成：${plan.fromDbPath} → ${plan.toDbPath}`, backupDir, retryable: false, copiedBytes, attachmentFiles: attachmentSummary.files };
  } catch (error) {
    // 失败：清掉目标侧半成品，源库与设置保持不动
    try { if (existsSync(plan.toDbPath)) rmSync(plan.toDbPath, { force: true }); } catch { /* 忽略 */ }
    for (const suffix of DB_SIDECAR_SUFFIXES) {
      try { rmSync(`${plan.toDbPath}${suffix}`, { force: true }); } catch { /* 忽略 */ }
    }
    try { if (existsSync(plan.toAttachmentsDir)) rmSync(plan.toAttachmentsDir, { recursive: true, force: true }); } catch { /* 忽略 */ }
    const code = (error as { code?: DbMigrationErrorCode }).code ?? 'DB_MIGRATION_COPY_FAILED';
    return { ok: false, code, message: error instanceof Error ? error.message : String(error), backupDir: null, retryable: true, copiedBytes, attachmentFiles: 0 };
  }
}

/** 迁移成功且自检通过后清理旧文件（`.bak-<ts>` 保留，供回滚） */
export function cleanupOldDbFiles(backupDir: string, oldDbPath: string): { removed: string[] } {
  const removed: string[] = [];
  const archiveDir = `${backupDir}.old`;
  mkdirSync(archiveDir, { recursive: true });
  if (existsSync(oldDbPath)) {
    const target = join(archiveDir, basename(oldDbPath));
    renameSync(oldDbPath, target);
    removed.push(target);
  }
  for (const suffix of DB_SIDECAR_SUFFIXES) {
    const sidecar = `${oldDbPath}${suffix}`;
    if (existsSync(sidecar)) {
      const target = join(archiveDir, `${basename(oldDbPath)}${suffix}`);
      renameSync(sidecar, target);
      removed.push(target);
    }
  }
  return { removed };
}

// ─────────────────────── DB-2B：编排（阶段机 + 新进程自检 + 回滚） ───────────────────────

/** 阶段机：旧进程走到 restart；selfcheck → cleanup | rolled_back 由新进程完成 */
export type DbMigrationStage =
  | 'preflight' | 'snapshot' | 'verify' | 'switch' | 'restart'
  | 'selfcheck' | 'cleanup' | 'done' | 'rolled_back' | 'failed';

/** 编排层错误码（引擎错误码 + 编排/自检态） */
export type DbMigrationStatusCode =
  | DbMigrationErrorCode
  | 'DB_MIGRATION_BUSY'
  | 'DB_MIGRATION_SELFCHECK_FAILED'
  | 'DB_MIGRATION_ROLLED_BACK'
  | 'DB_MIGRATION_ENV_OVERRIDDEN'
  | 'DB_MIGRATION_RESTART_UNAVAILABLE';

/** 错误码 → 可读文案 + 是否可重试（路由直接透出，前端不拼文案） */
export const DB_MIGRATION_ERROR_TEXT: Record<DbMigrationStatusCode, { message: string; retryable: boolean }> = {
  DB_MIGRATION_TARGET_UNWRITABLE: { message: '目标目录不可写，检查权限后重试', retryable: true },
  DB_MIGRATION_NO_SPACE: { message: '目标磁盘剩余空间不足（需约 1.2 倍数据量），清理空间后重试', retryable: true },
  DB_MIGRATION_TARGET_EXISTS: { message: '目标已存在同名数据库；确认覆盖请带 overwrite=true 重试', retryable: true },
  DB_MIGRATION_COPY_FAILED: { message: '一致性快照失败，源库与设置均未改动，可直接重试', retryable: true },
  DB_MIGRATION_VERIFY_FAILED: { message: '复制校验失败（附件数量/字节/哈希不符），源库与设置均未改动，可重试', retryable: true },
  DB_MIGRATION_BUSY: { message: '已有迁移在进行中（同一时间只允许一个）', retryable: true },
  DB_MIGRATION_SELFCHECK_FAILED: { message: '新进程自检失败（表数/卡数/附件与迁移前不一致）', retryable: true },
  DB_MIGRATION_ROLLED_BACK: { message: '迁移未完成，已回滚到原数据库', retryable: true },
  DB_MIGRATION_ENV_OVERRIDDEN: { message: '中心库路径由环境变量 AGENTBOARD_DB 指定，改设置不生效；先移除该环境变量再迁移', retryable: false },
  DB_MIGRATION_RESTART_UNAVAILABLE: { message: '当前装配未启用服务重启，迁移后的新进程自检无法进行', retryable: false },
};

export function describeMigrationError(
  code: DbMigrationStatusCode,
  detail?: string,
): { code: DbMigrationStatusCode; message: string; retryable: boolean } {
  const base = DB_MIGRATION_ERROR_TEXT[code];
  const message = detail !== undefined && detail !== '' ? base.message + '：' + detail : base.message;
  return { code, message, retryable: base.retryable };
}

/** 迁移前采集的期望值；新进程启动后据此自检 */
export interface DbMigrationExpectations {
  tables: number;
  issues: number;
  attachment_files: number;
  attachment_bytes: number;
  sample_sha256: Record<string, string>;
}

/** 跨进程意图（写在固定状态目录，不随库路径漂移） */
export interface DbMigrationIntent {
  migration_id: string;
  from_db_path: string;
  to_db_path: string;
  from_attachments_dir: string;
  to_attachments_dir: string;
  backup_dir: string;
  expected: DbMigrationExpectations;
  created_at: number;
}

export interface DbMigrationStageEntry { stage: DbMigrationStage; at: number; detail?: string }

export interface DbMigrationStatus {
  migration_id: string;
  stage: DbMigrationStage;
  stages: DbMigrationStageEntry[];
  /** null = 已切换、等新进程自检 */
  ok: boolean | null;
  code: DbMigrationStatusCode | null;
  message: string;
  retryable: boolean;
  backup_dir: string | null;
  from_db_path: string;
  to_db_path: string;
}

/** 意图文件路径（状态目录固定，迁移后仍能被新进程读到） */
export function migrationIntentPath(stateDir: string): string {
  return join(stateDir, 'db-migration-pending.json');
}

export function writeMigrationIntent(stateDir: string, intent: DbMigrationIntent): void {
  mkdirSync(stateDir, { recursive: true });
  writeFileSync(migrationIntentPath(stateDir), JSON.stringify(intent, null, 2) + '\n', 'utf8');
}

export function readMigrationIntent(stateDir: string): DbMigrationIntent | null {
  const path = migrationIntentPath(stateDir);
  if (!existsSync(path)) return null;
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as DbMigrationIntent;
    return typeof parsed.migration_id === 'string' && typeof parsed.to_db_path === 'string' ? parsed : null;
  } catch {
    return null;
  }
}

export function clearMigrationIntent(stateDir: string): void {
  rmSync(migrationIntentPath(stateDir), { force: true });
}

export function migrationStatusPath(stateDir: string, id: string): string {
  return join(stateDir, 'db-migration-status-' + id + '.json');
}

function persistStatus(stateDir: string, status: DbMigrationStatus): void {
  try {
    mkdirSync(stateDir, { recursive: true });
    writeFileSync(migrationStatusPath(stateDir, status.migration_id), JSON.stringify(status, null, 2) + '\n', 'utf8');
  } catch { /* 状态落盘失败不影响迁移本身 */ }
}

export function readMigrationStatus(stateDir: string, id: string): DbMigrationStatus | null {
  const path = migrationStatusPath(stateDir, id);
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as DbMigrationStatus;
  } catch {
    return null;
  }
}

/** 进程内活跃表（重启后为空，靠意图文件兜住并发） */
const activeStatuses = new Map<string, DbMigrationStatus>();
let activeMigrationId: string | null = null;

/** 内存优先，其次磁盘（重启后 GET 状态仍能读到旧进程写的结果） */
export function getMigrationStatus(stateDir: string, id: string): DbMigrationStatus | null {
  return activeStatuses.get(id) ?? readMigrationStatus(stateDir, id);
}

/** 同一时间只允许一个迁移：进程内有活跃迁移，或状态目录里还有未自检的意图 */
export function isMigrationActive(stateDir: string): boolean {
  return activeMigrationId !== null || readMigrationIntent(stateDir) !== null;
}

/** 测试用：清空编排状态 */
export function resetMigrationState(): void {
  activeStatuses.clear();
  activeMigrationId = null;
}

/** 采集「库 + 附件」的期望值（迁移前调用） */
export function collectMigrationExpectations(
  dbPath: string,
  attachmentsDir: string,
  sourceDb: { prepare: (sql: string) => { get: () => unknown } },
): DbMigrationExpectations {
  const files = listFilesRecursive(attachmentsDir);
  const sample: Record<string, string> = {};
  for (const file of files.slice(0, 3)) {
    sample[file.path] = sha256(readFileSync(join(attachmentsDir, file.path))).slice(0, 8);
  }
  const tables = Number((sourceDb.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table'").get() as { n: number }).n);
  const issues = Number((sourceDb.prepare('SELECT COUNT(*) AS n FROM issue').get() as { n: number }).n);
  void dbPath;
  return {
    tables,
    issues,
    attachment_files: files.length,
    attachment_bytes: files.reduce((sum, file) => sum + file.bytes, 0),
    sample_sha256: sample,
  };
}

export interface SelfCheckResult {
  ok: boolean;
  problems: string[];
  actual: DbMigrationExpectations;
}

/** 新进程自检：表数/卡数/附件数/附件字节/抽样 sha256 必须与迁移前一致 */
export function selfCheckMigratedDb(
  intent: DbMigrationIntent,
  sourceDb: { prepare: (sql: string) => { get: () => unknown } },
): SelfCheckResult {
  const actual = collectMigrationExpectations(intent.to_db_path, intent.to_attachments_dir, sourceDb);
  const expected = intent.expected;
  const problems: string[] = [];
  if (actual.tables !== expected.tables) problems.push('表数不符：期望 ' + expected.tables + '，实际 ' + actual.tables);
  if (actual.issues !== expected.issues) problems.push('卡数不符：期望 ' + expected.issues + '，实际 ' + actual.issues);
  if (actual.attachment_files !== expected.attachment_files) problems.push('附件数不符：期望 ' + expected.attachment_files + '，实际 ' + actual.attachment_files);
  if (actual.attachment_bytes !== expected.attachment_bytes) problems.push('附件字节不符：期望 ' + expected.attachment_bytes + '，实际 ' + actual.attachment_bytes);
  for (const [path, sha8] of Object.entries(expected.sample_sha256)) {
    const got = actual.sample_sha256[path];
    if (got !== sha8) problems.push('附件抽样不符：' + path + '（期望 ' + sha8 + '，实际 ' + (got ?? '缺失') + '）');
  }
  return { ok: problems.length === 0, problems, actual };
}

export interface OrchestrateOptions extends PreflightOptions {
  /** 状态目录（意图 + 状态文件；生产用 configDir()，不随库路径漂移） */
  stateDir: string;
  sourceDb: { exec: (sql: string) => unknown; prepare: (sql: string) => { get: () => unknown } };
  /** 写设置（持久化键 dbPath） */
  applySettings: (dbPath: string) => void;
  /** 触发重启（生产 = 内部 performRestart；测试注入） */
  triggerRestart: () => Promise<void>;
  copyAttachments?: RunMigrationOptions['copyAttachments'];
  now?: () => number;
}

function newStatus(id: string, fromDbPath: string, toDbPath: string): DbMigrationStatus {
  return {
    migration_id: id, stage: 'preflight', stages: [], ok: null, code: null, message: '',
    retryable: true, backup_dir: null, from_db_path: fromDbPath, to_db_path: toDbPath,
  };
}

/**
 * 编排：preflight → snapshot → verify → switch → restart。
 * 本函数在**旧进程**执行到 restart 为止；selfcheck/cleanup/rolled_back 由新进程启动钩子完成。
 * 任一环节失败都保证：源库不动、设置回到旧路径、目标侧半成品清掉（由引擎负责）。
 */
export async function orchestrateMigration(options: OrchestrateOptions): Promise<DbMigrationStatus> {
  const now = options.now ?? Date.now;
  if (isMigrationActive(options.stateDir)) {
    const busy = newStatus('busy', options.fromDbPath, options.toDbPath);
    const text = describeMigrationError('DB_MIGRATION_BUSY');
    busy.stage = 'failed';
    busy.ok = false;
    busy.code = text.code;
    busy.message = text.message;
    busy.retryable = text.retryable;
    return busy;
  }
  const id = 'mig-' + now().toString(36) + '-' + Math.random().toString(36).slice(2, 8);
  const status = newStatus(id, options.fromDbPath, options.toDbPath);
  const mark = (stage: DbMigrationStage, detail?: string): void => {
    status.stage = stage;
    status.stages.push(detail === undefined ? { stage, at: now() } : { stage, at: now(), detail });
    activeStatuses.set(id, status);
    persistStatus(options.stateDir, status);
  };
  activeStatuses.set(id, status);
  activeMigrationId = id;
  const toAttachmentsDir = options.toAttachmentsDir ?? join(dirname(options.toDbPath), 'attachments');
  try {
    mark('preflight', '检查目标可写 / 空间 / 同名库');
    const expected = collectMigrationExpectations(options.fromDbPath, options.fromAttachmentsDir, options.sourceDb);
    const result = await runDbMigration(options);
    if (!result.ok || result.backupDir === null) {
      const code = result.code ?? 'DB_MIGRATION_COPY_FAILED';
      // 标准文案 + 引擎细节（NO_SPACE/TARGET_EXISTS/VERIFY_FAILED 都带「怎么改」）
      const text = describeMigrationError(code, result.message);
      mark('failed', text.message);
      status.ok = false;
      status.code = code;
      status.message = text.message;
      status.retryable = text.retryable;
      return status;
    }
    mark('snapshot', '一致性快照 ' + result.copiedBytes + ' 字节');
    mark('verify', result.attachmentFiles + ' 个附件逐文件 sha256 校验通过');
    status.backup_dir = result.backupDir;
    writeMigrationIntent(options.stateDir, {
      migration_id: id,
      from_db_path: options.fromDbPath,
      to_db_path: options.toDbPath,
      from_attachments_dir: options.fromAttachmentsDir,
      to_attachments_dir: toAttachmentsDir,
      backup_dir: result.backupDir,
      expected,
      created_at: now(),
    });
    options.applySettings(options.toDbPath);
    mark('switch', options.toDbPath);
    try {
      await options.triggerRestart();
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      options.applySettings(options.fromDbPath);
      clearMigrationIntent(options.stateDir);
      const text = describeMigrationError('DB_MIGRATION_ROLLED_BACK', '重启失败，' + detail);
      mark('rolled_back', text.message);
      status.ok = false;
      status.code = text.code;
      status.message = text.message;
      status.retryable = text.retryable;
      return status;
    }
    mark('restart', '已触发重启，等待新进程自检');
    status.message = '已切换并触发重启；自检在新进程启动时完成';
    status.retryable = false;
    return status;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const code = (error as { code?: DbMigrationErrorCode }).code ?? 'DB_MIGRATION_COPY_FAILED';
    mark('failed', message);
    status.ok = false;
    status.code = code;
    status.message = message;
    status.retryable = true;
    return status;
  } finally {
    activeMigrationId = null;
  }
}

export interface BootSelfCheckOptions {
  stateDir: string;
  /** 本进程实际打开的库（config.dbPath） */
  currentDbPath: string;
  sourceDb: { prepare: (sql: string) => { get: () => unknown } };
  applySettings: (dbPath: string) => void;
  /** 旧文件清理（缺省 cleanupOldDbFiles） */
  cleanup?: (backupDir: string, oldDbPath: string) => { removed: string[] };
  /** 延迟执行（缺省 setTimeout；测试注入） */
  schedule?: (fn: () => void, ms: number) => void;
  now?: () => number;
}

export interface BootSelfCheckResult {
  handled: boolean;
  ok: boolean;
  code: DbMigrationStatusCode | null;
  message: string;
  migration_id: string | null;
  /** 自检失败：设置已回滚，需要让新进程退出、由旧进程重新接管 */
  needsRestartToOldDb: boolean;
}

/**
 * 新进程启动钩子：有 pending 意图且本进程正用迁移目标库 → 自检。
 * 通过：归档旧库文件、清意图、状态收尾（cleanup → done）。
 * 失败：设置回滚旧路径、清意图、状态 rolled_back，并要求本进程退出（旧进程健康检查失败后会重新监听旧库）。
 */
export function runBootSelfCheck(options: BootSelfCheckOptions): BootSelfCheckResult {
  const intent = readMigrationIntent(options.stateDir);
  if (intent === null) {
    return { handled: false, ok: true, code: null, message: '无待自检的迁移', migration_id: null, needsRestartToOldDb: false };
  }
  const now = options.now ?? Date.now;
  const status = activeStatuses.get(intent.migration_id) ?? readMigrationStatus(options.stateDir, intent.migration_id);
  if (intent.to_db_path !== options.currentDbPath) {
    clearMigrationIntent(options.stateDir);
    return { handled: true, ok: true, code: null, message: '本进程用的不是迁移目标库，已清理待自检意图', migration_id: intent.migration_id, needsRestartToOldDb: false };
  }
  const check = selfCheckMigratedDb(intent, options.sourceDb);
  const record = status ?? newStatus(intent.migration_id, intent.from_db_path, intent.to_db_path);
  const push = (stage: DbMigrationStage, detail?: string): void => {
    record.stage = stage;
    record.stages.push(detail === undefined ? { stage, at: now() } : { stage, at: now(), detail });
    activeStatuses.set(record.migration_id, record);
    persistStatus(options.stateDir, record);
  };
  push('selfcheck', check.ok ? 'passed' : check.problems.join('；'));
  if (!check.ok) {
    options.applySettings(intent.from_db_path);
    clearMigrationIntent(options.stateDir);
    const text = describeMigrationError('DB_MIGRATION_SELFCHECK_FAILED', check.problems.join('；'));
    record.ok = false;
    record.code = 'DB_MIGRATION_ROLLED_BACK';
    record.message = text.message + '；已回滚设置到原库 ' + intent.from_db_path;
    record.retryable = text.retryable;
    push('rolled_back', record.message);
    return { handled: true, ok: false, code: 'DB_MIGRATION_ROLLED_BACK', message: record.message, migration_id: intent.migration_id, needsRestartToOldDb: true };
  }
  clearMigrationIntent(options.stateDir);
  const cleanup = options.cleanup ?? cleanupOldDbFiles;
  record.ok = true;
  record.code = null;
  record.retryable = false;
  let archived = false;
  let detail: string;
  try {
    const removed = cleanup(intent.backup_dir, intent.from_db_path);
    archived = true;
    detail = '旧库文件已归档 ' + removed.removed.length + ' 个';
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    detail = '旧库文件待归档（旧进程仍占用）：' + reason;
    // 旧进程在新进程开始监听后才退出，必然占着旧库：延迟一次重试，成功后补 done
    (options.schedule ?? ((fn, ms) => { const timer = setTimeout(fn, ms); timer.unref?.(); }))(() => {
      try {
        const removed = cleanup(intent.backup_dir, intent.from_db_path);
        record.message = '迁移完成，新进程自检通过；重试归档旧库文件 ' + removed.removed.length + ' 个';
        // 就地更新上一次 cleanup 的 detail，阶段链保持线性（不出现两条 cleanup）
        const lastCleanup = record.stages[record.stages.length - 1];
        if (lastCleanup !== undefined && lastCleanup.stage === 'cleanup') {
          lastCleanup.detail = '重试成功，归档 ' + removed.removed.length + ' 个';
          lastCleanup.at = Date.now();
        }
        push('done');
      } catch {
        // 仍占用：保留 <bak>.old 与旧库，可手动清理；stage 停在 cleanup 不再推进
      }
    }, 3000);
  }
  record.message = '迁移完成，新进程自检通过；' + detail;
  push('cleanup', detail);
  // done 只在旧库真正归档后出现（DB-3 可据此判定「彻底完成」）
  if (archived) push('done');
  return { handled: true, ok: true, code: null, message: record.message, migration_id: intent.migration_id, needsRestartToOldDb: false };
}
