import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { useNavStore } from '../state/navStore';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { HttpResponse, http } from 'msw';
import type { Issue, Session, WsEvent } from '@agentboard/shared';
import { eventToQueryKeys } from '../api/ws';
import { columnDroppableId, commitDrop, resolveDrop } from '../lib/dnd';
import { Board } from '../components/board/Board';
import { api } from '../api/client';
import { useAppStore } from '../state/appStore';
import { usePanelStore } from '../state/panelStore';
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

/** 待规划 a(0) b(1000) c(2000)；待验收 x(0)；进行中 z 占用 */
const dndIssues: Issue[] = [
  makeIssue('a', { sort_order: 0 }),
  makeIssue('b', { sort_order: 1000 }),
  makeIssue('c', { sort_order: 2000 }),
  makeIssue('x', { status: '待验收', sort_order: 0 }),
  makeIssue('z', {
    status: '进行中',
    sort_order: 0,
    claimed_by: 'agent:codex',
    claimed_at: 1,
    session_id: 's1',
  }),
];

describe('resolveDrop（拖拽结算纯函数）', () => {
  it('跨列拖到卡片上：patch 带 status，sort_order 取边界 -1000（插到首位）', () => {
    expect(resolveDrop(dndIssues, 'a', 'x')).toEqual({
      id: 'a',
      patch: { status: '待验收', sort_order: -1000 },
    });
  });

  it('列内向下：插到 over 卡片之后，sort_order 取前后中值，patch 只带 sort_order', () => {
    // a(0) 落到 b 上 → b 与 c(2000) 之间 → (1000+2000)/2
    expect(resolveDrop(dndIssues, 'a', 'b')).toEqual({ id: 'a', patch: { sort_order: 1500 } });
  });

  it('列内向上：插到 over 卡片之前，取边界 -1000', () => {
    expect(resolveDrop(dndIssues, 'c', 'a')).toEqual({ id: 'c', patch: { sort_order: -1000 } });
  });

  it('拖到列容器上：追加列尾，同列 +1000、跨列带 status', () => {
    expect(resolveDrop(dndIssues, 'a', columnDroppableId('待规划'))).toEqual({
      id: 'a',
      patch: { sort_order: 3000 },
    });
    expect(resolveDrop(dndIssues, 'a', columnDroppableId('待验收'))).toEqual({
      id: 'a',
      patch: { status: '待验收', sort_order: 1000 },
    });
  });

  it('拖入空列：sort_order 取 0（首张）', () => {
    expect(resolveDrop(dndIssues, 'a', columnDroppableId('已关闭'))).toEqual({
      id: 'a',
      patch: { status: '已关闭', sort_order: 0 },
    });
  });

  it('占用卡禁止拖出：返回 null', () => {
    expect(resolveDrop(dndIssues, 'z', 'a')).toBeNull();
    expect(resolveDrop(dndIssues, 'z', columnDroppableId('待规划'))).toBeNull();
  });

  it('无效拖放：原地放下、未知目标返回 null', () => {
    expect(resolveDrop(dndIssues, 'a', 'a')).toBeNull();
    expect(resolveDrop(dndIssues, 'a', 'not-exist')).toBeNull();
    expect(resolveDrop(dndIssues, 'nope', 'a')).toBeNull();
  });

  it('原地无变化（单卡放回本列）返回 null，不发无意义 PATCH', () => {
    const single = [makeIssue('x', { status: '待验收', sort_order: 0 })];
    expect(resolveDrop(single, 'x', columnDroppableId('待验收'))).toBeNull();
  });

  it('「进行中」未占用任务不可跨列改状态，列内排序仍放行（DETAIL-STATUS01）', () => {
    const running = makeIssue('r1', { status: '进行中', sort_order: 0 });
    const running2 = makeIssue('r2', { status: '进行中', sort_order: 1000 });
    const planned = makeIssue('p1', { status: '待规划', sort_order: 0 });
    const issues = [running, running2, planned];

    // 拖到其他列 → 不落库（状态只能由 claim/done/fail 流转）
    expect(resolveDrop(issues, 'r1', columnDroppableId('待验收'))).toBeNull();
    expect(resolveDrop(issues, 'r1', 'p1')).toBeNull();
    // 列内排序不改变状态 → 允许
    expect(resolveDrop(issues, 'r1', 'r2')).toEqual({ id: 'r1', patch: { sort_order: 2000 } });
    // 其他状态照常跨列
    expect(resolveDrop(issues, 'p1', columnDroppableId('进行中'))).toEqual({
      id: 'p1',
      patch: { status: '进行中', sort_order: 2000 },
    });
  });
});

