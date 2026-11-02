/**
 * 滚动条主题化（SCROLLBAR-DARK）契约测试。
 * jsdom 不应用外部 CSS，这里直接对样式表源码做断言：
 * 删除变量定义 / ::-webkit-scrollbar 系列 / 暗色覆盖中任意一处，本用例即失败。
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const css = readFileSync(resolve(process.cwd(), 'src/index.css'), 'utf8');

describe('滚动条主题化（SCROLLBAR-DARK）', () => {
  it('亮色：定义轨道/滑块变量并用 scrollbar-width + scrollbar-color（Firefox）', () => {
    expect(css).toMatch(/:root\s*\{[^}]*--ab-scrollbar-thumb:[^;]+;/);
    expect(css).toMatch(/:root\s*\{[^}]*--ab-scrollbar-track:[^;]+;/);
    expect(css).toContain('scrollbar-width: thin');
    expect(css).toMatch(/scrollbar-color:\s*var\(--ab-scrollbar-thumb\)\s+var\(--ab-scrollbar-track\)/);
  });

  it('暗色：.dark 覆盖轨道与滑块，且不是纯白/纯黑', () => {
    const darkBlock = css.match(/\.dark\s*\{[^}]*--ab-scrollbar[^}]*\}/)?.[0] ?? '';
    expect(darkBlock).toContain('--ab-scrollbar-track');
    expect(darkBlock).toContain('--ab-scrollbar-thumb');
    expect(darkBlock).not.toMatch(/--ab-scrollbar-thumb:\s*(#fff|#ffffff|white)/i);
    expect(darkBlock).not.toMatch(/--ab-scrollbar-track:\s*(#000|#000000|black)/i);
  });

  it('Chromium：细滚动条 + 圆角滑块 + 悬浮加深', () => {
    expect(css).toMatch(/::-webkit-scrollbar\s*\{[^}]*width:\s*var\(--ab-scrollbar-size\)/);
    expect(css).toContain('::-webkit-scrollbar-track');
    expect(css).toContain('::-webkit-scrollbar-thumb');
    expect(css).toMatch(/::-webkit-scrollbar-thumb:hover\s*\{[^}]*background:\s*var\(--ab-scrollbar-thumb-hover\)/);
    // 宽度落在 6–8px 区间
    const size = Number(css.match(/--ab-scrollbar-size:\s*(\d+)px/)?.[1] ?? '0');
    expect(size).toBeGreaterThanOrEqual(6);
    expect(size).toBeLessThanOrEqual(8);
  });
});
