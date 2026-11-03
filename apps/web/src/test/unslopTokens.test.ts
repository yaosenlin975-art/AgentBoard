/**
 * UNSLOP 全局令牌与方向的机器可验证部分。
 * 方向：Docs/design-2026-11-03-unslop-direction.md（暖石墨 + 单一琥珀强调）。
 * 这里钉两类东西：
 *  1) 令牌取值（十六进制字面量）——避免被随手改回蓝/紫 slop；
 *  2) `@theme inline` 的映射键——Tailwind v4 只有登记成 `--color-*` 才会生成对应工具类，
 *     漏一个键（如 `--color-accent-soft`）会让 `bg-accent-soft` 静默失效：页面不报错，高亮直接没了。
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { PRIORITY_BAR } from '../components/board/IssueCard';
import { statusAccent } from '../lib/workspaceStatuses';

const css = readFileSync(join(__dirname, '..', 'index.css'), 'utf8');

/** 界面实际用到、必须由 @theme 映射成工具类的令牌（漏一个就会静默失效） */
const REQUIRED_THEME_COLORS = [
  '--color-surface-page',
  '--color-surface-card',
  '--color-surface-raised',
  '--color-hairline',
  '--color-ink',
  '--color-ink-2',
  '--color-ink-3',
  '--color-accent',
  '--color-accent-ink',
  '--color-accent-soft',
];

describe('UNSLOP 全局令牌（pass 2 · color）', () => {
  it('暖石墨中性 ramp + 琥珀强调色，亮/暗两套都在', () => {
    // 亮：纸面 + 暖石墨文字 + 深琥珀（白字 4.5:1）
    expect(css).toContain('--ab-page: #f7f4ee');
    expect(css).toContain('--ab-card: #fdfbf7');
    expect(css).toContain('--ab-ink: #1f1b16');
    expect(css).toContain('--ab-accent: #b45309');
    // 暗：暖黑台面 + 提亮琥珀 + 深字
    expect(css).toContain('--ab-page: #161513');
    expect(css).toContain('--ab-accent: #f0a01e');
    expect(css).toContain('--ab-accent-ink: #1c1a18');
  });

  it('@theme 映射键齐全（含 accent-soft）：缺键会让 bg-*/text-* 工具类静默不生成', () => {
    for (const key of REQUIRED_THEME_COLORS) {
      expect(css, `@theme 缺少映射键 ${key}`).toContain(`${key}:`);
    }
    // 变量本体必须亮/暗各定义一次，否则工具类生成出来是空值
    for (const key of ['--ab-accent-soft', '--ab-accent', '--ab-ink-3', '--ab-hairline']) {
      const occurrences = css.split(`${key}:`).length - 1;
      expect(occurrences, `${key} 应在 :root 与 .dark 各定义一次`).toBeGreaterThanOrEqual(2);
    }
  });

  it('不出现色相渐变 / 彩色阴影（slop 特征）', () => {
    expect(css).not.toMatch(/linear-gradient\([^)]*(purple|violet|#7c3aed|#8b5cf6)/i);
    expect(css).not.toMatch(/from-(violet|purple|indigo)-/);
  });

  it('状态色只剩「待验收用强调色」，其余走中性台阶（不再紫/蓝/绿）', () => {
    expect(statusAccent('review')).toBe('text-accent');
    expect(statusAccent('started')).toBe('text-ink');
    expect(statusAccent('done')).toBe('text-ink-3');
    expect(statusAccent('deprecated')).toBe('text-ink-2');
  });

  it('卡片左缘优先级轨：低/中走中性台阶，只有「高」保留强调色', () => {
    expect(PRIORITY_BAR['低']).toBe('bg-ink-3');
    expect(PRIORITY_BAR['中']).toBe('bg-ink-2');
    expect(PRIORITY_BAR['高']).toBe('bg-accent');
  });
});
