/**
 * Task 14 测试：聊天视图。WS 事件经 wsBus.emitWsEvent 直接灌入（模拟 WS hook），
 * REST 走 msw。覆盖：delta 流拼接渲染落定、折叠块开合与 tool input 截断、排队计数
 * （queued:true +1 / end 清零）、停止调用与停止后队列保留、模型修改 PATCH、新建会话、未读徽标。
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { HttpResponse, http } from 'msw';
import type { Message, Session, Workspace } from '@agentboard/shared';
import { RightPanel } from '../components/right/RightPanel';
import { emitWsEvent } from '../api/wsBus';
import { useAppStore } from '../state/appStore';
import { usePanelStore } from '../state/panelStore';
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

const clisInstalled = [
  { id: 'codebuddy', displayName: 'CodeBuddy', installed: true, version: '2.0.0' },
  { id: 'codex', displayName: 'Codex', installed: true, version: '1.0.0' },
  { id: 'opencode', displayName: 'OpenCode', installed: false, version: null },
  { id: 'dsh', displayName: 'DSH', installed: false, version: null },
];

// ---- 可观测 mock 状态 ----
const msgStore: Record<string, Message[]> = {};
let sessionsList: Session[] = [];
const postBodies: Array<{ text?: string }> = [];
let postResponses: Array<{ queued: boolean }> = [];
let stopCount = 0;
const patchBodies: Array<{ model?: string | null }> = [];
const createBodies: Array<Record<string, unknown>> = [];

function resetMocks(): void {
  for (const k of Object.keys(msgStore)) delete msgStore[k];
  sessionsList = [];
  postBodies.length = 0;
  postResponses = [];
  stopCount = 0;
  patchBodies.length = 0;
  createBodies.length = 0;
}

/** ChatPanel 所需全部 REST handlers（按需在用例内再用 server.use 覆盖） */
function mockChatApi(): void {
  server.use(
    http.get('/api/sessions', ({ request }) => {
      const wid = new URL(request.url).searchParams.get('workspace');
      return HttpResponse.json(sessionsList.filter((s) => wid === null || s.workspace_id === wid));
    }),
    http.get('/api/sessions/:id', ({ params }) => {
      const found = sessionsList.find((s) => s.id === params.id);
      return found !== undefined
        ? HttpResponse.json(found)
        : HttpResponse.json({ error: { code: 'NOT_FOUND', message: '会话不存在' } }, { status: 404 });
    }),
    http.get('/api/sessions/:id/messages', ({ params }) =>
      HttpResponse.json(msgStore[params.id as string] ?? []),
    ),
    http.post('/api/sessions/:id/messages', async ({ request }) => {
      postBodies.push((await request.json()) as { text?: string });
      return HttpResponse.json(postResponses.shift() ?? { queued: false });
    }),
    http.post('/api/sessions/:id/stop', ({ params }) => {
      stopCount += 1;
      return HttpResponse.json(makeSession({ id: params.id as string, status: '已结束' }));
    }),
    http.patch('/api/sessions/:id', async ({ request, params }) => {
      const body = (await request.json()) as { model?: string | null };
      patchBodies.push(body);
      return HttpResponse.json(
        makeSession({ id: params.id as string, model: body.model ?? null }),
      );
    }),
    http.post('/api/sessions', async ({ request }) => {
      const body = (await request.json()) as Record<string, unknown>;
      createBodies.push(body);
      return HttpResponse.json(
        makeSession({ id: 's2', cli: 'codex', model: 'mx', issue_id: null }),
      );
    }),
    http.get('/api/workspaces', () => HttpResponse.json([ws])),
    http.get('/api/clis', () => HttpResponse.json(clisInstalled)),
    http.get('/api/clis/:id/models', () =>
      HttpResponse.json([{ id: 'm-a', source: 'static' }]),
    ),
  );
}

