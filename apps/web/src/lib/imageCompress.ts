/**
 * 知识页图片客户端压缩（KB-IMG-2 / design §5 + D3/D4）。
 *
 * 规则（不引新依赖，只用 createImageBitmap + canvas + toBlob）：
 * - 需要压缩的条件：`bytes > 5MiB` 或最长边 > 5000px；
 * - 压缩目标：等比缩到最长边 ≤ 3000px，`toBlob('image/webp', 0.9)`，不支持 webp 回落 `image/jpeg` 0.9；
 * - 透明图标（PNG 且含透明像素）优先保留 PNG；
 * - 压缩后仍 > 5MiB 由调用方提示并中止。
 */

export const IMAGE_MAX_BYTES = 5 * 1024 * 1024; // 与服务端 413 阈值一致
export const IMAGE_COMPRESS_TRIGGER_BYTES = 5 * 1024 * 1024;
export const IMAGE_COMPRESS_TRIGGER_EDGE = 5000;
export const IMAGE_COMPRESS_TARGET_EDGE = 3000;

export interface ImageMeta {
  bytes: number;
  width: number;
  height: number;
  type: string;
}

export type MimeCandidate = 'image/webp' | 'image/jpeg' | 'image/png';

/** 是否需要压缩（纯函数，便于单测） */
export function needsCompression(meta: Pick<ImageMeta, 'bytes' | 'width' | 'height'>): boolean {
  return meta.bytes > IMAGE_COMPRESS_TRIGGER_BYTES || Math.max(meta.width, meta.height) > IMAGE_COMPRESS_TRIGGER_EDGE;
}

/** 等比缩放后的尺寸（最长边 ≤ target） */
export function scaleToFit(width: number, height: number, target = IMAGE_COMPRESS_TARGET_EDGE): { width: number; height: number } {
  const longest = Math.max(width, height);
  if (longest <= target || longest <= 0) return { width: Math.max(1, Math.round(width)), height: Math.max(1, Math.round(height)) };
  const ratio = target / longest;
  return { width: Math.max(1, Math.round(width * ratio)), height: Math.max(1, Math.round(height * ratio)) };
}

/** 选输出格式：透明 → PNG；否则 webp 优先，不支持回落 jpeg */
export function pickMimeType(type: string, hasAlpha: boolean, supportsWebp: boolean): MimeCandidate {
  if (hasAlpha) return 'image/png';
  if (supportsWebp) return 'image/webp';
  return 'image/jpeg';
}

/** 字节数可读化（UI 文案用）：7.2MB / 320KB */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '0B';
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

export interface CompressionResult {
  blob: Blob;
  beforeBytes: number;
  afterBytes: number;
  width: number;
  height: number;
  mime: MimeCandidate;
  /** 未触发压缩时为 true（原样上传） */
  skipped: boolean;
}

interface CompressDeps {
  createBitmap?: (file: Blob) => Promise<{ width: number; height: number; close?: () => void }>;
  makeCanvas?: (width: number, height: number) => {
    getContext: (id: '2d') => CanvasRenderingContext2D | null;
    toBlob: (cb: (blob: Blob | null) => void, type?: string, quality?: number) => void;
  };
  supportsWebp?: () => boolean;
}

function defaultSupportsWebp(): boolean {
  if (typeof document === 'undefined') return false;
  const canvas = document.createElement('canvas');
  return canvas.toDataURL('image/webp').startsWith('data:image/webp');
}

/**
 * 压缩一张图片。未达阈值直接返回原 blob（skipped=true）。
 * 失败（解码失败等）抛出 Error，由调用方转成中文提示。
 */
export async function compressImage(file: File, deps: CompressDeps = {}): Promise<CompressionResult> {
  const createBitmap = deps.createBitmap ?? ((blob: Blob) => createImageBitmap(blob));
  const makeCanvas =
    deps.makeCanvas ??
    ((width: number, height: number) => {
      const canvas = document.createElement('canvas');
      canvas.width = width;
      canvas.height = height;
      return canvas;
    });
  const supportsWebp = (deps.supportsWebp ?? defaultSupportsWebp)();

  const bitmap = await createBitmap(file);
  const sourceWidth = bitmap.width;
  const sourceHeight = bitmap.height;
  const meta: ImageMeta = { bytes: file.size, width: sourceWidth, height: sourceHeight, type: file.type };

  if (!needsCompression(meta)) {
    bitmap.close?.();
    return { blob: file, beforeBytes: file.size, afterBytes: file.size, width: sourceWidth, height: sourceHeight, mime: (file.type as MimeCandidate) ?? 'image/jpeg', skipped: true };
  }

  const target = scaleToFit(sourceWidth, sourceHeight);
  const canvas = makeCanvas(target.width, target.height);
  const ctx = canvas.getContext('2d');
  if (ctx === null) throw new Error('当前浏览器无法创建 canvas 2D 上下文');
  ctx.drawImage(bitmap as unknown as CanvasImageSource, 0, 0, target.width, target.height);
  bitmap.close?.();

  // 透明检测（已知限制，KB-IMG-2-VERIFY 实测记录）：
  // 只取样左上角 ≤64×64 的像素判 alpha —— 「大面积透明但左上角不透明」的 PNG 会被判成不透明，
  // 从而转成 webp 丢掉 alpha。全图扫描会带来 O(像素) 的 getImageData 开销（3000×3000 ≈ 36MB 内存），
  // 当前按「图标类 PNG 通常左上角即透明」这一折衷处理；真需要严格判定时可加「四角 + 中心 5 点取样」或降采样扫描。
  let hasAlpha = false;
  if (file.type === 'image/png') {
    try {
      const sample = ctx.getImageData(0, 0, Math.min(target.width, 64), Math.min(target.height, 64)).data;
      for (let i = 3; i < sample.length; i += 4) {
        if (sample[i]! < 255) {
          hasAlpha = true;
          break;
        }
      }
    } catch {
      hasAlpha = false; // 跨域等场景读不到像素，按不透明处理
    }
  }

  const mime = pickMimeType(file.type, hasAlpha, supportsWebp);
  const blob = await new Promise<Blob>((resolve, reject) => {
    canvas.toBlob(
      (result) => {
        if (result === null) reject(new Error('图片压缩失败：浏览器未能编码该图片'));
        else resolve(result);
      },
      mime,
      0.9,
    );
  });

  return { blob, beforeBytes: file.size, afterBytes: blob.size, width: target.width, height: target.height, mime, skipped: false };
}
