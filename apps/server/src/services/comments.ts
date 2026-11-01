import type { CommentAuthor, IssueComment } from '@agentboard/shared';
import type { Db } from '../db/connection.js';
import { addComment as insertCommentRow, listCommentsByIssue } from '../db/repos/comment.js';
import { getLastSeenCommentId, getIssue, setLastSeenCommentId } from '../db/repos/issue.js';
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

export interface ConsumeCommentsResult {
  comments: IssueComment[];
  /** 本次消费的新评论 id（时间序）；重复调用第二次必为空 */
  new_comment_ids: string[];
}

/**
 * 留言消费（kb 占用场景的恰好一次标注，§5.8）：事务内读全部评论、
 * 计算游标之后的评论 id（游标 NULL 视为全部待读）、推进游标到最后一条评论（无评论置 NULL）。
 * 不触碰 updated_at、不广播（内部游标状态，对其他端不可见）。
 */
export function consumeComments(db: Db, issueId: string): ConsumeCommentsResult {
  let comments: IssueComment[] = [];
  let newCommentIds: string[] = [];
  db.transaction(() => {
    if (!getIssue(db, issueId)) throw new NotFoundError('任务不存在');
    comments = listCommentsByIssue(db, issueId);
    const cursor = getLastSeenCommentId(db, issueId);
    const cursorIndex = cursor === null ? -1 : comments.findIndex((c) => c.id === cursor);
    newCommentIds =
      cursor === null || cursorIndex === -1
        ? comments.map((c) => c.id)
        : comments.slice(cursorIndex + 1).map((c) => c.id);
    setLastSeenCommentId(db, issueId, comments.length > 0 ? comments[comments.length - 1]!.id : null);
  })();
  return { comments, new_comment_ids: newCommentIds };
}
