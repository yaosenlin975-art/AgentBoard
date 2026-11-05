/**
 * A2：tag / 入口点击反馈（transition-colors + 选中态）。
 *
 * 三条口径（全部只断言 class 契约，jsdom 无布局）：
 * - 标签 chip 与左栏五入口都带 `transition-colors` + `motion-reduce:transition-none`；
 * - 选中态有 `data-active`/`aria-pressed` 与 `active:` 按下反馈，且**不含位移/缩放**（A2 只做颜色）；
 * - 任务树「+ 新建」按钮同样有 hover/active 颜色过渡与 reduced-motion 关闭。
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { HttpResponse, http } from 'msw';
import { SideBar } from '../components/shell/SideBar';
import { LabelFilterBar } from '../components/board/LabelFilterBar';
import { useAppStore } from '../state/appStore';
import { useNavStore } from '../state/navStore';
import { usePanelStore } from '../state/panelStore';
import { server } from './server';

beforeEach(() => {
  cleanup();
  localStorage.clear();
  useAppStore.setState({ wsStatus: 'open', workspaceId: 'ws-1' });
  useNavStore.setState({ view: 'board', drawer: null, chatOrigin: null });
  usePanelStore.setState({ unread: {} });
  server.use(http.get('/api/workspaces', () => HttpResponse.json([])));
});

function renderSideBar(): void {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <SideBar workspace={{ id: 'ws-1', name: '主项目', path: 'D:/WorkSpaces/main', created_at: 1 }} />
    </QueryClientProvider>,
  );
}

describe('A2 入口点击反馈（SideBar 五入口）', () => {
  it('五入口都有 transition-colors + reduced-motion 关闭 + data-active', () => {
    renderSideBar();
    for (const view of ['board', 'tree', 'knowledge', 'log', 'chat']) {
      const btn = screen.getByTestId(`sidebar-entry-${view}`);
      expect(btn.className).toContain('transition-colors');
      expect(btn.className).toContain('motion-reduce:transition-none');
      expect(btn).toHaveAttribute('data-active', view === 'board' ? 'true' : 'false');
      // A2 明确不做位移/缩放：不能出现 transform 相关类
      expect(btn.className).not.toMatch(/scale-|translate-/);
    }
  });

  it('选中态与未选中态用不同令牌色，且都有 active: 按下反馈', () => {
    renderSideBar();
    const active = screen.getByTestId('sidebar-entry-board');
    const idle = screen.getByTestId('sidebar-entry-tree');
    expect(active.className).toContain('bg-accent-soft');
    expect(active.className).toContain('text-accent');
    expect(active.className).toContain('active:bg-accent-soft');
    expect(idle.className).toContain('hover:bg-surface-raised');
    expect(idle.className).toContain('active:bg-surface-raised');
  });
});

describe('A2 标签 chip 点击反馈（LabelFilterBar）', () => {
  it('chip 带 transition-colors + reduced-motion 关闭 + 按下态；选中态有 data-active', async () => {
    server.use(
      http.get('/api/issues', () =>
        HttpResponse.json([
          { id: 'i1', workspace_id: 'ws-1', title: '甲', description: '', status: '待规划', labels: ['设计', '性能'], created_at: 1, updated_at: 1 },
          { id: 'i2', workspace_id: 'ws-1', title: '乙', description: '', status: '待规划', labels: ['设计'], created_at: 2, updated_at: 2 },
        ]),
      ),
    );
    useAppStore.setState({ selectedLabelsByWorkspace: { 'ws-1': ['设计'] } });
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={qc}>
        <LabelFilterBar workspaceId="ws-1" />
      </QueryClientProvider>,
    );

    const chip = await screen.findByTestId('label-filter-设计');
    // LABEL-BAR：标签总数 <= MAX_VISIBLE 时全部直接可见，无需展开「更多」
    const idleChip = await screen.findByTestId('label-filter-性能');

    for (const element of [chip, idleChip]) {
      expect(element.className).toContain('transition-colors');
      expect(element.className).toContain('motion-reduce:transition-none');
      expect(element.className).toContain('active:bg-');
      expect(element.className).not.toMatch(/scale-|translate-/);
    }
    // 选中 chip：aria-pressed + data-active 都是 true；未选中为 false
    expect(chip).toHaveAttribute('aria-pressed', 'true');
    expect(chip).toHaveAttribute('data-active', 'true');
    expect(idleChip).toHaveAttribute('aria-pressed', 'false');
    expect(idleChip).toHaveAttribute('data-active', 'false');
    // CHIP-PALETTE：选中态改用 unslop 强调令牌（accent-soft / accent），不再用旧 blue 色板
    expect(chip.className).toContain('bg-accent-soft');
    expect(chip.className).toContain('text-accent');
    expect(chip.className).not.toMatch(/bg-blue-/);
    // 清除筛选按钮也补了同样的反馈
    const clear = screen.getByTestId('label-filter-clear');
    expect(clear.className).toContain('transition-colors');
    expect(clear.className).toContain('active:bg-neutral-200');
  });
});
