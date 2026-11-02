import { beforeEach, describe, expect, it } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { HttpResponse, http } from 'msw';
import type { Issue, IssueTreeItem, IssueTreePage } from '@agentboard/shared';
import { IssueTreeView } from '../components/board/IssueTreeView';
import { useAppStore } from '../state/appStore';
import { server } from './server';

function makeIssue(id: string, overrides: Partial<Issue> = {}): Issue {
  return {
    id,
    workspace_id: 'ws-1',
    title: id,
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
    updated_at: 10,
    ...overrides,
  };
}

function treeItem(id: string, overrides: Partial<IssueTreeItem> = {}): IssueTreeItem {
  return { ...makeIssue(id), child_count: 0, descendant_count: 0, descendants_closed_count: 0, ...overrides };
}

function page(items: IssueTreeItem[], next_cursor: string | null = null): IssueTreePage {
  return { items, ancestors: [], next_cursor };
}

function renderTree(issues: Issue[], query = '') {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const result = render(
    <QueryClientProvider client={queryClient}>
      <IssueTreeView workspaceId="ws-1" issues={issues} query={query} />
    </QueryClientProvider>,
  );
  return { queryClient, ...result };
}

beforeEach(() => {
  useAppStore.setState({ workspaceId: null, selectedLabelsByWorkspace: {} });
});