function renderChat(session: Session | null = makeSession()): void {
  if (session !== null) {
    usePanelStore.setState({ view: 'chat', sessionId: session.id, chatSession: session, rightOpen: true });
  } else {
    usePanelStore.setState({ view: 'chat', sessionId: null, chatSession: null, rightOpen: true });
  }
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <RightPanel />
    </QueryClientProvider>,
  );
}

/** 灌入当前会话的流式 text delta */
function emitText(sid: string, delta: string): void {
  act(() => {
    emitWsEvent({ type: 'session.event', session_id: sid, event: { type: 'text', delta } });
  });
}

function emitEnd(sid: string): void {
  act(() => {
    emitWsEvent({ type: 'session.event', session_id: sid, event: { type: 'end', exitCode: 0 } });
  });
}

function emitMessageAdded(message: Message): void {
  act(() => {
    emitWsEvent({ type: 'message.added', message });
  });
}

beforeEach(() => {
  resetMocks();
  localStorage.clear();
  useAppStore.setState({ workspaceId: 'ws-1' });
  usePanelStore.setState({ view: null, issueId: null, sessionId: null, chatSession: null, unread: {}, rightOpen: false });
  mockChatApi();
});

describe('ChatPanel 消息流与流式渲染', () => {
  it('session.event text delta 拼接进流式气泡；message.added assistant 落定并清 buffer', async () => {
    sessionsList = [makeSession()];
    msgStore['s1'] = [makeMessage({ id: 'mu1', content: 'hi', ts: 100 })];
    renderChat();

    expect(await screen.findByTestId('msg-mu1')).toBeInTheDocument();

    emitText('s1', '你好');
    emitText('s1', '，');
    emitText('s1', '世界');
    const bubble = await screen.findByTestId('streaming-bubble');
    expect(bubble).toHaveTextContent('你好，世界');

    emitMessageAdded(makeMessage({ id: 'ma1', role: 'assistant', content: '你好，世界', ts: 200 }));
    await waitFor(() => expect(screen.queryByTestId('streaming-bubble')).not.toBeInTheDocument());
    const list = within(screen.getByTestId('message-list'));
    // 落定后 assistant 内容只出现一次（buffer 已清，不重复渲染）
    expect(list.getAllByText('你好，世界')).toHaveLength(1);
    expect(screen.getByTestId('msg-ma1')).toBeInTheDocument();
    // 运行中：三个跳动点
    expect(screen.getByTestId('running-indicator')).toBeInTheDocument();
  });

  it('event/error 折叠块：summary 显示工具名，input 截断 200 字符；点击开合；错误块', async () => {
    sessionsList = [makeSession()];
    const longInput = 'a'.repeat(250);
    msgStore['s1'] = [
      makeMessage({ id: 'mu1', content: 'hi', ts: 100 }),
      makeMessage({ id: 'me1', role: 'event', content: JSON.stringify({ name: 'read_file', input: longInput }), ts: 110 }),
      makeMessage({ id: 'mx1', role: 'error', content: 'boom 发生了', ts: 120 }),
    ];
    renderChat();

    const block = await screen.findByTestId('event-block-me1');
    expect(within(block).getByText('工具 · read_file')).toBeInTheDocument();
    expect(block).not.toHaveAttribute('open');
    // 截断：仅 200 字符 + 省略号
    expect(within(block).getByText(`${'a'.repeat(200)}…`)).toBeInTheDocument();
    expect(within(block).queryByText(longInput)).not.toBeInTheDocument();

    const errorBlock = screen.getByTestId('error-block-mx1');
    expect(within(errorBlock).getByText('错误')).toBeInTheDocument();

    const user = userEvent.setup();
    await user.click(within(block).getByText('工具 · read_file'));
    expect(block).toHaveAttribute('open');
    await user.click(within(block).getByText('工具 · read_file'));
    expect(block).not.toHaveAttribute('open');
  });
});

