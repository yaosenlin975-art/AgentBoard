import { randomUUID } from 'node:crypto';
import type { CommentAuthor, IssueComment } from '@agentboard/shared';
import type { Db } from '../connection.js';
import type { PageResult } from '@agentboard/shared';
import { pageResult, textWindow, validatePage } from '../pagination.js';
import { ApiError } from '../../errors.js';
import { bindCommentAttachments, commentAttachmentsByComment } from './attachment.js';

export interface AddCommentInput {
  issue_id: string;
  author: CommentAuthor;
  content: string;
}

export function addComment(db: Db, input: AddCommentInput): IssueComment {
  const comment: IssueComment = {
    id: randomUUID(),
    issue_id: input.issue_id,
    author: input.author,
    content: input.content,
    ts: Date.now(),
  };
  db.prepare('INSERT INTO issue_comment (id, issue_id, author, content, ts) VALUES (?, ?, ?, ?, ?)').run(
    comment.id,
    comment.issue_id,
    comment.author,
    comment.content,
    comment.ts,
  );
  return comment;
}

export function listCommentsByIssue(db: Db, issueId: string): IssueComment[] {
  const rows = db
    .prepare('SELECT * FROM issue_comment WHERE issue_id = ? ORDER BY ts, id')
    .all(issueId) as IssueComment[];
  // CR2-4：附件一次批量装配（原逐条 commentAttachments 随评论数线性增加查询）
  const attachmentsByComment = commentAttachmentsByComment(db, issueId);
  return rows.map((row) => {
    const attachments = attachmentsByComment.get(row.id);
    return attachments === undefined ? row : { ...row, attachments };
  });
}
export function listCommentsPage(db: Db, issueId: string, input: { limit: number; offset: number }): PageResult<{ id: string; author: string; ts: number; snippet: string; has_more: boolean; attachments?: import('@agentboard/shared').AttachmentMetadata[] }> {
  validatePage(input.limit, input.offset);
  const rows = db.prepare('SELECT * FROM issue_comment WHERE issue_id=? ORDER BY id ASC LIMIT ? OFFSET ?').all(issueId, input.limit + 1, input.offset) as IssueComment[];
  // CR2-4：同一批附件查询复用，避免每行一次 commentAttachments
  const attachmentsByComment = commentAttachmentsByComment(db, issueId);
  return pageResult(rows.map(row => { const window = textWindow(row.content, 0, 500); const attachments = attachmentsByComment.get(row.id) ?? []; return { id: row.id, author: row.author, ts: row.ts, snippet: window.content, has_more: window.truncated, ...(attachments.length ? { attachments } : {}) }; }), input.limit, input.offset);
}
export function getCommentContent(db: Db, issueId: string, commentId: string, offsetChars = 0, maxChars = 12000) {
  const comment = db.prepare('SELECT * FROM issue_comment WHERE id=? AND issue_id=?').get(commentId, issueId) as IssueComment | undefined;
  if (!comment) throw new ApiError(404, 'COMMENT_NOT_FOUND', '评论不存在');
  return { ...bindCommentAttachments(db, issueId, comment), ...textWindow(comment.content, offsetChars, maxChars) };
}
