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

function mockApi(): void {
  server.use(
    http.get('/api/workspaces', () => HttpResponse.json([ws1, ws2])),
    http.get('/api/sessions', ({ request }) => {
      const wid = new URL(request.url).searchParams.get('workspace');
      return HttpResponse.json(sessionsList.filter((s) => s.workspace_id === wid));
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
  useAppStore.setState({ workspaceId: 'ws-1' });
  useNavStore.setState({ view: 'chat', drawer: null, chatOrigin: null });
  usePanelStore.setState({
    view: null,
    issueId: null,
    sessionId: null,
    chatSession: null,
    unread: {},
    refPanel: null,
    chatDraft: '',
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
});