describe('commitDrop（乐观更新 + PATCH）', () => {
  const queryKey = ['issues', 'ws-1'];

  function setup(issues: Issue[]): QueryClient {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    qc.setQueryData(queryKey, issues);
    return qc;
  }

  it('成功：乐观更新立即生效，PATCH 体正确，最终被服务端响应覆盖', async () => {
    const qc = setup(dndIssues);
    const updatedA: Issue = { ...dndIssues[0]!, status: '待验收', sort_order: -1000, updated_at: 999 };
    let patchBody: unknown = null;
    server.use(
      http.patch('/api/issues/a', async ({ request }) => {
        patchBody = await request.json();
        return HttpResponse.json(updatedA);
      }),
    );

    const drop = resolveDrop(dndIssues, 'a', 'x');
    expect(drop).toEqual({ id: 'a', patch: { status: '待验收', sort_order: -1000 } });
    commitDrop({
      queryClient: qc,
      queryKey,
      drop: drop!,
      patchIssue: (id, patch) => api.patch(`/api/issues/${id}`, patch),
    });

    expect(qc.getQueryData<Issue[]>(queryKey)!.find((i) => i.id === 'a')!.status).toBe('待验收');
    await waitFor(() => expect(patchBody).toEqual({ status: '待验收', sort_order: -1000 }));
    await waitFor(() =>
      expect(qc.getQueryData<Issue[]>(queryKey)!.find((i) => i.id === 'a')!.updated_at).toBe(999),
    );
  });

  it('PATCH 409：先乐观更新，失败后回滚原缓存并 invalidate + onError', async () => {
    const qc = setup(dndIssues);
    server.use(
      http.patch('/api/issues/a', () =>
        HttpResponse.json({ error: { code: 'CONFLICT', message: '已被占用' } }, { status: 409 }),
      ),
    );
    const invalidateSpy = vi.spyOn(qc, 'invalidateQueries');
    const onError = vi.fn();

    const drop = resolveDrop(dndIssues, 'a', 'x')!;
    commitDrop({
      queryClient: qc,
      queryKey,
      drop,
      patchIssue: (id, patch) => api.patch(`/api/issues/${id}`, patch),
      onError,
    });

    expect(qc.getQueryData<Issue[]>(queryKey)!.find((i) => i.id === 'a')!.status).toBe('待验收');
    await waitFor(() => expect(onError).toHaveBeenCalledTimes(1));
    const rolled = qc.getQueryData<Issue[]>(queryKey)!.find((i) => i.id === 'a')!;
    expect(rolled.status).toBe('待规划');
    expect(rolled.sort_order).toBe(0);
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey });
    expect(onError.mock.calls[0]?.[0]).toBeInstanceOf(Error);
    expect((onError.mock.calls[0]?.[0] as Error).message).toContain('已被占用');
  });
});

const boardIssues: Issue[] = [
  makeIssue('i1', { title: '渲染检查', priority: '高', labels: ['前端', '性能'], sort_order: 0, comment_count: 2 }),
  makeIssue('i2', { title: '低优卡片', priority: '低', sort_order: 1000 }),
  makeIssue('i3', {
    title: '占用运行中',
    status: '进行中',
    sort_order: 0,
    claimed_by: 'agent:codex',
    claimed_at: 5,
    session_id: 's1',
  }),
  makeIssue('i4', {
    title: '占用已结束',
    status: '进行中',
    sort_order: 1000,
    claimed_by: 'agent:dsh',
    claimed_at: 6,
    session_id: 's2',
  }),
  makeIssue('i5', { title: '收尾任务', status: '已关闭', sort_order: 0 }),
];

const boardSessions: Session[] = [
  {
    id: 's1',
    workspace_id: 'ws-1',
    issue_id: 'i3',
    cli: 'codex',
    model: null,
    status: '运行中',
    adapter_session_id: null,
    created_at: 1,
  },
  {
    id: 's2',
    workspace_id: 'ws-1',
    issue_id: 'i4',
    cli: 'dsh',
    model: null,
    status: '已结束',
    adapter_session_id: null,
    created_at: 2,
  },
];

