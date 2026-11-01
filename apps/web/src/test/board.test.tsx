import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
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
  useAppStore.setState({ workspaceId: null });
  usePanelStore.setState({ view: null, issueId: null, sessionId: null });
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

    // 优先级色条：高=红 / 低=灰 / 中=黄
    expect(screen.getByTestId('priority-bar-i1')).toHaveClass('bg-red-500');
    expect(screen.getByTestId('priority-bar-i2')).toHaveClass('bg-neutral-400');
    expect(screen.getByTestId('priority-bar-i3')).toHaveClass('bg-amber-400');

    // 标签 chips
    expect(screen.getByTestId('label-i1-前端')).toBeInTheDocument();
    expect(screen.getByTestId('label-i1-性能')).toBeInTheDocument();

    // 占用徽标：显示 cli id；运行中会话带动效点，已结束不带
    expect(screen.getByTestId('claimed-badge-i3')).toHaveTextContent('codex');
    expect(screen.getByTestId('session-running-i3')).toBeInTheDocument();
    expect(screen.getByTestId('claimed-badge-i4')).toHaveTextContent('dsh');
    expect(screen.queryByTestId('session-running-i4')).not.toBeInTheDocument();

    // 关联会话标记与评论数徽标：有评论显示 💬 N，0 条整块隐藏
    expect(screen.getByTestId('session-link-i3')).toBeInTheDocument();
    expect(screen.getByTestId('comment-count-i1')).toHaveTextContent('💬 2');
    expect(screen.queryByTestId('comment-count-i2')).not.toBeInTheDocument();
    expect(screen.queryByTestId('comment-count-i3')).not.toBeInTheDocument();

    // 占用卡禁拖态；未占用卡不禁
    const claimedCard = screen.getByTestId('issue-card-i3');
    expect(claimedCard).toHaveAttribute('aria-disabled', 'true');
    expect(claimedCard).toHaveClass('cursor-not-allowed');
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

  it('WS comment.added：按 eventToQueryKeys 失效（connectWs 语义）后卡片评论数刷新', async () => {
    mockBoardData(boardIssues, []);
    useAppStore.setState({ workspaceId: 'ws-1' });
    const { qc } = renderBoard();
    expect(await screen.findByTestId('comment-count-i1')).toHaveTextContent('💬 2');

    // 服务端又落一条评论：mock 数据更新，comment.added 到达 → ['issues'] 前缀失效重拉
    mockBoardData(boardIssues.map((i) => (i.id === 'i1' ? { ...i, comment_count: 3 } : i)), []);
    const event: WsEvent = {
      type: 'comment.added',
      comment: { id: 'c-new', issue_id: 'i1', author: 'user', content: 'x', ts: 2 },
    };
    for (const key of eventToQueryKeys(event)) {
      await qc.invalidateQueries({ queryKey: key });
    }

    expect(await screen.findByTestId('comment-count-i1')).toHaveTextContent('💬 3');
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
});
