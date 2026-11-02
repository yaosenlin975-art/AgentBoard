/**
 * 生成人工验收用的合成标记图（不调用任何 CLI / 模型 / 账号）。
 *
 * 用法：node apps/server/test/fixtures/img04ManualImages.mjs [输出目录]
 * 默认输出目录：apps/server/test/.fixture-img04/manual-images
 *
 * 图面约定（供人工核对模型回复）：
 *   绿底 (0,200,0) + 左上角洋红方块 (255,0,255) + 方块内黑色数字 = 标记值
 *   文件名 marker-<数字>.png 与图内数字一致，模型回复中应出现该数字
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeMarkerPng } from './png.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const outDir = resolve(process.argv[2] ?? join(here, '..', '.fixture-img04', 'manual-images'));
mkdirSync(outDir, { recursive: true });

const digits = [1, 2, 3, 4, 5, 6];
for (const digit of digits) {
  const png = makeMarkerPng(digit);
  const file = join(outDir, `marker-${digit}.png`);
  writeFileSync(file, png);
  console.log(`${file} bytes=${png.length} marker=${digit}`);
}
console.log(`MARKER_DIR ${outDir}`);
