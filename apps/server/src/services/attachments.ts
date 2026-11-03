import { randomUUID } from 'node:crypto';
import { unlinkSync } from 'node:fs';
import { mkdir, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Db } from '../db/connection.js';
import {
  deleteAttachmentCleanup,
  deleteAttachmentReservation,
  deleteExpiredStagedAttachments,
  finishAttachmentUpload,
  getIssueAttachment,
  getSessionAttachment,
  getStagedAttachment,
  getWorkspaceAttachment,
  listAttachmentCleanup,
  listStaleAttachmentReservations,
  releaseAttachmentReservation,
  reserveAttachmentUpload,
  type AttachmentRecord,
} from '../db/repos/attachment.js';
import { ApiError } from '../errors.js';

export const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
export const DEFAULT_ATTACHMENT_QUOTA_BYTES = 1024 * 1024 * 1024;
export const DEFAULT_ATTACHMENT_STAGED_TTL_MS = 24 * 60 * 60 * 1000;
export const DEFAULT_ATTACHMENT_CLEANUP_INTERVAL_MS = 60 * 60 * 1000;

export interface AttachmentPolicy {
  attachmentQuotaBytes: number;
  attachmentStagedTtlMs: number;
  attachmentCleanupIntervalMs: number;
}

export interface StagedAttachment {
  id: string;
  workspace_id: string;
  file_name: string;
  mime_type: AttachmentRecord['mime_type'];
  size_bytes: number;
  status: 'staged';
  expires_at: number;
  download_url: string;
}

const signatures: Record<AttachmentRecord['mime_type'], (bytes: Buffer) => boolean> = {
  'image/png': (bytes) => bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])),
  'image/jpeg': (bytes) => bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff,
  'image/webp': (bytes) => bytes.length >= 12 && bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP',
};

function safeFileName(value: string | undefined): string {
  const normalized = (value ?? 'image').replace(/[\x00-\x1f\x7f]/g, '').replace(/\\/g, '/');
  const base = normalized.split('/').filter(Boolean).at(-1) ?? 'image';
  return base.slice(0, 255) || 'image';
}