describe('ChatPanel 排队与停止', () => {
  it('POST 返回 queued:true 计数递增；收到 end 清零；POST 体带 text', async () => {
    sessionsList = [makeSession()];
    renderChat();
    const user = userEvent.setup();
    const input = await screen.findByTestId('composer-input');

    postResponses = [{ queued: true }, { queued: true }];
    await user.type(input, '第一条{Enter}');
    expect(await screen.findByTestId('queue-hint')).toHaveTextContent('排队中 1 条');
    await user.type(screen.getByTestId('composer-input'), '第二条{Enter}');
    expect(await screen.findByTestId('queue-hint')).toHaveTextContent('排队中 2 条');
    expect(postBodies.map((b) => b.text)).toEqual(['第一条', '第二条']);

    act(() => emitEnd('s1'));
    await waitFor(() => expect(screen.queryByTestId('queue-hint')).not.toBeInTheDocument());
  });

  it('停止按钮调用 POST stop；状态转已结束；停止后队列保留提示', async () => {
    sessionsList = [makeSession()];
    renderChat();
    const user = userEvent.setup();
    const input = await screen.findByTestId('composer-input');

    postResponses = [{ queued: true }];
    await user.type(input, '排队消息{Enter}');
    expect(await screen.findByTestId('queue-hint')).toHaveTextContent('排队中 1 条');
    expect(screen.getByTestId('stop-btn')).toBeInTheDocument();

    await user.click(screen.getByTestId('stop-btn'));
    expect(stopCount).toBe(1);
    // session.changed 覆盖：stop 响应已结束 → 不再显示停止按钮/运行指示
    await waitFor(() => expect(screen.queryByTestId('stop-btn')).not.toBeInTheDocument());
    expect(screen.queryByTestId('running-indicator')).not.toBeInTheDocument();
    // 队列保留提示（非运行中）
    expect(screen.getByTestId('queue-hint')).toHaveTextContent('已停止，排队 1 条保留');
  });
});

