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
import { migrateIssueDependency } from './migrations/issueDependency.js';
import { migrateIssueStatusModel } from './migrations/issueStatusModel.js';
import { createIssueMonotonicTimeTrigger } from './migrations/taskHierarchy.js';
import { migrateWorkspaceStatus } from './migrations/workspaceStatus.js';
import { migrateDraftAudit } from './migrations/draftAudit.js';
import { migrateKnowledgeAttachment } from './migrations/knowledgeAttachment.js';

/**
 * DDL：新库直接按最新结构建表。
 * 历史注记（STATUS-1）：`issue.status` 原为 CHECK 枚举（4 值）；状态模型扩展后改为纯文本，
 * 合法性由 `workspace_status`（每工作区字典）+ 服务层校验保证。DDL 变了，存量库靠
 * `migrateIssueStatusModel` 重建表（SQLite 删不掉 CHECK）。
 */
const DDL = `
CREATE TABLE IF NOT EXISTS workspace (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, path TEXT NOT NULL UNIQUE, created_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS issue (
  id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
  title TEXT NOT NULL, description TEXT NOT NULL DEFAULT '',
  priority TEXT NOT NULL DEFAULT '中' CHECK (priority IN ('低','中','高')),
  labels TEXT NOT NULL DEFAULT '[]',
  status TEXT NOT NULL DEFAULT '待规划',
  sort_order INTEGER NOT NULL DEFAULT 0,
  claimed_by TEXT, claimed_at INTEGER, session_id TEXT, last_seen_comment_id TEXT,
  parent_issue_id TEXT REFERENCES issue(id) ON DELETE RESTRICT,
  due_date TEXT, due_time TEXT,
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
  // STATUS-1：重建 issue（去 status CHECK + 加 due 列）必须在添加 parent_issue_id 之后，
  // 这样重建时能一并搬运该列；重建会带走表上的触发器，rename 后由迁移内部重建。
  migrateIssueStatusModel(db);
  migrateWorkspaceStatus(db);
  migrateIssueDependency(db);
  migrateDraftAudit(db);
  migrateKnowledgeAttachment(db);
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
  createIssueMonotonicTimeTrigger(db);
}

/** CREATE TABLE IF NOT EXISTS 不改已有表：缺列则 ALTER TABLE ADD COLUMN 补齐 */
function migrateIssueColumns(db: Db): void {
  const columns = db.prepare('PRAGMA table_info(issue)').all() as Array<{ name: string }>;
  const names = new Set(columns.map((c) => c.name));
  if (!names.has('last_seen_comment_id')) {
    db.exec('ALTER TABLE issue ADD COLUMN last_seen_comment_id TEXT');
  }
}