describe('IssueTreeView', () => {
  it('续读根节点与子节点，并递归展开三层任务和后代关闭进度', async () => {
    const root = treeItem('root', { title: '根任务', child_count: 2, descendant_count: 3, descendants_closed_count: 1 });
    const root2 = treeItem('root-2', { title: '第二根任务' });
    const child = treeItem('child', {
      title: '子任务', parent_issue_id: 'root', child_count: 1, descendant_count: 1,
      status: '进行中', claimed_by: 'agent:codex', claimed_at: 1,
    });
    const child2 = treeItem('child-2', { title: '第二子任务', parent_issue_id: 'root' });
    const grandchild = treeItem('grandchild', { title: '孙任务', parent_issue_id: 'child', status: '已关闭' });
    let requests = 0;
    server.use(
      http.get('/api/issues/tree', ({ request }) => {
        const url = new URL(request.url);
        const parent = url.searchParams.get('parent_issue_id');
        const cursor = url.searchParams.get('cursor');
        requests += 1;
        if (parent === null) return HttpResponse.json(cursor === 'root-next' ? page([root2]) : page([root], 'root-next'));
        if (parent === 'root') return HttpResponse.json(cursor === 'child-next' ? page([child2]) : page([child], 'child-next'));
        if (parent === 'child') return HttpResponse.json(page([grandchild]));
        return HttpResponse.json(page([]));
      }),
    );
    renderTree([root, child, child2, grandchild]);

    expect(await screen.findByText('根任务')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: '加载更多根任务' }));
    expect(await screen.findByText('第二根任务')).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: '展开子任务：根任务' }));
    expect(await screen.findByText('子任务')).toBeInTheDocument();
    expect(screen.getByText(/后代进度：1\/3 已关闭/)).toBeInTheDocument();
    expect(screen.getByTestId('tree-claim-child')).toHaveTextContent('codex');
    await userEvent.click(screen.getByRole('button', { name: '加载更多子任务：根任务' }));
    expect(await screen.findByText('第二子任务')).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: '展开子任务：子任务' }));
    expect(await screen.findByText('孙任务')).toBeInTheDocument();
    expect(screen.getByText('根任务 › 子任务')).toBeInTheDocument();
    expect(requests).toBe(5);
  });

  it('状态筛选自动续读并显示命中后代及其未命中的祖先', async () => {
    const root = treeItem('root', { title: '未关闭父项', child_count: 1 });
    const child = treeItem('child', { title: '未关闭子项', parent_issue_id: 'root', child_count: 1 });
    const matching = treeItem('match', { title: '已关闭命中', parent_issue_id: 'child', status: '已关闭' });
    const unrelated = treeItem('unrelated', { title: '无关根项', status: '进行中' });
    server.use(
      http.get('/api/issues/tree', ({ request }) => {
        const parent = new URL(request.url).searchParams.get('parent_issue_id');
        if (parent === null) return HttpResponse.json(page([root, unrelated]));
        if (parent === 'root') return HttpResponse.json(page([child]));
        if (parent === 'child') return HttpResponse.json(page([matching]));
        return HttpResponse.json(page([]));
      }),
    );
    renderTree([root, child, matching, unrelated]);

    await userEvent.selectOptions(await screen.findByLabelText('按状态筛选'), '已关闭');
    expect(await screen.findByText('已关闭命中')).toBeInTheDocument();
    expect(screen.getByTestId('tree-node-root')).toBeInTheDocument();
    expect(screen.getByTestId('tree-node-child')).toBeInTheDocument();
    expect(screen.queryByText('无关根项')).not.toBeInTheDocument();
    expect(screen.getByText('未关闭父项 › 未关闭子项')).toBeInTheDocument();
  });

  it('创建子任务和 CAS 移动父级保留各自操作上下文', async () => {
    const root = treeItem('root', { title: '根任务', child_count: 1 });
    const child = treeItem('child', { title: '子任务', parent_issue_id: 'root' });
    const other = treeItem('other', { title: '另一根任务' });
    let createBody: unknown;
    const patchBodies: unknown[] = [];
    server.use(
      http.get('/api/issues/tree', ({ request }) => {
        const parent = new URL(request.url).searchParams.get('parent_issue_id');
        return HttpResponse.json(page(parent === null ? [root, other] : parent === 'root' ? [child] : []));
      }),
      http.post('/api/issues', async ({ request }) => {
        createBody = await request.json();
        return HttpResponse.json(makeIssue('created', { title: '新子项', parent_issue_id: 'root' }));
      }),
      http.patch('/api/issues/child', async ({ request }) => {
        patchBodies.push(await request.json());
        return HttpResponse.json(makeIssue('child', { title: '子任务', parent_issue_id: null, updated_at: 11 }));
      }),
    );
    renderTree([root, child, other]);
    await userEvent.click(await screen.findByRole('button', { name: '展开子任务：根任务' }));

    await userEvent.click(await screen.findByRole('button', { name: '新建子任务：根任务' }));
    await userEvent.type(screen.getByLabelText('子任务标题：根任务'), '新子项');
    await userEvent.click(screen.getByRole('button', { name: '创建子任务' }));
    await waitFor(() => expect(createBody).toMatchObject({ workspace_id: 'ws-1', title: '新子项', parent_issue_id: 'root' }));

    await userEvent.selectOptions(screen.getByLabelText('状态：子任务'), '进行中');
    await waitFor(() => expect(patchBodies[0]).toMatchObject({
      workspace_id: 'ws-1', expected_updated_at: 10, status: '进行中',
    }));

    await userEvent.click(screen.getByRole('button', { name: '移动：子任务' }));
    await userEvent.selectOptions(screen.getByLabelText('新父任务：子任务'), '');
    await userEvent.click(screen.getByRole('button', { name: '保存父级' }));
    await waitFor(() => expect(patchBodies[1]).toMatchObject({
      workspace_id: 'ws-1', expected_updated_at: 10, parent_issue_id: null,
    }));
  });

  it('标签筛选命中子项时保留未命中的祖先上下文', async () => {
    const root = treeItem('root', { title: '未命中父项', child_count: 1 });
    const child = treeItem('child', { title: '未命中中间项', parent_issue_id: 'root', child_count: 1 });
    const matching = treeItem('match', { title: '命中子项', parent_issue_id: 'child', labels: ['目标'] });
    const unrelated = treeItem('unrelated', { title: '无关根项' });
    server.use(
      http.get('/api/issues/tree', ({ request }) => {
        const parent = new URL(request.url).searchParams.get('parent_issue_id');
        if (parent === null) return HttpResponse.json(page([root, unrelated]));
        if (parent === 'root') return HttpResponse.json(page([child]));
        if (parent === 'child') return HttpResponse.json(page([matching]));
        return HttpResponse.json(page([]));
      }),
    );
    useAppStore.setState({ selectedLabelsByWorkspace: { 'ws-1': ['目标'] } });
    renderTree([root, child, matching, unrelated]);

    expect(await screen.findByText('命中子项')).toBeInTheDocument();
    expect(screen.getByTestId('tree-node-root')).toBeInTheDocument();
    expect(screen.getByTestId('tree-node-child')).toBeInTheDocument();
    expect(screen.queryByText('无关根项')).not.toBeInTheDocument();
    expect(screen.getByText('未命中父项 › 未命中中间项')).toBeInTheDocument();
  });

  it('多标签按 OR 命中：命中任一选中标签即显示', async () => {
    const a = treeItem('a', { title: '标签甲任务', labels: ['甲'] });
    const b = treeItem('b', { title: '标签乙任务', labels: ['乙'] });
    const c = treeItem('c', { title: '无关任务', labels: ['丙'] });
    server.use(
      http.get('/api/issues/tree', () => HttpResponse.json(page([a, b, c]))),
    );
    useAppStore.setState({ selectedLabelsByWorkspace: { 'ws-1': ['甲', '乙'] } });
    renderTree([a, b, c]);

    expect(await screen.findByText('标签甲任务')).toBeInTheDocument();
    expect(screen.getByText('标签乙任务')).toBeInTheDocument();
    expect(screen.queryByText('无关任务')).not.toBeInTheDocument();
  });

  it('WebSocket 更新使任务换父级时保留移动表单，并将 409 上下文显示在已更新节点', async () => {
    const root = treeItem('root', { title: '根任务', child_count: 1 });
    const child = treeItem('child', { title: '子任务', parent_issue_id: 'root', updated_at: 10 });
    const other = treeItem('other', { title: '目标根' });
    let currentParent: string | null = 'root';
    let currentUpdatedAt = 10;
    let patchBody: unknown;
    let invalidateIssues: (() => Promise<void>) | undefined;
    let signalPatchStarted: (() => void) | undefined;
    const patchStarted = new Promise<void>((resolve) => { signalPatchStarted = resolve; });
    let releasePatch: (() => void) | undefined;
    const responseGate = new Promise<void>((resolve) => { releasePatch = resolve; });
    let signalRefreshCompleted: (() => void) | undefined;
    const refreshCompleted = new Promise<void>((resolve) => { signalRefreshCompleted = resolve; });

    server.use(
      http.get('/api/issues/tree', ({ request }) => {
        const parentId = new URL(request.url).searchParams.get('parent_issue_id');
        if (parentId === null) {
          return HttpResponse.json(page([
            treeItem('root', { title: '根任务', child_count: currentParent === 'root' ? 1 : 0 }),
            other,
            ...(currentParent === null ? [treeItem('child', { title: '子任务', parent_issue_id: null, updated_at: currentUpdatedAt })] : []),
          ]));
        }
        if (parentId === 'root' && currentParent === 'root') {
          return HttpResponse.json(page([treeItem('child', { title: '子任务', parent_issue_id: 'root', updated_at: currentUpdatedAt })]));
        }
        return HttpResponse.json(page([]));
      }),
      http.patch('/api/issues/child', async ({ request }) => {
        patchBody = await request.json();
        currentParent = null;
        currentUpdatedAt = 11;
        signalPatchStarted?.();
        await invalidateIssues?.();
        signalRefreshCompleted?.();
        await responseGate;
        return HttpResponse.json({ error: { code: 'CONFLICT', message: '任务已被其他操作更新' } }, { status: 409 });
      }),
    );

    const rendered = renderTree([root, child, other]);
    invalidateIssues = () => rendered.queryClient.invalidateQueries({ queryKey: ['issues', 'ws-1'] });
    await userEvent.click(await screen.findByRole('button', { name: '展开子任务：根任务' }));
    await userEvent.click(await screen.findByRole('button', { name: '移动：子任务' }));
    await userEvent.selectOptions(screen.getByLabelText('新父任务：子任务'), 'other');
    await userEvent.click(screen.getByRole('button', { name: '保存父级' }));

    await patchStarted;
    expect(patchBody).toMatchObject({ expected_updated_at: 10, parent_issue_id: 'other' });
    try {
      await refreshCompleted;
      const moveForm = screen.getByLabelText('新父任务：子任务') as HTMLSelectElement;
      expect(moveForm).toHaveValue('other');
    } finally {
      releasePatch?.();
    }

    const conflict = await screen.findByRole('alert');
    expect(conflict).toHaveTextContent('版本冲突');
    expect(conflict).toHaveTextContent('打开表单时版本 10，当前版本 11');
    expect(conflict).toHaveTextContent('目标“目标根”已保留');
    expect(screen.getByLabelText('新父任务：子任务')).toHaveValue('other');
  });

  it('显示关闭门禁进度并禁用过早关闭，移动错误留在对应节点', async () => {
    const parent = treeItem('parent', {
      title: '父任务', child_count: 1, descendant_count: 2, descendants_closed_count: 1,
    });
    const child = treeItem('child', { title: '子任务', parent_issue_id: 'parent' });
    const other = treeItem('other', { title: '另一父项' });
    server.use(
      http.get('/api/issues/tree', ({ request }) => {
        const parentId = new URL(request.url).searchParams.get('parent_issue_id');
        return HttpResponse.json(page(parentId === null ? [parent, other] : parentId === 'parent' ? [child] : []));
      }),
      http.patch('/api/issues/child', () => HttpResponse.json({ error: { code: 'CONFLICT', message: '目标父任务不存在' } }, { status: 409 })),
    );
    renderTree([parent, child, other]);
    expect(await screen.findByText('后代进度：1/2 已关闭；仍有 1 项未关闭')).toBeInTheDocument();
    const status = screen.getByLabelText('状态：父任务') as HTMLSelectElement;
    expect(within(status).getByRole('option', { name: '已关闭' })).toBeDisabled();

    await userEvent.click(screen.getByRole('button', { name: '展开子任务：父任务' }));
    await userEvent.click(await screen.findByRole('button', { name: '移动：子任务' }));
    await userEvent.selectOptions(screen.getByLabelText('新父任务：子任务'), 'other');
    await userEvent.click(screen.getByRole('button', { name: '保存父级' }));
    const moveError = await screen.findByRole('alert');
    expect(moveError).toHaveTextContent('移动“子任务”发生版本冲突');
    expect(moveError).toHaveTextContent('目标“另一父项”已保留');
    expect(moveError).toHaveTextContent('目标父任务不存在');
  });

  it('「进行中」节点（含未占用）状态下拉禁用，其他状态可改（DETAIL-STATUS01）', async () => {
    const running = treeItem('run', { title: '进行中节点', status: '进行中' });
    const planned = treeItem('plan', { title: '待规划节点', status: '待规划' });
    server.use(http.get('/api/issues/tree', () => HttpResponse.json(page([running, planned]))));
    renderTree([running, planned]);

    const runSelect = (await screen.findByLabelText('状态：进行中节点')) as HTMLSelectElement;
    expect(runSelect.value).toBe('进行中');
    expect(runSelect).toBeDisabled();
    expect(runSelect).toHaveAttribute('title', expect.stringContaining('进行中'));
    const planSelect = screen.getByLabelText('状态：待规划节点') as HTMLSelectElement;
    expect(planSelect).not.toBeDisabled();
  });
});