describe('ChatPanel 会话切换器与模型', () => {
  it('修改模型 → PATCH /api/sessions/:id {model} 且显示更新', async () => {
    sessionsList = [makeSession()];
    renderChat();
    const user = userEvent.setup();

    expect(await screen.findByTestId('model-display')).toHaveTextContent('codebuddy · m1');
    await user.click(screen.getByTestId('edit-model-btn'));
    const input = screen.getByTestId('model-input');
    expect(input).toHaveValue('m1');
    await user.clear(input);
    await user.type(input, 'm2');
    await user.click(screen.getByTestId('model-confirm'));

    await waitFor(() => expect(patchBodies).toEqual([{ model: 'm2' }]));
    expect(await screen.findByTestId('model-display')).toHaveTextContent('codebuddy · m2');
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('下拉分组显示任务/自由会话与徽标；非当前会话新消息未读 +1，选中后清零', async () => {
    sessionsList = [
      makeSession({ id: 's1', issue_id: 'iss-1' }),
      makeSession({ id: 's2', issue_id: null, cli: 'codex', status: '失败' }),
    ];
    renderChat(makeSession({ id: 's1', issue_id: 'iss-1' }));
    const user = userEvent.setup();
    await screen.findByTestId('model-display');

    emitMessageAdded(makeMessage({ id: 'mo1', session_id: 's2', content: '后台消息', ts: 300 }));
    await user.click(screen.getByTestId('session-switcher'));
    const menu = screen.getByTestId('session-menu');
    expect(within(menu).getByText('任务会话')).toBeInTheDocument();
    expect(within(menu).getByText('自由会话')).toBeInTheDocument();
    expect(screen.getByTestId('unread-s2')).toHaveTextContent('1');
    expect(screen.getByTestId('option-failed-s2')).toBeInTheDocument();

    await user.click(screen.getByTestId('session-option-s2'));
    // 切到 s2：消息流按 s2 拉取，未读清零
    await waitFor(() => expect(screen.getByTestId('model-display')).toHaveTextContent('codex · m1'));
    await user.click(screen.getByTestId('session-switcher'));
    expect(screen.queryByTestId('unread-s2')).not.toBeInTheDocument();
  });

  it('新建会话：弹窗提交 POST /api/sessions 并切到新会话', async () => {
    sessionsList = [makeSession()];
    renderChat();
    const user = userEvent.setup();
    await screen.findByTestId('model-display');

    await user.click(screen.getByTestId('new-session-btn'));
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    // CLI 默认第一个已安装项 codebuddy；切到 codex 后模型回上次值。
    // models 非空 → 模型字段为真下拉：选"手动输入…"切文本输入再手输 mx。
    await user.selectOptions(screen.getByTestId('ns-cli'), 'codex');
    await waitFor(async () => {
      expect(screen.getByTestId('ns-model').tagName).toBe('SELECT');
    });
    await user.selectOptions(screen.getByTestId('ns-model'), '手动输入…');
    await user.type(screen.getByTestId('ns-model'), 'mx');
    expect(screen.getByTestId('ns-workspace')).toHaveValue('ws-1');
    await user.click(screen.getByTestId('ns-confirm'));

    await waitFor(() => expect(createBodies).toEqual([{ cli: 'codex', model: 'mx', workspace_id: 'ws-1' }]));
    await waitFor(() => expect(screen.getByTestId('model-display')).toHaveTextContent('codex · mx'));
  });

  it('无选中会话：引导空态 + 新建入口', async () => {
    sessionsList = [];
    renderChat(null);
    expect(await screen.findByTestId('chat-empty')).toBeInTheDocument();
    expect(screen.queryByTestId('composer')).not.toBeInTheDocument();
    expect(screen.getByTestId('empty-new-session-btn')).toBeInTheDocument();
    await screen.findByTestId('session-switcher');
    await userEvent.click(screen.getByTestId('session-switcher'));
    expect(screen.getByTestId('session-menu-empty')).toBeInTheDocument();
  });

  it('当前工作空间暂无会话：空态提示会话归属创建时工作空间', async () => {
    sessionsList = [];
    renderChat(null);
    expect(await screen.findByTestId('chat-empty')).toBeInTheDocument();
    expect(
      await screen.findByText('会话归属创建时所选的工作空间，可切换左侧工作空间查找'),
    ).toBeInTheDocument();
  });
});

describe('ChatPanel 刷新恢复', () => {
  it('chatSession 缺失时按 sessionId 拉 GET /api/sessions/:id 渲染；404 → 清空回空态并提示归属', async () => {
    // 持久化恢复场景：sessionId 在、chatSession 空；会话归属另一工作空间
    sessionsList = [makeSession({ id: 'sx', workspace_id: 'ws-2' })];
    usePanelStore.setState({ view: 'chat', sessionId: 'sx', chatSession: null, rightOpen: true });
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={qc}>
        <RightPanel />
      </QueryClientProvider>,
    );

    // 按 id 拉取成功 → 直接渲染会话（CLI/模型条可见）
    expect(await screen.findByTestId('model-display')).toHaveTextContent('codebuddy · m1');

    // 换成不存在的会话 id → 清空 sessionId 回空态，不悬挂"会话加载中…"，且当前工作空间无会话时提示归属
    act(() => {
      usePanelStore.setState({ sessionId: 'gone', chatSession: null });
    });
    await waitFor(() => expect(usePanelStore.getState().sessionId).toBeNull());
    expect(screen.getByTestId('chat-empty')).toBeInTheDocument();
    expect(screen.queryByText('会话加载中…')).not.toBeInTheDocument();
    expect(screen.getByText('选择一个会话开始对话，或新建自由会话')).toBeInTheDocument();
    expect(screen.getByText('会话归属创建时所选的工作空间，可切换左侧工作空间查找')).toBeInTheDocument();
  });
});
