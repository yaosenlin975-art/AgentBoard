import type { Issue, IssueComment } from '@agentboard/shared';
import type { Db } from '../db/connection.js';
import { getIssue, type IssuePatch } from '../db/repos/issue.js';
import { addComment, type AddCommentResult } from './comments.js';
import { ConflictError, NotFoundError, ValidationError } from '../errors.js';
import { ApiError } from '../errors.js';
import { addComment as insertCommentRow } from '../db/repos/comment.js';
import { updateIssueInHierarchy } from './taskHierarchy.js';
import { blockedClaimMessage, unresolvedBlockers } from './dependency.js';

export function requireIssueInWorkspace(db: Db, issueId: string, workspaceId: string): Issue {
  const issue = getIssue(db, issueId, workspaceId);
  if (!issue) throw new ApiError(404, 'TASK_NOT_FOUND', '任务不存在');
  return issue;
}
export function updateIssueWithCAS(db: Db, issueId: string, workspaceId: string, expectedUpdatedAt: number, patch: IssuePatch): Issue {
  if (!Number.isSafeInteger(expectedUpdatedAt) || expectedUpdatedAt < 0) throw new ValidationError('expected_updated_at 不合法');
  return db.transaction(() => {
    const issue = requireIssueInWorkspace(db, issueId, workspaceId);
    if (issue.claimed_by && patch.status !== undefined) throw new ConflictError('占用中禁止修改状态');
    return updateIssueInHierarchy(db, issueId, patch, { workspaceId, expectedUpdatedAt });
  }).immediate();
}
function scopedFinish(db: Db, issueId: string, workspaceId: string, actorId: string, action: 'done' | 'fail' | 'release', detail?: string): ClaimActionResult {
  if (!actorId?.trim()) throw new ValidationError('agent_id 不能为空');
  if (action === 'fail' && !detail?.trim()) throw new ValidationError('失败原因不能为空');
  return db.transaction(() => {
    const issue = requireIssueInWorkspace(db, issueId, workspaceId);
    if (issue.claimed_by !== actorId) throw new ApiError(409, 'NOT_TASK_OWNER', '只有当前占用者可执行此操作');
    const result = db.prepare(`UPDATE issue SET status=?,claimed_by=NULL,claimed_at=NULL,session_id=NULL,last_seen_comment_id=NULL,updated_at=MAX(?,updated_at+1) WHERE id=? AND workspace_id=? AND claimed_by=?`)
      .run(action === 'done' ? '待验收' : '待规划', Date.now(), issueId, workspaceId, actorId);
    if (result.changes !== 1) throw new ApiError(409, 'NOT_TASK_OWNER', '任务占用已改变');
    const content = action === 'release' ? '占用者释放任务' : detail?.trim();
    const comment = content ? insertCommentRow(db, { issue_id: issueId, author: `agent:${actorId}`, content }) : null;
    return { issue: getIssue(db, issueId)!, comment };
  }).immediate();
}
export function releaseClaimedIssue(db: Db, issueId: string, workspaceId: string, actorId: string): ClaimActionResult {
  return scopedFinish(db, issueId, workspaceId, actorId, 'release');
}
export function finishClaimedIssue(db: Db, issueId: string, workspaceId: string, actorId: string, action: 'done' | 'fail', detail?: string): ClaimActionResult {
  return scopedFinish(db, issueId, workspaceId, actorId, action, detail);
}

/** done/fail/release 返回：流转后的 issue + 本次自动评论（done 无 notes 时 comment 为 null） */
export interface ClaimActionResult {
  issue: Issue;
  comment: IssueComment | null;
}

/**
 * 原子领取：并发领取仅一个成功；允许从"进行中"领取（覆盖用户手动拖到进行中后再派发）。
 * sessionId 传 null 即 REST/kb 的纯占用登记（不绑会话，评论不触发唤醒）。
 * 留言游标同步置为领取前最新评论；有未验证图片时停在首条图片评论之前，保持图片及其后续评论待读。
 * DEP-1 依赖门禁：前置未解除 → 409（守卫在同一个 IMMEDIATE 事务内，与占用更新原子）；`done`/`fail`/`release` 不受依赖影响。
 */
export function claimIssue(db: Db, issueId: string, agentId: string, sessionId: string | null): Issue {
  return db.transaction(() => {
    const blockers = unresolvedBlockers(db, issueId);
    if (blockers.length > 0) throw new ConflictError(blockedClaimMessage(blockers));
    const now = Date.now();
    const firstImage = db.prepare(`SELECT c.id,c.ts FROM issue_comment c
      JOIN comment_attachment ca ON ca.comment_id=c.id
      WHERE c.issue_id=? ORDER BY c.ts,c.id LIMIT 1`).get(issueId) as { id: string; ts: number } | undefined;
    let lastSeenCommentId: string | null;
    if (firstImage) {
      const previous = db.prepare(`SELECT id FROM issue_comment
        WHERE issue_id=? AND (ts<? OR (ts=? AND id<?)) ORDER BY ts DESC,id DESC LIMIT 1`)
        .get(issueId, firstImage.ts, firstImage.ts, firstImage.id) as { id: string } | undefined;
      lastSeenCommentId = previous?.id ?? null;
    } else {
      const latest = db.prepare('SELECT id FROM issue_comment WHERE issue_id=? ORDER BY ts DESC,id DESC LIMIT 1')
        .get(issueId) as { id: string } | undefined;
      lastSeenCommentId = latest?.id ?? null;
    }
    const row = db.prepare(
      `UPDATE issue SET claimed_by=?, claimed_at=?, session_id=?, status='进行中',
         last_seen_comment_id=?, updated_at=?
       WHERE id=? AND claimed_by IS NULL AND status IN ('待规划','进行中')`
    ).run(agentId, now, sessionId, lastSeenCommentId, now, issueId);
    if (row.changes !== 1) {
      // CLAIM-MSG：占用冲突与「状态不可领取」是两件事，文案必须分开（同报「已被占用」会让执行者误以为撞卡而放弃）
      const current = db.prepare('SELECT status, claimed_by FROM issue WHERE id=?').get(issueId) as
        { status: string; claimed_by: string | null } | undefined;
      if (!current) throw new NotFoundError('任务不存在');
      if (current.claimed_by !== null) {
        throw new ApiError(409, 'ISSUE_CLAIMED', `已被 ${current.claimed_by} 占用；先 release 或换卡，勿重复 claim`);
      }
      throw new ApiError(409, 'ISSUE_STATUS_NOT_CLAIMABLE',
        `状态不可领取（当前=${current.status}，需=待规划 或 进行中）；无人占用，待验收卡由 owner 验收或由父代理退回待规划`);
    }
    return getIssue(db, issueId)!;
  }).immediate();
}

