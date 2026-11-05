/**
 * BOARD-COLS：看板列容器改 grid（列数取当前列数组长度，不写死 4）。
 * - 每列 `minmax(240px, 1fr)`：列少时撑满容器不留白，列多时保底 280px 并横向滚动；
 * - 列本身不再有固定宽度（移除 `w-64 shrink-0`）。
 * 真实布局宽度与横向滚动由 CDP 在浏览器验证（jsdom 无布局）。
 */
import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { HttpResponse, http } from 'msw';
import type { Issue } from '@agentboard/shared';
import { Board } from '../components/board/Board';
import { BOARD_COLUMNS } from '../lib/dnd';
import { useAppStore } from '../state/appStore';
import { server } from './server';

function newClient() {
  return new QueryClient({ defaultOptions: { queries: { retry: false } } });
}

function mockBoardData() {
  server.use(
    http.get('/api/issues', () => HttpResponse.json<Issue[]>([])),
    http.get('/api/sessions', () => HttpResponse.json([])),
  );
}

function renderBoard(node: React.ReactNode) {
  return render(<QueryClientProvider client={newClient()}>{node}</QueryClientProvider>);
}

describe('看板列容器（grid 自适应）', () => {
  it('列数取当前列数组长度：4 列 → repeat(4, minmax(240px, 1fr))', async () => {
    useAppStore.setState({ workspaceId: 'ws-1', selectedLabelsByWorkspace: {} });
    mockBoardData();
    renderBoard(<Board />);

    const container = await screen.findByTestId('board-columns');
    // STATUS-3-UI：列由 workspace_status 派生，未 mock 接口时用五条内置兜底
    expect(container.style.gridTemplateColumns).toBe('repeat(5, minmax(240px, 1fr))');
    // 横向滚动能力：列多时容器自己滚，不挤压列
    expect(container.className).toContain('grid');
    expect(container.className).toContain('overflow-x-auto');
    // 每列仍是当前列数组里的状态
    for (const status of BOARD_COLUMNS) {
      expect(screen.getByTestId(`column-${status}`)).toBeInTheDocument();
    }
  });

  it('列不再写死宽度（无 w-64 / shrink-0），宽度由 grid 轨道决定', async () => {
    useAppStore.setState({ workspaceId: 'ws-1', selectedLabelsByWorkspace: {} });
    mockBoardData();
    renderBoard(<Board />);

    const column = await screen.findByTestId('column-待规划');
    expect(column.className).not.toContain('w-64');
    expect(column.className).not.toContain('shrink-0');
    expect(column.className).toContain('min-w-0');
  });
});
