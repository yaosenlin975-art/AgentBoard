/**
 * 新建任务附图（NEW-ISSUE-IMAGE）：粘贴 / 拖拽 / 选择三条入口共用同一套格式、大小与数量判定。
 * 与评论图片流程（`components/detail/CommentThread.tsx`）保持同一规则：PNG/JPEG/WebP、单张 ≤10 MiB、每条最多 5 张。
 */
import type { AttachmentUploadResult } from '../api/client';

export type ImageMimeType = AttachmentUploadResult['mime_type'];

export const MAX_DRAFT_IMAGES = 5;
export const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
/** CHAT-ATTACH-ANY：聊天附件（任意类型）的上限，与服务端 D7 单文件 10 MiB 同值 */
export const MAX_DRAFT_ATTACHMENTS = 5;
export const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;

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
 * CHAT-ATTACH-ANY：任意类型附件的 MIME 判定。
 * 浏览器给的类型优先（保留服务端 D7 的原始 MIME），缺失时按扩展名兜底（png/jpg/webp），
 * 仍未知则用 `application/octet-stream`；不做可执行类型拦截——文件只存储、不执行、不内联预览，
 * 下载由服务端强制 `Content-Disposition: attachment`。
 */
export function resolveAttachmentMime(file: File): string {
  if (file.type !== '') return file.type;
  const extension = file.name.split('.').at(-1)?.toLowerCase();
  return extension === undefined ? 'application/octet-stream' : MIME_BY_EXTENSION[extension] ?? 'application/octet-stream';
}

/** 是否图片附件（决定缩略图 vs 类型徽标，以及是否允许走当前聊天图片通道发送） */
export function isImageMime(mime: string): boolean {
  return mime.toLowerCase().startsWith('image/');
}

export interface AcceptedDraftAttachment {
  file: File;
  mimeType: string;
}

export interface CollectedDraftAttachments {
  accepted: AcceptedDraftAttachment[];
  /** 第一条被拒原因（超限/超数量） */
  rejection: string | null;
}

/**
 * CHAT-ATTACH-ANY：聊天附件收集（任意类型）。
 * 上限：每条消息最多 5 个、单文件 ≤10 MiB（与服务端 D7 一致）；已接收项按顺序保留。
 */
export function collectDraftAttachments(
  files: Iterable<File>,
  existingCount: number,
  max = MAX_DRAFT_ATTACHMENTS,
): CollectedDraftAttachments {
  const accepted: AcceptedDraftAttachment[] = [];
  let rejection: string | null = null;
  let remaining = max - existingCount;
  for (const file of files) {
    if (file.size > MAX_ATTACHMENT_BYTES) {
      rejection = '单个附件不能超过 10 MiB';
      continue;
    }
    if (remaining <= 0) {
      rejection = `每次最多添加 ${max} 个附件`;
      continue;
    }
    accepted.push({ file, mimeType: resolveAttachmentMime(file) });
    remaining -= 1;
  }
  return { accepted, rejection };
}

/**
 * CHAT-ATTACH-STATE：草稿附件（结构化状态，正文不再内联 markdown）。
 * 发送时由 `attachmentMarkdown` 物化到「发出文本」，保证气泡渲染与服务端历史不变。
 */
export interface DraftAttachment {
  id: string;
  url: string;
  name: string;
  mime: string;
  bytes: number;
}

/** 发出文本的附件 markdown（与历史渲染口径一致） */
export function attachmentMarkdown(list: DraftAttachment[]): string {
  // CHAT-ATTACH-ANY：只有图片靠正文 markdown 渲染；非图片由服务端把路径/元数据拼进 prompt，不写进气泡正文
  return list.filter((item) => isImageMime(item.mime)).map((item) => `![图片](${item.url})`).join('\n\n');
}

/** 发送时投递的附件 id（按附件卡顺序） */
export function attachmentIds(list: DraftAttachment[]): string[] {
  return list.map((item) => item.id);
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
