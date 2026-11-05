/**
 * 工作空间拖拽排序（WS-REORDER）：排序口径、乐观更新、权威覆盖、失败回滚、409 集合冲突提示、键盘上/下移。
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { HttpResponse, http } from 'msw';
import type { Workspace } from '@agentboard/shared';
import { WorkspaceList } from '../components/workspace/WorkspaceList';
import { commitWorkspaceOrder, moveWorkspace, sortWorkspaces, WORKSPACES_KEY } from '../lib/workspaceReorder';
import { server } from './server';

const wsA: Workspace = { id: 'a1', name: '甲', path: 'D:\\a', created_at: 3, sort_order: 0 };
const wsB: Workspace = { id: 'b2', name: '乙', path: 'D:\\b', created_at: 1, sort_order: 1 };
const wsC: Workspace = { id: 'c3', name: '丙', path: 'D:\\c', created_at: 2, sort_order: 2 };

function newClient() {
  return new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
}

beforeEach(() => {
  server.resetHandlers();
});

describe('workspaceReorder 纯函数', () => {
  it('按 sort_order 排序，缺失时按 created_at、id 兜底', () => {
    const sorted = sortWorkspaces([
      { ...wsA, sort_order: 2 },
      { ...wsB, sort_order: undefined },
      { ...wsC, sort_order: 1 },
    ]);
    expect(sorted.map((w) => w.id)).toEqual(['b2', 'c3', 'a1']);
  });

  it('moveWorkspace 前移/后移/越界不变', () => {
    const list = [wsA, wsB, wsC];
    expect(moveWorkspace(list, 0, 2).map((w) => w.id)).toEqual(['b2', 'c3', 'a1']);
    expect(moveWorkspace(list, 2, 0).map((w) => w.id)).toEqual(['c3', 'a1', 'b2']);
    expect(moveWorkspace(list, 1, 1).map((w) => w.id)).toEqual(['a1', 'b2', 'c3']);
    expect(moveWorkspace(list, 0, 9).map((w) => w.id)).toEqual(['a1', 'b2', 'c3']);
  });
});

describe('commitWorkspaceOrder', () => {
  it('成功：请求带 Idempotency-Key 与全部 id，并用响应整体覆盖缓存', async () => {
    const qc = newClient();
    qc.setQueryData<Workspace[]>(WORKSPACES_KEY, [wsA, wsB, wsC]);
    let key: string | null = null;
    let body: unknown = null;
    server.use(
      http.post('/api/workspaces/reorder', async ({ request }) => {
        key = request.headers.get('Idempotency-Key');
        body = await request.json();
        // 服务端返回权威顺序：丙、甲、乙
        return HttpResponse.json({ workspaces: [{ ...wsC, sort_order: 0 }, { ...wsA, sort_order: 1 }, { ...wsB, sort_order: 2 }], reordered_at: 1 });
      }),
    );

    const outcome = await commitWorkspaceOrder(qc, [wsC, wsA, wsB], 'key-1');
    expect(outcome).toEqual({ ok: true, message: null });
    expect(key).toBe('key-1');
    expect(body).toEqual({ ordered_ids: ['c3', 'a1', 'b2'] });
    expect(qc.getQueryData<Workspace[]>(WORKSPACES_KEY)?.map((w) => w.id)).toEqual(['c3', 'a1', 'b2']);
  });

  it('失败：回滚到快照并提示（不留脏顺序）', async () => {
    const qc = newClient();
    qc.setQueryData<Workspace[]>(WORKSPACES_KEY, [wsA, wsB, wsC]);
    server.use(
      http.post('/api/workspaces/reorder', () => HttpResponse.json({ error: { code: 'INTERNAL', message: '写库失败' } }, { status: 500 })),
      http.get('/api/workspaces', () => HttpResponse.json([wsA, wsB, wsC])),
    );

    const outcome = await commitWorkspaceOrder(qc, [wsC, wsA, wsB], 'key-2');
    expect(outcome.ok).toBe(false);
    expect(outcome.message).toContain('写库失败');
    expect(qc.getQueryData<Workspace[]>(WORKSPACES_KEY)?.map((w) => w.id)).toEqual(['a1', 'b2', 'c3']);
  });

  it('409 WORKSPACE_SET_CHANGED：回滚并提示刷新，不重试', async () => {
    const qc = newClient();
    qc.setQueryData<Workspace[]>(WORKSPACES_KEY, [wsA, wsB, wsC]);
    let calls = 0;
    server.use(
      http.post('/api/workspaces/reorder', () => {
        calls += 1;
        return HttpResponse.json({ error: { code: 'WORKSPACE_SET_CHANGED', message: '集合已变化', details: { missing: ['d4'], extra: [] } } }, { status: 409 });
      }),
      http.get('/api/workspaces', () => HttpResponse.json([wsA, wsB, wsC])),
    );

    const outcome = await commitWorkspaceOrder(qc, [wsC, wsA, wsB], 'key-3');
    expect(outcome.ok).toBe(false);
    expect(outcome.message).toContain('列表已变化');
    expect(outcome.message).toContain('刷新');
    expect(calls).toBe(1);
    expect(qc.getQueryData<Workspace[]>(WORKSPACES_KEY)?.map((w) => w.id)).toEqual(['a1', 'b2', 'c3']);
  });
});

describe('WorkspaceList 排序交互', () => {
  it('键盘上/下移改变顺序并发出 reorder 请求（带幂等键）', async () => {
    let body: unknown = null;
    let key: string | null = null;
    server.use(
      http.get('/api/workspaces', () => HttpResponse.json([wsA, wsB, wsC])),
      http.get('/api/issues', () => HttpResponse.json([])),
      http.post('/api/workspaces/reorder', async ({ request }) => {
        key = request.headers.get('Idempotency-Key');
        body = await request.json();
        return HttpResponse.json({ workspaces: [{ ...wsB, sort_order: 0 }, { ...wsA, sort_order: 1 }, { ...wsC, sort_order: 2 }], reordered_at: 1 });
      }),
    );
    render(
      <QueryClientProvider client={newClient()}>
        <WorkspaceList />
      </QueryClientProvider>,
    );

    const rowB = await screen.findByTestId('workspace-row-b2');
    expect(rowB).toBeInTheDocument();
    // 乙上移到第一位（I-11：上移/下移在卡面 ⋮ 菜单里）
    await userEvent.click(within(rowB).getByTestId('workspace-card-menu-b2'));
    await userEvent.click(within(rowB).getByTestId('workspace-move-up-b2'));
    await waitFor(() => expect(body).toEqual({ ordered_ids: ['b2', 'a1', 'c3'] }));
    expect(key).toBeTruthy();
    const rows = [...document.querySelectorAll('[data-testid^="workspace-row-"]')].map((n) => n.getAttribute('data-testid'));
    await waitFor(() => expect(rows).toEqual(['workspace-row-b2', 'workspace-row-a1', 'workspace-row-c3']));
  });

  it('首项「上移」与末项「下移」禁用', async () => {
    server.use(
      http.get('/api/workspaces', () => HttpResponse.json([wsA, wsB, wsC])),
      http.get('/api/issues', () => HttpResponse.json([])),
    );
    render(
      <QueryClientProvider client={newClient()}>
        <WorkspaceList />
      </QueryClientProvider>,
    );
    await screen.findByTestId('workspace-row-a1');
    // I-11：菜单是每卡独立浮层，逐张开菜单再断言禁用态
    await userEvent.click(screen.getByTestId('workspace-card-menu-a1'));
    expect(screen.getByTestId('workspace-move-up-a1')).toBeDisabled();
    expect(screen.getByTestId('workspace-move-down-a1')).toBeEnabled();
    await userEvent.click(screen.getByTestId('workspace-card-menu-a1'));
    await userEvent.click(screen.getByTestId('workspace-card-menu-c3'));
    expect(screen.getByTestId('workspace-move-down-c3')).toBeDisabled();
    expect(screen.getByTestId('workspace-move-up-c3')).toBeEnabled();
  });

  it('排序失败显示提示且顺序保持原样', async () => {
    server.use(
      http.get('/api/workspaces', () => HttpResponse.json([wsA, wsB, wsC])),
      http.get('/api/issues', () => HttpResponse.json([])),
      http.post('/api/workspaces/reorder', () => HttpResponse.json({ error: { code: 'INTERNAL', message: '写库失败' } }, { status: 500 })),
    );
    render(
      <QueryClientProvider client={newClient()}>
        <WorkspaceList />
      </QueryClientProvider>,
    );
    await screen.findByTestId('workspace-row-b2');
    await userEvent.click(screen.getByTestId('workspace-card-menu-b2'));
    await userEvent.click(screen.getByTestId('workspace-move-up-b2'));
    expect(await screen.findByTestId('workspace-order-notice')).toHaveTextContent('写库失败');
    await waitFor(() => {
      const rows = [...document.querySelectorAll('[data-testid^="workspace-row-"]')].map((n) => n.getAttribute('data-testid'));
      expect(rows).toEqual(['workspace-row-a1', 'workspace-row-b2', 'workspace-row-c3']);
    });
  });
});
