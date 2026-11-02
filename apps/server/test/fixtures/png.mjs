/**
 * 合成标记图生成器（纯 Node，无第三方依赖）：输出合法 PNG（signature + IHDR + IDAT + IEND）。
 *
 * 图面约定（人工验收脚本与 fixture 共用）：
 * - 背景色 绿色 (0,200,0)
 * - 左上角 128x128 洋红色块 (255,0,255)，块内用 3x5 点阵字体画一个黑色数字（= 标记值）
 * - 数字越大，点阵放大倍数越大（scale=10 → 30x50 px）
 *
 * 用途：IMG-04 隔离 fixture 的图片附件（不触发任何真实账号/模型调用）。
 */
import { deflateSync } from 'node:zlib';

export const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

const DIGIT_FONT = {
  '0': ['111', '101', '101', '101', '111'],
  '1': ['010', '110', '010', '010', '111'],
  '2': ['111', '001', '111', '100', '111'],
  '3': ['111', '001', '111', '001', '111'],
  '4': ['101', '101', '111', '001', '001'],
  '5': ['111', '100', '111', '001', '111'],
  '6': ['111', '100', '111', '101', '111'],
  '7': ['111', '001', '001', '001', '001'],
  '8': ['111', '101', '111', '101', '111'],
  '9': ['111', '101', '111', '001', '111'],
};

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i += 1) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([length, typeBuf, data, crc]);
}

/** 组装 PNG：RGB8，无交错 */
export function encodePng(width, height, pixelAt) {
  const raw = Buffer.alloc(height * (1 + width * 3));
  let offset = 0;
  for (let y = 0; y < height; y += 1) {
    raw[offset] = 0; // filter: none
    offset += 1;
    for (let x = 0; x < width; x += 1) {
      const [r, g, b] = pixelAt(x, y);
      raw[offset] = r;
      raw[offset + 1] = g;
      raw[offset + 2] = b;
      offset += 3;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // color type: truecolor
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;
  // level 0（stored）：输出尺寸≈原始像素，便于精确控制单图字节数
  const idat = deflateSync(raw, { level: 0 });
  return Buffer.concat([PNG_SIGNATURE, chunk('IHDR', ihdr), chunk('IDAT', idat), chunk('IEND', Buffer.alloc(0))]);
}

/** 合成标记图：绿底 + 洋红方块 + 块内黑色数字 */
export function makeMarkerPng(markerDigit, { size = 256, block = 128, scale = 10 } = {}) {
  const digit = String(markerDigit);
  const font = DIGIT_FONT[digit];
  if (!font) throw new Error(`不支持的标记数字: ${digit}`);
  const digitWidth = 3 * scale;
  const digitHeight = 5 * scale;
  const digitX = Math.max(0, Math.floor((block - digitWidth) / 2));
  const digitY = Math.max(0, Math.floor((block - digitHeight) / 2));
  return encodePng(size, size, (x, y) => {
    if (x < block && y < block) {
      const fx = Math.floor((x - digitX) / scale);
      const fy = Math.floor((y - digitY) / scale);
      if (fx >= 0 && fx < 3 && fy >= 0 && fy < 5 && font[fy][fx] === '1') return [0, 0, 0];
      return [255, 0, 255];
    }
    return [0, 200, 0];
  });
}

/** 大体积标记图（用于触发 20 MiB 批次上限）：绿底 + 洋红方块，尺寸按需放大 */
export function makeLargeMarkerPng(markerDigit, { width = 1024, height = 1365 } = {}) {
  const digit = String(markerDigit);
  const font = DIGIT_FONT[digit];
  if (!font) throw new Error(`不支持的标记数字: ${digit}`);
  const scale = 16;
  const block = 256;
  const digitWidth = 3 * scale;
  const digitHeight = 5 * scale;
  const digitX = Math.floor((block - digitWidth) / 2);
  const digitY = Math.floor((block - digitHeight) / 2);
  return encodePng(width, height, (x, y) => {
    if (x < block && y < block) {
      const fx = Math.floor((x - digitX) / scale);
      const fy = Math.floor((y - digitY) / scale);
      if (fx >= 0 && fx < 3 && fy >= 0 && fy < 5 && font[fy][fx] === '1') return [0, 0, 0];
      return [255, 0, 255];
    }
    return [0, 200, 0];
  });
}
