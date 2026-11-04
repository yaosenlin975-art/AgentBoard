/**
 * PALETTE-BOARD-LOG 收敛脚本（第二遍：通用色阶 → 设计令牌）。
 *
 * 第一遍（本文件同目录的 history: palette-sweep 初版）按精确字符串处理了主要类；本遍处理任意色阶组合：
 * 蓝色系 → accent 家族；中性/灰/石板 → ink / surface / hairline；绿色/紫色/靛蓝 → accent（类型标签已单色相）。
 * `dark:` 变体一律删除（令牌本身是主题感知的，不需要 dark 覆盖）。
 * 语义色 red（错误）/ amber（警告）**保留**，不在此表内。
 *
 * 用法：node scripts/verify/palette-sweep-2.mjs [--dry]
 */
import { readFileSync, writeFileSync, globSync } from 'node:fs';

const DRY = process.argv.includes('--dry');

const TARGETS = [
  'apps/web/src/components/board/**/*.tsx',
  'apps/web/src/components/changelog/**/*.tsx',
  'apps/web/src/components/workspace/**/*.tsx',
  'apps/web/src/components/knowledge/**/*.tsx',
  'apps/web/src/components/right/**/*.tsx',
  'apps/web/src/lib/markdownLinks.tsx',
];

/** 单个工具类 → 令牌；返回 '' 表示删除该类 */
function mapUtility(cls) {
  const dark = cls.startsWith('dark:');
  const body = dark ? cls.slice(5) : cls;
  const m = /^(?:(hover|focus|focus-visible|active|disabled|group-hover):)?(bg|text|border|divide|ring|outline|decoration|fill|stroke)-([a-z]+)-(\d{2,3})(?:\/(\d+))?$/.exec(body);
  if (!m) return null;
  const [, state, kind, hue, level, alpha] = m;
  if (dark) return '';
  const apply = (token) => `${state ? `${state}:` : ''}${token}`;
  const suffix = alpha ? `/${alpha}` : '';
  const warm = kind === 'text' || kind === 'border' || kind === 'divide' || kind === 'ring' || kind === 'outline' || kind === 'decoration' || kind === 'fill' || kind === 'stroke';
  if (hue === 'blue' || hue === 'indigo') {
    if (kind === 'bg') return apply(Number(level) >= 500 ? 'bg-accent' : 'bg-accent-soft');
    if (kind === 'text') return apply('text-accent');
    if (warm) return apply(kind === 'text' ? 'text-accent' : `${kind}-accent`);
    return apply('bg-accent');
  }
  if (hue === 'green' || hue === 'purple') {
    if (kind === 'bg') return apply('bg-accent-soft');
    if (kind === 'text') return apply('text-accent');
    if (warm) return apply(`${kind}-accent`);
    return null;
  }
  if (hue === 'neutral' || hue === 'gray' || hue === 'slate') {
    const n = Number(level);
    if (kind === 'bg') {
      if (n <= 60) return apply('bg-surface-page');
      if (n <= 250) return apply('bg-surface-raised');
      return apply('bg-surface-card');
    }
    if (kind === 'text') return apply(n >= 800 ? 'text-ink' : n >= 600 ? 'text-ink-2' : 'text-ink-3');
    if (warm) return apply(`${kind}-hairline`);
    return null;
  }
  return null;
}

let totalChanged = 0;
const report = [];
for (const pattern of TARGETS) {
  for (const file of globSync(pattern)) {
    // ChangelogTypeTag 的类型色由 tokenMapping.test.ts 守卫（多色相 + 内建色阶），不参与自动收敛
    if (file.includes('ChangelogTypeTag') || file.includes('LabelFilterBar')) continue;
    const before = readFileSync(file, 'utf8');
    const lines = before.split('\n');
    let changed = 0;
    const next = lines.map((line) => {
      const out = line.replace(/(?<![\w:-])((?:dark:)?(?:(?:hover|focus|focus-visible|active|disabled|group-hover):)?(?:bg|text|border|divide|ring|outline|decoration|fill|stroke)-(?:blue|indigo|green|purple|neutral|gray|slate)-\d{2,3}(?:\/\d+)?)/g, (whole) => {
        const mapped = mapUtility(whole);
        return mapped === null ? whole : mapped;
      });
      const tidied = out;
      if (tidied !== line) {
        changed += 1;
        return tidied;
      }
      return line;
    });
    if (changed > 0) {
      totalChanged += changed;
      report.push(`${file}: ${changed} 行`);
      if (!DRY) writeFileSync(file, next.join('\n'), 'utf8');
    }
  }
}
console.log(report.join('\n'));
console.log(`TOTAL_LINES_CHANGED=${totalChanged}${DRY ? ' (dry-run)' : ''}`);