function renderBoard(): ReturnType<typeof render> & { qc: QueryClient } {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return {
    qc,
    ...render(
      <QueryClientProvider client={qc}>
        <Board />
      </QueryClientProvider>,
    ),
  };
}

function mockBoardData(issues: Issue[], sessions: Session[]): void {
  server.use(
    http.get('/api/issues', ({ request }) => {
      const wid = new URL(request.url).searchParams.get('workspace');
      return HttpResponse.json(wid === 'ws-1' ? issues : []);
    }),
    http.get('/api/sessions', () => HttpResponse.json(sessions)),
  );
}

beforeEach(() => {
  useAppStore.setState({ workspaceId: null, selectedLabelsByWorkspace: {} });
  usePanelStore.setState({ view: null, issueId: null, sessionId: null });
  // FIX-2：视图状态在 navStore，用例间必须重置，否则前一个用例切到 tree/log 会串味
  useNavStore.setState({ view: 'board', chatOrigin: null });
});

describe('Board 组件', () => {
  it('渲染列头计数、卡片字段（色条/标签/徽标/会话标记）与空列占位', async () => {
    mockBoardData(boardIssues, boardSessions);
    useAppStore.setState({ workspaceId: 'ws-1' });
    renderBoard();

    expect(await screen.findByText('渲染检查')).toBeInTheDocument();
    expect(screen.getByTestId('count-待规划')).toHaveTextContent('2');
    expect(screen.getByTestId('count-进行中')).toHaveTextContent('2');
    expect(screen.getByTestId('count-待验收')).toHaveTextContent('0');
    expect(screen.getByTestId('count-已关闭')).toHaveTextContent('1');
    expect(screen.getByTestId('empty-待验收')).toBeInTheDocument();

    // UNSLOP：左缘 3px 轨道——高=琥珀强调 / 中=ink-2 / 低=ink-3
    expect(screen.getByTestId('priority-bar-i1')).toHaveClass('bg-accent');
    expect(screen.getByTestId('priority-bar-i2')).toHaveClass('bg-ink-3');
    expect(screen.getByTestId('priority-bar-i3')).toHaveClass('bg-ink-2');

    // 标签 chips
    expect(screen.getByTestId('label-i1-前端')).toBeInTheDocument();
    expect(screen.getByTestId('label-i1-性能')).toBeInTheDocument();

    // 占用徽标：显示 cli id；运行中会话带动效点，已结束不带
    expect(screen.getByTestId('claimed-badge-i3')).toHaveTextContent('codex');
    expect(screen.getByTestId('session-running-i3')).toBeInTheDocument();
    expect(screen.getByTestId('claimed-badge-i4')).toHaveTextContent('dsh');
    expect(screen.queryByTestId('session-running-i4')).not.toBeInTheDocument();

    // 关联会话标记与评论数：有评论显示线性图标 + N，0 条整块隐藏（UNSLOP：去 emoji）
    expect(screen.getByTestId('session-link-i3')).toBeInTheDocument();
    expect(screen.getByTestId('comment-count-i1')).toHaveTextContent('2');
    expect(screen.queryByTestId('comment-count-i2')).not.toBeInTheDocument();
    expect(screen.queryByTestId('comment-count-i3')).not.toBeInTheDocument();

    // 占用卡禁拖态；未占用卡不禁
    const claimedCard = screen.getByTestId('issue-card-i3');
    expect(claimedCard).toHaveAttribute('aria-disabled', 'true');
    // CURSOR-WHITE：占用态光标由内联 style 接管（不再用 cursor-not-allowed 类）
    expect(claimedCard.style.cursor).toBe('not-allowed');
    expect(claimedCard).toHaveAttribute('title', '占用中，不可拖动');
    expect(screen.getByTestId('issue-card-i1')).not.toHaveAttribute('aria-disabled');
  });

  it('点击卡片打开任务详情（panelStore）', async () => {
    mockBoardData(boardIssues, []);
    useAppStore.setState({ workspaceId: 'ws-1' });
    renderBoard();

    await userEvent.click(await screen.findByTestId('issue-card-i1'));
    expect(usePanelStore.getState()).toMatchObject({ view: 'detail', issueId: 'i1' });
  });

  it('拖动卡片时预览移到 body portal，脱离列滚动裁切区域', async () => {
    mockBoardData([boardIssues[0]!], []);
    useAppStore.setState({ workspaceId: 'ws-1' });
    const { container } = renderBoard();

    const card = await screen.findByTestId('issue-card-i1');
    const activator = card.querySelector('[aria-roledescription="sortable"]');
    expect(activator).not.toBeNull();
    (activator as HTMLElement).focus();
    fireEvent.keyDown(activator!, { code: 'Space', key: ' ' });

    try {
      const overlay = await screen.findByTestId('drag-overlay-i1');
      expect(container.contains(overlay)).toBe(false);
      expect(overlay).toHaveTextContent('渲染检查');
    } finally {
      fireEvent.keyDown(activator!, { code: 'Escape', key: 'Escape' });
    }
    await waitFor(() => expect(screen.queryByTestId('drag-overlay-i1')).not.toBeInTheDocument());
  });

  it('任务树与平铺看板可切换，树视图读取层级接口', async () => {
    mockBoardData([boardIssues[0]!], []);
    server.use(http.get('/api/issues/tree', () => HttpResponse.json({
      items: [{ ...boardIssues[0]!, child_count: 0, descendant_count: 0, descendants_closed_count: 0 }],
      ancestors: [],
      next_cursor: null,
    })));
    useAppStore.setState({ workspaceId: 'ws-1' });
    renderBoard();

    expect(await screen.findByTestId('issue-card-i1')).toBeInTheDocument();
    act(() => useNavStore.setState({ view: 'tree' }));
    expect(await screen.findByTestId('tree-node-i1')).toBeInTheDocument();
    // FIX-2：工具条已无 ViewSwitcher，没有任何「任务树」按钮
    expect(screen.queryByRole('button', { name: '任务树' })).toBeNull();

    act(() => useNavStore.setState({ view: 'board' }));
    expect(await screen.findByTestId('issue-card-i1')).toBeInTheDocument();
    expect(screen.getByTestId('count-待规划')).toHaveTextContent('1');
  });

  it('WS comment.added：按 eventToQueryKeys 失效（connectWs 语义）后卡片评论数刷新', async () => {
    mockBoardData(boardIssues, []);
    useAppStore.setState({ workspaceId: 'ws-1' });
    const { qc } = renderBoard();
    expect(await screen.findByTestId('comment-count-i1')).toHaveTextContent('2');

    // 服务端又落一条评论：mock 数据更新，comment.added 到达 → ['issues'] 前缀失效重拉
    mockBoardData(boardIssues.map((i) => (i.id === 'i1' ? { ...i, comment_count: 3 } : i)), []);
    const event: WsEvent = {
      type: 'comment.added',
      comment: { id: 'c-new', issue_id: 'i1', author: 'user', content: 'x', ts: 2 },
    };
    for (const key of eventToQueryKeys(event)) {
      await qc.invalidateQueries({ queryKey: key });
    }

    expect(await screen.findByTestId('comment-count-i1')).toHaveTextContent('3');
  });

  it('未选工作空间显示空态，不请求 issues', () => {
    const issuesSpy = vi.fn();
    server.use(
      http.get('/api/issues', () => {
        issuesSpy();
        return HttpResponse.json([]);
      }),
    );
    renderBoard();
    expect(screen.getByText('请先在左侧选择或创建工作空间')).toBeInTheDocument();
    expect(issuesSpy).not.toHaveBeenCalled();
  });

  it('未选工作空间 → 选中工作空间的分支切换不改变 hook 数量（父代理浏览器实测回归）', async () => {
    mockBoardData(labelIssues, []);
    useAppStore.setState({ workspaceId: null });
    renderBoard();
    expect(screen.getByText('请先在左侧选择或创建工作空间')).toBeInTheDocument();

    // 回归点：提前 return 之后才调用 useMemo 会让两条分支的 hook 数量不同，
    // React 抛 “Rendered more hooks than during the previous render”，整页白屏。
    act(() => useAppStore.setState({ workspaceId: 'ws-1' }));
    expect(await screen.findByTestId('issue-card-l1')).toBeInTheDocument();
    expect(screen.getByTestId('label-filter-bar')).toBeInTheDocument();

    act(() => useAppStore.setState({ workspaceId: null }));
    expect(await screen.findByText('请先在左侧选择或创建工作空间')).toBeInTheDocument();
  });
});

