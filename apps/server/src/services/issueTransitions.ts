/**
 * CLI-CLOSE：验收后的两条状态流转（服务层）。
 *
 * - `closeIssue`：待验收 → 已关闭。占用中拒绝（409，先 release）；已是已关闭则幂等返回。
 * - `reopenIssue`：已关闭/已废弃 → 指定状态（默认待规划）。目标必须命中本工作区状态字典（含自定义状态）。
 *
 * 语义复用既有 `updateIssueInHierarchy`（内含 kind/字典校验、父卡关闭校验、updated_at 单调），
 * 这里只加「当前状态是否允许这一步」的前置判断，不新造流转机制。
 */
import type { Issue } from '@agentboard/shared';
import type { Db } from '../db/connection.js';
import { getIssue } from '../db/repos/issue.js';
import { ApiError, ConflictError, NotFoundError, ValidationError } from '../errors.js';
import { updateIssueInHierarchy } from './taskHierarchy.js';
import { CLOSED_KINDS } from '../db/migrations/workspaceStatus.js';
import { isClosedKind, requireWorkspaceStatus } from './workspaceStatus.js';

/** 内置「已关闭」状态名（close 的落点） */
export const CLOSED_STATUS_NAME = '已关闭';

export function closeIssue(db: Db, issueId: string, workspaceId?: string): Issue {
  return db.transaction(() => {
    const issue = getIssue(db, issueId, workspaceId);
    if (!issue) throw new NotFoundError('任务不存在');
    if (issue.claimed_by !== null) {
      throw new ApiError(409, 'ISSUE_CLAIMED', `任务正被 ${issue.claimed_by} 占用，请先 release 再关闭`);
    }
    const closed = requireWorkspaceStatus(db, issue.workspace_id, CLOSED_STATUS_NAME);
    if (issue.status === closed) return issue; // 幂等：已经关闭
    if (issue.status !== '待验收') {
      throw new ApiError(409, 'INVALID_TRANSITION', `只有「待验收」的任务可以关闭（当前：${issue.status}）`);
    }
    return updateIssueInHierarchy(db, issueId, { status: closed });
  }).immediate();
}

export function reopenIssue(db: Db, issueId: string, to?: string, workspaceId?: string): Issue {
  return db.transaction(() => {
    const issue = getIssue(db, issueId, workspaceId);
    if (!issue) throw new NotFoundError('任务不存在');
    if (issue.claimed_by !== null) {
      throw new ApiError(409, 'ISSUE_CLAIMED', `任务正被 ${issue.claimed_by} 占用，请先 release 再重开`);
    }
    if (!isClosedKind(closedKindOf(db, issue))) {
      throw new ApiError(409, 'INVALID_TRANSITION', `只有「${CLOSED_KINDS.map(kind => kind).length > 0 ? '已关闭 / 已废弃' : '已关闭'}」的任务可以重开（当前：${issue.status}）`);
    }
    const target = (to ?? '待规划').trim();
    if (target === '') throw new ValidationError('目标状态不能为空');
    // 必填校验放在最前：非法目标 → 400 且列出可用状态
    const validated = requireWorkspaceStatus(db, issue.workspace_id, target);
    if (validated === issue.status) return issue;
    return updateIssueInHierarchy(db, issueId, { status: validated });
  }).immediate();
}

/** 当前状态所属 kind（查字典；查不到返回 null，交给 isClosedKind 判 false） */
function closedKindOf(db: Db, issue: Issue): string | null {
  const row = db.prepare('SELECT kind FROM workspace_status WHERE workspace_id=? AND name=?')
    .get(issue.workspace_id, issue.status) as { kind: string } | undefined;
  return row?.kind ?? null;
}

/** 供路由层复用：把占用冲突统一成可解释文案 */
export const claimedConflict = (claimedBy: string): ConflictError => new ConflictError(`任务正被 ${claimedBy} 占用`);
