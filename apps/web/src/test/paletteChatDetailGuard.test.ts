/**
 * PALETTE-CHAT-DETAIL 守卫：`components/{chat,detail}` 不允许再出现旧 blue 色板。
 *
 * 为什么要这条：首轮我用的 grep 口径只看了 `bg-blue-|text-blue-|border-blue-` 的**普通变体**，
 * 漏掉了 `dark:text-blue-300` 这类 `dark:` 前缀写法（复审线实测抓出 2 处）。这里把扫描写成
 * 断言：**任何位置出现 blue 类都算命中**（含 `dark:` / `hover:` / `focus:` 等变体前缀），
 * 只允许显式允许清单（当前为空）。
 *
 * 语义色说明：绿色（已解除）与琥珀（未解除）走 `DependencySection`，它们不是「旧色板」，
 * 不在此守卫里被禁；本守卫只管 blue。
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const SRC = join(__dirname, '..');
const DIRS = ['components/chat', 'components/detail'];

/** blue 类：允许任意变体前缀（dark:/hover:/focus-visible:/group-hover: …） */
const BLUE = /(?:^|[\s"'`{])(?:(?:[a-z-]+:)*)?(?:bg|text|border|ring|outline|from|to|via|fill|stroke)-blue-\d{2,3}/;

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else if (full.endsWith('.tsx') || full.endsWith('.ts')) out.push(full);
  }
  return out;
}

const ALLOW: { file: string; pattern: RegExp; reason: string }[] = [];

describe('聊天/详情区色板守卫（PALETTE-CHAT-DETAIL）', () => {
  it('components/{chat,detail} 不含任何 blue 色板类（含 dark:/hover: 等变体）', () => {
    const hits: string[] = [];
    for (const dir of DIRS) {
      for (const file of walk(join(SRC, dir))) {
        const source = readFileSync(file, 'utf8');
        source.split('\n').forEach((line, index) => {
          if (!BLUE.test(line)) return;
          if (ALLOW.some((rule) => file.endsWith(rule.file) && rule.pattern.test(line))) return;
          hits.push(`${file.replace(SRC, 'apps/web/src')}:${index + 1}: ${line.trim().slice(0, 100)}`);
        });
      }
    }
    expect(hits, '旧 blue 色板残留（含 dark:/hover: 变体）').toEqual([]);
  });

  it('守卫自身能抓到 dark: 变体（负向自检，防止正则退回旧口径）', () => {
    expect(BLUE.test('className="text-xs text-accent underline dark:text-blue-300"')).toBe(true);
    expect(BLUE.test('className="rounded px-2 py-1 text-blue-700 hover:bg-blue-50"')).toBe(true);
    expect(BLUE.test('className="dark:hover:bg-blue-950/40"')).toBe(true);
    // 非 blue 不应误报
    expect(BLUE.test('className="text-xs text-accent underline"')).toBe(false);
    expect(BLUE.test('className="bg-surface-raised text-ink-2"')).toBe(false);
    expect(BLUE.test('className="text-green-700 dark:text-green-400"')).toBe(false);
  });
});
