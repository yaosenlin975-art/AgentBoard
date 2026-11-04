import { existsSync } from 'node:fs';
import type { Db } from '../connection.js';
import { createIssueHierarchyObjects, createIssueMonotonicTimeTrigger } from './taskHierarchy.js';

/**
 * STATUS-1：重建 `issue` 表（设计 §3.3）。
 *
 * SQLite 删不掉列上的 CHECK，所以「去掉 status 枚举校验」必须走：建新表 → 搬数据 → drop 旧表 → rename。
 * 同时新增 `due_date TEXT` / `due_time TEXT`（设计 §4）。
 *
 * 幂等判据：`issue` 表已无 status CHECK 且已有 due_date/due_time 列 → 直接跳过（不再备份）。
 * 备份：迁移前 `VACUUM INTO <db>.pre-status-migration.<ts>`（一致性快照，事务外执行）。
 * 事务：建表/搬数/删表/改名/重建索引与触发器全在同一个事务里；失败整体回滚，库保持迁移前状态。
 * 触发器：`DROP TABLE issue` 会带走表上的全部触发器，rename 后用 taskHierarchy 里的同一份 DDL 重建
 * （`issue_parent_*` 三个 + `issue_monotonic_time`），索引 `issue_parent_order` 一并重建。
 *
 * 回滚：见 `Docs/decisions/2026-11-03-status-model.md`（靠备份文件还原，不自动回滚）。
 */
export interface StatusModelMigrationResult {
  migrated: boolean;
  backupPath: string | null;
  rowCount: number;
}

const TARGET_COLUMNS = [
  'id', 'workspace_id', 'title', 'description', 'priority', 'labels', 'status', 'sort_order',
  'claimed_by', 'claimed_at', 'session_id', 'last_seen_comment_id', 'parent_issue_id',
  'due_date', 'due_time', 'created_at', 'updated_at',
] as const;

const issueTableSql = (db: Db): string =>
  ((db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='issue'").get() as { sql?: string } | undefined)?.sql ?? '');

const issueColumns = (db: Db): string[] =>
  (db.prepare('PRAGMA table_info(issue)').all() as Array<{ name: string }>).map(column => column.name);

/** status 上还带着 CHECK 枚举（旧库）或缺少 due_date/due_time 列 → 需要重建 */
export function issueNeedsStatusModelMigration(db: Db): boolean {
  const sql = issueTableSql(db);
  if (sql === '') return false; // 表还没建（全新库由 DDL 直接建新结构）
  const columns = issueColumns(db);
  const hasDue = columns.includes('due_date') && columns.includes('due_time');
  const statusHasCheck = /status\s+TEXT[^,]*CHECK\s*\(\s*status\s+IN/i.test(sql);
  return statusHasCheck || !hasDue;
}

const quote = (value: string): string => `'${value.replace(/'/g, "''")}'`;

/** 迁移前一致性备份（VACUUM INTO，事务外执行；目标文件已存在会失败，因此用时间戳命名） */
export function backupDatabaseBeforeStatusMigration(db: Db, now: number = Date.now()): string | null {
  const dbPath = (db as unknown as { name?: string }).name;
  if (!dbPath || dbPath === ':memory:') return null;
  const target = `${dbPath}.pre-status-migration.${now}`;
  if (existsSync(target)) return target;
  db.exec(`VACUUM INTO ${quote(target)}`);
  return target;
}

export function migrateIssueStatusModel(db: Db, now: number = Date.now()): StatusModelMigrationResult {
  if (!issueNeedsStatusModelMigration(db)) return { migrated: false, backupPath: null, rowCount: 0 };

  const backupPath = backupDatabaseBeforeStatusMigration(db, now);
  const existing = new Set(issueColumns(db));
  const copyColumns = TARGET_COLUMNS.filter(column => existing.has(column));
  const selectList = copyColumns
    .map(column => (column === 'due_date' || column === 'due_time' ? `NULL AS ${column}` : column))
    .join(', ');
  const insertList = copyColumns.join(', ');
  const rowCount = (db.prepare('SELECT COUNT(*) AS n FROM issue').get() as { n: number }).n;

  // PRAGMA foreign_keys 不能在事务内切换：先关（避免 drop/rename 期间子表 FK 报错），迁移完再开
  db.pragma('foreign_keys = OFF');
  try {
    db.transaction(() => {
      /**
       * 别的表上的触发器若引用 issue，会在 `DROP TABLE issue` 时被 SQLite 重新解析而报
       * `no such table: main.issue`（实测：issue_dependency_same_workspace / _no_cycle）。
       * 先在事务内摘掉、rename 完成后用原 SQL 原样装回——不手写它们的 DDL，避免与迁移实现漂移。
       */
      const dependentTriggers = db.prepare(`SELECT name, sql FROM sqlite_master
        WHERE type='trigger' AND tbl_name <> 'issue' AND sql IS NOT NULL AND sql LIKE '%issue%'`).all() as Array<{ name: string; sql: string }>;
      for (const trigger of dependentTriggers) db.exec(`DROP TRIGGER IF EXISTS "${trigger.name}"`);

      db.exec(`
        CREATE TABLE issue_new (
          id TEXT PRIMARY KEY,
          workspace_id TEXT NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
          title TEXT NOT NULL,
          description TEXT NOT NULL DEFAULT '',
          priority TEXT NOT NULL DEFAULT '中' CHECK (priority IN ('低','中','高')),
          labels TEXT NOT NULL DEFAULT '[]',
          status TEXT NOT NULL DEFAULT '待规划',
          sort_order INTEGER NOT NULL DEFAULT 0,
          claimed_by TEXT,
          claimed_at INTEGER,
          session_id TEXT,
          last_seen_comment_id TEXT,
          parent_issue_id TEXT REFERENCES issue(id) ON DELETE RESTRICT,
          due_date TEXT,
          due_time TEXT,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL
        );
      `);
      db.exec(`INSERT INTO issue_new (${insertList}) SELECT ${selectList} FROM issue ORDER BY created_at, id`);
      db.exec('DROP TABLE issue');
      db.exec('ALTER TABLE issue_new RENAME TO issue');
      // 旧表上的索引与触发器随 DROP 一起消失，用同一份 DDL 重建
      createIssueHierarchyObjects(db);
      createIssueMonotonicTimeTrigger(db);
      for (const trigger of dependentTriggers) db.exec(trigger.sql);
      const violators = db.prepare('PRAGMA foreign_key_check').all() as unknown[];
      if (violators.length > 0) throw new Error(`迁移后外键校验失败：${violators.length} 条`);
    })();
  } finally {
    db.pragma('foreign_keys = ON');
  }
  return { migrated: true, backupPath, rowCount };
}
