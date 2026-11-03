/**
 * THEME-CONTRAST-AUDIT 回归网：把 index.css 里的亮/暗两套令牌算成 WCAG 对比度，钉住 ≥4.5:1。
 *
 * 为什么要有：暗色「黑底黑字」是继承链/portal 引起的，浏览器里肉眼看不出边界；
 * 令牌值被随手调暗一点就会跌破阈值，而现有测试全绿。这里直接对令牌取值做数值断言。
 * 另一条（legacy 弱化文字）由 index.css 的兼容层保证，见 .text-neutral-400 规则。
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const css = readFileSync(join(__dirname, '..', 'index.css'), 'utf8');

function hexToRgb(hex: string): { r: number; g: number; b: number } {
  const value = hex.replace('#', '');
  return {
    r: parseInt(value.slice(0, 2), 16),
    g: parseInt(value.slice(2, 4), 16),
    b: parseInt(value.slice(4, 6), 16),
  };
}

function luminance({ r, g, b }: { r: number; g: number; b: number }): number {
  const channel = (raw: number): number => {
    const v = raw / 255;
    return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

function contrast(fg: string, bg: string): number {
  const a = luminance(hexToRgb(fg));
  const b = luminance(hexToRgb(bg));
  const hi = Math.max(a, b);
  const lo = Math.min(a, b);
  return (hi + 0.05) / (lo + 0.05);
}

/** 取某个选择器块里的 --ab-* 令牌（块以 `}` 结束；块内注释先剥掉） */
function tokensOf(selector: string): Record<string, string> {
  const start = css.indexOf(`${selector} {`);
  expect(start, `index.css 缺少 ${selector} 块`).toBeGreaterThan(-1);
  const end = css.indexOf('}', start);
  const block = css
    .slice(start, end)
    .replace(/\/\*[\s\S]*?\*\//g, '');
  const tokens: Record<string, string> = {};
  for (const match of block.matchAll(/--ab-([a-z0-9-]+):\s*(#[0-9a-fA-F]{6})/g)) {
    tokens[match[1]!] = match[2]!;
  }
  return tokens;
}

const surfaces = ['page', 'card', 'raised'] as const;
const textTokens = ['ink', 'ink-2', 'ink-3'] as const;

describe.each([
  ['亮色', ':root'],
  ['暗色', '.dark'],
])('%s 令牌对比度（WCAG AA 正文 4.5:1）', (_label, selector) => {
  const tokens = tokensOf(selector);

  it.each(surfaces)('正文/次级/弱化文字在 surface-%s 上都 ≥ 4.5:1', (surface) => {
    for (const text of textTokens) {
      const fg = tokens[text];
      const bg = tokens[surface];
      expect(fg, `${selector} 缺少 --ab-${text}`).toBeDefined();
      expect(bg, `${selector} 缺少 --ab-${surface}`).toBeDefined();
      const ratio = contrast(fg!, bg!);
      expect(ratio, `${selector} --ab-${text} on --ab-${surface} = ${ratio.toFixed(2)}:1`).toBeGreaterThanOrEqual(4.5);
    }
  });

  it.each(surfaces)('强调色在 surface-%s 上 ≥ 4.5:1（可作文字色）', (surface) => {
    const ratio = contrast(tokens.accent!, tokens[surface]!);
    expect(ratio, `${selector} --ab-accent on --ab-${surface} = ${ratio.toFixed(2)}:1`).toBeGreaterThanOrEqual(4.5);
  });

  it('强调底上的强调文字（accent-ink）≥ 4.5:1', () => {
    const ratio = contrast(tokens['accent-ink']!, tokens.accent!);
    expect(ratio, `${selector} --ab-accent-ink on --ab-accent = ${ratio.toFixed(2)}:1`).toBeGreaterThanOrEqual(4.5);
  });
});

describe('legacy 弱化文字兼容层', () => {
  it('.text-neutral-400 / .text-neutral-500 被桥接到 ink-3（否则亮色只有 2.5:1）', () => {
    expect(css).toMatch(/\.text-neutral-400[\s\S]{0,80}\.text-neutral-500\s*\{[^}]*var\(--ab-ink-3\)/);
  });
});

describe('portal（弹窗）基准色', () => {
  it('html/body 显式设置基准前景与背景，Modal 走 portal 时不再靠继承拿到默认黑字', () => {
    expect(css).toMatch(/html,\s*body\s*\{[^}]*background-color:\s*var\(--ab-page\)[^}]*color:\s*var\(--ab-ink\)/);
  });
});
