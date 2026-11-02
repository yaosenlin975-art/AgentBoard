import type { Db } from './connection.js';
import { migrateKnowledge } from './migrations/knowledge.js';
import { migrateIdempotency } from './migrations/idempotency.js';
import { migrateAccounts } from './migrations/accounts.js';
import { migrateTaskHierarchy } from './migrations/taskHierarchy.js';
import { migrateAttachments } from './migrations/attachments.js';
import { migrateWorkspaceChangeLog } from './migrations/workspaceChangeLog.js';
import { migrateCheckin } from './migrations/checkin.js';
import { migrateWorkspaceOrder } from './migrations/workspaceOrder.js';
import { migrateIssueGitBaseline, pruneIssueGitBaselines } from './migrations/issueGitBaseline.js';
import { migrateAccountPlatforms } from './migrations/accountPlatforms.js';
import { migrateCheckinPlatforms } from './migrations/checkinPlatforms.js';
import { migrateKnowledgeLinks } from './migrations/knowledgeLinks.js';

// DDL 逐字来自实施计划 Pinned Contracts"DB DDL"段，不得改动
const DDL = `
CREATE TABLE IF NOT EXISTS workspace (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, path TEXT NOT NULL UNIQUE, created_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS issue (
  id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
  title TEXT NOT NULL, description TEXT NOT NULL DEFAULT '',
  priority TEXT NOT NULL DEFAULT '中' CHECK (priority IN ('低','中','高')),
  labels TEXT NOT NULL DEFAULT '[]',
  status TEXT NOT NULL DEFAULT '待规划' CHECK (status IN ('待规划','进行中','待验收','已关闭')),
  sort_order INTEGER NOT NULL DEFAULT 0,
  claimed_by TEXT, claimed_at INTEGER, session_id TEXT, last_seen_comment_id TEXT,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS issue_comment (
  id TEXT PRIMARY KEY, issue_id TEXT NOT NULL REFERENCES issue(id) ON DELETE CASCADE,
  author TEXT NOT NULL, content TEXT NOT NULL, ts INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS session (
  id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
  issue_id TEXT REFERENCES issue(id) ON DELETE SET NULL,
  cli TEXT NOT NULL, model TEXT, status TEXT NOT NULL DEFAULT '运行中'
    CHECK (status IN ('运行中','已结束','失败')),
  adapter_session_id TEXT, created_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS message (
  id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES session(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('user','assistant','event','error')),
  content TEXT NOT NULL, ts INTEGER NOT NULL);
`;

/** 幂等建表 + 存量库列迁移（全部幂等，可重复执行） */
export function initSchema(db: Db): void {
  db.exec(DDL);
  migrateIssueColumns(db);
  migrateWorkspaceOrder(db);
  migrateIssueGitBaseline(db);
  pruneIssueGitBaselines(db);
  migrateTaskHierarchy(db);
  migrateKnowledge(db);
  migrateKnowledgeLinks(db);
  migrateIdempotency(db);
  migrateAccounts(db);
  migrateAccountPlatforms(db);
  migrateAttachments(db);
  migrateWorkspaceChangeLog(db);
  migrateCheckin(db);
  migrateCheckinPlatforms(db);
  // One transactional guard covers edits, comments, claims and session recovery paths.
  db.exec(`CREATE TRIGGER IF NOT EXISTS issue_monotonic_time AFTER UPDATE ON issue
    WHEN new.updated_at <= old.updated_at BEGIN
      UPDATE issue SET updated_at=old.updated_at+1 WHERE id=new.id;
    END;`);
}

/** CREATE TABLE IF NOT EXISTS 不改已有表：缺列则 ALTER TABLE ADD COLUMN 补齐 */
function migrateIssueColumns(db: Db): void {
  const columns = db.prepare('PRAGMA table_info(issue)').all() as Array<{ name: string }>;
  const names = new Set(columns.map((c) => c.name));
  if (!names.has('last_seen_comment_id')) {
    db.exec('ALTER TABLE issue ADD COLUMN last_seen_comment_id TEXT');
  }
}
