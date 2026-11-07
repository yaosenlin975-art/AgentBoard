import { beforeEach, describe, expect, it } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { HttpResponse, http } from 'msw';import type { Issue, Workspace } from '@agentboard/shared';
import { WorkspaceList } from '../components/workspace/WorkspaceList';
import { useAppStore } from '../state/appStore';
import { server } from './server';

const ws1: Workspace = { id: 'ws-1', name: '主项目', path: 'D:/WorkSpaces/main', created_at: 1 };
const ws2: Workspace = { id: 'ws-2', name: '副项目', path: 'D:/WorkSpaces/second', created_at: 2 };

const issuesWs1: Issue[] = [
  { id: 'i1', workspace_id: 'ws-1', title: 'a', description: '', priority: '中', labels: [], status: '待规划', sort_order: 0, parent_issue_id: null, claimed_by: null, claimed_at: null, session_id: null, comment_count: 0, created_at: 1, updated_at: 1 },
  { id: 'i2', workspace_id: 'ws-1', title: 'b', description: '', priority: '低', labels: [], status: '待规划', sort_order: 1, parent_issue_id: null, claimed_by: null, claimed_at: null, session_id: null, comment_count: 0, created_at: 2, updated_at: 2 },
  { id: 'i3', workspace_id: 'ws-1', title: 'c', description: '', priority: '高', labels: [], status: '进行中', sort_order: 2, parent_issue_id: null, claimed_by: 'agent:codex', claimed_at: 3, session_id: 's-1', comment_count: 0, created_at: 3, updated_at: 3 },
  { id: 'i4', workspace_id: 'ws-1', title: 'd', description: '', priority: '中', labels: [], status: '已关闭', sort_order: 3, parent_issue_id: null, claimed_by: null, claimed_at: null, session_id: null, comment_count: 0, created_at: 4, updated_at: 4 },
];

function renderList() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <WorkspaceList />
    </QueryClientProvider>,
  );
}

function mockWorkspaces(list: Workspace[]) {
  server.use(http.get('/api/workspaces', () => HttpResponse.json(list)));
}

beforeEach(() => {
  useAppStore.setState({ workspaceId: null });
});

