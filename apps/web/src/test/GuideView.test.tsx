/**
 * GUIDE-1：教程视图骨架。
 * 断言：目录项与章节一一对应且按 order 排序；每章都有可执行的 steps；goTo 真的切视图。
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { GUIDE_CHAPTERS, GuideView } from '../components/guide/GuideView';
import { useNavStore } from '../state/navStore';

beforeEach(() => {
  cleanup();
  useNavStore.setState({ view: 'guide' });
});

describe('GuideView', () => {
  it('目录项 = 章节数，且按 order 升序渲染', () => {
    render(<GuideView />);
    expect(GUIDE_CHAPTERS.length).toBeGreaterThan(0);

    const tocItems = GUIDE_CHAPTERS.map((chapter) => screen.getByTestId(`guide-toc-${chapter.id}`));
    expect(tocItems).toHaveLength(GUIDE_CHAPTERS.length);

    const orders = GUIDE_CHAPTERS.map((chapter) => chapter.order);
    expect(orders).toEqual([...orders].sort((a, b) => a - b));

    // 正文顺序与目录同源
    const renderedTitles = screen
      .getAllByRole('heading', { level: 2 })
      .map((heading) => heading.textContent ?? '');
    GUIDE_CHAPTERS.forEach((chapter, index) => {
      expect(renderedTitles[index]).toContain(chapter.title);
    });
  });

  it('每章至少有一个 steps 块，且每条 do 非空', () => {
    render(<GuideView />);
    for (const chapter of GUIDE_CHAPTERS) {
      const steps = chapter.blocks.filter((block) => block.kind === 'steps');
      expect(steps.length, `${chapter.id} 缺少 steps`).toBeGreaterThan(0);
      const items = steps.flatMap((block) => (block.kind === 'steps' ? block.items : []));
      expect(items.length, `${chapter.id} 的 steps 为空`).toBeGreaterThan(0);
      for (const item of items) {
        expect(item.do.trim(), `${chapter.id} 有空的步骤文案`).not.toBe('');
      }
    }
  });

  it('章末「去任务看板」把导航切回看板', () => {
    render(<GuideView />);
    expect(useNavStore.getState().view).toBe('guide');
    fireEvent.click(screen.getByTestId('guide-goto-overview'));
    expect(useNavStore.getState().view).toBe('board');
  });

  it('G1 两栏独立滚动：根撑满高度，左栏固定宽、右栏自滚', () => {
    render(<GuideView />);
    const root = screen.getByTestId('guide-view');
    expect(root.className).toContain('h-full');
    expect(root.className).toContain('min-h-0');
    expect(root.className).toContain('lg:flex-row');
    // 去掉居中最宽，避免两栏固定后宽屏两侧留白
    expect(root.className).not.toContain('mx-auto');
    expect(root.className).not.toContain('max-w-[1100px]');

    const nav = screen.getByLabelText('教程目录');
    expect(nav.tagName).toBe('NAV');
    expect(nav.className).toContain('lg:w-[240px]');
    expect(nav.className).toContain('lg:overflow-y-auto');
    expect(nav.className).toContain('lg:border-r');
    // 窄屏仍是横向 chip 行
    expect(nav.querySelector('ul')?.className).toContain('overflow-x-auto');
    expect(nav.querySelector('ul')?.className).toContain('lg:flex-col');

    const content = root.lastElementChild as HTMLElement;
    expect(content.className).toContain('overflow-y-auto');
    expect(content.className).toContain('min-w-0');
    expect(content.className).toContain('flex-1');
    expect(content.className).toContain('space-y-8');
  });
});
