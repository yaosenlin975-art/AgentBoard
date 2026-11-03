/**
 * KB-IMG-1：知识页图片的存储与限额（设计 §3/§4）。
 *
 * - 目录：`dirname(db)/attachments/knowledge/<pageId>/<attachmentId>.<ext>`（沿用 DOCKER-2 的派生约定，容器只挂 /data）。
 * - 限额：单张 ≤ 5 MiB（413 `IMAGE_TOO_LARGE`）、每页 ≤ 20 张（409 `IMAGE_LIMIT_EXCEEDED`）、
 *   每页合计 ≤ 50 MiB（409 `IMAGE_LIMIT_EXCEEDED`）、类型白名单 png/jpeg/webp/gif 按签名判（415 `IMAGE_TYPE_UNSUPPORTED`）。
 * - `storage_key` 只由服务端生成，不用客户端文件名（防路径穿越）。
 * - 删除页面时行被 CASCADE 删除；文件由 `removePageFiles` / `sweepOrphans` 回收。
 */
import { randomUUID } from 'node:crypto';
import { promises as nodeFs } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import type { Db } from '../db/connection.js';
import { ApiError, NotFoundError, ValidationError } from '../errors.js';
import { extensionOf, readImageSize, sniffImageMime, type KnowledgeImageMime } from './imageInfo.js';

export const KNOWLEDGE_IMAGE_MAX_BYTES = 5 * 1024 * 1024;
export const KNOWLEDGE_IMAGE_MAX_PER_PAGE = 20;
export const KNOWLEDGE_IMAGE_MAX_PAGE_TOTAL_BYTES = 50 * 1024 * 1024;

export interface KnowledgeAttachmentRow {
  id: string;
  page_id: string;
  storage_key: string;
  mime: KnowledgeImageMime;
  bytes: number;
  width: number | null;
  height: number | null;
  original_bytes: number | null;
  created_by: string;
  created_at: number;
}

export interface KnowledgeImageStoreDeps {
  db: Db;
  /** 附件根目录；缺省用 `dirname(db.name)/attachments/knowledge` */
  storageRoot?: string;
  now?: () => number;
}

/**
 * 附件根目录：`<db 目录>/attachments`。
 * 知识页图片的 `storage_key` 自带 `knowledge/<pageId>/<id>.<ext>` 前缀，绝对路径 = join(root, storage_key)。
 */
export function knowledgeAttachmentsRoot(db: Db, override?: string): string {
  if (override !== undefined) return override;
  const dbPath = (db as unknown as { name?: string }).name ?? '';
  const base = dbPath === '' || dbPath === ':memory:' ? process.cwd() : dirname(dbPath);
  return join(base, 'attachments');
}

/** 知识页图片的子目录（root/knowledge） */
export const knowledgeImagesSubdir = (root: string): string => join(root, 'knowledge');

const absPath = (root: string, storageKey: string): string => {
  const target = resolve(root, storageKey);
  const inside = relative(resolve(root), target);
  if (inside.startsWith('..') || inside.startsWith(`..${sep}`) || inside.includes(`..${sep}`)) {
    throw new ValidationError('附件路径不合法');
  }
  return target;
};

export interface SaveKnowledgeImageInput {
  page_id: string;
  bytes: Buffer;
  /** 客户端声明的类型只作提示，最终以签名判定 */
  declared_mime?: string | null;
  /** 客户端压缩前的原始大小（可空） */
  original_bytes?: number | null;
  created_by: string;
}

export interface SaveKnowledgeImageResult {
  id: string;
  url: string;
  bytes: number;
  width: number | null;
  height: number | null;
  mime: KnowledgeImageMime;
}

export interface KnowledgeImageStore {
  root: string;
  save(input: SaveKnowledgeImageInput): Promise<SaveKnowledgeImageResult>;
  /** 读行 + 绝对路径；不存在 → null */
  locate(attachmentId: string): { row: KnowledgeAttachmentRow; path: string } | null;
  remove(attachmentId: string): Promise<void>;
  /** 删除某页的全部文件（页面被删后调用） */
  removePageFiles(pageId: string): Promise<void>;
  /** 扫描目录，删除没有对应行的孤儿文件；返回删除数 */
  sweepOrphans(): Promise<number>;
}

