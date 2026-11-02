import type { AttachmentMetadata, CommentAttachmentRecord, DispatchAttachmentCandidate, PageResult } from '@agentboard/shared';
import type { Db } from '../connection.js';
import { ApiError, NotFoundError, ValidationError } from '../../errors.js';
import { pageResult, textWindow, validatePage } from '../pagination.js';

export interface AttachmentRecord {
  id: string;
  workspace_id: string;
  storage_key: string;
  file_name: string;
  mime_type: 'image/png' | 'image/jpeg' | 'image/webp';
  size_bytes: number;
  status: 'staged' | 'attached';
  created_at: number;
  expires_at: number;
}

export interface CleanupRecord { storage_key: string; size_bytes: number }
export interface DispatchAttachmentRecord extends AttachmentRecord {
  comment_id: string;
  author: string;
  ts: number;
  snippet: string;
  delivery_state: 'pending' | 'sending' | 'unknown' | 'delivered';
}

export function reserveAttachmentUpload(db: Db, storageKey: string, sizeBytes: number, quotaBytes: number, now: number): void {
  db.transaction(() => {
    const row = db.prepare(`SELECT
      COALESCE((SELECT SUM(size_bytes) FROM attachment),0) +
      COALESCE((SELECT SUM(size_bytes) FROM attachment_cleanup),0) +
      COALESCE((SELECT SUM(size_bytes) FROM attachment_upload_reservation),0) AS used`).get() as { used: number };
    if (row.used + sizeBytes > quotaBytes) throw new ApiError(413, 'ATTACHMENT_QUOTA_EXCEEDED', '图片存储空间已满');
    db.prepare('INSERT INTO attachment_upload_reservation(storage_key,size_bytes,created_at) VALUES (?,?,?)')
      .run(storageKey, sizeBytes, now);
  }).immediate();
}

export function finishAttachmentUpload(db: Db, input: AttachmentRecord): void {
  db.transaction(() => {
    db.prepare(`INSERT INTO attachment(id,workspace_id,storage_key,file_name,mime_type,size_bytes,status,created_at,expires_at)
      VALUES (@id,@workspace_id,@storage_key,@file_name,@mime_type,@size_bytes,'staged',@created_at,@expires_at)`).run(input);
    db.prepare('DELETE FROM attachment_upload_reservation WHERE storage_key=?').run(input.storage_key);
  }).immediate();
}

export function releaseAttachmentReservation(db: Db, storageKey: string): void {
  db.prepare('DELETE FROM attachment_upload_reservation WHERE storage_key=?').run(storageKey);
}

export function getStagedAttachment(db: Db, workspaceId: string, id: string): AttachmentRecord {
  const row = db.prepare(`SELECT * FROM attachment WHERE id=? AND workspace_id=? AND status='staged'`).get(id, workspaceId) as AttachmentRecord | undefined;
  if (!row) throw new NotFoundError('图片不存在');
  if (row.expires_at <= Date.now()) throw new ApiError(410, 'ATTACHMENT_EXPIRED', '图片暂存已过期，请重新上传');
  return row;
}

export function getIssueAttachment(db: Db, issueId: string, id: string): AttachmentRecord {
  const row = db.prepare(`SELECT a.* FROM attachment a JOIN comment_attachment ca ON ca.attachment_id=a.id
    JOIN issue_comment c ON c.id=ca.comment_id WHERE c.issue_id=? AND a.id=? AND a.status='attached'`).get(issueId, id) as AttachmentRecord | undefined;
  if (!row) throw new NotFoundError('图片不存在');
  return row;
}

