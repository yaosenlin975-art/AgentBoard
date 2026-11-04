/**
 * PALETTE-BOARD-LOG 一次性收敛脚本（本卡交付物之一，可复现）。
 * 只做「遗留 Tailwind 调色板类 → 设计令牌类」的**精确字符串**替换，不做结构性重排、不改布局尺寸。
 * 语义色保留：red（错误）、amber（警告/阻塞）。
 * 用法：node scripts/verify/palette-sweep.mjs [--dry]
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { globSync } from 'node:fs';

const DRY = process.argv.includes('--dry');

/** 作用域：本卡允许改的目录/文件 */
const TARGETS = [
  'apps/web/src/components/board/**/*.tsx',
  'apps/web/src/components/changelog/**/*.tsx',
  'apps/web/src/components/workspace/**/*.tsx',
  'apps/web/src/components/knowledge/**/*.tsx',
  'apps/web/src/components/right/**/*.tsx',
  'apps/web/src/lib/markdownLinks.tsx',
];

/**
 * 替换表（顺序敏感：先长后短）。
 * 语义：主操作 accent/accent-ink、选中 accent-soft/accent、中性文字 ink-2/ink-3、
 *       面板/卡片 surface-card、抬升面 surface-raised、边框 hairline。
 */
const RULES = [
  // 表面
  ['hover:bg-white', 'hover:bg-surface-card'],
  ['bg-white', 'bg-surface-card'],
  ['dark:bg-neutral-950', ''],
  ['dark:bg-neutral-900', ''],
  ['dark:bg-neutral-800', ''],
  // 抬升面（浅底徽标/次级按钮底）
  ['dark:bg-neutral-700', ''],
  ['bg-neutral-200', 'bg-surface-raised'],
  ['bg-neutral-100', 'bg-surface-raised'],
  ['hover:bg-neutral-200', 'hover:bg-surface-raised'],
  ['hover:bg-neutral-100', 'hover:bg-surface-raised'],
  ['active:bg-neutral-200', 'active:bg-surface-raised'],
  // 边框 / 分隔
  ['dark:border-neutral-800', ''],
  ['dark:border-neutral-700', ''],
  ['dark:divide-neutral-800', ''],
  ['border-neutral-300', 'border-hairline'],
  ['border-neutral-200', 'border-hairline'],
  ['divide-neutral-200', 'divide-hairline'],
  // 文字
  ['dark:text-neutral-100', ''],
  ['dark:text-neutral-200', ''],
  ['dark:text-neutral-300', ''],
  ['dark:text-neutral-400', ''],
  ['dark:text-neutral-500', ''],
  ['text-neutral-900', 'text-ink'],
  ['text-neutral-800', 'text-ink'],
  ['text-neutral-700', 'text-ink-2'],
  ['text-neutral-600', 'text-ink-2'],
  ['text-neutral-500', 'text-ink-3'],
  ['text-neutral-400', 'text-ink-3'],
  ['placeholder:text-neutral-400', 'placeholder:text-ink-3'],
  // 主操作 / 链接 / 选中
  ['hover:text-blue-700', 'hover:text-accent'],
  ['hover:text-blue-600', 'hover:text-accent'],
  ['bg-blue-600 text-white', 'bg-accent text-accent-ink'],
  ['bg-blue-600', 'bg-accent'],
  ['dark:bg-blue-950/30', ''],
  ['bg-blue-50', 'bg-accent-soft'],
  ['dark:text-blue-300', ''],
  ['dark:text-blue-400', ''],
  ['text-blue-700', 'text-accent'],
  ['text-blue-600', 'text-accent'],
  ['border-blue-300', 'border-accent'],
  ['focus:border-blue-500', 'focus:border-accent'],
  ['focus:ring-blue-500', 'focus:ring-accent'],
  // 类型标签（多色相收敛到单色相，见 ChangelogTypeTag 决策）
  ['bg-green-100 text-green-800 dark:bg-green-900/40 dark:text-green-300', 'bg-accent-soft text-accent'],
  ['bg-blue-100 text-blue-800 dark:bg-blue-900/40 dark:text-blue-300', 'bg-accent-soft text-accent'],
  ['bg-purple-100 text-purple-800 dark:bg-purple-900/40 dark:text-purple-300', 'bg-accent-soft text-accent'],
  ['bg-neutral-200 text-neutral-700 dark:bg-neutral-800 dark:text-neutral-300', 'bg-surface-raised text-ink-2'],
  ['bg-green-100 text-green-700 dark:bg-green-950/40 dark:text-green-300', 'bg-accent-soft text-accent'],
];

/** 清理替换后可能出现的多余空格（只压空格，不动引号内容） */
const tidy = (line) => line.replace(/ {2,}/g, ' ');

let totalChanged = 0;
const report = [];
for (const pattern of TARGETS) {
  for (const file of globSync(pattern)) {
    const before = readFileSync(file, 'utf8');
    const lines = before.split('\n');
    let changed = 0;
    const next = lines.map((line) => {
      let out = line;
      for (const [from, to] of RULES) {
        if (out.includes(from)) out = out.split(from).join(to);
      }
      if (out !== line) {
        changed += 1;
        return tidy(out);
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