export function createKnowledgeImageStore(deps: KnowledgeImageStoreDeps): KnowledgeImageStore {
  const db = deps.db;
  const root = knowledgeAttachmentsRoot(db, deps.storageRoot);
  const now = deps.now ?? (() => Date.now());

  const pageUsage = (pageId: string): { count: number; bytes: number } => {
    const row = db.prepare('SELECT COUNT(*) AS n, COALESCE(SUM(bytes), 0) AS total FROM knowledge_attachment WHERE page_id=?')
      .get(pageId) as { n: number; total: number };
    return { count: row.n, bytes: row.total };
  };

  return {
    root,

    async save(input) {
      const mime = sniffImageMime(input.bytes);
      if (mime === null) {
        throw new ApiError(415, 'IMAGE_TYPE_UNSUPPORTED', '只支持 PNG / JPEG / WebP / GIF 图片（按文件签名判定）');
      }
      if (input.bytes.length > KNOWLEDGE_IMAGE_MAX_BYTES) {
        throw new ApiError(413, 'IMAGE_TOO_LARGE', `单张图片不能超过 ${KNOWLEDGE_IMAGE_MAX_BYTES / (1024 * 1024)} MiB`);
      }
      const usage = pageUsage(input.page_id);
      if (usage.count >= KNOWLEDGE_IMAGE_MAX_PER_PAGE) {
        throw new ApiError(409, 'IMAGE_LIMIT_EXCEEDED', `每个知识页最多 ${KNOWLEDGE_IMAGE_MAX_PER_PAGE} 张图片`);
      }
      if (usage.bytes + input.bytes.length > KNOWLEDGE_IMAGE_MAX_PAGE_TOTAL_BYTES) {
        throw new ApiError(409, 'IMAGE_LIMIT_EXCEEDED', `每个知识页图片总量不能超过 ${KNOWLEDGE_IMAGE_MAX_PAGE_TOTAL_BYTES / (1024 * 1024)} MiB`);
      }

      const pageExists = db.prepare('SELECT 1 FROM knowledge_page WHERE id=?').get(input.page_id);
      if (!pageExists) throw new NotFoundError('知识页不存在');

      const id = randomUUID();
      const storageKey = `knowledge/${input.page_id}/${id}.${extensionOf(mime)}`;
      const path = absPath(root, storageKey);
      await nodeFs.mkdir(dirname(path), { recursive: true });
      await nodeFs.writeFile(path, input.bytes, { flag: 'wx' });
      const size = readImageSize(input.bytes, mime);
      try {
        db.prepare(`INSERT INTO knowledge_attachment
          (id, page_id, storage_key, mime, bytes, width, height, original_bytes, created_by, created_at)
          VALUES (?,?,?,?,?,?,?,?,?,?)`).run(
          id, input.page_id, storageKey, mime, input.bytes.length,
          size?.width ?? null, size?.height ?? null, input.original_bytes ?? null, input.created_by, now(),
        );
      } catch (error) {
        await nodeFs.rm(path, { force: true });
        throw error;
      }
      return {
        id,
        url: `/api/knowledge/images/${id}`,
        bytes: input.bytes.length,
        width: size?.width ?? null,
        height: size?.height ?? null,
        mime,
      };
    },

    locate(attachmentId) {
      const row = db.prepare('SELECT * FROM knowledge_attachment WHERE id=?').get(attachmentId) as KnowledgeAttachmentRow | undefined;
      if (!row) return null;
      return { row, path: absPath(root, row.storage_key) };
    },

    async remove(attachmentId) {
      const found = this.locate(attachmentId);
      if (!found) throw new NotFoundError('图片不存在');
      db.prepare('DELETE FROM knowledge_attachment WHERE id=?').run(attachmentId);
      await nodeFs.rm(found.path, { force: true });
    },

    async removePageFiles(pageId) {
      await nodeFs.rm(join(knowledgeImagesSubdir(root), pageId), { recursive: true, force: true });
    },

    async sweepOrphans() {
      let removed = 0;
      const known = new Set((db.prepare('SELECT storage_key FROM knowledge_attachment').all() as Array<{ storage_key: string }>)
        .map(row => resolve(root, row.storage_key)));
      const walk = async (dir: string): Promise<void> => {
        let entries;
        try { entries = await nodeFs.readdir(dir, { withFileTypes: true }); } catch { return; }
        for (const entry of entries) {
          const path = join(dir, entry.name);
          if (entry.isDirectory()) await walk(path);
          else if (entry.isFile() && !known.has(resolve(root, path))) {
            await nodeFs.rm(path, { force: true });
            removed += 1;
          }
        }
      };
      await walk(knowledgeImagesSubdir(root));
      return removed;
    },
  };
}