export function bindAttachmentsToComment(db: Db, workspaceId: string, commentId: string, ids: string[], now: number): void {
  if (ids.length === 0) return;
  const placeholders = ids.map(() => '?').join(',');
  const rows = db.prepare(`SELECT * FROM attachment WHERE id IN (${placeholders})`).all(...ids) as AttachmentRecord[];
  if (rows.length !== ids.length || rows.some((row) => row.workspace_id !== workspaceId)) {
    throw new NotFoundError('图片不存在');
  }
  if (rows.some((row) => row.status !== 'staged')) {
    throw new ApiError(409, 'ATTACHMENT_ALREADY_BOUND', '图片已关联到其他评论');
  }
  if (rows.some((row) => row.expires_at <= now)) {
    throw new ApiError(410, 'ATTACHMENT_EXPIRED', '图片暂存已过期，请重新上传');
  }
  const insert = db.prepare('INSERT INTO comment_attachment(comment_id,attachment_id,position) VALUES (?,?,?)');
  const update = db.prepare("UPDATE attachment SET status='attached' WHERE id=? AND status='staged'");
  const byId = new Map(rows.map((row) => [row.id, row]));
  for (const [position, id] of ids.entries()) {
    const row = byId.get(id)!;
    insert.run(commentId, row.id, position);
    if (update.run(row.id).changes !== 1) throw new ApiError(409, 'ATTACHMENT_ALREADY_BOUND', '图片已关联到其他评论');
  }
}

export function commentAttachments(db: Db, issueId: string, commentId: string): AttachmentMetadata[] {
  const rows = db.prepare(`SELECT a.id,a.file_name,a.mime_type,a.size_bytes,ca.delivery_state FROM attachment a
    JOIN comment_attachment ca ON ca.attachment_id=a.id JOIN issue_comment c ON c.id=ca.comment_id
    WHERE c.issue_id=? AND c.id=? ORDER BY ca.position`).all(issueId, commentId) as CommentAttachmentRecord[];
  return rows.map((row) => ({
    id: row.id,
    file_name: row.file_name,
    mime_type: row.mime_type,
    size_bytes: row.size_bytes,
    url: `/api/issues/${issueId}/attachments/${row.id}`,
    delivery_state: row.delivery_state,
  }));
}

export function hasUndeliveredCommentAttachments(db: Db, issueId: string, commentId: string): boolean {
  return Boolean(db.prepare(`SELECT 1 FROM comment_attachment ca
    JOIN issue_comment c ON c.id=ca.comment_id
    WHERE c.issue_id=? AND c.id=? AND ca.delivered_at IS NULL LIMIT 1`).get(issueId, commentId));
}

export function listPendingIssueAttachments(db: Db, issueId: string, input: { limit: number; offset: number }): PageResult<DispatchAttachmentCandidate> {
  validatePage(input.limit, input.offset);
  const rows = db.prepare(`SELECT a.id,a.file_name,a.mime_type,a.size_bytes,c.id AS comment_id,c.author,c.ts,
      substr(c.content,1,501) AS snippet_raw,ca.delivery_state
    FROM attachment a JOIN comment_attachment ca ON ca.attachment_id=a.id
    JOIN issue_comment c ON c.id=ca.comment_id
    WHERE c.issue_id=? AND a.status='attached' AND ca.delivered_at IS NULL AND ca.delivery_state IN ('pending','unknown')
    ORDER BY c.ts,c.id,ca.position,a.id LIMIT ? OFFSET ?`).all(issueId, input.limit + 1, input.offset) as Array<{
      id: string; file_name: string; mime_type: AttachmentMetadata['mime_type']; size_bytes: number;
      comment_id: string; author: string; ts: number; snippet_raw: string; delivery_state: 'pending' | 'unknown';
    }>;
  const candidates = rows.map((row): DispatchAttachmentCandidate => ({
    id: row.id, file_name: row.file_name, mime_type: row.mime_type, size_bytes: row.size_bytes,
    comment_id: row.comment_id, author: row.author, ts: row.ts,
    snippet: textWindow(row.snippet_raw, 0, 500).content,
    delivery_state: row.delivery_state,
  }));
  return pageResult(candidates, input.limit, input.offset);
}

export function countPendingIssueAttachments(db: Db, issueId: string): number {
  const row = db.prepare(`SELECT COUNT(*) AS count
    FROM attachment a JOIN comment_attachment ca ON ca.attachment_id=a.id
    JOIN issue_comment c ON c.id=ca.comment_id
    WHERE c.issue_id=? AND a.status='attached' AND ca.delivered_at IS NULL AND ca.delivery_state IN ('pending','unknown')`).get(issueId) as { count: number };
  return row.count;
}

