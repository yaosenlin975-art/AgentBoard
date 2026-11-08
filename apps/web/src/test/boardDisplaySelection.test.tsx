/**
 * BORROW-1.1：看板显示偏好（密度/分组）持久化 + 两段式选择（先范围后卡片）与批量改状态。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { HttpResponse, http, delay } from 'msw';
import type { Issue } from '@agentboard/shared';
import { Board } from '../components/board/Board';
import { useAppStore } from '../state/appStore';
import { useNavStore } from '../state/navStore';
import { usePanelStore } from '../state/panelStore';
import { server } from './server';

const STORAGE_KEY = 'agentboard.board.displayOptions.v1';

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

const issues: Issue[] = [
  makeIssue('i1', { labels: ['前端'], sort_order: 0 }),
  makeIssue('i2', { labels: ['后端'], sort_order: 1000 }),
  makeIssue('i3', { status: '已关闭', sort_order: 0 }),
];

function mockBoardData(): void {
  server.use(
    http.get('/api/issues', () => HttpResponse.json(issues)),
    http.get('/api/sessions', () => HttpResponse.json([])),
  );
}

function renderBoard() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <Board />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  localStorage.clear();
  useAppStore.setState({ workspaceId: 'ws-1', selectedLabelsByWorkspace: {} });
  useNavStore.setState({ view: 'board', chatOrigin: null });
  usePanelStore.setState({ view: null, issueId: null, sessionId: null, chatSession: null, unread: {} });
  mockBoardData();
});

describe('显示偏好（密度 / 分组）', () => {
  it('切换密度与分组后写入 localStorage，重新挂载仍保持', async () => {
    const first = renderBoard();
    await screen.findByTestId('issue-card-i1');

    await userEvent.selectOptions(screen.getByTestId('display-density'), 'compact');
    await userEvent.selectOptions(screen.getByTestId('display-grouping'), 'label');
    expect(JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '{}')).toEqual({ density: 'compact', grouping: 'label' });

    // 分组：待规划列内按首个标签分段
    expect(screen.getByTestId('board-group-待规划-前端')).toBeInTheDocument();
    expect(screen.getByTestId('board-group-待规划-后端')).toBeInTheDocument();

    first.unmount();
    renderBoard();
    await screen.findByTestId('issue-card-i1');
    expect(screen.getByTestId('display-density')).toHaveValue('compact');
    expect(screen.getByTestId('display-grouping')).toHaveValue('label');
    expect(screen.getByTestId('board-group-待规划-前端')).toBeInTheDocument();
  });
});

describe('两段式选择与批量操作', () => {
  it('先选范围再选卡：范围外卡片不可勾选；批量改状态逐张 PATCH 并清空选择', async () => {
    const patches: Array<{ id: string; body: unknown }> = [];
    server.use(
      http.patch('/api/issues/:id', async ({ params, request }) => {
        const body = await request.json();
        patches.push({ id: String(params.id), body });
        return HttpResponse.json({ ...issues.find((issue) => issue.id === params.id)!, status: '已关闭' });
      }),
    );
    renderBoard();
    await screen.findByTestId('issue-card-i1');

    await userEvent.click(screen.getByTestId('board-select-toggle'));
    expect(await screen.findByTestId('selection-bar')).toBeInTheDocument();
    // 第 1 步：还没选范围，任何卡都没有勾选入口
    expect(screen.queryByTestId('card-select-i1')).toBeNull();

    await userEvent.click(screen.getByTestId('selection-scope-column-待规划'));
    expect(screen.getByTestId('selection-stage')).toHaveTextContent('列：待规划');
    expect(screen.getByTestId('card-select-i1')).toBeInTheDocument();
    expect(screen.getByTestId('card-select-i2')).toBeInTheDocument();
    // 范围外（已关闭列）的卡片不可勾选
    expect(screen.queryByTestId('card-select-i3')).toBeNull();

    await userEvent.click(screen.getByTestId('issue-card-i1'));
    expect(screen.getByTestId('selection-count')).toHaveTextContent('已选 1 / 2');
    // 选择模式下点击卡片只勾选，不打开详情
    expect(usePanelStore.getState().view).toBeNull();

    await userEvent.click(screen.getByTestId('selection-select-all'));
    expect(screen.getByTestId('selection-count')).toHaveTextContent('已选 2 / 2');

    await userEvent.selectOptions(screen.getByTestId('selection-batch-status'), '已关闭');
    await userEvent.click(screen.getByTestId('selection-batch-apply'));
    await waitFor(() => expect(patches).toHaveLength(2));
    expect(patches.map((patch) => patch.id).sort()).toEqual(['i1', 'i2']);
    for (const patch of patches) expect(patch.body).toEqual({ status: '已关闭' });

    await waitFor(() => expect(screen.getByTestId('selection-count')).toHaveTextContent('已选 0 / 2'));
    expect(screen.getByTestId('selection-bar')).toBeInTheDocument();
  });

  it('退出选择后恢复普通点击打开详情', async () => {
    renderBoard();
    await screen.findByTestId('issue-card-i1');
    await userEvent.click(screen.getByTestId('board-select-toggle'));
    await userEvent.click(screen.getByTestId('selection-close'));
    expect(screen.queryByTestId('selection-bar')).toBeNull();

    await userEvent.click(screen.getByTestId('issue-card-i1'));
    expect(usePanelStore.getState()).toMatchObject({ view: 'detail', issueId: 'i1' });
  });

  it('DETAIL-HIGHLIGHT：详情打开高亮与批量勾选同时命中不互相抹掉', async () => {
    renderBoard();
    await screen.findByTestId('issue-card-i1');

    // 先打开 i1 详情 → 卡片进入选中态
    await userEvent.click(screen.getByTestId('issue-card-i1'));
    expect(usePanelStore.getState()).toMatchObject({ view: 'detail', issueId: 'i1' });
    expect(screen.getByTestId('issue-card-i1')).toHaveAttribute('data-selected', 'true');
    expect(screen.getByTestId('issue-card-i1')).toHaveClass('border-accent', 'bg-accent-soft/40');

    // 进入选择模式并勾选 i1：勾选框生效（selected 驱动），高亮不被抹掉
    await userEvent.click(screen.getByTestId('board-select-toggle'));
    await userEvent.click(screen.getByTestId('selection-scope-column-待规划'));
    await userEvent.click(screen.getByTestId('issue-card-i1'));
    expect(screen.getByTestId('selection-count')).toHaveTextContent('已选 1 / 2');
    expect(screen.getByTestId('issue-card-i1')).toHaveAttribute('data-selected', 'true');
    expect(screen.getByTestId('issue-card-i1')).toHaveClass('border-accent', 'bg-accent-soft/40');
  });
});

describe('批量改状态：并发上限与部分失败收敛（CR-4）', () => {
  it('第 3 张卡 409：其余卡全部落库，失败卡保留选中并逐条展示原因，列表缓存刷新', async () => {
    const batch = ['i1', 'i2', 'i3', 'i4', 'i5'].map((id) => makeIssue(id));
    const succeeded: string[] = [];
    const attempted: string[] = [];
    const issueFetches: string[] = [];
    server.use(
      http.get('/api/issues', ({ request }) => {
        issueFetches.push(request.url);
        return HttpResponse.json(batch);
      }),
      http.get('/api/sessions', () => HttpResponse.json([])),
      http.patch('/api/issues/:id', async ({ params }) => {
        const id = String(params.id);
        attempted.push(id);
        if (id === 'i3') {
          return HttpResponse.json(
            { error: { code: 'ISSUE_CLAIMED', message: '任务正被其他代理占用' } },
            { status: 409 },
          );
        }
        succeeded.push(id);
        return HttpResponse.json({ ...batch.find((issue) => issue.id === id)!, status: '已关闭' });
      }),
    );
    renderBoard();
    await screen.findByTestId('issue-card-i1');

    await userEvent.click(screen.getByTestId('board-select-toggle'));
    await userEvent.click(screen.getByTestId('selection-scope-column-待规划'));
    await userEvent.click(screen.getByTestId('selection-select-all'));
    expect(screen.getByTestId('selection-count')).toHaveTextContent('已选 5 / 5');

    await userEvent.selectOptions(screen.getByTestId('selection-batch-status'), '已关闭');
    await userEvent.click(screen.getByTestId('selection-batch-apply'));

    // 全部 5 张都被尝试（包括失败的 i3），其余 4 张成功落库
    await waitFor(() => expect(attempted).toHaveLength(5));
    expect(attempted).toContain('i3');
    expect(succeeded.sort()).toEqual(['i1', 'i2', 'i4', 'i5']);

    // 失败卡保留在选中态；横幅逐条列出原因
    await waitFor(() => expect(screen.getByTestId('selection-count')).toHaveTextContent('已选 1 / 5'));
    const banner = await screen.findByRole('alert');
    expect(banner).toHaveTextContent('成功 4 张，失败 1 张');
    expect(banner).toHaveTextContent('任务i3：任务正被其他代理占用');

    // 无论成败统一 invalidate：初次拉取后又刷新了一次列表
    await waitFor(() => expect(issueFetches.length).toBeGreaterThanOrEqual(2));
  });

  it('20 张卡批量改状态：并发不超过 6 且全部落库', async () => {
    const batch = Array.from({ length: 20 }, (_, index) => makeIssue(`i${index + 1}`));
    const patches: string[] = [];
    let inflight = 0;
    let maxInflight = 0;
    server.use(
      http.get('/api/issues', () => HttpResponse.json(batch)),
      http.get('/api/sessions', () => HttpResponse.json([])),
      http.patch('/api/issues/:id', async ({ params }) => {
        inflight += 1;
        maxInflight = Math.max(maxInflight, inflight);
        await delay(15);
        patches.push(String(params.id));
        inflight -= 1;
        return HttpResponse.json({});
      }),
    );
    renderBoard();
    await screen.findByTestId('issue-card-i1');

    await userEvent.click(screen.getByTestId('board-select-toggle'));
    await userEvent.click(screen.getByTestId('selection-scope-column-待规划'));
    await userEvent.click(screen.getByTestId('selection-select-all'));
    await userEvent.selectOptions(screen.getByTestId('selection-batch-status'), '已关闭');
    await userEvent.click(screen.getByTestId('selection-batch-apply'));

    await waitFor(() => expect(patches).toHaveLength(20));
    expect(maxInflight).toBeLessThanOrEqual(6);
    // 全部成功 → 选择清空
    await waitFor(() => expect(screen.getByTestId('selection-count')).toHaveTextContent('已选 0 / 20'));
  });
});
