/**
 * STORE-2（M2a）：`enable` 的八阶段状态机（第一次真实搬数据）。
 *
 * 阶段（设计 §6.3，`localize.json` 每阶段**前**落盘）：
 *   preflight → backup(VACUUM INTO) → create(initSchema+workspace 行副本+workspace_status+meta.localized=0)
 *   → copy(按外键顺序按工作区复制) → copy_attachments(两表取 key，逐文件 sha256)
 *   → verify(七项) → switch(先工作区 meta.localized=1，再中心一个事务删 scoped 行 + db_mode=localized) → finalize
 *
 * 可中断/可重入：
 * - 每阶段前写 `localize.json`；阶段内失败把 `last_error` 写进去并保留目标库，便于排障；
 * - 重跑时若发现**未 finalize** 的中间态：视为半拷贝，`overwrite=true` 时先清目标库 + 附件 + 状态再从头来；
 * - `already_localized`：`db_mode=localized` 且工作区库 `meta.localized=1` → 直接返回，不重做。
 */
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import type { Db } from '../db/connection.js';
import { openDb } from '../db/connection.js';
import { initSchema } from '../db/schema.js';
import { ApiError } from '../errors.js';
import { vacuumInto, listFilesRecursive } from './dbMigration.js';
import { workspaceStateDir } from '../db/resolver.js';
import {
  LOCALIZE_STAGES,
  clearLocalizeState,
  collectWorkspaceAttachmentKeys,
  countWorkspacePayload,
  localizeError,
  localizeStatePath,
  preflightLocalize,
  readLocalizeState,
  safeSize,
  writeLocalizeState,
  type LocalizeCounts,
  type LocalizeStage,
  type LocalizeState,
  type PreflightLocalizeInput,
} from './workspaceLocalize.js';

/** copy 阶段的表顺序（外键必须先父后子） */
export const LOCALIZE_COPY_ORDER = [
  'workspace_status',
  'issue',
  'issue_comment',
  'issue_dependency',
  'issue_git_baseline',
  'issue_draft_audit',
  'session',
  'message',
  'attachment',
  'workspace_change_log',
  'knowledge_page',
  'knowledge_revision',
  'knowledge_link',
  'knowledge_attachment',
] as const;

/**
 * STORE-3a：copy / revert 反向拷贝 / status 行数与快照落后统计共用的「该工作区 scoped 行」查询。
 * SQL 与 2a 的 copyScopedRows 逐字一致；顺序即外键序（先父后子）。
 */
export interface WorkspaceTableQuery {
  table: (typeof LOCALIZE_COPY_ORDER)[number];
  sql: string;
}

export const WORKSPACE_TABLE_QUERIES: readonly WorkspaceTableQuery[] = [
  { table: 'workspace_status', sql: 'SELECT * FROM workspace_status WHERE workspace_id = ?' },
  { table: 'issue', sql: 'SELECT * FROM issue WHERE workspace_id = ?' },
  { table: 'issue_comment', sql: 'SELECT c.* FROM issue_comment c JOIN issue i ON i.id = c.issue_id WHERE i.workspace_id = ?' },
  { table: 'issue_dependency', sql: 'SELECT d.* FROM issue_dependency d JOIN issue i ON i.id = d.blocked_issue_id WHERE i.workspace_id = ?' },
  { table: 'issue_git_baseline', sql: 'SELECT b.* FROM issue_git_baseline b JOIN issue i ON i.id = b.issue_id WHERE i.workspace_id = ?' },
  { table: 'issue_draft_audit', sql: 'SELECT * FROM issue_draft_audit WHERE workspace_id = ?' },
  { table: 'session', sql: 'SELECT * FROM session WHERE workspace_id = ?' },
  { table: 'message', sql: 'SELECT m.* FROM message m JOIN session s ON s.id = m.session_id WHERE s.workspace_id = ?' },
  { table: 'attachment', sql: 'SELECT * FROM attachment WHERE workspace_id = ?' },
  { table: 'workspace_change_log', sql: 'SELECT * FROM workspace_change_log WHERE origin_workspace_id = ?' },
  { table: 'knowledge_page', sql: "SELECT * FROM knowledge_page WHERE scope='workspace' AND workspace_id = ?" },
  { table: 'knowledge_revision', sql: "SELECT r.* FROM knowledge_revision r JOIN knowledge_page p ON p.id = r.page_id WHERE p.scope='workspace' AND p.workspace_id = ?" },
  { table: 'knowledge_link', sql: "SELECT l.* FROM knowledge_link l JOIN knowledge_page p ON p.id = l.source_page_id WHERE p.scope='workspace' AND p.workspace_id = ?" },
  { table: 'knowledge_attachment', sql: "SELECT a.* FROM knowledge_attachment a JOIN knowledge_page p ON p.id = a.page_id WHERE p.scope='workspace' AND p.workspace_id = ?" },
];

