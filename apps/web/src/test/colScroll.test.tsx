/**
 * COL-SCROLL 回归：平铺看板列内纵向滚动。
 *
 * 机型：grid 容器原先用默认 `grid-auto-rows: auto`，隐式行按内容 max-content 撑高（实测 15089px），
 * 列内 `overflow-y-auto` 因此永远没有可滚动溢出（scrollHeight == clientHeight），超长内容被外层
 * `overflow-y-hidden` 裁掉 —— 滚轮完全没反应。修复 = 行高钉成 minmax(0,1fr)（`auto-rows-fr`）
 * + 列自身 `min-h-0`，让列内滚动容器真正受限。
 *
 * jsdom 不做布局，这里断言「决定高度约束的那两条 class」，真实像素由 CDP 实测保证。
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { HttpResponse, http } from 'msw';
import type { Issue } from '@agentboard/shared';
import { Board } from '../components/board/Board';
import { useAppStore } from '../state/appStore';
import { server } from './server';

function makeIssue(id: string, overrides: Partial<Issue> = {}): Issue {
  return {
    id,
    workspace_id: 'ws-1',
    title: `任务${id}`,
    description: '',
    priority: '中',
    labels: [],
    status: '待规划',
    sort_order: 0,
    parent_issue_id: null,
    claimed_by: null,
    claimed_at: null,
    session_id: null,
    comment_count: 0,
    created_at: 1,
    updated_at: 1,
    ...overrides,
  };
}

function renderBoard(): void {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <Board layout="board" onLayout={() => undefined} knowledgeOpen={false} onToggleKnowledge={() => undefined} />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  localStorage.clear();
  useAppStore.setState({ workspaceId: 'ws-1' });
  server.use(
    http.get('/api/issues', () => HttpResponse.json([makeIssue('a'), makeIssue('b', { sort_order: 1000 })])),
    http.get('/api/sessions', () => HttpResponse.json([])),
    http.get('/api/workspaces', () => HttpResponse.json([{ id: 'ws-1', name: '主项目', path: 'D:/ws/main', created_at: 1 }])),
  );
});

describe('看板列内纵向滚动（COL-SCROLL）', () => {
  it('列容器行高被钉成 minmax(0,1fr)，列自身 min-h-0 —— 列内滚动容器才受高度约束', async () => {
    renderBoard();
    const grid = await screen.findByTestId('board-columns');

    // 隐式行若保持 auto，行高会跟内容 max-content 走，列内 overflow-y-auto 无溢出可滚
    expect(grid.className).toContain('auto-rows-fr');
    // 列少时仍撑满、列多时横向滚动（BOARD-COLS 行为不能丢）
    expect(grid.className).toContain('overflow-x-auto');

    const column = screen.getByTestId('column-待规划');
    expect(column.className).toContain('min-h-0');
    // 列内滚动容器保留纵向滚动
    const scroller = column.children[1] as HTMLElement;
    expect(scroller.className).toContain('overflow-y-auto');
    expect(scroller.className).toContain('flex-1');
  });
});