/** 标签筛选夹具：l1=[前端,性能] l2=[后端] l3=[] */
const labelIssues: Issue[] = [
  makeIssue('l1', { title: '前端任务', labels: ['前端', '性能'], sort_order: 0 }),
  makeIssue('l2', { title: '后端任务', labels: ['后端'], sort_order: 1000 }),
  makeIssue('l3', { title: '无标签任务', sort_order: 2000 }),
];

describe('顶栏标签筛选（UI-FILTER01）', () => {
  it('工具条同一行：视图切换 + 搜索框 + 标签条（TOPBAR-INLINE），溢出收进更多浮层', async () => {
    mockBoardData(labelIssues, []);
    useAppStore.setState({ workspaceId: 'ws-1' });
    renderBoard();

    const row = await screen.findByTestId('board-toolbar-row');
    const controls = within(row).getByTestId('board-toolbar-controls');
    const filters = within(row).getByTestId('board-toolbar-filters');
    // 三者同一行：tab 组与搜索框在同一个 row 容器内，且 tab 组在搜索框之前（右侧）
    expect(row.contains(controls)).toBe(true);
    expect(row.contains(filters)).toBe(true);
    expect(controls.compareDocumentPosition(filters) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(within(controls).queryByRole('button', { name: '平铺看板' })).toBeNull();
    expect(within(controls).queryByTestId('view-switcher')).toBeNull();
    expect(within(controls).queryByTestId('board-search')).not.toBeInTheDocument();

    // 搜索框在 chips 之前；chips 容器不再横滚（LABEL-BAR：溢出改由「更多」浮层承载，避免裁掉浮层）
    const search = within(filters).getByTestId('board-search');
    const chips = within(filters).getByTestId('board-toolbar-chips');
    expect(search.compareDocumentPosition(chips) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(chips.className).not.toContain('overflow-x-auto');
    expect(chips.className).toContain('min-w-0');
    expect(within(chips).getByTestId('label-filter-bar')).toBeInTheDocument();
    // tab 组与搜索框都不允许被压缩（shrink-0）
    expect(controls.className).toContain('shrink-0');
    expect(search.className).toContain('shrink-0');
  });

  it('标签集合覆盖整个 workspace：请求不带分页参数，尾部 issue 的标签也进入筛选条', async () => {
    const many = Array.from({ length: 60 }, (_, index) =>
      makeIssue(`m${index}`, { labels: index === 59 ? ['尾部标签'] : [], sort_order: index }),
    );
    const requestedUrls: string[] = [];
    server.use(
      http.get('/api/issues', ({ request }) => {
        requestedUrls.push(request.url);
        return HttpResponse.json(many);
      }),
      http.get('/api/sessions', () => HttpResponse.json([])),
    );
    useAppStore.setState({ workspaceId: 'ws-1' });
    renderBoard();

    expect(await screen.findByTestId('label-filter-尾部标签')).toBeInTheDocument();
    expect(requestedUrls.length).toBeGreaterThan(0);
    for (const url of requestedUrls) {
      expect(url).not.toMatch(/[?&](limit|offset)=/);
    }
  });

  it('未选标签显示全部；单标签只显示命中；多标签按 OR 命中；取消全部后回到全部', async () => {
    mockBoardData(labelIssues, []);
    useAppStore.setState({ workspaceId: 'ws-1' });
    renderBoard();

    expect(await screen.findByTestId('issue-card-l1')).toBeInTheDocument();
    expect(screen.getByTestId('issue-card-l2')).toBeInTheDocument();
    expect(screen.getByTestId('issue-card-l3')).toBeInTheDocument();

    await userEvent.click(await screen.findByTestId('label-filter-前端'));
    expect(screen.getByTestId('label-filter-前端')).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByTestId('issue-card-l1')).toBeInTheDocument();
    expect(screen.queryByTestId('issue-card-l2')).not.toBeInTheDocument();
    expect(screen.queryByTestId('issue-card-l3')).not.toBeInTheDocument();

    // 多选 OR：命中任一选中标签即显示（LABEL-BAR：标签总数 <= MAX_VISIBLE，全部直接可见）
    await userEvent.click(screen.getByTestId('label-filter-后端'));
    expect(screen.getByTestId('issue-card-l1')).toBeInTheDocument();
    expect(screen.getByTestId('issue-card-l2')).toBeInTheDocument();
    expect(screen.queryByTestId('issue-card-l3')).not.toBeInTheDocument();

    // 全部取消 → 回到「显示全部」
    await userEvent.click(screen.getByTestId('label-filter-前端'));
    await userEvent.click(screen.getByTestId('label-filter-后端'));
    expect(screen.getByTestId('issue-card-l1')).toBeInTheDocument();
    expect(screen.getByTestId('issue-card-l2')).toBeInTheDocument();
    expect(screen.getByTestId('issue-card-l3')).toBeInTheDocument();
  });

  it('选中的标签无任何命中时不显示任务', async () => {
    mockBoardData(labelIssues, []);
    useAppStore.setState({ workspaceId: 'ws-1', selectedLabelsByWorkspace: { 'ws-1': ['已不存在的标签'] } });
    renderBoard();

    expect(await screen.findByTestId('label-filter-bar')).toBeInTheDocument();
    expect(screen.queryByTestId('issue-card-l1')).not.toBeInTheDocument();
    expect(screen.queryByTestId('issue-card-l2')).not.toBeInTheDocument();
    expect(screen.queryByTestId('issue-card-l3')).not.toBeInTheDocument();
    expect(screen.getByTestId('empty-待规划')).toBeInTheDocument();
  });

  it('切换工作空间后标签选择不串台', async () => {
    server.use(
      http.get('/api/issues', ({ request }) => {
        const wid = new URL(request.url).searchParams.get('workspace');
        if (wid === 'ws-1') return HttpResponse.json(labelIssues);
        if (wid === 'ws-2') {
          return HttpResponse.json([
            makeIssue('w2-1', { workspace_id: 'ws-2', title: '另一空间带标签', labels: ['前端', '后端'] }),
            makeIssue('w2-2', { workspace_id: 'ws-2', title: '另一空间无标签', labels: [] }),
          ]);
        }
        return HttpResponse.json([]);
      }),
      http.get('/api/sessions', () => HttpResponse.json([])),
    );
    useAppStore.setState({ workspaceId: 'ws-1' });
    renderBoard();

    await userEvent.click(await screen.findByTestId('label-filter-前端'));
    expect(screen.queryByTestId('issue-card-l2')).not.toBeInTheDocument();

    useAppStore.setState({ workspaceId: 'ws-2' });
    // 新工作空间未继承上一空间的标签选择：无标签任务仍显示，标签按钮回到未按下
    expect(await screen.findByTestId('issue-card-w2-2')).toBeInTheDocument();
    expect(screen.getByTestId('issue-card-w2-1')).toBeInTheDocument();
    expect(screen.getByTestId('label-filter-前端')).toHaveAttribute('aria-pressed', 'false');
  });

  it('标签按钮可键盘聚焦并用 Enter 切换筛选', async () => {
    mockBoardData(labelIssues, []);
    useAppStore.setState({ workspaceId: 'ws-1' });
    renderBoard();

    const chip = await screen.findByTestId('label-filter-前端');
    chip.focus();
    expect(chip).toHaveFocus();
    await userEvent.keyboard('{Enter}');
    expect(chip).toHaveAttribute('aria-pressed', 'true');
    expect(screen.queryByTestId('issue-card-l2')).not.toBeInTheDocument();
    await userEvent.keyboard(' ');
    expect(chip).toHaveAttribute('aria-pressed', 'false');
    expect(screen.getByTestId('issue-card-l2')).toBeInTheDocument();
  });

  it('任务树与平铺看板共享同一标签选择', async () => {
    mockBoardData(labelIssues, []);
    server.use(http.get('/api/issues/tree', () => HttpResponse.json({
      items: labelIssues.map((issue) => ({
        ...issue,
        child_count: 0,
        descendant_count: 0,
        descendants_closed_count: 0,
      })),
      ancestors: [],
      next_cursor: null,
    })));
    useAppStore.setState({ workspaceId: 'ws-1' });
    renderBoard();

    await userEvent.click(await screen.findByTestId('label-filter-前端'));
    act(() => useNavStore.setState({ view: 'tree' }));
    expect(await screen.findByTestId('tree-node-l1')).toBeInTheDocument();
    expect(screen.queryByTestId('tree-node-l2')).not.toBeInTheDocument();
    expect(screen.queryByTestId('tree-node-l3')).not.toBeInTheDocument();
  });
});

/** 搜索夹具：标题 / 描述 / 标签三种命中来源 + 标点与大小写 */
const searchIssues: Issue[] = [
  makeIssue('s1', { title: '登录页崩溃', labels: [], sort_order: 0 }),
  makeIssue('s2', { title: '其它任务', description: '复现步骤：点击登录（主流程）', sort_order: 1000 }),
  makeIssue('s3', { title: '无关任务', labels: ['登录'], sort_order: 2000 }),
  makeIssue('s4', { title: '正则字符 a.b', sort_order: 3000 }),
  makeIssue('s5', { title: 'Fix Login Bug', labels: [], sort_order: 4000 }),
];

/** 搜索 + 标签组合夹具：c1[前端] c2[后端] c3[后端] c4[] */
const searchComboIssues: Issue[] = [
  makeIssue('c1', { title: '登录崩溃', labels: ['前端'], sort_order: 0 }),
  makeIssue('c2', { title: '登录慢', labels: ['后端'], sort_order: 1000 }),
  makeIssue('c3', { title: '导出崩溃', labels: ['后端'], sort_order: 2000 }),
  makeIssue('c4', { title: '登录无标签', labels: [], sort_order: 3000 }),
];

describe('顶栏搜索（BOARD-SEARCH）', () => {
  it('标题、描述、标签均可用普通子串命中；标点为字面字符；大小写不敏感', async () => {
    mockBoardData(searchIssues, []);
    useAppStore.setState({ workspaceId: 'ws-1' });
    renderBoard();

    const input = await screen.findByTestId('board-search');
    await userEvent.type(input, '登录');
    expect(screen.getByTestId('issue-card-s1')).toBeInTheDocument(); // 标题
    expect(screen.getByTestId('issue-card-s2')).toBeInTheDocument(); // 描述
    expect(screen.getByTestId('issue-card-s3')).toBeInTheDocument(); // 标签
    expect(screen.queryByTestId('issue-card-s4')).not.toBeInTheDocument();
    expect(screen.getByTestId('count-待规划')).toHaveTextContent('3');

    // 标点按字面匹配：'a.b' 命中 'a.b'，且不当正则点号（'axb' 不命中）
    await userEvent.clear(input);
    await userEvent.type(input, 'a.b');
    expect(screen.getByTestId('issue-card-s4')).toBeInTheDocument();
    expect(screen.queryByTestId('issue-card-s1')).not.toBeInTheDocument();
    await userEvent.clear(input);
    await userEvent.type(input, 'axb');
    expect(screen.queryByTestId('issue-card-s4')).not.toBeInTheDocument();

    // 大小写不敏感
    await userEvent.clear(input);
    await userEvent.type(input, 'login');
    expect(screen.getByTestId('issue-card-s5')).toBeInTheDocument();
  });

  it('搜索与多标签 OR 组合：查询 AND（标签 OR）', async () => {
    mockBoardData(searchComboIssues, []);
    useAppStore.setState({ workspaceId: 'ws-1' });
    renderBoard();

    await userEvent.click(await screen.findByTestId('label-filter-前端'));
    await userEvent.click(screen.getByTestId('label-filter-后端'));
    expect(screen.getByTestId('issue-card-c1')).toBeInTheDocument();
    expect(screen.getByTestId('issue-card-c2')).toBeInTheDocument();
    expect(screen.getByTestId('issue-card-c3')).toBeInTheDocument();
    expect(screen.queryByTestId('issue-card-c4')).not.toBeInTheDocument();

    await userEvent.type(screen.getByTestId('board-search'), '登录');
    // 查询 AND（标签 OR）：只剩 c1 c2
    expect(screen.getByTestId('issue-card-c1')).toBeInTheDocument();
    expect(screen.getByTestId('issue-card-c2')).toBeInTheDocument();
    expect(screen.queryByTestId('issue-card-c3')).not.toBeInTheDocument();
    expect(screen.queryByTestId('issue-card-c4')).not.toBeInTheDocument();
  });

  it('清空搜索保留标签筛选与其他筛选结果', async () => {
    mockBoardData(searchComboIssues, []);
    useAppStore.setState({ workspaceId: 'ws-1' });
    renderBoard();

    await userEvent.click(await screen.findByTestId('label-filter-前端'));
    const input = screen.getByTestId('board-search');
    await userEvent.type(input, '导出');
    expect(screen.queryByTestId('issue-card-c1')).not.toBeInTheDocument(); // 标签命中但查询不命中

    await userEvent.clear(input);
    expect(screen.getByTestId('issue-card-c1')).toBeInTheDocument(); // 标签筛选仍在
    expect(screen.queryByTestId('issue-card-c2')).not.toBeInTheDocument();
    expect(screen.getByTestId('label-filter-前端')).toHaveAttribute('aria-pressed', 'true');
  });

  it('切换工作空间后不残留上一空间的查询', async () => {
    server.use(
      http.get('/api/issues', ({ request }) => {
        const wid = new URL(request.url).searchParams.get('workspace');
        if (wid === 'ws-1') return HttpResponse.json(searchIssues);
        if (wid === 'ws-2') {
          return HttpResponse.json([
            makeIssue('w2-1', { workspace_id: 'ws-2', title: '另一空间任务甲' }),
            makeIssue('w2-2', { workspace_id: 'ws-2', title: '另一空间任务乙' }),
          ]);
        }
        return HttpResponse.json([]);
      }),
      http.get('/api/sessions', () => HttpResponse.json([])),
    );
    useAppStore.setState({ workspaceId: 'ws-1' });
    renderBoard();

    await userEvent.type(await screen.findByTestId('board-search'), '登录');
    expect(screen.queryByTestId('issue-card-s4')).not.toBeInTheDocument();

    useAppStore.setState({ workspaceId: 'ws-2' });
    expect(await screen.findByTestId('issue-card-w2-1')).toBeInTheDocument();
    expect(screen.getByTestId('issue-card-w2-2')).toBeInTheDocument();
    expect(screen.getByTestId('board-search')).toHaveValue('');
  });

  it('平铺与任务树共享同一查询：命中集合一致，树保留命中项祖先', async () => {
    const parent = makeIssue('p1', { title: '未匹配父任务', sort_order: 0 });
    const hit = makeIssue('p2', { title: '搜索目标子任务', parent_issue_id: 'p1', sort_order: 1000 });
    const other = makeIssue('p3', { title: '无关任务', sort_order: 2000 });
    const asTreeItem = (issue: Issue) => ({
      ...issue,
      child_count: issue.id === 'p1' ? 1 : 0,
      descendant_count: issue.id === 'p1' ? 1 : 0,
      descendants_closed_count: 0,
    });
    mockBoardData([parent, hit, other], []);
    server.use(
      http.get('/api/issues/tree', ({ request }) => {
        const parentId = new URL(request.url).searchParams.get('parent_issue_id');
        if (parentId === null) return HttpResponse.json({ items: [asTreeItem(parent), asTreeItem(other)], ancestors: [], next_cursor: null });
        if (parentId === 'p1') return HttpResponse.json({ items: [asTreeItem(hit)], ancestors: [], next_cursor: null });
        return HttpResponse.json({ items: [], ancestors: [], next_cursor: null });
      }),
    );
    useAppStore.setState({ workspaceId: 'ws-1' });
    renderBoard();

    await userEvent.type(await screen.findByTestId('board-search'), '目标子');
    // 平铺：只显示命中卡片，不显示祖先
    expect(await screen.findByTestId('issue-card-p2')).toBeInTheDocument();
    expect(screen.queryByTestId('issue-card-p1')).not.toBeInTheDocument();
    expect(screen.getByTestId('count-待规划')).toHaveTextContent('1');

    act(() => useNavStore.setState({ view: 'tree' }));
    // 任务树：命中项 + 未命中的祖先上下文
    expect(await screen.findByTestId('tree-node-p2')).toBeInTheDocument();
    expect(screen.getByTestId('tree-node-p1')).toBeInTheDocument();
    expect(screen.queryByTestId('tree-node-p3')).not.toBeInTheDocument();
    expect(screen.getByTestId('board-search')).toHaveValue('目标子');
  });
});


describe('视图切换（TOPBAR-CLEAN）', () => {
  it('FIX-2：工具条不再有 ViewSwitcher（视图切换只走左栏五入口）', async () => {
    mockBoardData([boardIssues[0]!], []);
    useAppStore.setState({ workspaceId: 'ws-1' });
    renderBoard();
    expect(await screen.findByTestId('count-待规划')).toBeInTheDocument();
    // 工具条容器里既没有 switcher，也没有「平铺看板 / 任务树 / 知识库」三个按钮
    expect(screen.queryByTestId('view-switcher')).toBeNull();
    expect(screen.queryByRole('button', { name: '任务树' })).toBeNull();
    expect(screen.queryByRole('button', { name: '平铺看板' })).toBeNull();
    // 视图仍由 navStore 决定：切到 tree 后平铺列不再渲染（树由 navStore 驱动，工具条不参与）
    expect(screen.getByTestId('count-待规划')).toBeInTheDocument();
    act(() => useNavStore.setState({ view: 'tree' }));
    await waitFor(() => expect(screen.queryByTestId('count-待规划')).toBeNull());
  });
});

