/**
 * PALETTE-BOARD-LOG：看板/日志/工作区/知识库旧色板清剿的守卫测试。
 *
 * 读源码文本断言（与 `tokenMapping.test.ts` 同一手法）：这些组件是纯类名收敛，
 * 渲染断言看不出「改回了 blue-600」这类回退，所以直接钉源码。
 * 指定排除项（多色相类型标签、被既有守卫钉住的 chip 按下态）不在本文件断言范围。
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// vitest 的 cwd 是 apps/web，源码路径以仓库根书写，这里向上退两级
const ROOT = join(process.cwd(), '..', '..');
const read = (relative: string): string => readFileSync(join(ROOT, relative), 'utf8');

/** 遗留调色板类：带色阶号的 blue/green/purple/indigo/neutral/gray/slate 或 bg-white */
const LEGACY = /(?<![\w:-])(?:bg|text|border|divide|ring|outline|decoration)-(?:blue|green|purple|indigo|neutral|gray|slate)-\d{2,3}|bg-white/g;

describe('旧色板已收敛到令牌（读源码）', () => {
  const files = [
    'apps/web/src/components/board/IssueTreeView.tsx',
    'apps/web/src/components/board/PlanningSortButton.tsx',
    'apps/web/src/components/changelog/ArchivedChangelogPanel.tsx',
    'apps/web/src/components/changelog/ChangelogEntryForm.tsx',
    'apps/web/src/components/changelog/ChangelogTimeline.tsx',
    'apps/web/src/components/workspace/NewWorkspaceDialog.tsx',
    'apps/web/src/components/workspace/RemoveWorkspaceDialog.tsx',
    'apps/web/src/components/knowledge/KnowledgePanel.tsx',
    'apps/web/src/components/right/RightPanel.tsx',
    'apps/web/src/lib/markdownLinks.tsx',
  ];

  for (const file of files) {
    it(`${file} 无遗留调色板类`, () => {
      const source = read(file);
      const hits = source.match(LEGACY) ?? [];
      expect(hits, `仍有：${hits.join(', ')}`).toEqual([]);
    });
  }

  it('任务树：领取按钮=accent/accent-soft，领取徽标=accent-soft+accent，提交=accent+accent-ink', () => {
    const tree = read('apps/web/src/components/board/IssueTreeView.tsx');
    expect(tree).toContain('text-accent hover:bg-accent-soft');
    expect(tree).toMatch(/tree-claim[\s\S]{0,240}bg-accent-soft[\s\S]{0,80}text-accent/);
    expect(tree).toContain('bg-accent px-2.5 py-1.5');
    expect(tree).toContain('text-accent-ink');
  });

  it('日志：选中行=accent-soft、标题 hover=accent、输入 focus=accent、提示条用令牌', () => {
    const archived = read('apps/web/src/components/changelog/ArchivedChangelogPanel.tsx');
    expect(archived).toContain('bg-accent-soft');
    const timeline = read('apps/web/src/components/changelog/ChangelogTimeline.tsx');
    expect(timeline).toContain('hover:text-accent');
    const form = read('apps/web/src/components/changelog/ChangelogEntryForm.tsx');
    expect(form).toContain('focus:border-accent');
  });

  it('排序按钮 hover 收敛到 accent（不再 hover:text-blue-* / hover:bg-white）', () => {
    const sort = read('apps/web/src/components/board/PlanningSortButton.tsx');
    expect(sort).toContain('hover:text-accent');
    expect(sort).toContain('hover:bg-surface-card');
  });

  it('markdown 链接的类型图标用 accent', () => {
    expect(read('apps/web/src/lib/markdownLinks.tsx')).toContain('text-accent');
  });
});
