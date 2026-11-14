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