/**
 * 完成：待验收 + 释放占用；notes 非空时经 comments.addComment 落评论(author=agent:<id>)。
 * agent/system 作者不触发唤醒，且 addComment 的 DB 段同步完成、可嵌套在外层事务内，
 * 因此"状态流转 + 评论"仍在同一事务提交；返回的 promise 在事务提交后 await。
 */
export async function doneIssue(
  db: Db,
  issueId: string,
  agentId: string,
  notes?: string,
): Promise<ClaimActionResult> {
  const issue = getIssue(db, issueId);
  if (!issue) throw new NotFoundError('任务不存在');
  if (issue.claimed_by === null) throw new ConflictError('未被占用');
  if (agentId !== 'user' && issue.claimed_by !== agentId) throw new ApiError(409, 'NOT_TASK_OWNER', '只有当前占用者可完成任务');
  const now = Date.now();
  const release = db.prepare(
    `UPDATE issue SET status='待验收', claimed_by=NULL, claimed_at=NULL, session_id=NULL,
       last_seen_comment_id=NULL, updated_at=?
     WHERE id=? AND claimed_by=?`,
  );
  const writeNote = notes !== undefined && notes.trim() !== '';
  let write: Promise<AddCommentResult> | undefined;
  let comment: IssueComment | null = null;
  db.transaction(() => {
    if (release.run(now, issueId, issue.claimed_by).changes !== 1) throw new ConflictError('占用已改变');
    if (writeNote) {
      write = addComment(db, issueId, `agent:${agentId}`, notes);
    }
  })();
  if (write) comment = (await write).comment;
  return { issue: getIssue(db, issueId)!, comment };
}

/** 失败回报：回待规划 + 释放占用；reason 必填，经 comments.addComment 落评论(author=agent:<id>) */
export async function failIssue(
  db: Db,
  issueId: string,
  agentId: string,
  reason: string,
  expectedSessionId?: string,
): Promise<ClaimActionResult> {
  if (reason === undefined || reason === null || reason.trim() === '') {
    throw new ValidationError('失败原因不能为空');
  }
  const issue = getIssue(db, issueId);
  if (!issue) throw new NotFoundError('任务不存在');
  if (issue.claimed_by === null) throw new ConflictError('未被占用');
  const boundSessionFailure = expectedSessionId !== undefined && issue.session_id === expectedSessionId;
  if (agentId !== 'user' && issue.claimed_by !== agentId && !boundSessionFailure) throw new ApiError(409, 'NOT_TASK_OWNER', '只有当前占用者可回报失败');
  const now = Date.now();
  const release = db.prepare(
    `UPDATE issue SET status='待规划', claimed_by=NULL, claimed_at=NULL, session_id=NULL,
       last_seen_comment_id=NULL, updated_at=?
     WHERE id=? AND claimed_by=? AND session_id IS ?`,
  );
  let write: Promise<AddCommentResult> | undefined;
  let comment: IssueComment | null = null;
  db.transaction(() => {
    if (release.run(now, issueId, issue.claimed_by, issue.session_id).changes !== 1) throw new ConflictError('占用已改变');
    write = addComment(db, issueId, `agent:${agentId}`, reason);
  })();
  if (write) comment = (await write).comment;
  return { issue: getIssue(db, issueId)!, comment };
}

/** 用户强制释放：回待规划 + 清空占用 + 经 comments.addComment 落 system 评论 */
export async function releaseIssue(db: Db, issueId: string): Promise<ClaimActionResult> {
  const issue = getIssue(db, issueId);
  if (!issue) throw new NotFoundError('任务不存在');
  const now = Date.now();
  let write: Promise<AddCommentResult> | undefined;
  let comment: IssueComment | null = null;
  db.transaction(() => {
    db.prepare(
      `UPDATE issue SET status='待规划', claimed_by=NULL, claimed_at=NULL, session_id=NULL,
         last_seen_comment_id=NULL, updated_at=?
       WHERE id=?`,
    ).run(now, issueId);
    write = addComment(db, issueId, 'system', '用户强制释放');
  })();
  if (write) comment = (await write).comment;
  return { issue: getIssue(db, issueId)!, comment };
}

/** 服务层守卫：占用中的 issue 拒绝 status 变更，其余字段放行 */
export function updateIssueGuarded(db: Db, id: string, patch: IssuePatch): Issue {
  return db.transaction(() => {
    const issue = getIssue(db, id);
    if (!issue) throw new NotFoundError('任务不存在');
    if (issue.claimed_by !== null && patch.status !== undefined) {
      throw new ConflictError('占用中禁止修改状态');
    }
    return updateIssueInHierarchy(db, id, patch);
  }).immediate();
}
