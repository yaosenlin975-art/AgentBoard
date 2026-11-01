/**
 * unreadCollector（issue 6def6819）测试：message.added → markUnread 挂 wsBus 全局层
 * （模块加载即订阅，非组件生命周期），ChatPanel 未挂载（面板收起）期间同样计数；
 * 当前会话消息不计；多会话计数独立互不串扰；session.deleted 清被删会话条目；
 * openChat 打开对应会话清零（TopBar 总徽标与切换器「新消息」徽标同步）。
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { HttpResponse, http } from 'msw';
import type { Message, Session, Workspace } from '@agentboard/shared';
// 模块加载即订阅 wsBus（与 App 启动经 ChatPanel 静态 import 同路径）
import '../state/unreadCollector';
import { TopBar } from '../components/topbar/TopBar';
import { RightPanel } from '../components/right/RightPanel';
import { emitWsEvent } from '../api/wsBus';
import { useAppStore } from '../state/appStore';
import { usePanelStore } from '../state/panelStore';
import { useStreamingStore } from '../state/streamingStore';
import { server } from './server';

const ws: Workspace = { id: 'ws-1', name: '主项目', path: 'D:/ws/main', created_at: 1 };

function makeSession(overrides: Partial<Session> = {}): Session {
  return {
    id: 's1',
    workspace_id: 'ws-1',
    issue_id: null,
    cli: 'codebuddy',
    model: 'm1',
    status: '运行中',
    adapter_session_id: null,
    created_at: 1,
    ...overrides,
  };
}

function makeMessage(overrides: Partial<Message> = {}): Message {
  return {
    id: `m-${Math.random().toString(36).slice(2)}`,
    session_id: 's1',
    role: 'user',
    content: 'hi',
    ts: 100,
    ...overrides,
  };
}

function emitMessageAdded(message: Message): void {
  act(() => {
    emitWsEvent({ type: 'message.added', message });
  });
}

let sessionsList: Session[] = [];

beforeEach(() => {
  sessionsList = [];
  localStorage.clear();
  useAppStore.setState({ workspaceId: 'ws-1' });
  usePanelStore.setState({
    view: null,
    issueId: null,
    sessionId: null,
    chatSession: null,
    unread: {},
    rightOpen: false,
  });
  useStreamingStore.setState({ streams: new Map() });
  server.use(
    http.get('/api/clis', () => HttpResponse.json([])),
    http.get('/api/clis/:id/models', () => HttpResponse.json([{ id: 'm-a', source: 'static' }])),
    http.get('/api/sessions', () => HttpResponse.json(sessionsList)),
    http.get('/api/sessions/:id', ({ params }) =>
      HttpResponse.json(
        sessionsList.find((s) => s.id === params.id) ?? makeSession({ id: params.id as string }),
      ),
    ),
    http.get('/api/sessions/:id/messages', () => HttpResponse.json([])),
    http.get('/api/sessions/:id/queue', () => HttpResponse.json({ texts: [] })),
  );
});

function renderShell(): void {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <TopBar workspace={ws} />
      <RightPanel />
    </QueryClientProvider>,
  );
}

describe('unreadCollector 全局未读计数', () => {
  it('ChatPanel 未挂载（面板收起）收到 message.added 即计数；TopBar 徽标出现；展开后切换器显示「新消息」徽标；openChat 清零', async () => {
    sessionsList = [makeSession({ id: 's1' }), makeSession({ id: 's2', cli: 'codex' })];
    // 聊天视图选中 s1，但面板收起 → ChatPanel 未挂载
    usePanelStore.setState({
      view: 'chat',
      sessionId: 's1',
      chatSession: makeSession({ id: 's1' }),
      rightOpen: false,
    });
    renderShell();
    await waitFor(() => expect(screen.queryByTestId('chat-panel')).not.toBeInTheDocument());

    emitMessageAdded(makeMessage({ id: 'mb1', session_id: 's2', content: '后台消息', ts: 300 }));
    expect(usePanelStore.getState().unread).toEqual({ s2: 1 });
    expect(screen.getByTestId('topbar-chat-unread')).toHaveTextContent('1');

    // 展开面板 → ChatPanel 重挂载，切换器该会话显示未读徽标
    const user = userEvent.setup();
    await user.click(screen.getByTestId('right-panel-expand'));
    await screen.findByTestId('session-switcher');
    await user.click(screen.getByTestId('session-switcher'));
    expect(screen.getByTestId('unread-s2')).toHaveTextContent('1');

    // openChat（切换器选项点开 s2）→ 未读清零，徽标消失
    // （展开面板时 openChat() 已顺带清当前会话 s1 → 0，清零语义即"打开即读"）
    await user.click(screen.getByTestId('session-option-s2'));
    await waitFor(() => expect(usePanelStore.getState().unread).toEqual({ s1: 0, s2: 0 }));
    await waitFor(() => expect(screen.queryByTestId('unread-s2')).not.toBeInTheDocument());
    await waitFor(() => expect(screen.queryByTestId('topbar-chat-unread')).not.toBeInTheDocument());
  });

  it('多会话并行计数独立互不串扰', () => {
    emitMessageAdded(makeMessage({ id: 'x1', session_id: 'a', ts: 1 }));
    emitMessageAdded(makeMessage({ id: 'x2', session_id: 'b', ts: 2 }));
    emitMessageAdded(makeMessage({ id: 'x3', session_id: 'a', ts: 3 }));
    expect(usePanelStore.getState().unread).toEqual({ a: 2, b: 1 });

    emitMessageAdded(makeMessage({ id: 'x4', session_id: 'b', ts: 4 }));
    expect(usePanelStore.getState().unread).toEqual({ a: 2, b: 2 });
  });

  it('当前会话消息不计数', () => {
    usePanelStore.setState({ sessionId: 's1' });
    emitMessageAdded(makeMessage({ id: 'y1', session_id: 's1', ts: 1 }));
    expect(usePanelStore.getState().unread).toEqual({});
  });

  it('session.deleted 清被删会话未读条目（ChatPanel 未挂载的非当前会话）', () => {
    usePanelStore.setState({ unread: { gone: 3, keep: 1 } });
    act(() => {
      emitWsEvent({ type: 'session.deleted', session_id: 'gone' });
    });
    // clearUnread 置 0：0 值不显示徽标、不进 TopBar 总数，重水合 sanitize 剔除
    expect(usePanelStore.getState().unread).toEqual({ gone: 0, keep: 1 });
  });
});
