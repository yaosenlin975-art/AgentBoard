/**
 * STORE-3a：工作区库 localize 的反向操作——cleanup（清半成品）/ revert（反向迁移）/ 启动塌缩。
 *
 * - `recoverLocalizeGates`：进程启动时中心 db_mode=localizing 必然是「上次进程死在迁移中」
 *   （job 表只在内存、活任务不可能跨进程），统一塌缩为 failed（待恢复态，D4 语义照旧冻结写）；
 * - `cleanupWorkspaceDbRemnants`：只删工作区侧半成品（目标库 + 附件目录 + 残留快照 + localize.json），
 *   中心库数据不动；删除前校验中心库仍持有该区数据（或工作区库不含唯一副本），否则拒绝；
 * - `revertWorkspace`：localized → center 反向迁移——附件文件回拷（sha256）→ 单事务
 *   「删中心残留行（幂等）+ 反向插行 + 行数守恒校验 + db_mode=center」，提交后工作区库移入
 *   `<ws>/.agentboard/backup/`（backup 副本 meta.localized 落 0，杜绝被当成活库打开）。
 */
import { copyFileSync, existsSync, mkdirSync, readdirSync, renameSync, rmSync, statSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import Database from 'better-sqlite3';
import type { Db } from '../db/connection.js';
import { ApiError } from '../errors.js';
import { readWorkspaceMeta, workspaceDbPath, workspaceStateDir, type WorkspaceDbMode } from '../db/resolver.js';
import { clearLocalizeState, localizeError } from './workspaceLocalize.js';
import { getMeta, ensureMetaTable, setMeta } from './workspaceLocalizeRun.js';
import {
  WORKSPACE_TABLE_QUERIES,
  collectWorkspaceAttachmentKeys,
  countScopedRowsByTable,
  centerRevertBlockingRows,
  deleteWorkspaceScopedRows,
  insertRows,
  sha256File,
} from './workspaceLocalizeRun.js';

/** cleanup / revert 专用错误码（与 localize 的六条硬拒绝同构） */
export const WORKSPACE_DB_OP_ERRORS = {
  /** 已是干净状态（无 localize.json、无目标库、无残留快照），没有可清理的东西 */
  WORKSPACE_DB_NOTHING_TO_CLEAN: { status: 409, message: '没有可清理的迁移半成品（该工作区当前没有 localize.json / 目标库 / 残留快照）' },
  /** 已正常下沉（db_mode=localized），目标库是活库，不是半成品 */
  WORKSPACE_DB_CLEANUP_NOT_ALLOWED: { status: 409, message: '该工作区已正常下沉（db_mode=localized），无半成品可清理' },
  /** 中心库已无该区行而工作区库标记 localized=1：工作区库是唯一数据副本，删了就是丢数据 */
  WORKSPACE_DB_CLEANUP_UNSAFE: { status: 409, message: '中心库已无该工作区数据、工作区库是唯一数据副本，拒绝清理；请先执行 revert 恢复中心库' },
  /** 只有 localized（或 revert 中断遗留的 failed 且中心无行）才能 revert */
  WORKSPACE_DB_REVERT_NOT_LOCALIZED: { status: 409, message: '该工作区不在已下沉状态（db_mode≠localized），无可回迁数据' },
  /** 中心库已有该区数据（disabled 期间回写 / 上次 revert 提交后中断），直接回拷会覆盖或撞主键 */
  WORKSPACE_DB_REVERT_CENTER_ROWS: { status: 409, message: '中心库已存在该工作区数据，无法安全回迁；请先处理分叉（核对 snapshotLagRows 后删除或归档中心侧行）' },
} as const;

export type WorkspaceDbOpErrorCode = keyof typeof WORKSPACE_DB_OP_ERRORS;

export function workspaceDbOpError(code: WorkspaceDbOpErrorCode, detail?: string): ApiError {
  const spec = WORKSPACE_DB_OP_ERRORS[code];
  return new ApiError(spec.status, code, detail === undefined || detail === '' ? spec.message : `${spec.message}：${detail}`);
}

export interface WorkspaceDbOpDeps {
  /** 测试注入 */
  now?: () => number;
  integrityCheck?: (db: Db) => string;
  /** 中心库附件目录（缺省 `<中心库目录>/attachments`） */
  attachmentsDir?: string;
  /** 测试注入：阶段钩子（kill 演练用）；revert 阶段：preflight → copy_attachments_back → copy_back → finalize */
  onStage?: (stage: string) => void;
}

export interface CleanupResult {
  removed: Array<{ path: string; kind: 'target_db' | 'target_attachments' | 'stale_backup' | 'state_file' }>;
  /** 清理前中心库中该区 scoped 行总数（>0 表示中心持有数据，清理安全） */
  center_rows_before: number;
  /** 清理后的中心 db_mode（failed/localizing 已塌缩为 center，闸门释放） */
  mode_after: 'center';
}

interface WorkspaceRowLike {
  id: string;
  path: string;
  db_mode?: string | null;
}

function requireWorkspaceRow(centerDb: Db, workspaceId: string): WorkspaceRowLike {
  const row = centerDb.prepare('SELECT id, path, db_mode FROM workspace WHERE id = ?').get(workspaceId) as WorkspaceRowLike | undefined;
  if (row === undefined) throw localizeError('WORKSPACE_NOT_FOUND');
  return row;
}

function normalizeMode(mode: string | null | undefined): WorkspaceDbMode {
  return mode === 'localizing' || mode === 'localized' || mode === 'failed' ? mode : 'center';
}

function defaultIntegrityCheck(db: Db): string {
  try {
    const rows = db.prepare('PRAGMA integrity_check').all() as Array<{ integrity_check?: string }>;
    const first = rows[0]?.integrity_check ?? 'unknown';
    return String(first).toLowerCase() === 'ok' ? 'ok' : String(first);
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

/** 中心库该区 scoped 行总数（cleanup 安全闸用——判定「中心是否持有数据」要含全部表） */
export function centerScopedRowsTotal(centerDb: Db, workspaceId: string): number {
  return Object.values(countScopedRowsByTable(centerDb, workspaceId)).reduce((sum, n) => sum + n, 0);
}

/**
 * STORE-3a：启动塌缩——中心 db_mode=localizing 且本进程没有活任务 → 上次进程死在迁移中，
 * 统一落 failed（待恢复态）。这是「写闸门只在 job 生命周期内有效」的跨进程兜底：
 * job 终态由状态机自己落 failed/localized，进程死亡留下的 localizing 在下一次启动塌缩。
 * 返回塌缩的工作区数（0 = 无残留）。
 */
export function recoverLocalizeGates(centerDb: Db): number {
  const rows = centerDb.prepare("SELECT id FROM workspace WHERE db_mode = 'localizing'").all() as Array<{ id: string }>;
  if (rows.length === 0) return 0;
  const tx = centerDb.transaction(() => {
    for (const row of rows) centerDb.prepare("UPDATE workspace SET db_mode = 'failed' WHERE id = ?").run(row.id);
  });
  tx();
  return rows.length;
}

/**
 * STORE-3a：清理失败的迁移半成品。只动工作区侧（目标库 / -wal / -shm / 附件目录 / 残留
 * center-backup 快照 / localize.json），中心库数据一律不动；failed/localizing 的中心 db_mode
 * 落回 center（写闸门释放，D4 的 failed 冻结随之解除）。
 *
 * 安全闸（防删唯一数据副本）：
 * - db_mode=localized → 拒绝（目标库是活库）；
 * - 中心库该区行数为 0 且工作区库存在且（meta.localized=1 或打不开）→ 拒绝（可能唯一副本，先 revert）。
 */
export function cleanupWorkspaceDbRemnants(centerDb: Db, input: { workspaceId: string }, deps: WorkspaceDbOpDeps = {}): CleanupResult {
  const row = requireWorkspaceRow(centerDb, input.workspaceId);
  const mode = normalizeMode(row.db_mode);
  if (mode === 'localized') throw workspaceDbOpError('WORKSPACE_DB_CLEANUP_NOT_ALLOWED', workspaceDbPath(row.path));
  const stateDir = workspaceStateDir(row.path);
  const targetDbPath = workspaceDbPath(row.path);
  const centerRows = centerScopedRowsTotal(centerDb, row.id);
  if (existsSync(targetDbPath)) {
    const meta = readWorkspaceMeta(targetDbPath);
    if (centerRows === 0 && (meta === null || meta.localized)) {
      // 中心无该区行 + 工作区库 localized=1（或打不开无法证明不是唯一副本）→ 删了就是丢数据
      throw workspaceDbOpError('WORKSPACE_DB_CLEANUP_UNSAFE', targetDbPath);
    }
  }

  const removed: CleanupResult['removed'] = [];
  const rmIfExists = (path: string, kind: CleanupResult['removed'][number]['kind'], options: { recursive?: boolean } = {}): void => {
    if (!existsSync(path)) return;
    rmSync(path, { force: true, ...(options.recursive === true ? { recursive: true } : {}) });
    removed.push({ path, kind });
  };
  rmIfExists(targetDbPath, 'target_db');
  rmIfExists(`${targetDbPath}-wal`, 'target_db');
  rmIfExists(`${targetDbPath}-shm`, 'target_db');
  rmIfExists(join(stateDir, 'attachments'), 'target_attachments', { recursive: true });
  if (existsSync(stateDir)) {
    for (const name of readdirSync(stateDir)) {
      if (name.startsWith(`${basename(targetDbPath)}.center-backup-`)) rmIfExists(join(stateDir, name), 'stale_backup');
    }
  }
  if (existsSync(join(stateDir, 'localize.json'))) {
    clearLocalizeState(row.path);
    removed.push({ path: join(stateDir, 'localize.json'), kind: 'state_file' });
  }

  // 写闸门释放：failed / 残留 localizing 一律落回 center（中心数据未动过，回 center 即恢复原状）。
  // 无可删残留但闸门仍冻结（如备份恢复后塌缩的 failed）→ 释放闸门即本次清理成果，返回成功；
  // 干净且闸门本来就开（center）→ 才报 NOTHING_TO_CLEAN。
  if (removed.length === 0 && mode === 'center') throw workspaceDbOpError('WORKSPACE_DB_NOTHING_TO_CLEAN');
  if (mode === 'failed' || mode === 'localizing') {
    centerDb.prepare("UPDATE workspace SET db_mode = 'center' WHERE id = ?").run(row.id);
  }
  return { removed, center_rows_before: centerRows, mode_after: 'center' };
}

export interface RevertResult {
  migration_id: string;
  stages: string[];
  /** 回迁后中心库逐表行数（与工作区库逐表守恒） */
  counts: Record<string, number>;
  /** 工作区库移入 `<ws>/.agentboard/backup/` 后的路径 */
  backup_path: string;
  target_db_path: string;
}

/** revert 阶段顺序（独立于前向 localize 的 LOCALIZE_STAGES） */
export const REVERT_STAGES = ['preflight', 'copy_attachments_back', 'copy_back', 'finalize'] as const;

/**
 * STORE-3a：反向迁移（localized → center）。
 *
 * 前置：db_mode=localized（或 revert 中断遗留的 failed——中心无行、工作区库 meta.localized=1 时放行；
 * 前向迁移失败遗留的 failed 因中心仍有行会被 CENTER_ROWS 拒绝，走 resume/cleanup）；
 * 工作区库存在、可打开、meta.localized=1 且 workspace_id 一致；中心库该区行数为 0（防覆盖分叉）。
 *
 * 流程：preflight（只读）→ 附件文件回拷（sha256）→ copy_back 单事务
 * （删中心残留行〔幂等〕+ 反向插行 + 逐表守恒校验 + db_mode='center'）→ finalize
 * （工作区库 checkpoint 后移入 `.agentboard/backup/`，backup 副本 meta.localized=0，清 localize.json，
 * 删工作区侧附件目录）。写闸门：preflight 过后置 localizing 冻结该区写，copy_back 事务内原子落 center；
 * 失败回滚（中心数据未动）并把 db_mode 还原为 localized（工作区库仍是唯一活副本）。
 */
export async function revertWorkspace(centerDb: Db, input: { workspaceId: string }, deps: WorkspaceDbOpDeps = {}): Promise<RevertResult> {
  const now = deps.now ?? Date.now;
  const row = requireWorkspaceRow(centerDb, input.workspaceId);
  const mode = normalizeMode(row.db_mode);
  const stateDir = workspaceStateDir(row.path);
  const wsDbPath = workspaceDbPath(row.path);
  const stages: string[] = [];
  const mark = (stage: (typeof REVERT_STAGES)[number]): void => {
    stages.push(stage);
    deps.onStage?.(stage);
  };

  // ---- preflight（全部只读）----
  mark('preflight');
  if (mode !== 'localized' && mode !== 'failed') throw workspaceDbOpError('WORKSPACE_DB_REVERT_NOT_LOCALIZED', `db_mode=${mode}`);
  if (!existsSync(wsDbPath)) throw workspaceDbOpError('WORKSPACE_DB_REVERT_NOT_LOCALIZED', '工作区库文件不存在');
  const meta = readWorkspaceMeta(wsDbPath);
  if (meta === null) throw new ApiError(500, 'WORKSPACE_DB_UNREADABLE', '工作区库文件存在但打不开（损坏或非 SQLite 文件），无法回迁；请修复或从 .agentboard/backup 恢复');
  if (!meta.localized) throw workspaceDbOpError('WORKSPACE_DB_REVERT_NOT_LOCALIZED', 'meta.localized≠1（迁移未完成，请 resume 或 cleanup）');
  if (meta.workspaceId !== row.id) throw new ApiError(409, 'WORKSPACE_DB_ID_MISMATCH', `工作区库内的 workspace_id（${meta.workspaceId ?? '（缺失）'}）与目录绑定不一致，拒绝回迁`);
  const centerRows = centerRevertBlockingRows(centerDb, row.id);
  if (centerRows > 0) throw workspaceDbOpError('WORKSPACE_DB_REVERT_CENTER_ROWS', `${centerRows} 行（可能来自 disabled 期间的中心回写）`);
  const integrity = (deps.integrityCheck ?? defaultIntegrityCheck)(centerDb);
  if (integrity !== 'ok') throw localizeError('CENTER_DB_UNHEALTHY', integrity);

  // ---- 写闸门：回迁期间冻结该区写（崩溃后由启动塌缩/下一次 revert 兜底）----
  centerDb.prepare("UPDATE workspace SET db_mode = 'localizing' WHERE id = ?").run(row.id);
  const restoreLocalized = (): void => {
    // 回迁失败 = 中心数据未动（事务回滚），工作区库仍是唯一活副本 → 还原 localized
    try {
      const current = centerDb.prepare('SELECT db_mode FROM workspace WHERE id = ?').get(row.id) as { db_mode?: string } | undefined;
      if (current?.db_mode === 'localizing') centerDb.prepare("UPDATE workspace SET db_mode = 'localized' WHERE id = ?").run(row.id);
    } catch { /* 保持 localizing 由下次启动塌缩，不掩盖原始错误 */ }
  };

  let wsDb: Database.Database | null = null;
  try {
    // ---- copy_attachments_back：工作区附件文件回拷中心目录（已存在且一致则跳过）----
    mark('copy_attachments_back');
    wsDb = new Database(wsDbPath, { readonly: true, fileMustExist: true });
    const keys = collectWorkspaceAttachmentKeys(wsDb, row.id);
    const centerAttachmentsDir = deps.attachmentsDir ?? join(dirname(centerDb.name), 'attachments');
    const wsAttachmentsDir = join(stateDir, 'attachments');
    mkdirSync(centerAttachmentsDir, { recursive: true });
    const mismatches: string[] = [];
    for (const key of keys) {
      const from = join(wsAttachmentsDir, key);
      const to = join(centerAttachmentsDir, key);
      if (!existsSync(from)) continue; // 库里有行但文件本来就不在（历史遗留），不阻塞回迁
      if (existsSync(to)) {
        if (sha256File(from) !== sha256File(to)) mismatches.push(`${key}（两侧内容不一致）`);
        continue;
      }
      mkdirSync(dirname(to), { recursive: true });
      copyFileSync(from, to);
      if (sha256File(from) !== sha256File(to)) mismatches.push(`${key}（sha256 不一致）`);
    }
    if (mismatches.length > 0) throw new ApiError(500, 'REVERT_ATTACHMENT_MISMATCH', `附件回迁校验失败：${mismatches.slice(0, 3).join('；')}`);

    // ---- copy_back：单事务「删中心残留行（幂等）+ 反向插行 + 守恒校验 + db_mode=center」----
    mark('copy_back');
    const sourceCounts = countScopedRowsByTable(wsDb, row.id);
    centerDb.exec('PRAGMA defer_foreign_keys = ON');
    const counts: Record<string, number> = {};
    centerDb.transaction(() => {
      deleteWorkspaceScopedRows(centerDb, row.id); // 干净 localized 下是空删；revert 提交后中断的重跑在此自愈
      for (const query of WORKSPACE_TABLE_QUERIES) {
        const rows = wsDb!.prepare(query.sql).all(row.id) as Array<Record<string, unknown>>;
        insertRows(centerDb, query.table, rows);
        counts[query.table] = rows.length;
      }
      // 行数守恒（复用 verify 的守恒语义）：逐表「工作区库 = 中心库」
      const centerCounts = countScopedRowsByTable(centerDb, row.id);
      for (const query of WORKSPACE_TABLE_QUERIES) {
        if (centerCounts[query.table] !== sourceCounts[query.table]) {
          throw new ApiError(500, 'REVERT_VERIFY_FAILED', `回迁校验未通过：${query.table} 中心 ${centerCounts[query.table]} != 工作区库 ${sourceCounts[query.table]}`);
        }
      }
      centerDb.prepare("UPDATE workspace SET db_mode = 'center', localized_at = NULL WHERE id = ?").run(row.id);
    })();

    // ---- finalize：工作区库移入 backup（先移文件再改副本 meta，杜绝任何「活库被当备份」的中间态）----
    mark('finalize');
    try { wsDb.close(); } catch { /* 忽略 */ }
    wsDb = null;
    const stamp = new Date(now()).toISOString().replace(/[:.]/g, '-');
    const backupDir = join(stateDir, 'backup');
    mkdirSync(backupDir, { recursive: true });
    const backupPath = join(backupDir, `agentboard.db-reverted-${stamp}`);
    renameSync(wsDbPath, backupPath);
    rmSync(`${wsDbPath}-wal`, { force: true });
    rmSync(`${wsDbPath}-shm`, { force: true });
    // backup 副本标记为已回迁（localized=0）：它永远不会被解析层当活库打开，只是排障保险
    const backupDb = new Database(backupPath);
    try {
      ensureMetaTable(backupDb);
      setMeta(backupDb, 'localized', '0');
      setMeta(backupDb, 'reverted_at', String(now()));
    } finally {
      backupDb.close();
    }
    // 工作区侧附件目录已回拷中心，删除（失败安全：复制语义，中途失败只多中心侧孤儿文件，不丢数据）
    rmSync(wsAttachmentsDir, { recursive: true, force: true });
    clearLocalizeState(row.path);
    return { migration_id: `revert-${stamp}`, stages, counts, backup_path: backupPath, target_db_path: wsDbPath };
  } catch (error) {
    restoreLocalized();
    throw error;
  } finally {
    try { wsDb?.close(); } catch { /* 忽略 */ }
  }
}

/** 工作区库文件大小（status 附件/库体积用；缺失返回 0） */
export function safeFileSize(path: string): number {
  try {
    return statSync(path).size;
  } catch {
    return 0;
  }
}

/** revert 后 backup 目录里的副本 meta 校验（测试/排障用） */
export function readBackupMeta(dbPath: string): Record<string, string> {
  const db = new Database(dbPath, { readonly: true, fileMustExist: true });
  try {
    if (getMeta(db, 'workspace_id') === null && getMeta(db, 'localized') === null) return {};
    const rows = db.prepare('SELECT key, value FROM meta').all() as Array<{ key: string; value: string }>;
    return Object.fromEntries(rows.map((r) => [r.key, r.value]));
  } finally {
    db.close();
  }
}
