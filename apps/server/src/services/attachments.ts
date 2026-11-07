import { randomUUID } from 'node:crypto';
import { unlinkSync } from 'node:fs';
import { mkdir, unlink, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
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
  type AttachmentKind,
  type AttachmentRecord,
} from '../db/repos/attachment.js';
import { ApiError, NotFoundError } from '../errors.js';

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
  mime_type: string;
  kind: AttachmentKind;
  size_bytes: number;
  status: 'staged';
  expires_at: number;
  download_url: string;
}

/** D7：图片白名单三 MIME——声明白名单内走签名校验并落 kind='image'，其余 MIME 不校验签名落 kind='file' */
type ImageMime = 'image/png' | 'image/jpeg' | 'image/webp';

const signatures: Record<ImageMime, (bytes: Buffer) => boolean> = {
  'image/png': (bytes) => bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])),
  'image/jpeg': (bytes) => bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff,
  'image/webp': (bytes) => bytes.length >= 12 && bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP',
};

/**
 * D7：下载建议（Content-Disposition）按 kind——image 内联展示，file 强制下载（防止 HTML/SVG 等
 * 在浏览器上下文内联执行）；文件名统一 RFC 5987 UTF-8 编码，兼容非 ASCII 名。
 */
export function attachmentContentDisposition(kind: AttachmentKind, fileName: string): string {
  return `${kind === 'image' ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(fileName)}`;
}

function safeFileName(value: string | undefined): string {
  const normalized = (value ?? 'image').replace(/[\x00-\x1f\x7f]/g, '').replace(/\\/g, '/');
  const base = normalized.split('/').filter(Boolean).at(-1) ?? 'image';
  return base.slice(0, 255) || 'image';
}