/** 按表统计某库中该工作区 scoped 行数（copy 守恒校验 / status 快照落后 / revert 守恒共用） */
export function countScopedRowsByTable(db: Db, workspaceId: string): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const query of WORKSPACE_TABLE_QUERIES) {
    counts[query.table] = Number((db.prepare(`SELECT COUNT(*) AS n FROM (${query.sql})`).get(workspaceId) as { n: number }).n);
  }
  return counts;
}

/**
 * STORE-3a：revert 的「分叉行数」口径——中心库中会阻止 revert 的行数。
 * 排除 workspace_status：状态字典是可派生数据，已下沉后任何中心侧写卡都会重建 5 条默认
 * 字典行（openWorkspaceDbs=false 过渡期写落中心库），把可派生行当分叉会让 revert 永久被拒。
 * status 的 localized 态快照落后同用此口径，两处判定保持一致。
 */
export function centerRevertBlockingRows(db: Db, workspaceId: string): number {
  const counts = countScopedRowsByTable(db, workspaceId);
  return WORKSPACE_TABLE_QUERIES.reduce((sum, query) => sum + (query.table === 'workspace_status' ? 0 : (counts[query.table] ?? 0)), 0);
}

/**
 * STORE-4e：迁移终态 counts 补齐与 dry-run 统一的聚合键（键集契约见 shared WorkspaceLocalizeJobView.counts）：
 * rows_total = Σ scoped 表；attachment_files / attachment_bytes 取工作区附件目录实盘（= 拷出的同一集合，
 * resume 中段复用上次拷贝时同样成立）；db_bytes = 目标库主文件 + WAL 体积（dry-run 侧为中心库同口径）；
 * estimated_bytes = 附件 + 库体积（真实迁移即实际落盘合计）。
 */
function fillTerminalAggregateCounts(counts: Record<string, number>, stateDir: string, targetDbPath: string): void {
  counts.rows_total = WORKSPACE_TABLE_QUERIES.reduce((sum, query) => sum + (counts[query.table] ?? 0), 0);
  const files = listFilesRecursive(join(stateDir, 'attachments'));
  counts.attachment_files = files.length;
  counts.attachment_bytes = files.reduce((sum, file) => sum + file.bytes, 0);
  counts.db_bytes = safeSize(targetDbPath) + safeSize(`${targetDbPath}-wal`);
  counts.estimated_bytes = counts.attachment_bytes + counts.db_bytes;
}

export interface LocalizeDeps {
  /** 测试注入 */
  now?: () => number;
  freeBytes?: (dir: string) => Promise<number | null>;
  integrityCheck?: (db: Db) => string;
  attachmentsDir?: string;
  knowledgeImagesDir?: string;
  /** 测试注入：阶段钩子（kill 演练用） */
  onStage?: (stage: LocalizeStage, state: LocalizeState) => void;
}

