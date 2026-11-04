/**
 * CHIP-PALETTE：颜色类 → `@theme inline` 映射键的一致性守卫。
 *
 * 我们踩过的坑：在 `@theme inline` 里漏写 `--color-*` 映射时，`bg-accent-soft` 这类工具类
 * **根本不会生成**，而普通快照/类名断言仍然全绿。所以这里不做「钉十六进制」，而是：
 * 1. 从真实源码里抽出**我们自定义令牌**的颜色类（surface-* / hairline / ink-* / accent*）；
 * 2. 断言 `index.css` 的 `@theme inline` 里存在对应的 `--color-<key>` 映射（不是值，是**键存在**）；
 * 3. 同时断言被替换掉的旧色板类（bg-blue-100 / text-blue-800）不再出现在标签 chip 与创建方式 tab 上。
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const WEB_ROOT = join(__dirname, '..');

/** 本仓库自定义的语义令牌（须与 index.css @theme inline 的 --color-* 一一对应） */
const TOKEN_NAMES = [
  'surface-page', 'surface-card', 'surface-raised', 'hairline',
  'ink', 'ink-2', 'ink-3', 'accent', 'accent-ink', 'accent-soft',
];

/** 本轮改用令牌的组件（旧 blue 色板必须消失） */
const MIGRATED_FILES = [
  'components/board/LabelFilterBar.tsx',
  'components/topbar/NewIssueDialog.tsx',
];

function read(relative: string): string {
  return readFileSync(join(WEB_ROOT, relative), 'utf8');
}

describe('令牌一致性（CHIP-PALETTE）', () => {
  it('`@theme inline` 为每个自定义令牌提供了 --color-* 映射键', () => {
    const css = read('index.css');
    const themeBlock = /@theme inline \{([\s\S]*?)\n\}/.exec(css);
    expect(themeBlock).not.toBeNull();
    const body = themeBlock![1]!;
    const declared = new Set(
      [...body.matchAll(/--color-([a-z0-9-]+)\s*:/g)].map((m) => m[1]!),
    );
    for (const name of TOKEN_NAMES) {
      expect(declared, `@theme inline 缺少 --color-${name} 映射（缺了 bg-${name}/text-${name} 根本不会生成）`).toContain(name);
    }
  });

  it('已迁移的三处选中态不再用旧 blue 色板，落到 accent 令牌', () => {
    // 1) 标签 chip 整份文件里不应再出现 blue 选中态（该文件只有 chip 一个颜色用途）
    const chip = read('components/board/LabelFilterBar.tsx');
    expect(chip, 'LabelFilterBar 仍有 bg-blue-/text-blue-').not.toMatch(/bg-blue-\d|text-blue-\d/);
    expect(chip).toContain('bg-accent-soft');
    expect(chip).toContain('text-accent');

    // 2) 创建方式 tabs：只看 mode===manual / mode===smart 那两行的选中态
    const dialog = read('components/topbar/NewIssueDialog.tsx');
    const modeLines = dialog.split('\n').filter((line) => (line.includes("mode === 'manual' ?") || line.includes("mode === 'smart' ?")) && line.includes('className'));
    expect(modeLines.length, '没找到创建方式 tab 的选中态行').toBe(2);
    for (const line of modeLines) {
      expect(line).toContain('bg-accent-soft');
      expect(line).toContain('text-accent');
      expect(line).not.toMatch(/bg-blue-\d|text-blue-\d/);
    }
  });

  it('语义色（类型标签 / Badge tone）保留多色相，但只用 Tailwind 内建色阶', () => {
    // 判定为「语义色」的两处：ChangelogTypeTag 的四类变更类型、Badge 的 tone 字典
    const tag = read('components/changelog/ChangelogTypeTag.tsx');
    expect(tag).toMatch(/新增: 'bg-green-100/);
    expect(tag).toMatch(/修复: 'bg-blue-100/);
    const badge = read('components/ui/Badge.tsx');
    expect(badge).toMatch(/blue: 'bg-blue-100/);
    // 这两处不引入自定义令牌，避免与 unslop accent 抢语义
    expect(tag).not.toContain('bg-accent-soft');
    expect(badge).not.toContain('bg-accent-soft');
  });
});
