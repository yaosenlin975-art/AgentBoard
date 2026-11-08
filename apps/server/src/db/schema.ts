import type { Db } from './connection.js';
import { migrateKnowledge } from './migrations/knowledge.js';
import { migrateIdempotency } from './migrations/idempotency.js';
import { migrateAccounts } from './migrations/accounts.js';
import { migrateDeviceIdentity } from './migrations/deviceIdentity.js';
// ACC-TOKEN-2：凭据到期/失效四列（幂等加列；必须排在 migrateDeviceIdentity 与一切重建 managed_account 的迁移之后）
import { migrateCredentialExpiry } from './migrations/credentialExpiry.js';
import { migrateWorkspaceDbMode } from './migrations/workspaceDbMode.js';
import { migrateTaskHierarchy } from './migrations/taskHierarchy.js';
import { migrateAttachments, migrateAttachmentKind } from './migrations/attachments.js';
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
import { migrateApprovalRule } from './migrations/approvalRule.js';
import { migrateClaimLease } from './migrations/claimLease.js';
import { migrateSessionTurn } from './migrations/sessionTurn.js';
// BORROW-4.2：会话事件流（纯追加表；seq 翻页依赖主键）
import { migrateSessionEvent } from './migrations/sessionEvent.js';
// BORROW-4.3：会话暂停标记（幂等加列，不重建 session 表）
import { migrateSessionPaused } from './migrations/sessionPaused.js';
// CHAT-RETRY1（契约 #15）：单步重试步骤台账（依赖 session_turn 已建）
import { migrateSessionStepLedger } from './migrations/sessionStepLedger.js';
import { migrateCliAccounts } from './migrations/cliAccounts.js';
// DEC-1：待决策区三表（纯追加表 + 部分唯一索引；workspace 纯加列）
import { migratePendingDecision } from './migrations/pendingDecision.js';
// PERM-1：工作区成员表 + 既有工作区 owner 回填（纯追加表，幂等）
import { migrateWorkspaceMember } from './migrations/workspaceMember.js';
// STORE-3a：issue(parent_issue_id) 子列索引（放在最末——此前任何 issue 表重建都会带走它，这里幂等补回）
import { migrateIssueParentIndex } from './migrations/issueParentIndex.js';
// STORE-4b：中心库定位索引 entity_locator（薄索引；行由 repos 维护钩子写入，删表可由重建路径回填）
import { migrateEntityLocator } from './migrations/entityLocator.js';
// STORE-7：中心库归档记录（纯追加表；已下沉工作区删除时落一条，归档列表据此回显）
import { migrateWorkspaceArchive } from './migrations/workspaceArchive.js';
// PERF-5：issue_comment(issue_id) 索引（comment_count 相关子查询；放最末，幂等补回）
import { migrateIssueCommentIndex } from './migrations/issueCommentIndex.js';
// CR2-2：聊天热表索引 message(session_id)、session(workspace_id)（放最末，幂等补回）
import { migrateChatIndex } from './migrations/chatIndex.js';

/**
 * DDL：新库直接按最新结构建表。
 * 历史注记（STATUS-1）：`issue.status` 原为 CHECK 枚举（4 值）；状态模型扩展后改为纯文本，
 * 合法性由 `workspace_status`（每工作区字典）+ 服务层校验保证。DDL 变了，存量库靠
 * `migrateIssueStatusModel` 重建表（SQLite 删不掉 CHECK）。
 */