describe('任务树搜索（BOARD-SEARCH）', () => {
  it('query 命中子任务时保留未命中的祖先上下文', async () => {
    const root = treeItem('root', { title: '未命中父项', child_count: 1, descendant_count: 1 });
    const child = treeItem('child', { title: '未命中中间项', parent_issue_id: 'root', child_count: 1, descendant_count: 1 });
    const matching = treeItem('match', { title: '搜索命中子项', parent_issue_id: 'child' });
    const unrelated = treeItem('unrelated', { title: '无关根项' });
    server.use(
      http.get('/api/issues/tree', ({ request }) => {
        const parent = new URL(request.url).searchParams.get('parent_issue_id');
        if (parent === null) return HttpResponse.json(page([root, unrelated]));
        if (parent === 'root') return HttpResponse.json(page([child]));
        if (parent === 'child') return HttpResponse.json(page([matching]));
        return HttpResponse.json(page([]));
      }),
    );
    renderTree([root, child, matching, unrelated], '搜索命中');

    expect(await screen.findByText('搜索命中子项')).toBeInTheDocument();
    expect(screen.getByTestId('tree-node-root')).toBeInTheDocument();
    expect(screen.getByTestId('tree-node-child')).toBeInTheDocument();
    expect(screen.queryByText('无关根项')).not.toBeInTheDocument();
    expect(screen.getByText('未命中父项 › 未命中中间项')).toBeInTheDocument();
  });

  it('搜索命中分页之外的根任务：自动续拉下一页直到命中项加载', async () => {
    const first = treeItem('late-1', { title: '第一页任务' });
    const target = treeItem('late-2', { title: '第二页命中目标' });
    let requests = 0;
    server.use(
      http.get('/api/issues/tree', ({ request }) => {
        requests += 1;
        const cursor = new URL(request.url).searchParams.get('cursor');
        return HttpResponse.json(cursor === 'p2' ? page([target]) : page([first], 'p2'));
      }),
    );
    renderTree([first, target], '命中目标');

    expect(await screen.findByText('第二页命中目标')).toBeInTheDocument();
    expect(screen.queryByText('第一页任务')).not.toBeInTheDocument();
    expect(requests).toBeGreaterThan(1);
  });

  it('搜索与标签筛选叠加生效（查询 AND 标签 OR）', async () => {
    const a = treeItem('a', { title: '登录崩溃', labels: ['前端'] });
    const b = treeItem('b', { title: '登录慢', labels: ['后端'] });
    const c = treeItem('c', { title: '导出崩溃', labels: ['前端'] });
    const d = treeItem('d', { title: '登录无标签', labels: [] });
    server.use(http.get('/api/issues/tree', () => HttpResponse.json(page([a, b, c, d]))));
    useAppStore.setState({ selectedLabelsByWorkspace: { 'ws-1': ['前端'] } });
    renderTree([a, b, c, d], '登录');

    expect(await screen.findByText('登录崩溃')).toBeInTheDocument();
    expect(screen.queryByText('导出崩溃')).not.toBeInTheDocument(); // 标签命中但查询不命中
    expect(screen.queryByText('登录慢')).not.toBeInTheDocument(); // 查询命中但标签不命中
    expect(screen.queryByText('登录无标签')).not.toBeInTheDocument();
  });

  it('清空查询后恢复状态/标签筛选的结果', async () => {
    const a = treeItem('a', { title: '登录崩溃', labels: ['前端'] });
    const b = treeItem('b', { title: '导出崩溃', labels: ['前端'] });
    server.use(http.get('/api/issues/tree', () => HttpResponse.json(page([a, b]))));
    useAppStore.setState({ selectedLabelsByWorkspace: { 'ws-1': ['前端'] } });
    const { rerender } = renderTree([a, b], '登录');
    expect(await screen.findByText('登录崩溃')).toBeInTheDocument();
    expect(screen.queryByText('导出崩溃')).not.toBeInTheDocument();

    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    rerender(
      <QueryClientProvider client={queryClient}>
        <IssueTreeView workspaceId="ws-1" issues={[a, b]} query="" />
      </QueryClientProvider>,
    );
    expect(await screen.findByText('导出崩溃')).toBeInTheDocument();
    expect(screen.getByText('登录崩溃')).toBeInTheDocument();
  });
});