describe('WorkspaceList', () => {
  it('渲染工作空间卡片与四列统计；计数只发一次 counts 聚合，不再每卡拉全量', async () => {
    const countsCalls: string[] = [];
    const issuesCalls: string[] = [];
    server.use(
      http.get('/api/issues/counts', ({ request }) => {
        countsCalls.push(request.url);
        const ids = new URL(request.url).searchParams.get('workspace_ids')?.split(',') ?? [];
        return HttpResponse.json({
          items: ids.map((id) => ({
            workspace_id: id,
            total: id === 'ws-1' ? issuesWs1.length : 0,
            counts: id === 'ws-1' ? { 待规划: 2, 进行中: 1, 已关闭: 1 } : {},
          })),
        });
      }),
      http.get('/api/issues', ({ request }) => {
        issuesCalls.push(request.url);
        const wid = new URL(request.url).searchParams.get('workspace');
        return HttpResponse.json(wid === 'ws-1' ? issuesWs1 : []);
      }),
    );
    mockWorkspaces([ws1, ws2]);
    renderList();

    expect(await screen.findByText('主项目')).toBeInTheDocument();
    expect(screen.getByText('副项目')).toBeInTheDocument();
    expect(screen.getByText('D:/WorkSpaces/main')).toBeInTheDocument();

    const card = screen.getByTestId('workspace-card-ws-1');
    // 统计数字是 stat 单元格的第一个子节点；counts 查询异步返回，用 waitFor
    await waitFor(() =>
      expect(within(card).getByTestId('stat-待规划').firstElementChild).toHaveTextContent('2'),
    );
    expect(within(card).getByTestId('stat-进行中').firstElementChild).toHaveTextContent('1');
    expect(within(card).getByTestId('stat-待验收').firstElementChild).toHaveTextContent('0');
    expect(within(card).getByTestId('stat-已关闭').firstElementChild).toHaveTextContent('1');

    // PERF-4b：N 张卡只发 1 次 counts（覆盖可见工作区），不再出现每卡一次全量 /api/issues
    expect(countsCalls).toHaveLength(1);
    expect(new URL(countsCalls[0]!).searchParams.get('workspace_ids')).toBe('ws-1,ws-2');
    expect(issuesCalls).toEqual([]);
  });

  it('字典外状态归「其他」，各格加总等于 total', async () => {
    server.use(
      http.get('/api/issues/counts', ({ request }) => {
        const ids = new URL(request.url).searchParams.get('workspace_ids')?.split(',') ?? [];
        return HttpResponse.json({
          items: ids.map((id) => ({
            workspace_id: id,
            total: id === 'ws-1' ? 5 : 0,
            counts: id === 'ws-1' ? { 待规划: 2, 已关闭: 1, 归档中: 2 } : {},
          })),
        });
      }),
    );
    mockWorkspaces([ws1]);
    renderList();

    const card = await screen.findByTestId('workspace-card-ws-1');
    await waitFor(() =>
      expect(within(card).getByTestId('stat-其他').firstElementChild).toHaveTextContent('2'),
    );
    const cells = [...card.querySelectorAll('[data-testid^="stat-"]')];
    const total = cells.reduce((sum, cell) => sum + Number(cell.firstElementChild?.textContent ?? 0), 0);
    expect(total).toBe(5);
  });

  it('counts 不可用（404）时回落旧全量路径', async () => {
    const issuesCalls: string[] = [];
    server.use(
      http.get('/api/issues/counts', () =>
        HttpResponse.json({ error: { code: 'NOT_FOUND', message: '接口不存在: GET /issues/counts' } }, { status: 404 }),
      ),
      http.get('/api/issues', ({ request }) => {
        issuesCalls.push(request.url);
        const wid = new URL(request.url).searchParams.get('workspace');
        return HttpResponse.json(wid === 'ws-1' ? issuesWs1 : []);
      }),
    );
    mockWorkspaces([ws1, ws2]);
    renderList();

    const card = await screen.findByTestId('workspace-card-ws-1');
    await waitFor(() =>
      expect(within(card).getByTestId('stat-待规划').firstElementChild).toHaveTextContent('2'),
    );
    expect(issuesCalls.some((url) => url.includes('workspace=ws-1'))).toBe(true);
  });

  it('点击卡片选中并高亮', async () => {
    mockWorkspaces([ws1, ws2]);
    renderList();

    const card = await screen.findByTestId('workspace-card-ws-2');
    await userEvent.click(card);

    await waitFor(() => expect(useAppStore.getState().workspaceId).toBe('ws-2'));
    expect(card).toHaveAttribute('aria-pressed', 'true');
    const other = screen.getByTestId('workspace-card-ws-1');
    expect(other).toHaveAttribute('aria-pressed', 'false');
  });

  it('新建工作空间：提交后刷新列表并携带表单体', async () => {
    const list: Workspace[] = [ws1];
    let created: { name: string; path: string } | null = null;
    server.use(
      http.get('/api/workspaces', () => HttpResponse.json(list)),
      http.get('/api/issues', () => HttpResponse.json([])),
      http.post('/api/workspaces', async ({ request }) => {
        const body = (await request.json()) as { name: string; path: string };
        created = body;
        const next: Workspace = { id: 'ws-3', name: body.name, path: body.path, created_at: 3 };
        list.push(next);
        return HttpResponse.json(next, { status: 201 });
      }),
    );
    renderList();
    await screen.findByText('主项目');

    await userEvent.click(screen.getByRole('button', { name: '新增工作空间' }));
    const dialog = screen.getByRole('dialog', { name: '新增工作空间' });
    await userEvent.type(within(dialog).getByLabelText('工作空间名称'), '新项目');
    await userEvent.type(within(dialog).getByLabelText('工作空间路径'), 'D:/WorkSpaces/new');
    await userEvent.click(within(dialog).getByRole('button', { name: '创建' }));

    expect(await screen.findByText('新项目')).toBeInTheDocument();
    expect(created).toEqual({ name: '新项目', path: 'D:/WorkSpaces/new' });
  });

  it('空列表显示引导文案', async () => {
    mockWorkspaces([]);
    renderList();
    expect(await screen.findByText('还没有工作空间')).toBeInTheDocument();
    expect(screen.getByText(/创建第一个工作空间/)).toBeInTheDocument();
  });

  describe('移除工作空间', () => {
    it('点移除出现二次确认；取消不发 DELETE', async () => {
      let deleted = 0;
      server.use(
        http.get('/api/issues', () => HttpResponse.json([])),
        http.delete('/api/workspaces/:id', () => {
          deleted += 1;
          return new HttpResponse(null, { status: 204 });
        }),
      );
      mockWorkspaces([ws1]);
      renderList();

      // I-11：移除入口在卡面 ⋮ 菜单里
      await userEvent.click(await screen.findByTestId('workspace-card-menu-ws-1'));
      await userEvent.click(screen.getByRole('menuitem', { name: '移除工作空间 主项目' }));
      const dialog = screen.getByRole('dialog', { name: '移除工作空间' });
      expect(within(dialog).getByText(/将移除「主项目」/)).toBeInTheDocument();
      // 未输入空间名 → 提交按钮禁用，防止误删
      const confirmBtn = within(dialog).getByRole('button', { name: '移除工作空间' });
      expect(confirmBtn).toBeDisabled();

      await userEvent.click(within(dialog).getByRole('button', { name: '取消' }));
      expect(screen.queryByRole('dialog', { name: '移除工作空间' })).toBeNull();
      expect(deleted).toBe(0);
    });

    it('输入空间名确认后 DELETE 并刷新列表；选中态被清空', async () => {
      const list: Workspace[] = [ws1, ws2];
      const deletedIds: string[] = [];
      server.use(
        http.get('/api/issues', () => HttpResponse.json([])),
        http.delete('/api/workspaces/:id', ({ params }) => {
          const id = String(params.id);
          deletedIds.push(id);
          const index = list.findIndex((w) => w.id === id);
          if (index >= 0) list.splice(index, 1);
          return new HttpResponse(null, { status: 204 });
        }),
      );
      mockWorkspaces(list);
      renderList();

      await userEvent.click(await screen.findByTestId('workspace-card-ws-1'));
      await waitFor(() => expect(useAppStore.getState().workspaceId).toBe('ws-1'));

      await userEvent.click(screen.getByTestId('workspace-card-menu-ws-1'));
      await userEvent.click(screen.getByRole('menuitem', { name: '移除工作空间 主项目' }));
      const dialog = screen.getByRole('dialog', { name: '移除工作空间' });
      await userEvent.type(within(dialog).getByLabelText('确认空间名称'), '主项目');
      await userEvent.click(within(dialog).getByRole('button', { name: '移除工作空间' }));

      await waitFor(() => expect(deletedIds).toEqual(['ws-1']));
      await waitFor(() => expect(screen.queryByTestId('workspace-card-ws-1')).toBeNull());
      expect(screen.getByText('副项目')).toBeInTheDocument();
      await waitFor(() => expect(useAppStore.getState().workspaceId).toBeNull());
    });

    it('服务端拒绝（知识页/运行中会话/父子任务）→ 原样展示原因且空间保留', async () => {
      server.use(
        http.get('/api/issues', () => HttpResponse.json([])),
        http.delete('/api/workspaces/:id', () =>
          HttpResponse.json(
            { error: { code: 'CONFLICT', message: '该空间有 2 个运行中会话，请先结束会话后再移除' } },
            { status: 409 },
          ),
        ),
      );
      mockWorkspaces([ws1]);
      renderList();

      await userEvent.click(await screen.findByTestId('workspace-card-menu-ws-1'));
      await userEvent.click(screen.getByRole('menuitem', { name: '移除工作空间 主项目' }));
      const dialog = screen.getByRole('dialog', { name: '移除工作空间' });
      await userEvent.type(within(dialog).getByLabelText('确认空间名称'), '主项目');
      await userEvent.click(within(dialog).getByRole('button', { name: '移除工作空间' }));

      expect(await screen.findByTestId('remove-workspace-error')).toHaveTextContent(
        '该空间有 2 个运行中会话，请先结束会话后再移除',
      );
      // 拒绝后对话框与卡片都保留，列表未被乐观移除
      expect(screen.getByRole('dialog', { name: '移除工作空间' })).toBeInTheDocument();
      expect(screen.getByTestId('workspace-card-ws-1')).toBeInTheDocument();
    });
  });
});
