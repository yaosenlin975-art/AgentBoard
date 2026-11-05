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
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { Db } from '../db/connection.js';
import { openDb } from '../db/connection.js';
import { initSchema } from '../db/schema.js';
import { ApiError } from '../errors.js';
import { vacuumInto } from './dbMigration.js';
import { workspaceStateDir } from '../db/resolver.js';
import {
  LOCALIZE_STAGES,
  clearLocalizeState,
  countWorkspacePayload,
  localizeError,
  localizeStatePath,
  preflightLocalize,
  readLocalizeState,
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

const sha256File = (path: string): string => createHash('sha256').update(readFileSync(path)).digest('hex');

function tableColumns(db: Db, table: string): string[] {
  return (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((c) => c.name);
}

/** 按「目标库现有列」逐行插入（同构库，列名一致；多余列自动裁剪，缺列报错） */
function insertRows(target: Db, table: string, rows: Array<Record<string, unknown>>): void {
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

/** 复制该工作区的行（只读中心库；返回每表行数） */
function copyScopedRows(centerDb: Db, target: Db, workspaceId: string): Record<string, number> {
  const counts: Record<string, number> = {};
  const run = (table: string, sql: string, params: unknown[]): void => {
    const rows = centerDb.prepare(sql).all(...params) as Array<Record<string, unknown>>;
    insertRows(target, table, rows);
    counts[table] = rows.length;
  };
  target.exec('PRAGMA defer_foreign_keys = ON');
  target.transaction(() => {
  run('workspace_status', 'SELECT * FROM workspace_status WHERE workspace_id = ?', [workspaceId]);
  run('issue', 'SELECT * FROM issue WHERE workspace_id = ?', [workspaceId]);
  run('issue_comment', 'SELECT c.* FROM issue_comment c JOIN issue i ON i.id = c.issue_id WHERE i.workspace_id = ?', [workspaceId]);
  run('issue_dependency', `SELECT d.* FROM issue_dependency d JOIN issue i ON i.id = d.blocked_issue_id WHERE i.workspace_id = ?`, [workspaceId]);
  run('issue_git_baseline', 'SELECT b.* FROM issue_git_baseline b JOIN issue i ON i.id = b.issue_id WHERE i.workspace_id = ?', [workspaceId]);
  run('issue_draft_audit', 'SELECT * FROM issue_draft_audit WHERE workspace_id = ?', [workspaceId]);
  run('session', 'SELECT * FROM session WHERE workspace_id = ?', [workspaceId]);
  run('message', 'SELECT m.* FROM message m JOIN session s ON s.id = m.session_id WHERE s.workspace_id = ?', [workspaceId]);
  run('attachment', 'SELECT * FROM attachment WHERE workspace_id = ?', [workspaceId]);
  run('workspace_change_log', 'SELECT * FROM workspace_change_log WHERE origin_workspace_id = ?', [workspaceId]);
  run('knowledge_page', "SELECT * FROM knowledge_page WHERE scope='workspace' AND workspace_id = ?", [workspaceId]);
  run('knowledge_revision', "SELECT r.* FROM knowledge_revision r JOIN knowledge_page p ON p.id = r.page_id WHERE p.scope='workspace' AND p.workspace_id = ?", [workspaceId]);
  run('knowledge_link', "SELECT l.* FROM knowledge_link l JOIN knowledge_page p ON p.id = l.source_page_id WHERE p.scope='workspace' AND p.workspace_id = ?", [workspaceId]);
  run('knowledge_attachment', "SELECT a.* FROM knowledge_attachment a JOIN knowledge_page p ON p.id = a.page_id WHERE p.scope='workspace' AND p.workspace_id = ?", [workspaceId]);
  })();
  return counts;
}

/** meta 表（工作区库的身份与状态；设计 §5.1） */
function ensureMetaTable(db: Db): void {
  db.exec('CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
}
function setMeta(db: Db, key: string, value: string): void {
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

/** copy_attachments：两表取 storage_key，逐文件复制 + sha256（目标在 `<ws>/.agentboard/attachments`） */
function copyAttachmentFiles(
  centerDb: Db,
  workspaceId: string,
  sourceDir: string,
  targetDir: string,
): { files: number; mismatches: string[] } {
  const keys = new Set<string>();
  for (const row of centerDb.prepare('SELECT storage_key FROM attachment WHERE workspace_id = ?').all(workspaceId) as Array<{ storage_key: string }>) keys.add(row.storage_key);
  for (const row of centerDb.prepare("SELECT a.storage_key FROM knowledge_attachment a JOIN knowledge_page p ON p.id = a.page_id WHERE p.scope='workspace' AND p.workspace_id = ?").all(workspaceId) as Array<{ storage_key: string }>) keys.add(row.storage_key);
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
 */
export async function localizeWorkspace(
  centerDb: Db,
  input: PreflightLocalizeInput & { overwrite?: boolean },
  deps: LocalizeDeps = {},
): Promise<LocalizeResult> {
  const now = deps.now ?? Date.now;
  const workspaceRow = centerDb.prepare('SELECT id, path, db_mode FROM workspace WHERE id = ?').get(input.workspaceId) as { id: string; path: string; db_mode?: string | null } | undefined;
  if (workspaceRow === undefined) throw localizeError('WORKSPACE_NOT_FOUND');
  const wsPath = workspaceRow.path;
  const stateDir = workspaceStateDir(wsPath);
  const targetDbPath = join(stateDir, 'agentboard.db');

  // 已下沉：幂等返回（验收 4）
  if ((workspaceRow.db_mode ?? 'center') === 'localized' && existsSync(targetDbPath)) {
    const probe = openDb(targetDbPath);
    try {
      if (getMeta(probe, 'localized') === '1' && getMeta(probe, 'workspace_id') === workspaceRow.id) {
        return { state: 'already_localized', migration_id: readLocalizeState(wsPath)?.migration_id ?? 'existing', stages: [], counts: {}, backup_path: null, target_db_path: targetDbPath };
      }
    } finally {
      probe.close();
    }
  }

  // 半拷贝识别：有未 finalize 的中间态 → 只有 overwrite 才清理后重来
  const existingState = readLocalizeState(wsPath);
  if (existingState !== null && existingState.stage !== 'finalize' && input.overwrite !== true) {
    throw localizeError('MIGRATION_BUSY', `上次迁移停在 ${existingState.stage}（${localizeStatePath(wsPath)}）；确认清理后重来请带 overwrite=true`);
  }
  if (existingState !== null && input.overwrite === true) {
    rmSync(targetDbPath, { force: true });
    rmSync(`${targetDbPath}-wal`, { force: true });
    rmSync(`${targetDbPath}-shm`, { force: true });
    rmSync(join(stateDir, 'attachments'), { recursive: true, force: true });
    clearLocalizeState(wsPath);
  }

  const preflight = await preflightLocalize(centerDb, input);
  const migrationId = `mig-${now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  const stages: LocalizeStage[] = [];
  const counts: Record<string, number> = {};
  let backupPath: string | null = null;
  const write = (stage: LocalizeStage, lastError: string | null = null): void => {
    stages.push(stage);
    const state: LocalizeState = {
      migration_id: migrationId, workspace_id: workspaceRow.id, stage, center_db: centerDb.name,
      backup_path: backupPath, started_at: now(), counts, last_error: lastError,
    };
    writeLocalizeState(wsPath, state);
    deps.onStage?.(stage, state);
  };

  let target: Db | null = null;
  // STORE-2a：迁移写闸门——开跑即置中心 db_mode=localizing（resolver 据此冻结该区写、放行读）；
  // 失败落 failed（待恢复态，同样冻结写）；只有 switch 事务自己把它改成 localized。
  let modeFrozen = false;
  const setMode = (mode: 'localizing' | 'failed'): void => {
    centerDb.prepare('UPDATE workspace SET db_mode = ? WHERE id = ?').run(mode, workspaceRow.id);
  };
  try {
    write('preflight');

    // ② backup：中心库一致性快照（旧库保留供回滚）
    setMode('localizing');
    modeFrozen = true;
    write('backup');
    backupPath = `${targetDbPath}.center-backup-${new Date(now()).toISOString().replace(/[:.]/g, '-')}`;
    vacuumInto(centerDb, backupPath);

    // ③ create：目标库 + 全量 schema + workspace 行副本 + workspace_status + meta.localized=0
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
    // ⑥ verify：七项
    write('verify');
    const problems = verifyLocalizedWorkspace({ centerDb, targetDb: target, workspaceId: workspaceRow.id, expected: counts, attachmentDir: targetAttachments });
    if (problems.length > 0) throw new ApiError(500, 'LOCALIZE_VERIFY_FAILED', `迁移校验未通过：${problems.join('；')}`);
    // ⑦ switch：先工作区 meta.localized=1，再中心一个事务删 scoped 行 + db_mode=localized
    write('switch');
    setMeta(target, 'localized', '1');
    centerDb.transaction(() => {
      for (const table of LOCALIZE_COPY_ORDER) {
        if (table === 'attachment') { centerDb.prepare('DELETE FROM attachment WHERE workspace_id = ?').run(workspaceRow.id); continue; }
        if (table === 'workspace_status') { centerDb.prepare('DELETE FROM workspace_status WHERE workspace_id = ?').run(workspaceRow.id); continue; }
        if (table === 'workspace_change_log') { centerDb.prepare('DELETE FROM workspace_change_log WHERE origin_workspace_id = ?').run(workspaceRow.id); continue; }
        if (table === 'issue') { centerDb.prepare('DELETE FROM issue WHERE workspace_id = ?').run(workspaceRow.id); continue; }
        if (table === 'issue_draft_audit') { centerDb.prepare('DELETE FROM issue_draft_audit WHERE workspace_id = ?').run(workspaceRow.id); continue; }
        if (table === 'session') { centerDb.prepare('DELETE FROM session WHERE workspace_id = ?').run(workspaceRow.id); continue; }
        if (table === 'knowledge_page') { deleteWorkspaceKnowledgeRows(centerDb, workspaceRow.id); continue; }
        // 其余表由外键级联或父行删除带走的，不再单独删（issue/comment、session/message、page/revision/link/attachment）
      }
      centerDb.prepare("UPDATE workspace SET db_mode='localized', localized_at=? WHERE id=?").run(now(), workspaceRow.id);
    })();
    // ⑧ finalize
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
