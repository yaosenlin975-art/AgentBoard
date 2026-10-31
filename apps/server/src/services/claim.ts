import type { Issue } from '@agentboard/shared';
import type { Db } from '../db/connection.js';
import { addComment } from '../db/repos/comment.js';
import { getIssue, updateIssue, type IssuePatch } from '../db/repos/issue.js';
import { ConflictError, NotFoundError, ValidationError } from '../errors.js';

/** 原子领取：并发领取仅一个成功；允许从"进行中"领取（覆盖用户手动拖到进行中后再派发） */
export function claimIssue(db: Db, issueId: string, agentId: string, sessionId: string): Issue {
  const row = db.prepare(
    `UPDATE issue SET claimed_by=?, claimed_at=?, session_id=?, status='进行中', updated_at=?
     WHERE id=? AND claimed_by IS NULL AND status IN ('待规划','进行中')`
  ).run(agentId, Date.now(), sessionId, Date.now(), issueId);
  if (row.changes !== 1) throw new ConflictError('已被占用');
  return getIssue(db, issueId)!;
}

/** 完成：待验收 + 释放占用；notes 非空时落 issue_comment(author=agent:<id>) */
export function doneIssue(db: Db, issueId: string, agentId: string, notes?: string): Issue {
  const issue = getIssue(db, issueId);
  if (!issue) throw new NotFoundError('任务不存在');
  if (issue.claimed_by === null) throw new ConflictError('未被占用');
  const now = Date.now();
  const release = db.prepare(
    `UPDATE issue SET status='待验收', claimed_by=NULL, claimed_at=NULL, session_id=NULL, updated_at=?
     WHERE id=? AND claimed_by IS NOT NULL`,
  );
  const writeNote = notes !== undefined && notes.trim() !== '';
  db.transaction(() => {
    if (release.run(now, issueId).changes !== 1) throw new ConflictError('未被占用');
    if (writeNote) {
      addComment(db, { issue_id: issueId, author: `agent:${agentId}`, content: notes });
    }
  })();
  return getIssue(db, issueId)!;
}

/** 失败回报：回待规划 + 释放占用；reason 必填落 issue_comment(author=agent:<id>) */
export function failIssue(db: Db, issueId: string, agentId: string, reason: string): Issue {
  if (reason === undefined || reason === null || reason.trim() === '') {
    throw new ValidationError('失败原因不能为空');
  }
  const issue = getIssue(db, issueId);
  if (!issue) throw new NotFoundError('任务不存在');
  if (issue.claimed_by === null) throw new ConflictError('未被占用');
  const now = Date.now();
  const release = db.prepare(
    `UPDATE issue SET status='待规划', claimed_by=NULL, claimed_at=NULL, session_id=NULL, updated_at=?
     WHERE id=? AND claimed_by IS NOT NULL`,
  );
  db.transaction(() => {
    if (release.run(now, issueId).changes !== 1) throw new ConflictError('未被占用');
    addComment(db, { issue_id: issueId, author: `agent:${agentId}`, content: reason });
  })();
  return getIssue(db, issueId)!;
}

/** 用户强制释放：回待规划 + 清空占用 + system 评论 */
export function releaseIssue(db: Db, issueId: string): Issue {
  const issue = getIssue(db, issueId);
  if (!issue) throw new NotFoundError('任务不存在');
  const now = Date.now();
  db.transaction(() => {
    db.prepare(
      `UPDATE issue SET status='待规划', claimed_by=NULL, claimed_at=NULL, session_id=NULL, updated_at=?
       WHERE id=?`,
    ).run(now, issueId);
    addComment(db, { issue_id: issueId, author: 'system', content: '用户强制释放' });
  })();
  return getIssue(db, issueId)!;
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