export function getIssueDispatchAttachments(db: Db, issueId: string, attachmentIds: string[]): DispatchAttachmentRecord[] {
  if (attachmentIds.length === 0) return [];
  const placeholders = attachmentIds.map(() => '?').join(',');
  const rows = db.prepare(`SELECT a.*,c.id AS comment_id,c.author,c.ts,substr(c.content,1,501) AS snippet_raw,ca.delivery_state
    FROM attachment a JOIN comment_attachment ca ON ca.attachment_id=a.id
    JOIN issue_comment c ON c.id=ca.comment_id
    WHERE c.issue_id=? AND a.status='attached' AND a.id IN (${placeholders})
    ORDER BY c.ts,c.id,ca.position,a.id`).all(issueId, ...attachmentIds) as Array<
      AttachmentRecord & { comment_id: string; author: string; ts: number; snippet_raw: string; delivery_state: DispatchAttachmentRecord['delivery_state'] }
    >;
  if (rows.length !== attachmentIds.length) throw new NotFoundError('所选图片不存在');
  return rows.map(({ snippet_raw, ...row }) => ({ ...row, snippet: textWindow(snippet_raw, 0, 500).content }));
}

function markIssueAttachments(db: Db, issueId: string, attachmentIds: string[], fromStates: string[], toState: 'sending' | 'unknown' | 'delivered', at?: number): string[] {
  if (attachmentIds.length === 0) return [];
  const attachmentMarks = attachmentIds.map(() => '?').join(',');
  const stateMarks = fromStates.map(() => '?').join(',');
  return db.transaction(() => {
    const comments = db.prepare(`SELECT DISTINCT c.id FROM issue_comment c JOIN comment_attachment ca ON ca.comment_id=c.id
      WHERE c.issue_id=? AND ca.attachment_id IN (${attachmentMarks})`).all(issueId, ...attachmentIds) as Array<{ id: string }>;
    const query = toState === 'sending'
      ? `UPDATE comment_attachment SET delivery_state='sending',attempted_at=COALESCE(attempted_at,?)
         WHERE attachment_id IN (${attachmentMarks}) AND comment_id IN (SELECT id FROM issue_comment WHERE issue_id=?) AND delivery_state IN (${stateMarks})`
      : toState === 'delivered'
        ? `UPDATE comment_attachment SET delivered_at=COALESCE(delivered_at,?),delivery_state='delivered'
           WHERE attachment_id IN (${attachmentMarks}) AND comment_id IN (SELECT id FROM issue_comment WHERE issue_id=?) AND delivery_state IN (${stateMarks})`
        : `UPDATE comment_attachment SET delivery_state='unknown'
           WHERE attachment_id IN (${attachmentMarks}) AND comment_id IN (SELECT id FROM issue_comment WHERE issue_id=?) AND delivery_state IN (${stateMarks})`;
    const args = toState === 'sending' || toState === 'delivered'
      ? [at!, ...attachmentIds, issueId, ...fromStates]
      : [...attachmentIds, issueId, ...fromStates];
    db.prepare(query).run(...args);
    return comments.map((comment) => comment.id);
  }).immediate();
}

