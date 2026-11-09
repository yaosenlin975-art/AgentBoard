import type { CommentAuthor, IssueComment } from '@agentboard/shared';
import type { Db } from '../db/connection.js';
import { addComment as insertCommentRow, listCommentsByIssue } from '../db/repos/comment.js';
import { getLastSeenCommentId, getIssue, setLastSeenCommentId } from '../db/repos/issue.js';
import { NotFoundError } from '../errors.js';
import { assertFenceCurrent } from './claim.js';
import { bindAttachmentsToComment, bindCommentAttachments, undeliveredCommentIds } from '../db/repos/attachment.js';
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
 * author='user'、无附件且 issue 占用中（claimed_by 与 session_id 均非空）→ 调 sender 唤醒占用 agent。
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
  const { comment, wakeSessionId } = storeComment(db, issueId, author, content);
  if (wakeSessionId === null) return { comment, woke: false };
  await wakeCommentSession(wakeSessionId, content);
  return { comment, woke: true };
}

export function wakeCommentSession(sessionId: string, content: string, delivery?: Parameters<SessionSender>[2]): Promise<unknown> {
  return delivery === undefined
    ? sessionSender(sessionId, content)
    : sessionSender(sessionId, content, delivery);
}
export function storeComment(db: Db, issueId: string, author: CommentAuthor, content: string, attachmentIds: string[] = [], fence?: number): { comment: IssueComment; wakeSessionId: string | null } {
  let comment: IssueComment | undefined;
  let wakeSessionId: string | null = null;
  db.transaction(() => {
    const issue = getIssue(db, issueId);
    if (!issue) throw new NotFoundError('任务不存在');
    // BORROW-0.3：fence 软校验（缺席放行）；断言先于任何写入，旧 fence 409 STALE_FENCE 零写入
    assertFenceCurrent(db, issueId, fence);
    const inserted = insertCommentRow(db, { issue_id: issueId, author, content });
    if (attachmentIds.length > 0) bindAttachmentsToComment(db, issue.workspace_id, inserted.id, attachmentIds, Date.now());
    comment = bindCommentAttachments(db, issueId, inserted);
    db.prepare('UPDATE issue SET updated_at = ? WHERE id = ?').run(Date.now(), issueId);
    if (author === 'user' && issue.claimed_by !== null && issue.session_id !== null) {
      wakeSessionId = issue.session_id;
    }
  }).immediate();

  return { comment: comment!, wakeSessionId };
}

export interface ConsumeCommentsResult {
  comments: IssueComment[];
  /** 当前可交付的新评论 id（遇到未验证图片时停在其前面） */
  new_comment_ids: string[];
}

/**
 * 留言消费（kb 占用场景的恰好一次标注，§5.8）：事务内读取评论并推进游标。
 * 含图片评论在图片交付能力验证前阻断游标前进，避免只传递文字后误标已读。
 */
export function consumeComments(db: Db, issueId: string): ConsumeCommentsResult {
  let comments: IssueComment[] = [];
  let newCommentIds: string[] = [];
  db.transaction(() => {
    if (!getIssue(db, issueId)) throw new NotFoundError('任务不存在');
    comments = listCommentsByIssue(db, issueId);
    const cursor = getLastSeenCommentId(db, issueId);
    const cursorIndex = cursor === null ? -1 : comments.findIndex((c) => c.id === cursor);
    const unread =
      cursor === null || cursorIndex === -1
        ? comments.map((c) => c.id)
        : comments.slice(cursorIndex + 1).map((c) => c.id);
    // CR2-4：未交付图片评论一次查全（原逐条 EXISTS 是 N+1）
    const pendingImages = undeliveredCommentIds(db, issueId);
    const firstPendingImage = comments.findIndex(
      (comment) => unread.includes(comment.id) && pendingImages.has(comment.id),
    );
    if (firstPendingImage >= 0) {
      const imageId = comments[firstPendingImage]!.id;
      const beforeImage = unread.indexOf(imageId);
      newCommentIds = unread.slice(0, beforeImage);
      setLastSeenCommentId(db, issueId, firstPendingImage > 0 ? comments[firstPendingImage - 1]!.id : null);
    } else {
      newCommentIds = unread;
      setLastSeenCommentId(db, issueId, unread.length > 0 ? unread[unread.length - 1]! : cursor);
    }
  })();
  return { comments, new_comment_ids: newCommentIds };
}
