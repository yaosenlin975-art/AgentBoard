import { randomUUID } from 'node:crypto';
import type { CommentAuthor, IssueComment } from '@agentboard/shared';
import type { Db } from '../connection.js';

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
  return db
    .prepare('SELECT * FROM issue_comment WHERE issue_id = ? ORDER BY ts, id')
    .all(issueId) as IssueComment[];
}