const DDL = `
CREATE TABLE IF NOT EXISTS workspace (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, path TEXT NOT NULL UNIQUE, created_at INTEGER NOT NULL,
  -- DEC-1：工作区级默认宽限秒数；默认 180，区间 0–600（存量库由 migratePendingDecision 幂等补列）
  decision_grace_seconds INTEGER NOT NULL DEFAULT 180 CHECK (decision_grace_seconds BETWEEN 0 AND 600));
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
-- PERM-1：工作区成员（权限方案路线 A；迁移期每个既有工作区 seed ('user','owner')）
CREATE TABLE IF NOT EXISTS workspace_member (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
  actor_id TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('owner','member','viewer')),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL);
CREATE UNIQUE INDEX IF NOT EXISTS ux_workspace_member ON workspace_member(workspace_id, actor_id);
CREATE TABLE IF NOT EXISTS session (
  id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
  issue_id TEXT REFERENCES issue(id) ON DELETE SET NULL,
  cli TEXT NOT NULL, model TEXT, status TEXT NOT NULL DEFAULT '运行中'
    CHECK (status IN ('运行中','已结束','失败')),
  adapter_session_id TEXT, created_at INTEGER NOT NULL, title TEXT,
  archived_at INTEGER, forked_from_session_id TEXT, fork_message_id TEXT,
  paused_at INTEGER);
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
  // D7：附件 kind 列（image/file）——重建 attachment 表去掉 mime 白名单 CHECK；可重入
  migrateAttachmentKind(db);
  migrateWorkspaceChangeLog(db);
  migrateCheckin(db);
  migrateCheckinPlatforms(db);
  // ACC-KB-B2S：协议级「添加账号」的授权会话表（纯追加表）
  migrateAddAccount(db);
  // ACC-KB-B6：设备身份字段（幂等；老数据默认 pending）。**必须放在所有「重建 managed_account」的迁移之后**，
  // 否则重建表会把这 4 列丢掉（accountPlatforms / checkinPlatforms 都是 DROP+CREATE 重建）。
  migrateDeviceIdentity(db);
  // ACC-TOKEN-2：凭据到期/失效四列（幂等纯加列；老数据不回填，保持 unknown 由写入点自然补齐）
  migrateCredentialExpiry(db);
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
  // BORROW-4.2：会话事件流（纯追加；依赖 session 表已建）
  migrateSessionEvent(db);
  // BORROW-4.3：会话暂停标记（纯加列；不重建 session 表，避免 FK 级联清空）
  migrateSessionPaused(db);
  // CHAT-RETRY1（契约 #15）：步骤台账（必须排在 migrateSessionTurn 之后）
  migrateSessionStepLedger(db);
  // CHAT-AWAIT1（契约 #13 / 超时兜底）：session_turn 心跳列（必须排在 migrateSessionTurn 之后）
  migrateSessionAwaiting(db);
  // CHAT-APP1（契约 #9）：三档确认规则表（含未撤销规则的部分唯一索引；依赖 session_turn 已建）
  migrateApprovalRule(db);
  // BORROW-0.2：占用租约列。**必须排在 migrateIssueStatusModel 之后**——该迁移重建 issue 表，
  // 排在前面加的列会被重建带走（重建后这里再幂等补齐，新旧库都收敛到同一结构）。
  migrateClaimLease(db);
  // DEC-1：待决策区三表与索引（纯追加，不重建 issue/workspace；必须排在 claim 租约之后）
  migratePendingDecision(db);
  // PERM-1：成员表 + 既有工作区 owner 回填（纯追加；只依赖 workspace 表已建）
  migrateWorkspaceMember(db);
  // ACC-CLI-MULTI：CLI 三来源的本机凭据登记表（纯追加，幂等；与 managed_account 无关）
  migrateCliAccounts(db);
  // STORE-3a：issue(parent_issue_id) 子列索引（放在最末——此前任何 issue 表重建都会带走它，这里幂等补回）
  migrateIssueParentIndex(db);
  // STORE-4b：中心库定位索引 entity_locator（纯追加新表，幂等；与既有表无重建依赖，放最末）
  migrateEntityLocator(db);
  // STORE-7：归档记录（纯追加新表，幂等；无外键，与 workspace 删除解耦）
  migrateWorkspaceArchive(db);
  // PERF-5：issue_comment(issue_id) 索引（放最末，幂等；comment_count 相关子查询从 SCAN 变 SEARCH）
  migrateIssueCommentIndex(db);
  // CR2-2：聊天热表索引（放最末，幂等；message 按 session、session 按 workspace 查询从 SCAN 变 SEARCH）
  migrateChatIndex(db);
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