function isStorageKey(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

export class AttachmentStore {
  private policy: AttachmentPolicy;
  private activeReservations = new Set<string>();
  private cleanupTimer: NodeJS.Timeout | undefined;
  private cleanupRunning = false;

  constructor(
    private readonly db: Db,
    readonly storageDir: string,
    policy: AttachmentPolicy,
  ) {
    this.policy = { ...policy };
  }

  configure(policy: AttachmentPolicy): void {
    this.policy = { ...policy };
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = undefined;
      this.startCleanupWorker();
    }
  }

  async upload(workspaceId: string, declaredMime: string, filename: string | undefined, bytes: Buffer): Promise<StagedAttachment> {
    const mimeType = declaredMime.split(';', 1)[0]!.trim().toLowerCase();
    if (!Object.hasOwn(signatures, mimeType) || !signatures[mimeType as AttachmentRecord['mime_type']](bytes)) {
      throw new ApiError(400, 'ATTACHMENT_INVALID_IMAGE', '图片格式与文件签名不匹配');
    }
    if (bytes.length > MAX_IMAGE_BYTES) {
      throw new ApiError(413, 'ATTACHMENT_TOO_LARGE', '单张图片不能超过 10 MiB');
    }
    const id = randomUUID();
    const storageKey = randomUUID();
    const now = Date.now();
    reserveAttachmentUpload(this.db, storageKey, bytes.length, this.policy.attachmentQuotaBytes, now);
    this.activeReservations.add(storageKey);
    try {
      await mkdir(this.storageDir, { recursive: true });
      await writeFile(this.storagePath(storageKey), bytes, { flag: 'wx' });
    } catch (error) {
      if (await this.removeFile(storageKey)) releaseAttachmentReservation(this.db, storageKey);
      throw error;
    } finally {
      this.activeReservations.delete(storageKey);
    }
    const row: AttachmentRecord = {
      id,
      workspace_id: workspaceId,
      storage_key: storageKey,
      file_name: safeFileName(filename),
      mime_type: mimeType as AttachmentRecord['mime_type'],
      size_bytes: bytes.length,
      status: 'staged',
      created_at: now,
      expires_at: now + this.policy.attachmentStagedTtlMs,
    };
    finishAttachmentUpload(this.db, row);
    return {
      id,
      workspace_id: workspaceId,
      file_name: row.file_name,
      mime_type: row.mime_type,
      size_bytes: row.size_bytes,
      status: 'staged',
      expires_at: row.expires_at,
      download_url: `/api/workspaces/${workspaceId}/attachments/${id}`,
    };
  }

  stagedPath(workspaceId: string, id: string): string {
    return this.storagePath(getStagedAttachment(this.db, workspaceId, id).storage_key);
  }

  issuePath(issueId: string, id: string): string {
    return this.storagePath(getIssueAttachment(this.db, issueId, id).storage_key);
  }

  /** CHAT-IMG-DELIVERY：会话级附件（绑定到聊天会话后投递用） */
  sessionPath(sessionId: string, id: string): string {
    return this.storagePath(getSessionAttachment(this.db, sessionId, id).storage_key);
  }

  sessionMime(sessionId: string, id: string): string {
    return getSessionAttachment(this.db, sessionId, id).mime_type;
  }

  /** CHAT-IMG-DELIVERY：workspace 内读取（staged/attached 均可）——聊天 markdown URL 绑定后仍能显示 */
  workspacePath(workspaceId: string, id: string): string {
    return this.storagePath(getWorkspaceAttachment(this.db, workspaceId, id).storage_key);
  }

  workspaceMime(workspaceId: string, id: string): string {
    return getWorkspaceAttachment(this.db, workspaceId, id).mime_type;
  }

  workspaceName(workspaceId: string, id: string): string {
    return getWorkspaceAttachment(this.db, workspaceId, id).file_name;
  }

  stagedMime(workspaceId: string, id: string): string {
    return getStagedAttachment(this.db, workspaceId, id).mime_type;
  }

  stagedName(workspaceId: string, id: string): string {
    return getStagedAttachment(this.db, workspaceId, id).file_name;
  }

  issueMime(issueId: string, id: string): string {
    return getIssueAttachment(this.db, issueId, id).mime_type;
  }

  issueName(issueId: string, id: string): string {
    return getIssueAttachment(this.db, issueId, id).file_name;
  }

  startCleanupWorker(): void {
    if (this.cleanupTimer) return;
    this.runCleanup();
    this.cleanupTimer = setInterval(() => this.runCleanup(), this.policy.attachmentCleanupIntervalMs);
    this.cleanupTimer.unref();
  }

  async processCleanup(now = Date.now()): Promise<void> {
    if (this.cleanupRunning) return;
    this.cleanupRunning = true;
    try {
      deleteExpiredStagedAttachments(this.db, now);
      for (const row of listAttachmentCleanup(this.db)) {
        this.db.transaction(() => {
          if (!this.db.prepare('SELECT 1 FROM attachment_cleanup WHERE storage_key=?').get(row.storage_key)) return;
          if (this.db.prepare('SELECT 1 FROM attachment WHERE storage_key=?').get(row.storage_key)) return;
          if (this.removeFileSync(row.storage_key)) deleteAttachmentCleanup(this.db, row.storage_key);
        }).immediate();
      }
      const staleBefore = now - Math.max(this.policy.attachmentCleanupIntervalMs, 60 * 60 * 1000);
      for (const row of listStaleAttachmentReservations(this.db, staleBefore)) {
        if (this.activeReservations.has(row.storage_key)) continue;
        this.db.transaction(() => {
          if (!this.db.prepare('SELECT 1 FROM attachment_upload_reservation WHERE storage_key=?').get(row.storage_key)) return;
          if (this.db.prepare('SELECT 1 FROM attachment WHERE storage_key=?').get(row.storage_key)) {
            deleteAttachmentReservation(this.db, row.storage_key);
            return;
          }
          if (this.removeFileSync(row.storage_key)) deleteAttachmentReservation(this.db, row.storage_key);
        }).immediate();
      }
    } catch {
      console.error('[agentboard] 图片清理延后，待清理记录保留');
    } finally {
      this.cleanupRunning = false;
    }
  }

  private runCleanup(): void {
    void this.processCleanup();
  }

  private storagePath(storageKey: string): string {
    if (!isStorageKey(storageKey)) throw new ApiError(500, 'ATTACHMENT_STORAGE_INVALID', '图片存储记录无效');
    return join(this.storageDir, storageKey);
  }

  private async removeFile(storageKey: string): Promise<boolean> {
    try {
      await unlink(this.storagePath(storageKey));
      return true;
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === 'ENOENT';
    }
  }

  private removeFileSync(storageKey: string): boolean {
    try {
      unlinkSync(this.storagePath(storageKey));
      return true;
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === 'ENOENT';
    }
  }
}
