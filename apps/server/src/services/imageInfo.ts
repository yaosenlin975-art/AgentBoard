/**
 * KB-IMG-1：图片格式识别与尺寸读取（零依赖）。
 *
 * 只处理白名单四种：PNG / JPEG / WebP / GIF。签名不符 → null（调用方给 415）。
 * 尺寸读不出来不是错误（返回 null），前端只是不显示宽高。
 */
export type KnowledgeImageMime = 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif';

export const KNOWLEDGE_IMAGE_MIMES: readonly KnowledgeImageMime[] = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'];

const EXTENSION: Record<KnowledgeImageMime, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
  'image/gif': 'gif',
};

export const extensionOf = (mime: KnowledgeImageMime): string => EXTENSION[mime];

/** 按文件签名判定真实类型（不信任客户端声明的 Content-Type） */
export function sniffImageMime(bytes: Buffer): KnowledgeImageMime | null {
  if (bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
  if (bytes.length >= 6) {
    const head = bytes.toString('ascii', 0, 6);
    if (head === 'GIF87a' || head === 'GIF89a') return 'image/gif';
  }
  if (bytes.length >= 12 && bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP') return 'image/webp';
  return null;
}

export interface ImageSize { width: number; height: number }

function pngSize(bytes: Buffer): ImageSize | null {
  if (bytes.length < 24) return null;
  if (bytes.toString('ascii', 12, 16) !== 'IHDR') return null;
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
}

function gifSize(bytes: Buffer): ImageSize | null {
  if (bytes.length < 10) return null;
  return { width: bytes.readUInt16LE(6), height: bytes.readUInt16LE(8) };
}

function jpegSize(bytes: Buffer): ImageSize | null {
  let offset = 2;
  while (offset + 9 < bytes.length) {
    if (bytes[offset] !== 0xff) { offset += 1; continue; }
    const marker = bytes[offset + 1]!;
    // SOF0..SOF3 / SOF5..SOF7 / SOF9..SOF11 / SOF13..SOF15（排除 C4 DHT / C8 JPG / CC DAC）
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      return { height: bytes.readUInt16BE(offset + 5), width: bytes.readUInt16BE(offset + 7) };
    }
    const length = bytes.readUInt16BE(offset + 2);
    if (length < 2) return null;
    offset += 2 + length;
  }
  return null;
}

function webpSize(bytes: Buffer): ImageSize | null {
  if (bytes.length < 30) return null;
  const chunk = bytes.toString('ascii', 12, 16);
  if (chunk === 'VP8 ') {
    // 关键帧：起始码 9d 01 2a 之后是 14 位宽高（小端）
    const start = bytes.indexOf(Buffer.from([0x9d, 0x01, 0x2a]), 20);
    if (start < 0 || start + 7 > bytes.length) return null;
    return { width: bytes.readUInt16LE(start + 3) & 0x3fff, height: bytes.readUInt16LE(start + 5) & 0x3fff };
  }
  if (chunk === 'VP8L') {
    const bits = bytes.readUInt32LE(21);
    return { width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 };
  }
  if (chunk === 'VP8X') {
    const width = 1 + (bytes.readUIntLE(24, 3) & 0xffffff);
    const height = 1 + (bytes.readUIntLE(27, 3) & 0xffffff);
    return { width, height };
  }
  return null;
}

/** 读尺寸；格式不支持或数据截断 → null（不视为错误） */
export function readImageSize(bytes: Buffer, mime: KnowledgeImageMime): ImageSize | null {
  try {
    switch (mime) {
      case 'image/png': return pngSize(bytes);
      case 'image/gif': return gifSize(bytes);
      case 'image/jpeg': return jpegSize(bytes);
      case 'image/webp': return webpSize(bytes);
      default: return null;
    }
  } catch {
    return null;
  }
}
