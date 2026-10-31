import type { CommentAuthor, IssueComment } from '@agentboard/shared';
import type { Db } from '../db/connection.js';
import { addComment as insertCommentRow } from '../db/repos/comment.js';
import { getIssue } from '../db/repos/issue.js';
import { NotFoundError } from '../errors.js';
import type { SessionSender } from './sessionManager.js';

/** Task 9 装配真实 sendToSession 前的默认 sender：任何唤醒尝试显式失败 */
const unassembledSender: SessionSender = async () => {
  throw new Error('sessionManager 未装配');
};

let sessionSender: SessionSender = unassembledSender;

/** Task 9 装配真实 sessionManager.sendToSession；测试注入 stub */
export function setSessionSender(sender: SessionSender): void {
  sessionSender = sender;
}

/** 恢复默认未装配状态（测试隔离用） */
export function resetSessionSender(): void {
  sessionSender = unassembledSender;
}

export interface AddCommentResult {
  comment: IssueComment;
  /** 唤醒调用是否成功返回；true 同时涵盖空闲起轮与运行中入队（queued 语义由 sender 承载） */
  woke: boolean;
}

/**
 * 评论单一入口（设计 §5.8）：事务内插入 issue_comment 并触碰 issue.updated_at；
 * author='user' 且 issue 占用中（claimed_by 与 session_id 均非空）→ 调 sender 唤醒占用 agent。
 * sender 抛错时评论已落库、占用不变，错误向上抛。
 *
 * 所有 DB 操作在任何 await 之前同步完成，因此可安全嵌套在外层同步事务内
 * （claim.ts 的 done/fail/release 依赖此性质保持"状态流转 + 评论"原子性）。
 */
export async function addComment(
  db: Db,
  issueId: string,
  author: CommentAuthor,
  content: string,
): Promise<AddCommentResult> {
  let comment: IssueComment | undefined;
  let wakeSessionId: string | null = null;
  db.transaction(() => {
    const issue = getIssue(db, issueId);
    if (!issue) throw new NotFoundError('任务不存在');
    comment = insertCommentRow(db, { issue_id: issueId, author, content });
    db.prepare('UPDATE issue SET updated_at = ? WHERE id = ?').run(Date.now(), issueId);
    if (author === 'user' && issue.claimed_by !== null && issue.session_id !== null) {
      wakeSessionId = issue.session_id;
    }
  })();

  if (wakeSessionId === null) {
    return { comment: comment!, woke: false };
  }

  await sessionSender(wakeSessionId, content);
  return { comment: comment!, woke: true };
}
