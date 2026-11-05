/**
 * BOARD-COLS：列数变化时模板跟着变（STATUS-1 会给看板加第 5 个内置列「已废弃」）。
 * 这里把 BOARD_COLUMNS mock 成 5 项，验证 grid 模板取的是「当前列数组长度」而不是写死的 4。
 * 注意：`groupByColumn` 内部仍硬编码 4 个键（属 lib/dnd.ts，STATUS-1 负责同步），这里一并 mock 成 5 列分组。
 */
import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { HttpResponse, http } from 'msw';
import type { Issue } from '@agentboard/shared';
import { Board } from '../components/board/Board';
import { useAppStore } from '../state/appStore';
import { server } from './server';

vi.mock('../lib/dnd', async () => {
  const actual = await vi.importActual<typeof import('../lib/dnd')>('../lib/dnd');
  const COLUMNS = [...actual.BOARD_COLUMNS, '已废弃'] as unknown as typeof actual.BOARD_COLUMNS;
  return {
    ...actual,
    BOARD_COLUMNS: COLUMNS,
    groupByColumn: (issues: Issue[]) => {
      const grouped: Record<string, Issue[]> = {};
      for (const status of COLUMNS as unknown as string[]) grouped[status] = [];
      for (const issue of issues) (grouped[issue.status] ??= []).push(issue);
      for (const list of Object.values(grouped)) list.sort((a, b) => a.sort_order - b.sort_order);
      return grouped as unknown as ReturnType<typeof actual.groupByColumn>;
    },
  };
});

describe('看板列容器（5 列）', () => {
  it('列数组有 5 项时模板变成 repeat(5, minmax(240px, 1fr))', async () => {
    server.use(
      http.get('/api/issues', () => HttpResponse.json<Issue[]>([])),
      http.get('/api/sessions', () => HttpResponse.json([])),
    );
    useAppStore.setState({ workspaceId: 'ws-1', selectedLabelsByWorkspace: {} });
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={qc}>
        <Board />
      </QueryClientProvider>,
    );

    const container = await screen.findByTestId('board-columns');
    expect(container.style.gridTemplateColumns).toBe('repeat(5, minmax(240px, 1fr))');
    expect(screen.getByTestId('column-已废弃')).toBeInTheDocument();
    expect(screen.getByTestId('column-已关闭')).toBeInTheDocument();
  });
});