export function markIssueAttachmentsSending(
  db: Db,
  issueId: string,
  attachmentIds: string[],
  attemptedAt: number,
  retryUnknownAttachmentIds: string[] = [],
): string[] {
  if (attachmentIds.length === 0) return [];
  if (new Set(attachmentIds).size !== attachmentIds.length) {
    throw new ValidationError('IMAGE_ATTACHMENT_SELECTION_INVALID:所选图片不能重复');
  }
  const retryUnknownIds = new Set(retryUnknownAttachmentIds);
  if (retryUnknownAttachmentIds.some((id) => !attachmentIds.includes(id))) {
    throw new ValidationError('IMAGE_ATTACHMENT_SELECTION_INVALID:未知状态确认只能对应所选图片');
  }
  return db.transaction(() => {
    const placeholders = attachmentIds.map(() => '?').join(',');
    const rows = db.prepare(`SELECT a.id,a.status,ca.comment_id,ca.delivery_state,ca.delivered_at
      FROM attachment a JOIN comment_attachment ca ON ca.attachment_id=a.id
      JOIN issue_comment c ON c.id=ca.comment_id
      WHERE c.issue_id=? AND a.id IN (${placeholders})`).all(issueId, ...attachmentIds) as Array<{
        id: string;
        status: string;
        comment_id: string;
        delivery_state: 'pending' | 'sending' | 'unknown' | 'delivered';
        delivered_at: number | null;
      }>;
    if (rows.length !== attachmentIds.length) throw new NotFoundError('所选图片不存在');

    for (const row of rows) {
      if (row.status !== 'attached' || row.delivered_at !== null || row.delivery_state === 'delivered') {
        throw new ValidationError('IMAGE_ATTACHMENT_NOT_PENDING:所选图片已交付或不可派发');
      }
      if (row.delivery_state === 'sending') {
        throw new ValidationError('IMAGE_DELIVERY_IN_PROGRESS:所选图片仍在投递');
      }
      if (row.delivery_state === 'unknown' && !retryUnknownIds.has(row.id)) {
        throw new ValidationError('IMAGE_DELIVERY_UNKNOWN_RETRY_REQUIRED:投递结果已变为未知，需重新确认');
      }
      if (row.delivery_state !== 'pending' && row.delivery_state !== 'unknown') {
        throw new ValidationError('IMAGE_ATTACHMENT_NOT_PENDING:所选图片当前不可派发');
      }
    }

    const update = db.prepare(`UPDATE comment_attachment SET delivery_state='sending',attempted_at=COALESCE(attempted_at,?)
      WHERE attachment_id=? AND comment_id=? AND delivery_state=? AND delivered_at IS NULL`);
    for (const row of rows) {
      if (update.run(attemptedAt, row.id, row.comment_id, row.delivery_state).changes !== 1) {
        throw new ValidationError('IMAGE_ATTACHMENT_NOT_PENDING:所选图片状态已变化');
      }
    }
    return [...new Set(rows.map((row) => row.comment_id))];
  }).immediate();
}

export function markIssueAttachmentsUnknown(db: Db, issueId: string, attachmentIds: string[]): string[] {
  return markIssueAttachments(db, issueId, attachmentIds, ['sending'], 'unknown');
}

export function markIssueAttachmentsDelivered(db: Db, issueId: string, attachmentIds: string[], deliveredAt: number): string[] {
  return markIssueAttachments(db, issueId, attachmentIds, ['sending'], 'delivered', deliveredAt);
}

export function bindCommentAttachments(db: Db, issueId: string, comment: { id: string; issue_id: string; author: string; content: string; ts: number }): typeof comment & { attachments?: AttachmentMetadata[] } {
  const attachments = commentAttachments(db, issueId, comment.id);
  return attachments.length > 0 ? { ...comment, attachments } : comment;
}

export function deleteExpiredStagedAttachments(db: Db, now: number): void {
  db.transaction(() => {
    db.prepare("DELETE FROM attachment WHERE status='staged' AND expires_at<=?").run(now);
  }).immediate();
}

export function listAttachmentCleanup(db: Db): CleanupRecord[] {
  return db.prepare('SELECT storage_key,size_bytes FROM attachment_cleanup ORDER BY queued_at,storage_key').all() as CleanupRecord[];
}

export function deleteAttachmentCleanup(db: Db, storageKey: string): void {
  db.prepare('DELETE FROM attachment_cleanup WHERE storage_key=?').run(storageKey);
}

export function listStaleAttachmentReservations(db: Db, olderThan: number): CleanupRecord[] {
  return db.prepare('SELECT storage_key,size_bytes FROM attachment_upload_reservation WHERE created_at<=?').all(olderThan) as CleanupRecord[];
}

export function deleteAttachmentReservation(db: Db, storageKey: string): void {
  db.prepare('DELETE FROM attachment_upload_reservation WHERE storage_key=?').run(storageKey);
}

