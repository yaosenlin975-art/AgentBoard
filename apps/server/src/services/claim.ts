import type { Issue, IssueComment } from '@agentboard/shared';
import type { Db } from '../db/connection.js';
import { getIssue, updateIssue, type IssuePatch } from '../db/repos/issue.js';
import { addComment, type AddCommentResult } from './comments.js';
import { ConflictError, NotFoundError, ValidationError } from '../errors.js';

/** done/fail/release 返回：流转后的 issue + 本次自动评论（done 无 notes 时 comment 为 null） */
export interface ClaimActionResult {
  issue: Issue;
  comment: IssueComment | null;
}

/**
 * 原子领取：并发领取仅一个成功；允许从"进行中"领取（覆盖用户手动拖到进行中后再派发）。
 * sessionId 传 null 即 REST/kb 的纯占用登记（不绑会话，评论不触发唤醒）。
 * 留言游标同步置为当前最新评论 id（领取输出含全部评论，视为已读）；无评论时为 NULL。
 */
export function claimIssue(db: Db, issueId: string, agentId: string, sessionId: string | null): Issue {
  const now = Date.now();
  const row = db.prepare(
    `UPDATE issue SET claimed_by=?, claimed_at=?, session_id=?, status='进行中',
       last_seen_comment_id=(SELECT id FROM issue_comment WHERE issue_id=? ORDER BY ts DESC, id DESC LIMIT 1),
       updated_at=?
     WHERE id=? AND claimed_by IS NULL AND status IN ('待规划','进行中')`
  ).run(agentId, now, sessionId, issueId, now, issueId);
  if (row.changes !== 1) throw new ConflictError('已被占用');
  return getIssue(db, issueId)!;
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
  const now = Date.now();
  const release = db.prepare(
    `UPDATE issue SET status='待验收', claimed_by=NULL, claimed_at=NULL, session_id=NULL,
       last_seen_comment_id=NULL, updated_at=?
     WHERE id=? AND claimed_by IS NOT NULL`,
  );
  const writeNote = notes !== undefined && notes.trim() !== '';
  let write: Promise<AddCommentResult> | undefined;
  let comment: IssueComment | null = null;
  db.transaction(() => {
    if (release.run(now, issueId).changes !== 1) throw new ConflictError('未被占用');
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
): Promise<ClaimActionResult> {
  if (reason === undefined || reason === null || reason.trim() === '') {
    throw new ValidationError('失败原因不能为空');
  }
  const issue = getIssue(db, issueId);
  if (!issue) throw new NotFoundError('任务不存在');
  if (issue.claimed_by === null) throw new ConflictError('未被占用');
  const now = Date.now();
  const release = db.prepare(
    `UPDATE issue SET status='待规划', claimed_by=NULL, claimed_at=NULL, session_id=NULL,
       last_seen_comment_id=NULL, updated_at=?
     WHERE id=? AND claimed_by IS NOT NULL`,
  );
  let write: Promise<AddCommentResult> | undefined;
  let comment: IssueComment | null = null;
  db.transaction(() => {
    if (release.run(now, issueId).changes !== 1) throw new ConflictError('未被占用');
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
  const issue = getIssue(db, id);
  if (!issue) throw new NotFoundError('任务不存在');
  if (issue.claimed_by !== null && patch.status !== undefined) {
    throw new ConflictError('占用中禁止修改状态');
  }
  return updateIssue(db, id, patch);
}