export interface LocalizeResult {
  state: 'localized' | 'already_localized';
  migration_id: string;
  stages: LocalizeStage[];
  counts: Record<string, number>;
  backup_path: string | null;
  target_db_path: string;
}

export const sha256File = (path: string): string => createHash('sha256').update(readFileSync(path)).digest('hex');

function tableColumns(db: Db, table: string): string[] {
  return (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((c) => c.name);
}

/** 按「目标库现有列」逐行插入（同构库，列名一致；多余列自动裁剪，缺列报错）；revert 反向拷贝复用 */
export function insertRows(target: Db, table: string, rows: Array<Record<string, unknown>>): void {
  if (rows.length === 0) return;
  const targetCols = new Set(tableColumns(target, table));
  const cols = Object.keys(rows[0]!).filter((c) => targetCols.has(c));
  if (cols.length === 0) throw new ApiError(500, 'LOCALIZE_COPY_SCHEMA', `目标库缺列：${table}`);
  const sql = `INSERT INTO ${table} (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`;
  const stmt = target.prepare(sql);
  for (const row of rows) {
    try {
      stmt.run(...cols.map((c) => row[c] as never));
    } catch (error) {
      throw new ApiError(500, 'LOCALIZE_COPY_FAILED', `复制表 ${table} 失败：${error instanceof Error ? error.message : String(error)}（行主键 ${String(row.id ?? '?')}）`);
    }
  }
}

/** 复制该工作区的行（只读中心库；返回每表行数）。表序与 SQL 由 WORKSPACE_TABLE_QUERIES 统一供 reverse/status 复用 */
function copyScopedRows(centerDb: Db, target: Db, workspaceId: string): Record<string, number> {
  const counts: Record<string, number> = {};
  target.exec('PRAGMA defer_foreign_keys = ON');
  target.transaction(() => {
    for (const query of WORKSPACE_TABLE_QUERIES) {
      const rows = centerDb.prepare(query.sql).all(workspaceId) as Array<Record<string, unknown>>;
      insertRows(target, query.table, rows);
      counts[query.table] = rows.length;
    }
  })();
  return counts;
}

/** meta 表（工作区库的身份与状态；设计 §5.1）；revert 收尾写 backup 副本 meta 复用 */
export function ensureMetaTable(db: Db): void {
  db.exec('CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
}
export function setMeta(db: Db, key: string, value: string): void {
  db.prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, value);
}
export function getMeta(db: Db, key: string): string | null {
  try {
    const row = db.prepare('SELECT value FROM meta WHERE key = ?').get(key) as { value?: string } | undefined;
    return typeof row?.value === 'string' ? row.value : null;
  } catch {
    return null;
  }
}

/** 该工作区附件行的全部 storage_key：STORE-4e 实现上移 workspaceLocalize.ts（dry-run 统计同源），此处转发导出保持既有导入路径 */
export { collectWorkspaceAttachmentKeys } from './workspaceLocalize.js';

/** copy_attachments：两表取 storage_key，逐文件复制 + sha256（目标在 `<ws>/.agentboard/attachments`） */
function copyAttachmentFiles(
  centerDb: Db,
  workspaceId: string,
  sourceDir: string,
  targetDir: string,
): { files: number; mismatches: string[] } {
  const keys = collectWorkspaceAttachmentKeys(centerDb, workspaceId);
  mkdirSync(targetDir, { recursive: true });
  const mismatches: string[] = [];
  let files = 0;
  for (const key of keys) {
    const from = join(sourceDir, key);
    if (!existsSync(from)) { mismatches.push(`${key}（源文件缺失）`); continue; }
    const to = join(targetDir, key);
    mkdirSync(dirname(to), { recursive: true });
    copyFileSync(from, to);
    files += 1;
    if (sha256File(from) !== sha256File(to)) mismatches.push(`${key}（sha256 不一致）`);
  }
  return { files, mismatches };
}

/**
 * 删中心库里该工作区的知识页（先 revision，再页面）。
 * 两个坑必须处理：
 * - `knowledge_revision.page_id` 是 `ON DELETE RESTRICT`，页面不能直接删；
 * - `knowledge_revision` 上有不可变历史触发器（RAISE ABORT），删 revision 前要临时摘掉、事后再原样建回。
 */
function deleteWorkspaceKnowledgeRows(centerDb: Db, workspaceId: string): void {
  const triggers = centerDb
    .prepare("SELECT name, sql FROM sqlite_master WHERE type='trigger' AND name IN ('knowledge_revision_no_update','knowledge_revision_no_delete') AND sql IS NOT NULL")
    .all() as Array<{ name: string; sql: string }>;
  for (const trigger of triggers) centerDb.exec(`DROP TRIGGER ${trigger.name}`);
  try {
    centerDb.prepare("DELETE FROM knowledge_revision WHERE page_id IN (SELECT id FROM knowledge_page WHERE scope='workspace' AND workspace_id = ?)").run(workspaceId);
    centerDb.prepare("DELETE FROM knowledge_link WHERE source_page_id IN (SELECT id FROM knowledge_page WHERE scope='workspace' AND workspace_id = ?)").run(workspaceId);
    centerDb.prepare("DELETE FROM knowledge_attachment WHERE page_id IN (SELECT id FROM knowledge_page WHERE scope='workspace' AND workspace_id = ?)").run(workspaceId);
    centerDb.prepare("DELETE FROM knowledge_page WHERE scope='workspace' AND workspace_id = ?").run(workspaceId);
  } finally {
    for (const trigger of triggers) centerDb.exec(trigger.sql);
  }
}

/**
 * 删中心库里该工作区的全部 scoped 行（switch 前向迁移与 revert 反向迁移的清场共用；STORE-3a 提取）。
 * 调用方负责自己的事务；revert 场景调用前必须确认该区行已在工作区库（唯一副本不落地不删）。
 *
 * STORE-3a：子表必须先显式删、父表最后删——issue_comment / issue_git_baseline / issue_dependency /
 * issue_decision / approval_rule / message 等子表没有 (issue_id / session_id) 索引，靠外键级联逐行
 * 触发时每删一行父行就全表扫一遍子表（O(n²)，十万卡即分钟级卡死真跑）。子表各用一条
 * `WHERE issue_id IN (SELECT ...)`（SQLite 对 IN 清单建临时索引）整体线性；行集与 2a 逐条级联一致。
 * issue 自引用 parent_issue_id 为 ON DELETE RESTRICT：叶子优先逐轮删（父子同区由 taskHierarchy
 * 触发器保证，必然删空）；message 先于 session（session_turn/step_ledger 有 session_id 索引，级联免扫）。
 */
export function deleteWorkspaceScopedRows(centerDb: Db, workspaceId: string): void {
  const inIssue = '(SELECT id FROM issue WHERE workspace_id = ?)';
  centerDb.prepare(`DELETE FROM issue_comment WHERE issue_id IN ${inIssue}`).run(workspaceId);
  centerDb.prepare(`DELETE FROM issue_dependency WHERE blocked_issue_id IN ${inIssue} OR blocker_issue_id IN ${inIssue}`).run(workspaceId, workspaceId);
  centerDb.prepare(`DELETE FROM issue_git_baseline WHERE issue_id IN ${inIssue}`).run(workspaceId);
  centerDb.prepare(`DELETE FROM issue_decision WHERE issue_id IN ${inIssue}`).run(workspaceId);
  centerDb.prepare(`DELETE FROM approval_rule WHERE issue_id IN ${inIssue}`).run(workspaceId);
  const deleteLeafIssues = centerDb.prepare('DELETE FROM issue WHERE workspace_id = ? AND NOT EXISTS (SELECT 1 FROM issue child WHERE child.parent_issue_id = issue.id)');
  for (;;) {
    if (deleteLeafIssues.run(workspaceId).changes === 0) break;
  }
  centerDb.prepare('DELETE FROM message WHERE session_id IN (SELECT id FROM session WHERE workspace_id = ?)').run(workspaceId);
  centerDb.prepare('DELETE FROM session WHERE workspace_id = ?').run(workspaceId);
  centerDb.prepare('DELETE FROM attachment WHERE workspace_id = ?').run(workspaceId);
  centerDb.prepare('DELETE FROM workspace_status WHERE workspace_id = ?').run(workspaceId);
  centerDb.prepare('DELETE FROM issue_draft_audit WHERE workspace_id = ?').run(workspaceId);
  centerDb.prepare('DELETE FROM workspace_change_log WHERE origin_workspace_id = ?').run(workspaceId);
  deleteWorkspaceKnowledgeRows(centerDb, workspaceId); // revision→link→attachment→page（先摘不可变历史触发器）
}

/** verify 七项（设计 §6.4）；返回 problems，空数组 = 通过 */
export function verifyLocalizedWorkspace(options: {
  centerDb: Db;
  targetDb: Db;
  workspaceId: string;
  expected: Record<string, number>;
  attachmentDir: string;
}): string[] {
  const problems: string[] = [];
  const { centerDb, targetDb, workspaceId, expected } = options;

  const integrity = (targetDb.prepare('PRAGMA integrity_check').all() as Array<{ integrity_check?: string }>)[0]?.integrity_check ?? 'unknown';
  if (String(integrity).toLowerCase() !== 'ok') problems.push(`integrity_check=${integrity}`);
  const fk = targetDb.prepare('PRAGMA foreign_key_check').all() as unknown[];
  if (fk.length > 0) problems.push(`foreign_key_check 有 ${fk.length} 条`);

  // 逐表行数相等：只比对**拷贝序列表**（counts 里混有 attachment_files 之类的非表键）
  for (const table of LOCALIZE_COPY_ORDER) {
    const n = expected[table];
    if (n === undefined) continue;
    const got = Number((targetDb.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n);
    if (got !== n) problems.push(`${table} 行数 ${got} != ${n}`);
  }
  // workspace 恰 1 行且 id 正确、无 common 知识页
  const wsRows = targetDb.prepare('SELECT id FROM workspace').all() as Array<{ id: string }>;
  if (wsRows.length !== 1 || wsRows[0]!.id !== workspaceId) problems.push(`workspace 行 ${wsRows.length} 条`);
  const commonPages = Number((targetDb.prepare("SELECT COUNT(*) AS n FROM knowledge_page WHERE scope='common'").get() as { n: number }).n);
  if (commonPages !== 0) problems.push(`工作区库不应含 common 知识页（${commonPages}）`);
  // fts 行数 = 知识页数
  const fts = Number((targetDb.prepare('SELECT COUNT(*) AS n FROM knowledge_fts').get() as { n: number }).n);
  const pages = Number((targetDb.prepare('SELECT COUNT(*) AS n FROM knowledge_page').get() as { n: number }).n);
  if (fts !== pages) problems.push(`fts ${fts} != 知识页 ${pages}`);
  // 同构校验（第 ⑦ 条）：工作区库必须含中心库的全部列（含 KB-PAGE-3 的 domain）
  for (const table of ['knowledge_page', 'issue', 'workspace'] as const) {
    const centerCols = new Set(tableColumns(centerDb, table));
    const targetCols = new Set(tableColumns(targetDb, table));
    for (const col of centerCols) if (!targetCols.has(col)) problems.push(`${table} 缺列 ${col}`);
  }
  return problems;
}

/**
 * 跑一次 enable（八阶段）。只在隔离实例/测试里调用；`onStage` 可注入 kill 演练。
 *
 * STORE-3a resume 崩溃矩阵（`resume: true`，落点取 `<ws>/.agentboard/localize.json` 的 stage）：
 * - preflight / backup：整段重跑（清残留快照与半成品目标库后从头走八阶段）；
 * - create ~ copy_attachments：删半成品目标库 + 附件目录后从 create 重建（沿用上次 backup 快照——
 *   backup 完成后中心库被冻结，快照仍有效）；
 * - verify：保留已拷贝数据，只重跑七项校验 → switch → finalize；
 * - switch：幂等重跑 switch（中心事务删行 + db_mode=localized，行已删时为空删）→ finalize；
 * - finalize / switch 已提交（db_mode=localized）：迁移实际已完成，补账返回 already_localized。
 */
export async function localizeWorkspace(
  centerDb: Db,
  input: PreflightLocalizeInput & { overwrite?: boolean; resume?: boolean },
  deps: LocalizeDeps = {},
): Promise<LocalizeResult> {
  const now = deps.now ?? Date.now;
  const workspaceRow = centerDb.prepare('SELECT id, path, db_mode FROM workspace WHERE id = ?').get(input.workspaceId) as { id: string; path: string; db_mode?: string | null } | undefined;
  if (workspaceRow === undefined) throw localizeError('WORKSPACE_NOT_FOUND');
  const wsPath = workspaceRow.path;
  const stateDir = workspaceStateDir(wsPath);
  const targetDbPath = join(stateDir, 'agentboard.db');
  const centerMode = workspaceRow.db_mode ?? 'center';

  // 已下沉：幂等返回（验收 4）
  if (centerMode === 'localized' && existsSync(targetDbPath)) {
    const probe = openDb(targetDbPath);
    try {
      if (getMeta(probe, 'localized') === '1' && getMeta(probe, 'workspace_id') === workspaceRow.id) {
        const state = readLocalizeState(wsPath);
        return { state: 'already_localized', migration_id: state?.migration_id ?? 'existing', stages: [], counts: state === null ? {} : { ...state.counts }, backup_path: state?.backup_path ?? null, target_db_path: targetDbPath };
      }
    } finally {
      probe.close();
    }
  }

  // STORE-3a：resume 入口——localize.json 是跨进程唯一事实源（job 表只在内存）
  const newMigrationId = (): string => `mig-${now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  let resumeFrom: LocalizeStage | null = null;
  let migrationId = newMigrationId();
  let startedAt: number | null = null;
  const resumeState = input.resume === true ? readLocalizeState(wsPath) : null;
  if (input.resume === true) {
    if (resumeState === null) throw localizeError('NO_LOCALIZE_STATE', localizeStatePath(wsPath));
    if (resumeState.workspace_id !== workspaceRow.id || resumeState.center_db !== centerDb.name || !(LOCALIZE_STAGES as readonly string[]).includes(resumeState.stage)) {
      throw localizeError('LOCALIZE_STATE_INVALID', `${localizeStatePath(wsPath)}（stage=${resumeState.stage}）`);
    }
    // switch 已提交（db_mode=localized，含 kill@finalize）：迁移实际完成 → 补账即返回
    if (centerMode === 'localized') {
      return { state: 'already_localized', migration_id: resumeState.migration_id, stages: [], counts: { ...resumeState.counts }, backup_path: resumeState.backup_path, target_db_path: targetDbPath };
    }
    resumeFrom = resumeState.stage;
    migrationId = resumeState.migration_id;
    startedAt = resumeState.started_at;
  }

  const wipeTarget = (): void => {
    rmSync(targetDbPath, { force: true });
    rmSync(`${targetDbPath}-wal`, { force: true });
    rmSync(`${targetDbPath}-shm`, { force: true });
    rmSync(join(stateDir, 'attachments'), { recursive: true, force: true });
  };
  // 非 resume：半拷贝识别（2a 语义不动）——有未 finalize 的中间态 → 只有 overwrite 才清理后重来
  const existingState = input.resume === true ? null : readLocalizeState(wsPath);
  if (existingState !== null && existingState.stage !== 'finalize' && input.overwrite !== true) {
    throw localizeError('MIGRATION_BUSY', `上次迁移停在 ${existingState.stage}（${localizeStatePath(wsPath)}）；确认清理后重来请带 overwrite=true`);
  }
  if (existingState !== null && input.overwrite === true) {
    wipeTarget();
    clearLocalizeState(wsPath);
  }

  if (input.resume === true && resumeFrom !== null) {
    if (resumeFrom === 'preflight' || resumeFrom === 'backup') {
      // 直接重跑：清上次残留（可能写坏的快照/半成品目标库/中间态文件）后从头走八阶段；
      // 视为全新迁移 → 换新 migration_id / started_at
      for (const name of readdirSync(stateDir)) {
        if (name.startsWith(`${basename(targetDbPath)}.center-backup-`)) rmSync(join(stateDir, name), { force: true });
      }
      wipeTarget();
      clearLocalizeState(wsPath);
      resumeFrom = null;
      migrationId = newMigrationId();
      startedAt = null;
    } else if (resumeFrom === 'create' || resumeFrom === 'copy' || resumeFrom === 'copy_attachments') {
      // 删半成品重建（沿用上次 backup 快照与原 migration_id）
      wipeTarget();
    }
    // verify / switch：保留已拷贝目标，只重跑对应段；finalize 已在 db_mode=localized 早退里补账
  }

  // resume 中段（create 之后）不重跑 preflight：中间态是上次 preflight 通过后的延续，
  // 中心库自冻结起写不进该区新行；resume 重跑段（preflight/backup）继续走完整 preflight。
  if (resumeFrom === null) {
    await preflightLocalize(centerDb, input.resume === true ? { ...input, resume: true } : input);
  }
  const stages: LocalizeStage[] = [];
  const reuseCopiedCounts = resumeFrom === 'verify' || resumeFrom === 'switch' || resumeFrom === 'finalize';
  const counts: Record<string, number> = reuseCopiedCounts && resumeState !== null ? { ...resumeState.counts } : {};
  let backupPath: string | null = resumeState?.backup_path ?? null;
  const write = (stage: LocalizeStage, lastError: string | null = null): void => {
    stages.push(stage);
    const state: LocalizeState = {
      migration_id: migrationId, workspace_id: workspaceRow.id, stage, center_db: centerDb.name,
      backup_path: backupPath, started_at: startedAt ?? now(), counts, last_error: lastError,
    };
    writeLocalizeState(wsPath, state);
    deps.onStage?.(stage, state);
  };

  let target: Db | null = null;
  // STORE-2a：迁移写闸门——开跑即置中心 db_mode=localizing（resolver 据此冻结该区写、放行读）；
  // 失败落 failed（待恢复态，同样冻结写）；只有 switch 事务自己把它改成 localized。
  // STORE-3a：resume 中段同样先回 localizing（崩溃/重启后可能已塌缩成 failed）。
  let modeFrozen = false;
  const setMode = (mode: 'localizing' | 'failed'): void => {
    centerDb.prepare('UPDATE workspace SET db_mode = ? WHERE id = ?').run(mode, workspaceRow.id);
  };
  try {
    if (resumeFrom === null) {
      write('preflight');

      // ② backup：中心库一致性快照（旧库保留供回滚）
      setMode('localizing');
      modeFrozen = true;
      write('backup');
      backupPath = `${targetDbPath}.center-backup-${new Date(now()).toISOString().replace(/[:.]/g, '-')}`;
      vacuumInto(centerDb, backupPath);
    } else {
      // resume：重新冻结该区写
      setMode('localizing');
      modeFrozen = true;
    }

    // ③④⑤ create → copy → copy_attachments（fresh 全跑；resume 从 create/copy/copy_attachments 进）
    if (resumeFrom === null || resumeFrom === 'create' || resumeFrom === 'copy' || resumeFrom === 'copy_attachments') {
      // ③ create：目标库 + 全量 schema + workspace 行副本 + meta.localized=0
      write('create');
      mkdirSync(stateDir, { recursive: true });
      target = openDb(targetDbPath);
      initSchema(target);
      ensureMetaTable(target);
      const wsRow = centerDb.prepare('SELECT * FROM workspace WHERE id = ?').get(workspaceRow.id) as Record<string, unknown>;
      // 行副本只允许 UPDATE 语义：先插入（目标库空），后续同步一律 UPDATE（禁止 INSERT OR REPLACE，见设计 §5.2）
      insertRows(target, 'workspace', [wsRow]);
      setMeta(target, 'workspace_id', workspaceRow.id);
      setMeta(target, 'localized', '0');

      // ④ copy：按外键顺序复制 scoped 行
      write('copy');
      Object.assign(counts, copyScopedRows(centerDb, target, workspaceRow.id));

      // ⑤ copy_attachments：两表取 key，逐文件 sha256
      write('copy_attachments');
      const sourceAttachments = deps.attachmentsDir ?? join(dirname(centerDb.name), 'attachments');
      const targetAttachments = join(stateDir, 'attachments');
      const copied = copyAttachmentFiles(centerDb, workspaceRow.id, sourceAttachments, targetAttachments);
      counts.attachment_files = copied.files;
      if (copied.mismatches.length > 0) throw new ApiError(500, 'LOCALIZE_ATTACHMENT_MISMATCH', `附件校验失败：${copied.mismatches.slice(0, 3).join('；')}`);
    }

    // ⑥ verify：七项（resume@switch/finalize 不重跑——switch 幂等、finalize 只补账）
    if (resumeFrom === null || resumeFrom === 'create' || resumeFrom === 'copy' || resumeFrom === 'copy_attachments' || resumeFrom === 'verify') {
      write('verify');
      if (target === null) target = openDb(targetDbPath);
      const targetAttachments = join(stateDir, 'attachments');
      const problems = verifyLocalizedWorkspace({ centerDb, targetDb: target, workspaceId: workspaceRow.id, expected: counts, attachmentDir: targetAttachments });
      if (problems.length > 0) throw new ApiError(500, 'LOCALIZE_VERIFY_FAILED', `迁移校验未通过：${problems.join('；')}`);
    }

    // ⑦ switch：先工作区 meta.localized=1，再中心一个事务删 scoped 行 + db_mode=localized
    //（resume@switch 重跑幂等：行已删时为空删、db_mode 原地改写）
    write('switch');
    if (target === null) target = openDb(targetDbPath);
    setMeta(target, 'localized', '1');
    centerDb.transaction(() => {
      deleteWorkspaceScopedRows(centerDb, workspaceRow.id);
      centerDb.prepare("UPDATE workspace SET db_mode='localized', localized_at=? WHERE id=?").run(now(), workspaceRow.id);
    })();
    // ⑧ finalize（STORE-4e：先补齐与 dry-run 统一的聚合键——rows_total / 附件 / 库体积，再落盘状态）
    fillTerminalAggregateCounts(counts, stateDir, targetDbPath);
    write('finalize');
    return { state: 'localized', migration_id: migrationId, stages, counts, backup_path: backupPath, target_db_path: targetDbPath };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    write(stages.at(-1) ?? 'preflight', message);
    // 只在仍是 localizing 时落 failed：switch 成功后 db_mode=localized，不得回改
    if (modeFrozen) {
      const current = centerDb.prepare('SELECT db_mode FROM workspace WHERE id = ?').get(workspaceRow.id) as { db_mode?: string } | undefined;
      if (current?.db_mode === 'localizing') setMode('failed');
    }
    throw error;
  } finally {
    try { target?.close(); } catch { /* 忽略 */ }
  }
}