function isStorageKey(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

/**
 * STORE-4d：按库路由依赖（缺省未装配 = 单库行为——一切读写都在构造传入的库上，既有调用/测试不变）。
 * 装配后：workspace 维度操作落「工作区当前库」（未下沉回中心库），issue/session 维度按行探测定位所在库。
 */
export interface AttachmentDbRouting {
  /** workspace_id → 该工作区当前库；判定错误（LOCKED/MISSING/…）原样向上抛 */
  getDbForWorkspace: (workspaceId: string) => Db;
  /** 已下发工作区库清单（行探测 fan-out 与清理遍历用；单个打不开由实现方跳过） */
  listWorkspaceDbs: () => Db[];
}

export class AttachmentStore {
  private policy: AttachmentPolicy;
  private activeReservations = new Set<string>();
  private cleanupTimer: NodeJS.Timeout | undefined;
  private cleanupRunning = false;
  /** STORE-4d：按库懒创建缓存（db 路径 → 该库的附件目录），工作区库目录各自派生、按库隔离不串目录 */
  private readonly dirByDb = new Map<string, string>();

  constructor(
    private readonly db: Db,
    readonly storageDir: string,
    policy: AttachmentPolicy,
    private readonly routing?: AttachmentDbRouting,
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

  /** 单库模式：恒构造库；路由模式：workspace_id → 工作区当前库 */
  private dbForWorkspace(workspaceId: string): Db {
    if (this.routing === undefined) return this.db;
    return this.routing.getDbForWorkspace(workspaceId);
  }

  /** 已下发工作区库清单（清单失败按空处理，探测/清理不因清单查询失败而中断） */
  private workspaceDbs(): Db[] {
    if (this.routing === undefined) return [];
    try {
      return this.routing.listWorkspaceDbs();
    } catch {
      return [];
    }
  }

  /** 该库的附件目录：构造库用注入的 storageDir（含中心库目录覆写）；工作区库按 `dirname(db)/attachments` 派生并懒缓存 */
  private dirFor(db: Db): string {
    if (db === this.db) return this.storageDir;
    const key = db.name ?? '';
    const cached = this.dirByDb.get(key);
    if (cached !== undefined) return cached;
    const base = key === '' || key === ':memory:' ? process.cwd() : dirname(key);
    const dir = join(base, 'attachments');
    this.dirByDb.set(key, dir);
    return dir;
  }

  /**
   * STORE-4d：按行探测定位附件所在库——先构造库（中心库），再 fan-out 已下沉区
   * （附件 id 是 UUID，行在哪个库只能探测；非 NotFound 的探测错误（如过期 410）原样抛出）。
   */
  private locateDb(probe: (target: Db) => AttachmentRecord): { db: Db; row: AttachmentRecord } {
    try {
      return { db: this.db, row: probe(this.db) };
    } catch (error) {
      if (!(error instanceof NotFoundError)) throw error;
    }
    let lastError: unknown = null;
    for (const wsDb of this.workspaceDbs()) {
      try {
        return { db: wsDb, row: probe(wsDb) };
      } catch (error) {
        if (error instanceof NotFoundError) continue;
        lastError = error;
      }
    }
    if (lastError !== null) throw lastError;
    throw new NotFoundError('图片不存在');
  }

  async upload(workspaceId: string, declaredMime: string, filename: string | undefined, bytes: Buffer): Promise<StagedAttachment> {
    const mimeType = declaredMime.split(';', 1)[0]!.trim().toLowerCase();
    // D7：声明白名单内的三图片 MIME 仍做签名校验（kind='image'）；其余任意 MIME 不校验签名
    //（kind='file'）——两类同样受 10 MiB 上限与工作区配额约束
    const isImage = Object.hasOwn(signatures, mimeType);
    if (isImage && !signatures[mimeType as ImageMime](bytes)) {
      throw new ApiError(400, 'ATTACHMENT_INVALID_IMAGE', '图片格式与文件签名不匹配');
    }
    if (bytes.length > MAX_IMAGE_BYTES) {
      throw new ApiError(413, 'ATTACHMENT_TOO_LARGE', '单个附件不能超过 10 MiB');
    }
    // STORE-4d：行与文件都落「工作区当前库」（未下沉回中心库，行为与切库前一致）
    const db = this.dbForWorkspace(workspaceId);
    const storageDir = this.dirFor(db);
    const id = randomUUID();
    const storageKey = randomUUID();
    const now = Date.now();
    reserveAttachmentUpload(db, storageKey, bytes.length, this.policy.attachmentQuotaBytes, now);
    this.activeReservations.add(storageKey);
    try {
      await mkdir(storageDir, { recursive: true });
      await writeFile(join(storageDir, storageKey), bytes, { flag: 'wx' });
    } catch (error) {
      if (await this.removeFile(storageDir, storageKey)) releaseAttachmentReservation(db, storageKey);
      throw error;
    } finally {
      this.activeReservations.delete(storageKey);
    }
    const row: AttachmentRecord = {
      id,
      workspace_id: workspaceId,
      storage_key: storageKey,
      file_name: safeFileName(filename),
      mime_type: mimeType,
      kind: isImage ? 'image' : 'file',
      size_bytes: bytes.length,
      status: 'staged',
      created_at: now,
      expires_at: now + this.policy.attachmentStagedTtlMs,
    };
    finishAttachmentUpload(db, row);
    return {
      id,
      workspace_id: workspaceId,
      file_name: row.file_name,
      mime_type: row.mime_type,
      kind: row.kind,
      size_bytes: row.size_bytes,
      status: 'staged',
      expires_at: row.expires_at,
      download_url: `/api/workspaces/${workspaceId}/attachments/${id}`,
    };
  }

  stagedPath(workspaceId: string, id: string): string {
    const db = this.dbForWorkspace(workspaceId);
    return this.storagePathFor(db, getStagedAttachment(db, workspaceId, id).storage_key);
  }

  issuePath(issueId: string, id: string): string {
    const { db, row } = this.locateDb((target) => getIssueAttachment(target, issueId, id));
    return this.storagePathFor(db, row.storage_key);
  }

  /** CHAT-IMG-DELIVERY：会话级附件（绑定到聊天会话后投递用） */
  sessionPath(sessionId: string, id: string): string {
    const { db, row } = this.locateDb((target) => getSessionAttachment(target, sessionId, id));
    return this.storagePathFor(db, row.storage_key);
  }

  sessionMime(sessionId: string, id: string): string {
    return this.locateDb((target) => getSessionAttachment(target, sessionId, id)).row.mime_type;
  }

  /** CHAT-IMG-DELIVERY：workspace 内读取（staged/attached 均可）——聊天 markdown URL 绑定后仍能显示 */
  workspacePath(workspaceId: string, id: string): string {
    const db = this.dbForWorkspace(workspaceId);
    return this.storagePathFor(db, getWorkspaceAttachment(db, workspaceId, id).storage_key);
  }

  workspaceMime(workspaceId: string, id: string): string {
    return getWorkspaceAttachment(this.dbForWorkspace(workspaceId), workspaceId, id).mime_type;
  }

  workspaceName(workspaceId: string, id: string): string {
    return getWorkspaceAttachment(this.dbForWorkspace(workspaceId), workspaceId, id).file_name;
  }

  /** CHAT-ATTACH-ANY：非图片附件投递时把体积写进 prompt 元数据 */
  workspaceSize(workspaceId: string, id: string): number {
    return getWorkspaceAttachment(this.dbForWorkspace(workspaceId), workspaceId, id).size_bytes;
  }

  /** D7：下载端点按 kind 决定 Content-Disposition（image→inline，file→attachment） */
  workspaceKind(workspaceId: string, id: string): AttachmentKind {
    return getWorkspaceAttachment(this.dbForWorkspace(workspaceId), workspaceId, id).kind;
  }

  stagedMime(workspaceId: string, id: string): string {
    return getStagedAttachment(this.dbForWorkspace(workspaceId), workspaceId, id).mime_type;
  }

  stagedName(workspaceId: string, id: string): string {
    return getStagedAttachment(this.dbForWorkspace(workspaceId), workspaceId, id).file_name;
  }

  issueMime(issueId: string, id: string): string {
    return this.locateDb((target) => getIssueAttachment(target, issueId, id)).row.mime_type;
  }

  issueName(issueId: string, id: string): string {
    return this.locateDb((target) => getIssueAttachment(target, issueId, id)).row.file_name;
  }

  /** D7：issue 级下载端点同 workspace 端点按 kind 决定 Content-Disposition */
  issueKind(issueId: string, id: string): AttachmentKind {
    return this.locateDb((target) => getIssueAttachment(target, issueId, id)).row.kind;
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
      // STORE-4d：清理遍历构造库（中心库）+ 全部已下发工作区库；单库失败留待下轮，不阻断其余库
      for (const db of [this.db, ...this.workspaceDbs()]) {
        try {
          this.cleanupDb(db, this.dirFor(db), now);
        } catch {
          console.error('[agentboard] 图片清理延后，待清理记录保留');
        }
      }
    } finally {
      this.cleanupRunning = false;
    }
  }

  /** 单库清理：过期 staged 行 + 待删文件记录 + 陈旧预留（原 processCleanup 主体，按库执行） */
  private cleanupDb(db: Db, storageDir: string, now: number): void {
    deleteExpiredStagedAttachments(db, now);
    for (const row of listAttachmentCleanup(db)) {
      db.transaction(() => {
        if (!db.prepare('SELECT 1 FROM attachment_cleanup WHERE storage_key=?').get(row.storage_key)) return;
        if (db.prepare('SELECT 1 FROM attachment WHERE storage_key=?').get(row.storage_key)) return;
        if (this.removeFileSync(storageDir, row.storage_key)) deleteAttachmentCleanup(db, row.storage_key);
      }).immediate();
    }
    const staleBefore = now - Math.max(this.policy.attachmentCleanupIntervalMs, 60 * 60 * 1000);
    for (const row of listStaleAttachmentReservations(db, staleBefore)) {
      if (this.activeReservations.has(row.storage_key)) continue;
      db.transaction(() => {
        if (!db.prepare('SELECT 1 FROM attachment_upload_reservation WHERE storage_key=?').get(row.storage_key)) return;
        if (db.prepare('SELECT 1 FROM attachment WHERE storage_key=?').get(row.storage_key)) {
          deleteAttachmentReservation(db, row.storage_key);
          return;
        }
        if (this.removeFileSync(storageDir, row.storage_key)) deleteAttachmentReservation(db, row.storage_key);
      }).immediate();
    }
  }

  private runCleanup(): void {
    void this.processCleanup();
  }

  private storagePathFor(db: Db, storageKey: string): string {
    if (!isStorageKey(storageKey)) throw new ApiError(500, 'ATTACHMENT_STORAGE_INVALID', '图片存储记录无效');
    return join(this.dirFor(db), storageKey);
  }

  private async removeFile(storageDir: string, storageKey: string): Promise<boolean> {
    try {
      await unlink(join(storageDir, storageKey));
      return true;
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === 'ENOENT';
    }
  }

  private removeFileSync(storageDir: string, storageKey: string): boolean {
    try {
      unlinkSync(join(storageDir, storageKey));
      return true;
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === 'ENOENT';
    }
  }
}
