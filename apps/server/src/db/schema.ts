import type { Db } from './connection.js';
import { migrateKnowledge } from './migrations/knowledge.js';
import { migrateIdempotency } from './migrations/idempotency.js';
import { migrateAccounts } from './migrations/accounts.js';
import { migrateDeviceIdentity } from './migrations/deviceIdentity.js';
import { migrateWorkspaceDbMode } from './migrations/workspaceDbMode.js';
import { migrateTaskHierarchy } from './migrations/taskHierarchy.js';
import { migrateAttachments } from './migrations/attachments.js';
import { migrateWorkspaceChangeLog } from './migrations/workspaceChangeLog.js';
import { migrateCheckin } from './migrations/checkin.js';
import { migrateWorkspaceOrder } from './migrations/workspaceOrder.js';
import { migrateIssueGitBaseline, pruneIssueGitBaselines } from './migrations/issueGitBaseline.js';
import { migrateAccountPlatforms } from './migrations/accountPlatforms.js';
import { migrateCheckinPlatforms } from './migrations/checkinPlatforms.js';
import { migrateAddAccount } from './migrations/addAccount.js';
import { migrateKnowledgeLinks } from './migrations/knowledgeLinks.js';
import { migrateIssueDependency } from './migrations/issueDependency.js';
import { migrateIssueStatusModel } from './migrations/issueStatusModel.js';
import { createIssueMonotonicTimeTrigger } from './migrations/taskHierarchy.js';
import { migrateWorkspaceStatus } from './migrations/workspaceStatus.js';
import { migrateDraftAudit } from './migrations/draftAudit.js';
import { migrateKnowledgeAttachment } from './migrations/knowledgeAttachment.js';
import { migrateSessionMessageSignals } from './migrations/sessionMessage.js';
import { migrateSessionTitle } from './migrations/sessionTitle.js';
import { migrateSessionSidebar } from './migrations/sessionSidebar.js';
import { migrateSessionAwaiting } from './migrations/sessionAwaiting.js';
import { migrateClaimLease } from './migrations/claimLease.js';
import { migrateSessionTurn } from './migrations/sessionTurn.js';
import { migrateCliAccounts } from './migrations/cliAccounts.js';

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
  -- BORROW-0.2 占用租约：NULL 租约=不可抢占；fence 代次每次 claim 自增（校验属 B03）
  claim_lease_until INTEGER, claim_fence INTEGER NOT NULL DEFAULT 0, last_heartbeat_at INTEGER,
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
  adapter_session_id TEXT, created_at INTEGER NOT NULL, title TEXT,
  archived_at INTEGER, forked_from_session_id TEXT, fork_message_id TEXT);
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
  // ACC-KB-B2S：协议级「添加账号」的授权会话表（纯追加表）
  migrateAddAccount(db);
  // ACC-KB-B6：设备身份字段（幂等；老数据默认 pending）。**必须放在所有「重建 managed_account」的迁移之后**，
  // 否则重建表会把这 4 列丢掉（accountPlatforms / checkinPlatforms 都是 DROP+CREATE 重建）。
  migrateDeviceIdentity(db);
  // STORE-1：必须排在最末（此前任何 workspace 表重建都会丢掉后加列）
  migrateWorkspaceDbMode(db);
  // AUDIT-SRV（F-04）：message 表的错误归类列（幂等加列；老行保持 NULL，读取时现算兜底）
  migrateSessionMessageSignals(db);
  // 会话级标题（重命名）：幂等加列，不重建 session 表；NULL 保持既有派生标题
  migrateSessionTitle(db);
  // CHAT-SB1（契约 #1–4）：侧栏会话字段 archived_at / forked_from_session_id / fork_message_id
  //（title 已由上一步补齐；同样是纯加列，不重建 session 表）
  migrateSessionSidebar(db);
  // CHAT-TURN1（契约 #5–8）：轮次表 + message 三列。纯加表/加列，不重建 message/session
  //（重建会带走 error_code/retryable 与全部消息），历史数据不回填。
  migrateSessionTurn(db);
  // CHAT-AWAIT1（契约 #13 / 超时兜底）：session_turn 心跳列（必须排在 migrateSessionTurn 之后）
  migrateSessionAwaiting(db);
  // BORROW-0.2：占用租约列。**必须排在 migrateIssueStatusModel 之后**——该迁移重建 issue 表，
  // 排在前面加的列会被重建带走（重建后这里再幂等补齐，新旧库都收敛到同一结构）。
  migrateClaimLease(db);
  // ACC-CLI-MULTI：CLI 三来源的本机凭据登记表（纯追加，幂等；与 managed_account 无关）
  migrateCliAccounts(db);
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
