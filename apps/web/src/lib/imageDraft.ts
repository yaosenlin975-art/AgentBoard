/**
 * 新建任务附图（NEW-ISSUE-IMAGE）：粘贴 / 拖拽 / 选择三条入口共用同一套格式、大小与数量判定。
 * 与评论图片流程（`components/detail/CommentThread.tsx`）保持同一规则：PNG/JPEG/WebP、单张 ≤10 MiB、每条最多 5 张。
 */
import type { AttachmentUploadResult } from '../api/client';

export type ImageMimeType = AttachmentUploadResult['mime_type'];

export const MAX_DRAFT_IMAGES = 5;
export const MAX_IMAGE_BYTES = 10 * 1024 * 1024;

const MIME_BY_EXTENSION: Record<string, ImageMimeType> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
};

/** 优先用浏览器给出的 MIME，缺失/伪装时按扩展名兜底；非图片返回 null */
export function getImageMimeType(file: File): ImageMimeType | null {
  if (file.type === 'image/png' || file.type === 'image/jpeg' || file.type === 'image/webp') return file.type;
  const extension = file.name.split('.').at(-1)?.toLowerCase();
  return extension ? MIME_BY_EXTENSION[extension] ?? null : null;
}

/** 剪贴板里的图片文件（截图粘贴走这条） */
export function filesFromClipboard(data: DataTransfer | null | undefined): File[] {
  if (!data) return [];
  return Array.from(data.items)
    .filter((item) => item.kind === 'file')
    .map((item) => item.getAsFile())
    .filter((file): file is File => file !== null);
}

/** 拖入的文件 */
export function filesFromDataTransfer(data: DataTransfer | null | undefined): File[] {
  if (!data || data.files === undefined) return [];
  return Array.from(data.files);
}

export interface AcceptedDraftImage {
  file: File;
  mimeType: ImageMimeType;
}

export interface CollectedDraftImages {
  accepted: AcceptedDraftImage[];
  /** 第一条被拒原因（与原评论图片流程同一文案） */
  rejection: string | null;
}

/**
 * 过滤并限量：超限/非法/超数量都返回可读原因，已接收项按顺序保留。
 * `existingCount` 为当前草稿里已有的图片数。
 */
export function collectDraftImages(
  files: Iterable<File>,
  existingCount: number,
  max = MAX_DRAFT_IMAGES,
): CollectedDraftImages {
  const accepted: AcceptedDraftImage[] = [];
  let rejection: string | null = null;
  let remaining = max - existingCount;
  for (const file of files) {
    if (file.size > MAX_IMAGE_BYTES) {
      rejection = '单张图片不能超过 10 MiB';
      continue;
    }
    const mimeType = getImageMimeType(file);
    if (!mimeType) {
      rejection = '仅支持 PNG、JPEG 和 WebP 图片';
      continue;
    }
    if (remaining <= 0) {
      rejection = `每次最多添加 ${max} 张图片`;
      continue;
    }
    accepted.push({ file, mimeType });
    remaining -= 1;
  }
  return { accepted, rejection };
}

/**
 * CHAT-IMG-DELIVERY：从草稿文本提取粘贴上传的附件 id（按出现顺序去重）。
 * 只认指向本服务附件端点的图片 markdown（`![…](/api/workspaces/{ws}/attachments/{id})`）；
 * 用户手删了某张图的 markdown 即视为不投递该图。超 5 张由调用方提示。
 */
export function attachmentIdsFromText(text: string): string[] {
  const pattern = /!\[[^\]]*\]\(\/api\/workspaces\/[^/)]+\/attachments\/([^/)]+)\)/g;
  const ids: string[] = [];
  for (const match of text.matchAll(pattern)) {
    const id = match[1];
    if (id && !ids.includes(id)) ids.push(id);
  }
  return ids;
}
