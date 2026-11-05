/**
 * S3 聊天整屏视图（设计稿 §5）测试：
 * 左会话列表 250px 的渲染与选中、跨工作空间分组、标题口径（任务 → issue 标题 / 自由 → cli·model）、
 * 进入视图默认选中最近一条、左栏聊天入口未读聚合（含 99+）、选中会话的 openChat 联动。
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { HttpResponse, http } from 'msw';
import type { Issue, Session, Workspace } from '@agentboard/shared';
import { ChatView } from '../components/chat/ChatView';
import { SideBar } from '../components/shell/SideBar';
import { useAppStore } from '../state/appStore';
import { useNavStore } from '../state/navStore';
import { usePanelStore } from '../state/panelStore';
import { server } from './server';

const ws1: Workspace = { id: 'ws-1', name: '主项目', path: 'D:/ws/main', created_at: 1 };
const ws2: Workspace = { id: 'ws-2', name: '第二项目', path: 'D:/ws/second', created_at: 2 };

function makeSession(overrides: Partial<Session> = {}): Session {
  return {
    id: 's1',
    workspace_id: 'ws-1',
    issue_id: null,
    cli: 'codebuddy',
    model: 'm1',
    status: '已结束',
    adapter_session_id: null,
    created_at: 1,
    ...overrides,
  };
}

let sessionsList: Session[] = [];
let issueStore: Issue[] = [];
let lastPatch: Record<string, unknown> | null = null;
let forkCounter = 0;

function mockApi(): void {
  server.use(
    http.get('/api/workspaces', () => HttpResponse.json([ws1, ws2])),
    http.get('/api/sessions', ({ request }) => {
      const wid = new URL(request.url).searchParams.get('workspace');
      return HttpResponse.json(sessionsList.filter((s) => s.workspace_id === wid));
    }),
    http.patch('/api/sessions/:id', async ({ request, params }) => {
      const body = (await request.json()) as { title?: string | null; archived?: boolean };
      lastPatch = body as Record<string, unknown>;
      const target = sessionsList.find((s) => s.id === params.id);
      if (target === undefined) {
        return HttpResponse.json({ error: { code: 'NOT_FOUND', message: '会话不存在' } }, { status: 404 });
      }
      // CHAT-SB1 契约：运行中归档 409
      if (body.archived === true && target.status === '运行中') {
        return HttpResponse.json(
          { error: { code: 'CONFLICT', message: '会话正在运行，请先停止再归档' } },
          { status: 409 },
        );
      }
      const updated: Session = {
        ...target,
        ...(body.title !== undefined ? { title: body.title } : {}),
        ...(body.archived !== undefined ? { archived_at: body.archived ? Date.now() : null } : {}),
      };
      sessionsList = sessionsList.map((s) => (s.id === updated.id ? updated : s));
      return HttpResponse.json(updated);
    }),
    http.post('/api/sessions/:id/fork', ({ params }) => {
      const source = sessionsList.find((s) => s.id === params.id);
      if (source === undefined) {
        return HttpResponse.json({ error: { code: 'NOT_FOUND', message: '会话不存在' } }, { status: 404 });
      }
      forkCounter += 1;
      const created = makeSession({
        id: `fork-${forkCounter}`,
        workspace_id: source.workspace_id,
        issue_id: source.issue_id,
        cli: source.cli,
        model: source.model,
        title: null,
        forked_from_session_id: source.id,
        created_at: Date.now() + forkCounter,
      });
      sessionsList = [...sessionsList, created];
      return HttpResponse.json(created);
    }),
    http.get('/api/sessions/:id/messages', () => HttpResponse.json([])),
    http.get('/api/issues/:id', ({ params }) => {
      const found = issueStore.find((i) => i.id === params.id);
      return found !== undefined
        ? HttpResponse.json(found)
        : HttpResponse.json({ error: { code: 'NOT_FOUND', message: '任务不存在' } }, { status: 404 });
    }),
  );
}

function renderChatView(): void {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <ChatView />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  localStorage.clear();
  sessionsList = [];
  issueStore = [];
  lastPatch = null;
  forkCounter = 0;
  useAppStore.setState({ workspaceId: 'ws-1' });
  useNavStore.setState({ view: 'chat', drawer: null, chatOrigin: null });
  usePanelStore.setState({
    view: null,
    issueId: null,
    sessionId: null,
    chatSession: null,
    unread: {},
    refPanel: null,
    chatDrafts: {},
    rightOpen: false,
  });
  mockApi();
});

describe('S3 左会话列表', () => {
  it('跨工作空间分组：任务会话归各自工作空间组，自由会话归「无任务会话」，标题口径按 issue 标题 / cli·model', async () => {
    issueStore = [
      { id: 'iss-1', workspace_id: 'ws-1', title: '任务一号' } as Issue,
      { id: 'iss-2', workspace_id: 'ws-2', title: '任务二号' } as Issue,
    ];
    sessionsList = [
      makeSession({ id: 's1', workspace_id: 'ws-1', issue_id: 'iss-1', created_at: 1 }),
      makeSession({ id: 's2', workspace_id: 'ws-2', issue_id: 'iss-2', created_at: 2 }),
      makeSession({ id: 's3', workspace_id: 'ws-1', issue_id: null, cli: 'codex', model: 'm2', created_at: 3 }),
    ];
    renderChatView();

    // 三个分组：主项目 / 第二项目 / 无任务会话
    const g1 = await screen.findByTestId('chat-session-group-ws-1');
    const g2 = await screen.findByTestId('chat-session-group-ws-2');
    const gFree = await screen.findByTestId('chat-session-group-free');
    expect(within(g1).getByText('主项目')).toBeInTheDocument();
    expect(within(g2).getByText('第二项目')).toBeInTheDocument();
    expect(within(gFree).getByText('无任务会话')).toBeInTheDocument();

    // 分区归属：s1 → ws-1 组；s2 → ws-2 组；自由会话 s3 → 无任务会话组（不重复出现在 ws-1 组）
    expect(within(g1).getByTestId('session-row-s1')).toBeInTheDocument();
    expect(within(g1).queryByTestId('session-row-s3')).not.toBeInTheDocument();
    expect(within(g2).getByTestId('session-row-s2')).toBeInTheDocument();
    expect(within(gFree).getByTestId('session-row-s3')).toBeInTheDocument();

    // 标题口径：任务会话 = issue 标题；自由会话 = cli·model
    expect(within(g1).getByTestId('session-option-s1')).toHaveTextContent('任务一号');
    expect(within(g2).getByTestId('session-option-s2')).toHaveTextContent('任务二号');
    expect(within(gFree).getByTestId('session-option-s3')).toHaveTextContent('codex · m2');
  });

  it('点选会话：写 panelStore 选中 + openChat 联动（切到聊天视图、关闭详情浮窗）', async () => {
    sessionsList = [makeSession({ id: 's1' }), makeSession({ id: 's2', workspace_id: 'ws-2', created_at: 2 })];
    usePanelStore.setState({
      view: 'detail',
      issueId: 'iss-9',
      sessionId: 's1',
      chatSession: makeSession({ id: 's1' }),
      rightOpen: true,
    });
    useNavStore.setState({ view: 'board' });
    renderChatView();

    const user = userEvent.setup();
    await user.click(await screen.findByTestId('session-option-s2'));

    expect(usePanelStore.getState().sessionId).toBe('s2');
    expect(useNavStore.getState().view).toBe('chat');
    // 详情/引用浮窗被清空收起（整屏聊天不与 absolute 浮窗叠加）
    expect(usePanelStore.getState().view).toBeNull();
    expect(usePanelStore.getState().issueId).toBeNull();
    expect(usePanelStore.getState().rightOpen).toBe(false);
  });

  it('进入视图默认选中最近一条会话（无选中时）', async () => {
    sessionsList = [
      makeSession({ id: 'old', created_at: 10 }),
      makeSession({ id: 'recent', created_at: 99 }),
    ];
    renderChatView();

    await waitFor(() => expect(usePanelStore.getState().sessionId).toBe('recent'));
  });

  it('进入视图已有选中会话：不重置选择（切走再切回保持）', async () => {
    sessionsList = [makeSession({ id: 'old', created_at: 10 }), makeSession({ id: 'kept', created_at: 99 })];
    usePanelStore.setState({ sessionId: 'old', chatSession: makeSession({ id: 'old', created_at: 10 }) });
    renderChatView();

    await screen.findByTestId('session-option-old');
    expect(usePanelStore.getState().sessionId).toBe('old');
  });

  it('运行中/失败徽标：运行中橙点与失败红点按状态渲染', async () => {
    sessionsList = [
      makeSession({ id: 'run', status: '运行中', created_at: 2 }),
      makeSession({ id: 'bad', status: '失败', created_at: 1 }),
    ];
    renderChatView();

    expect(await screen.findByTestId('option-running-run')).toBeInTheDocument();
    expect(screen.getByTestId('option-failed-bad')).toBeInTheDocument();
  });

  it('未读徽标：会话条目红徽标 >99 收口 99+；左栏聊天入口聚合全部未读', async () => {
    sessionsList = [
      makeSession({ id: 's1', created_at: 2 }),
      makeSession({ id: 's2', created_at: 1 }),
    ];
    usePanelStore.setState({ sessionId: 's1', unread: { s2: 120, s3: 3 } });
    renderChatView();

    // 条目徽标按自身计数，>99 → 99+
    expect(await screen.findByTestId('unread-s2')).toHaveTextContent('99+');
    // 当前会话 s1 无未读 → 不渲染徽标
    expect(screen.queryByTestId('unread-s1')).not.toBeInTheDocument();

    // 左栏聊天入口 = 全部会话未读合计（120 + 3 = 123 → 99+）
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={qc}>
        <SideBar workspace={ws1} />
      </QueryClientProvider>,
    );
    expect(screen.getByTestId('sidebar-chat-unread')).toHaveTextContent('99+');
  });

  it('未读徽标：合计不超过 99 时显示实际条数，0 时不渲染', async () => {
    render(<SideBar workspace={ws1} />);
    expect(screen.queryByTestId('sidebar-chat-unread')).not.toBeInTheDocument();

    usePanelStore.setState({ unread: { a: 2, b: 3 } });
    expect(await screen.findByTestId('sidebar-chat-unread')).toHaveTextContent('5');
  });

  it('AUDIT-3：条目带相对时间与任务归属，同名标题追加时间可区分', async () => {
    const now = Date.now();
    issueStore = [
      { id: 'iss-a', workspace_id: 'ws-1', title: '同名任务' } as Issue,
      { id: 'iss-b', workspace_id: 'ws-1', title: '同名任务' } as Issue,
      { id: 'iss-empty', workspace_id: 'ws-1', title: '' } as Issue,
    ];
    sessionsList = [
      makeSession({ id: 's1', issue_id: 'iss-a', created_at: now - 5 * 60_000 }),
      makeSession({ id: 's2', issue_id: 'iss-b', created_at: now - 90 * 60_000 }),
      makeSession({ id: 's3', issue_id: 'iss-empty', created_at: now - 26 * 3_600_000 }),
    ];
    renderChatView();

    // 同名标题各自追加相对时间，三条可区分
    expect(await screen.findByTestId('session-option-s1')).toHaveTextContent('同名任务 · 5 分钟前');
    expect(screen.getByTestId('session-option-s2')).toHaveTextContent('同名任务 · 1 小时前');
    // 空标题退化为任务号，时间在副行
    expect(screen.getByTestId('session-option-s3')).toHaveTextContent('#iss-empt');
    expect(screen.getByTestId('session-meta-s1')).toHaveTextContent('#iss-a · 5 分钟前');
    expect(screen.getByTestId('session-meta-s3')).toHaveTextContent('#iss-empt · 1 天前');
  });

  it('AUDIT-3：删除 ✕ 命中区 ≥24px，默认隐藏、hover/focus 可见', async () => {
    sessionsList = [makeSession({ id: 's1' })];
    renderChatView();

    const del = await screen.findByTestId('session-delete-s1');
    expect(del.className).toContain('size-6');
    expect(del.className).toContain('opacity-0');
    expect(del.className).toContain('group-hover:opacity-100');
    expect(del.className).toContain('focus-visible:opacity-100');
  });

  it('AUDIT-3：行内删除二次确认仍在（点 ✕ 出现确认/取消）', async () => {
    sessionsList = [makeSession({ id: 's1' })];
    renderChatView();
    const user = userEvent.setup();

    await user.click(await screen.findByTestId('session-delete-s1'));
    expect(screen.getByTestId('session-delete-confirm-s1')).toBeInTheDocument();
    await user.click(screen.getByTestId('session-delete-cancel-s1'));
    expect(screen.queryByTestId('session-delete-confirm-s1')).toBeNull();
  });
});

describe('CHAT-SB2 侧栏：搜索 / 行内改名 / 归档 / 分叉', () => {
  it('搜索按标题 / 任务号 / 模型 / 分叉来源过滤，无匹配给空态，清空恢复全量', async () => {
    issueStore = [
      { id: 'iss-1', workspace_id: 'ws-1', title: '任务一号' } as Issue,
      { id: 'iss-2', workspace_id: 'ws-1', title: '另一任务' } as Issue,
    ];
    sessionsList = [
      makeSession({ id: 's1', issue_id: 'iss-1', created_at: 3 }),
      makeSession({ id: 's2', issue_id: 'iss-2', cli: 'codex', model: 'm2', created_at: 2 }),
      makeSession({
        id: 's3',
        issue_id: null,
        cli: 'gemini',
        model: 'g1',
        forked_from_session_id: 's2',
        created_at: 1,
      }),
    ];
    renderChatView();
    const user = userEvent.setup();
    const search = await screen.findByTestId('chat-search-input');
    // issue 标题异步载入后再搜标题，避免按 #id 兜底标题过滤
    await waitFor(() => expect(screen.getByTestId('session-option-s1')).toHaveTextContent('任务一号'));

    // 标题
    await user.type(search, '任务一号');
    await waitFor(() => expect(screen.queryByTestId('session-row-s2')).toBeNull());
    expect(screen.getByTestId('session-row-s1')).toBeInTheDocument();

    // 任务号
    await user.clear(search);
    await user.type(search, 'iss-2');
    await waitFor(() => expect(screen.queryByTestId('session-row-s1')).toBeNull());
    expect(screen.getByTestId('session-row-s2')).toBeInTheDocument();

    // 模型
    await user.clear(search);
    await user.type(search, 'g1');
    expect(screen.getByTestId('session-row-s3')).toBeInTheDocument();
    expect(screen.queryByTestId('session-row-s1')).toBeNull();

    // 分叉来源 id（s2 自身不命中，只有分叉自 s2 的 s3 命中）
    await user.clear(search);
    await user.type(search, 's2');
    expect(screen.getByTestId('session-row-s3')).toBeInTheDocument();
    expect(screen.queryByTestId('session-row-s2')).toBeNull();

    // 无匹配空态
    await user.clear(search);
    await user.type(search, '不存在的关键词');
    expect(await screen.findByTestId('chat-search-empty')).toBeInTheDocument();
    expect(screen.queryByTestId('session-row-s1')).toBeNull();

    // 清空恢复全量
    await user.click(screen.getByTestId('chat-search-clear'));
    await waitFor(() => expect(screen.getByTestId('session-row-s1')).toBeInTheDocument());
    expect(screen.getByTestId('session-row-s2')).toBeInTheDocument();
    expect(screen.getByTestId('session-row-s3')).toBeInTheDocument();
  });

  it('行内改名：Enter 提交同步列表；Esc 取消不回写；空标题拒绝并提示', async () => {
    sessionsList = [makeSession({ id: 's1' })];
    renderChatView();
    const user = userEvent.setup();
    await screen.findByTestId('session-option-s1');

    // Enter 提交
    await user.click(screen.getByTestId('session-rename-s1'));
    const input = screen.getByTestId('session-rename-input-s1');
    await user.clear(input);
    await user.type(input, '新会话名');
    await user.keyboard('{Enter}');
    await waitFor(() => expect(lastPatch).toEqual({ title: '新会话名' }));
    await waitFor(() => expect(screen.getByTestId('session-option-s1')).toHaveTextContent('新会话名'));
    // 验收 #2：列表改名后聊天头部同步（两处都读同一份 sessions 数据）
    await waitFor(() => expect(screen.getByTestId('chat-session-title')).toHaveTextContent('新会话名'));
    expect(screen.queryByTestId('session-rename-input-s1')).toBeNull();

    // Esc 取消：不回写
    lastPatch = null;
    await user.click(screen.getByTestId('session-rename-s1'));
    const input2 = screen.getByTestId('session-rename-input-s1');
    await user.clear(input2);
    await user.type(input2, '不该保存');
    await user.keyboard('{Escape}');
    expect(screen.queryByTestId('session-rename-input-s1')).toBeNull();
    expect(screen.getByTestId('session-option-s1')).toHaveTextContent('新会话名');
    expect(lastPatch).toBeNull();

    // 空标题拒绝
    await user.click(screen.getByTestId('session-rename-s1'));
    const input3 = screen.getByTestId('session-rename-input-s1');
    await user.clear(input3);
    await user.keyboard('{Enter}');
    expect(screen.getByTestId('session-rename-error-s1')).toHaveTextContent('会话名称不能为空');
    expect(lastPatch).toBeNull();
  });

  it('归档：行操作归档后默认列表不可见，已归档组可展开并恢复', async () => {
    sessionsList = [makeSession({ id: 's1' }), makeSession({ id: 's2', created_at: 2 })];
    renderChatView();
    const user = userEvent.setup();
    await screen.findByTestId('session-row-s1');

    await user.click(screen.getByTestId('session-archive-s1'));
    await waitFor(() => expect(screen.queryByTestId('session-row-s1')).toBeNull());
    expect(screen.getByTestId('archived-count')).toHaveTextContent('已归档 1');

    await user.click(screen.getByTestId('archived-toggle'));
    expect(screen.getByTestId('session-row-s1')).toBeInTheDocument();

    await user.click(screen.getByTestId('session-restore-s1'));
    await waitFor(() => expect(screen.queryByTestId('archived-group')).toBeNull());
    expect(screen.getByTestId('session-row-s1')).toBeInTheDocument();
  });

  it('运行中归档：409 文案就地展示，不静默失败', async () => {
    sessionsList = [makeSession({ id: 'run', status: '运行中' })];
    renderChatView();
    const user = userEvent.setup();

    await user.click(await screen.findByTestId('session-archive-run'));
    expect(await screen.findByTestId('chat-session-error')).toHaveTextContent('会话正在运行，请先停止再归档');
    expect(screen.getByTestId('session-row-run')).toBeInTheDocument();
  });

  it('分叉：新会话自动选中并带 ⎇ 分叉自 来源标记，源会话保留', async () => {
    sessionsList = [makeSession({ id: 's1' })];
    renderChatView();
    const user = userEvent.setup();
    await screen.findByTestId('session-row-s1');

    await user.click(screen.getByTestId('session-fork-s1'));
    await waitFor(() => expect(usePanelStore.getState().sessionId).toBe('fork-1'));
    expect(await screen.findByTestId('session-forked-from-fork-1')).toHaveTextContent(
      '⎇ 分叉自 codebuddy · m1',
    );
    expect(screen.getByTestId('session-row-s1')).toBeInTheDocument();
  });

  it('会话头 ⋯ 菜单也能归档（与行操作同一入口契约）', async () => {
    sessionsList = [makeSession({ id: 's1' })];
    renderChatView();
    const user = userEvent.setup();
    await screen.findByTestId('chat-header-menu-btn');

    await user.click(screen.getByTestId('chat-header-menu-btn'));
    await user.click(screen.getByTestId('archive-session-btn'));
    await waitFor(() => expect(screen.queryByTestId('session-row-s1')).toBeNull());
    expect(screen.getByTestId('archived-count')).toHaveTextContent('已归档 1');
  });

  it('会话头归档运行中会话：409 文案展示在聊天错误条', async () => {
    sessionsList = [makeSession({ id: 'run', status: '运行中' })];
    renderChatView();
    const user = userEvent.setup();
    await screen.findByTestId('chat-header-menu-btn');

    await user.click(screen.getByTestId('chat-header-menu-btn'));
    await user.click(screen.getByTestId('archive-session-btn'));
    expect(await screen.findByTestId('chat-action-error')).toHaveTextContent('会话正在运行，请先停止再归档');
  });

  it('草稿按会话独立并持久化到 localStorage（切换会话互不覆盖）', () => {
    usePanelStore.getState().setChatDraft('s1', '甲会话草稿');
    usePanelStore.getState().setChatDraft('s2', '乙会话草稿');

    expect(usePanelStore.getState().chatDrafts).toEqual({ s1: '甲会话草稿', s2: '乙会话草稿' });
    const persisted = JSON.parse(localStorage.getItem('agentboard.panel') ?? '{}') as {
      state?: { chatDrafts?: Record<string, string> };
    };
    expect(persisted.state?.chatDrafts).toEqual({ s1: '甲会话草稿', s2: '乙会话草稿' });
  });
});
