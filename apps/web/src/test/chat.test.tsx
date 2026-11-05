/**
 * Task 14 测试：聊天视图。WS 事件经 wsBus.emitWsEvent 直接灌入（模拟 WS hook），
 * REST 走 msw。覆盖：delta 流拼接渲染落定、折叠块开合与 tool input 截断、排队计数
 * （queued:true +1 / end 清零）、停止调用与停止后队列保留、模型修改 PATCH、新建会话、未读徽标。
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { HttpResponse, http } from 'msw';
import type { Issue, Message, Session, Workspace } from '@agentboard/shared';
import { ChatView } from '../components/chat/ChatView';
import { ChatPanel } from '../components/chat/ChatPanel';
import { emitWsEvent } from '../api/wsBus';
import { useAppStore } from '../state/appStore';
import { usePanelStore } from '../state/panelStore';
import { useNavStore } from '../state/navStore';
import { useStreamingStore } from '../state/streamingStore';
import { server } from './server';

const ws: Workspace = { id: 'ws-1', name: '主项目', path: 'D:/ws/main', created_at: 1 };
// 工作空间列表可覆盖（聊天头部空间名称用例）
let workspacesList: Workspace[] = [ws];

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

/** 泡泡外观类（背景/边框/圆角）：assistant 正文容器不应含任何一项 */
const BUBBLE_CLASS = /^(rounded|bg-|border)/;

/** 取元素上的泡泡外观类（用于正/反断言） */
function bubbleClasses(el: HTMLElement): string[] {
  return Array.from(el.classList).filter((c) => BUBBLE_CLASS.test(c));
}

function expectAssistantBody(testId: string): { row: HTMLElement; body: HTMLElement } {
  const row = screen.getByTestId(testId);
  const body = row.firstElementChild as HTMLElement;
  // 行容器与正文容器都不得带泡泡外观（圆角/背景/边框）
  expect(bubbleClasses(row)).toEqual([]);
  expect(bubbleClasses(body)).toEqual([]);
  // 正文容器可收缩（min-w-0）+ 撑满（flex-1/max-w-full）：长代码行在 pre 内横向滚动，不撑破消息流
  expect(body).toHaveClass('min-w-0', 'max-w-full', 'flex-1');
  return { row, body };
}

function makeIssue(overrides: Partial<Issue> = {}): Issue {
  return {
    id: 'iss-1',
    workspace_id: 'ws-1',
    title: '测试任务',
    description: '任务描述内容',
    priority: '中',
    labels: ['前端'],
    status: '进行中',
    sort_order: 0,
    parent_issue_id: null,
    claimed_by: 'agent:codebuddy',
    claimed_at: 5,
    session_id: 's1',
    comment_count: 0,
    created_at: 1,
    updated_at: 1,
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
// workspaces 列表回落（resetMocks 复位）
// 删除会话可观测态：调用记录 + 可覆盖响应（默认 204 并从 sessionsList 剔除）
const deleteCalls: string[] = [];
let deleteResponse: { status: number; body: unknown } | null = null;
const patchBodies: Array<{ model?: string | null }> = [];
const createBodies: Array<Record<string, unknown>> = [];
const queueStore: Record<string, string[]> = {};
// 任务会话「标记待验收」可观测态：GET /api/issues/:id 数据源、done 调用记录、issues GET 次数
let issueStore: Issue | undefined;
const doneCalls: Array<{ id: string; body: Record<string, unknown> }> = [];
let issueGetCount = 0;

function resetMocks(): void {
  for (const k of Object.keys(msgStore)) delete msgStore[k];
  sessionsList = [];
  postBodies.length = 0;
  postResponses = [];
  stopCount = 0;
  workspacesList = [ws];
  deleteCalls.length = 0;
  deleteResponse = null;
  patchBodies.length = 0;
  createBodies.length = 0;
  for (const k of Object.keys(queueStore)) delete queueStore[k];
  issueStore = undefined;
  doneCalls.length = 0;
  issueGetCount = 0;
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
    http.get('/api/sessions/:id/queue', ({ params }) =>
      HttpResponse.json({ texts: queueStore[params.id as string] ?? [] }),
    ),
    http.post('/api/sessions/:id/messages', async ({ request }) => {
      postBodies.push((await request.json()) as { text?: string });
      return HttpResponse.json(postResponses.shift() ?? { queued: false });
    }),
    http.delete('/api/sessions/:id', ({ params }) => {
      deleteCalls.push(params.id as string);
      if (deleteResponse !== null) {
        return HttpResponse.json(deleteResponse.body as Record<string, unknown>, { status: deleteResponse.status });
      }
      sessionsList = sessionsList.filter((s) => s.id !== params.id);
      return new HttpResponse(null, { status: 204 });
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
    http.get('/api/issues/:id', ({ params }) => {
      issueGetCount += 1;
      return issueStore !== undefined && issueStore.id === params.id
        ? HttpResponse.json(issueStore)
        : HttpResponse.json({ error: { code: 'NOT_FOUND', message: '任务不存在' } }, { status: 404 });
    }),
    // 模拟服务端 done 语义：置待验收并释放占用（后续 issues GET 返回未占用对象）
    http.post('/api/issues/:id/done', async ({ params, request }) => {
      const body = (await request.json()) as Record<string, unknown>;
      doneCalls.push({ id: params.id as string, body });
      if (issueStore !== undefined && issueStore.id === params.id) {
        issueStore = { ...issueStore, status: '待验收', claimed_by: null, claimed_at: null, updated_at: 9 };
      }
      return HttpResponse.json(
        issueStore ?? makeIssue({ id: params.id as string, status: '待验收', claimed_by: null, claimed_at: null }),
      );
    }),
    http.get('/api/workspaces', () => HttpResponse.json(workspacesList)),
    http.get('/api/clis', () => HttpResponse.json(clisInstalled)),
    http.get('/api/clis/:id/models', () =>
      HttpResponse.json([{ id: 'm-a', source: 'static' }]),
    ),
  );
}

function renderChat(session: Session | null = makeSession()): QueryClient {
  if (session !== null) {
    usePanelStore.setState({ view: null, sessionId: session.id, chatSession: session, rightOpen: false });
    useNavStore.setState({ view: 'chat' });
  } else {
    usePanelStore.setState({ view: null, sessionId: null, chatSession: null, rightOpen: false });
    useNavStore.setState({ view: 'chat' });
  }
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      {/* S3：聊天视图 = 左会话列表 + 右消息区，会话选择改由左栏列表提供 */}
      <ChatView />
    </QueryClientProvider>,
  );
  return qc;
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
  useStreamingStore.setState({ streams: new Map() });
  mockChatApi();
});

describe('ChatPanel 消息流与流式渲染', () => {
  it('用户消息用 unslop 强调令牌气泡（不再是旧蓝色），历史 assistant 消息直接显示正文', async () => {
    sessionsList = [makeSession()];
    msgStore['s1'] = [
      makeMessage({ id: 'mu1', role: 'user', content: '问题', ts: 100 }),
      makeMessage({
        id: 'ma0',
        role: 'assistant',
        content: '历史 **回答**\n\n- 列表项一\n- 列表项二\n\n```ts\nconst answer = 42;\n```',
        ts: 200,
      }),
    ];
    renderChat();

    expect(await screen.findByTestId('msg-mu1')).toBeInTheDocument();
    const userRow = screen.getByTestId('msg-mu1');
    const userBubble = userRow.firstElementChild as HTMLElement;
    expect(userBubble).toHaveClass('rounded-lg', 'rounded-br-sm', 'bg-accent-soft', 'text-ink', 'px-2.5', 'py-1.5');
    // PALETTE-CHAT-DETAIL：旧 blue 色板必须消失
    expect(userBubble.className).not.toMatch(/bg-blue-\d|text-blue-\d/);
    // 反向：用户泡泡确实保留泡泡外观类，且仍右对齐
    expect(bubbleClasses(userBubble)).toEqual(expect.arrayContaining(['rounded-lg', 'rounded-br-sm', 'bg-accent-soft']));
    expect(userRow).toHaveClass('justify-end');
    const history = expectAssistantBody('msg-ma0');
    // MarkdownView 懒加载：等真实结构渲染出来再断言（不固定 sleep）
    await waitFor(() => {
      const markdown = history.body.querySelector('.markdown-body');
      expect(markdown?.querySelector('strong')?.textContent).toBe('回答');
      expect(markdown?.querySelectorAll('ul li')).toHaveLength(2);
      expect(markdown?.querySelector('pre code')?.textContent).toContain('const answer = 42;');
    }, { timeout: 5000 });
    const markdown = history.body.querySelector('.markdown-body');
    // 代码高亮标记仍在（rehype-highlight 生效）
    expect(markdown?.querySelector('pre code')?.className).toContain('hljs');
  });

  it('session.event text delta 拼接进流式气泡；message.added assistant 落定并清 buffer', async () => {
    sessionsList = [makeSession()];
    msgStore['s1'] = [makeMessage({ id: 'mu1', content: 'hi', ts: 100 })];
    renderChat();

    expect(await screen.findByTestId('msg-mu1')).toBeInTheDocument();

    emitText('s1', '你好');
    emitText('s1', '，');
    emitText('s1', '世界');
    const stream = await screen.findByTestId('streaming-bubble');
    const streamingBody = expectAssistantBody('streaming-bubble').body;
    expect(stream).toHaveTextContent('你好，世界');
    const streamingRowClass = stream.className;
    const streamingBodyClass = streamingBody.className;

    emitMessageAdded(makeMessage({ id: 'ma1', role: 'assistant', content: '你好，世界', ts: 200 }));
    await waitFor(() => expect(screen.queryByTestId('streaming-bubble')).not.toBeInTheDocument());
    const list = within(screen.getByTestId('message-list'));
    // 落定后 assistant 内容只出现一次（buffer 已清，不重复渲染）
    expect(list.getAllByText('你好，世界')).toHaveLength(1);
    const settled = expectAssistantBody('msg-ma1');
    expect(settled.row.className).toBe(streamingRowClass);
    expect(settled.body.className).toBe(streamingBodyClass);
    // 运行中：三个跳动点
    expect(screen.getByTestId('running-indicator')).toBeInTheDocument();
  });

  it('流式输出为无泡泡正文容器：流式态渲染 Markdown/代码高亮，落定后容器类名完全一致（不闪变）', async () => {
    sessionsList = [makeSession()];
    msgStore['s1'] = [makeMessage({ id: 'mu1', content: 'hi', ts: 100 })];
    renderChat();
    await screen.findByTestId('msg-mu1');

    const md = '**流式粗体**\n\n```ts\nconst streamed = 1;\n```';
    emitText('s1', md);
    const stream = await screen.findByTestId('streaming-bubble');
    const body = expectAssistantBody('streaming-bubble').body;
    // 流式态同样走 MarkdownView（懒加载）：等待真实渲染落地后再断言粗体/代码块/高亮
    await waitFor(() => {
      const streamMarkdown = body.querySelector('.markdown-body');
      expect(streamMarkdown?.querySelector('strong')?.textContent).toBe('流式粗体');
      expect(streamMarkdown?.querySelector('pre code')?.textContent).toContain('const streamed = 1;');
      expect(streamMarkdown?.querySelector('pre code')?.className).toContain('hljs');
    }, { timeout: 5000 });
    const streamingRowClass = stream.className;
    const streamingBodyClass = body.className;

    emitMessageAdded(makeMessage({ id: 'ma2', role: 'assistant', content: md, ts: 200 }));
    await waitFor(() => expect(screen.queryByTestId('streaming-bubble')).not.toBeInTheDocument());
    const settled = expectAssistantBody('msg-ma2');
    expect(settled.row.className).toBe(streamingRowClass);
    expect(settled.body.className).toBe(streamingBodyClass);
  });

  it('思考/工具/错误块仍在消息流内，聚合块未被 assistant 正文容器吞掉', async () => {
    sessionsList = [makeSession()];
    msgStore['s1'] = [
      makeMessage({ id: 'mu1', content: 'hi', ts: 100 }),
      makeMessage({ id: 'mt1', role: 'event', content: JSON.stringify({ kind: 'thinking', text: '内部推理' }), ts: 110 }),
      makeMessage({ id: 'me1', role: 'event', content: JSON.stringify({ name: 'read_file', input: '{"a":1}' }), ts: 120 }),
      makeMessage({ id: 'mx1', role: 'error', content: 'boom 发生了', ts: 130 }),
      makeMessage({ id: 'ma1', role: 'assistant', content: '答复', ts: 140 }),
    ];
    renderChat();

    const list = screen.getByTestId('message-list');
    await screen.findByTestId('msg-ma1');
    // AUDIT-3：同一轮连续事件聚合成一个折叠块，该块是 message-list 的直接子节点（未被正文容器吞掉）
    const group = screen.getByTestId('event-group-mt1');
    expect(group.parentElement).toBe(list);
    expect(screen.getByTestId('msg-mu1').parentElement).toBe(list);
    expect(screen.getByTestId('msg-ma1').parentElement).toBe(list);
    expect(screen.getByTestId('error-block-mx1').parentElement).toBe(list);
    expect(within(group).getByTestId('thinking-block-mt1')).toBeInTheDocument();
    expect(within(group).getByTestId('event-block-me1')).toBeInTheDocument();
    // 汇总行计数：工具 1 次 · 思考 1 段；默认收起
    expect(screen.getByTestId('event-group-summary-mt1')).toHaveTextContent('工具 1 次 · 思考 1 段');
    expect(group).not.toHaveAttribute('open');
    // 折叠块自身保留 summary 与 pre 正文
    expect(within(screen.getByTestId('thinking-block-mt1')).getByText('思考')).toBeInTheDocument();
    expect(within(screen.getByTestId('event-block-me1')).getByText('工具 · read_file')).toBeInTheDocument();
    expect(within(screen.getByTestId('error-block-mx1')).getByText('错误')).toBeInTheDocument();
  });

  it('AUDIT-3：事件按轮聚合为一行汇总，点开后逐条明细', async () => {
    sessionsList = [makeSession()];
    const events = Array.from({ length: 20 }, (_, i) => {
      const thinking = i < 8;
      return makeMessage({
        id: `e${i}`,
        role: 'event',
        content: JSON.stringify(
          thinking ? { kind: 'thinking', text: `思考 ${i}` } : { name: 'read_file', input: `p${i}` },
        ),
        ts: 110 + i,
      });
    });
    msgStore['s1'] = [
      makeMessage({ id: 'mu1', content: 'hi', ts: 100 }),
      ...events,
      makeMessage({ id: 'ma1', role: 'assistant', content: '答复', ts: 200 }),
    ];
    renderChat();

    const group = await screen.findByTestId('event-group-e0');
    expect(group).not.toHaveAttribute('open');
    expect(screen.getByTestId('event-group-summary-e0')).toHaveTextContent('工具 12 次 · 思考 8 段');

    const user = userEvent.setup();
    await user.click(screen.getByTestId('event-group-summary-e0'));
    expect(group).toHaveAttribute('open');
    expect(within(group).getAllByTestId(/^(event|thinking)-block-/)).toHaveLength(20);
  });

  it('运行中会话后台收流不丢：流式期间切到 B，A 的 delta 继续累积且不串显；切回 A 显示完整内容', async () => {
    sessionsList = [makeSession({ id: 's1' }), makeSession({ id: 's2', cli: 'codex' })];
    renderChat(makeSession({ id: 's1' }));
    await screen.findByTestId('model-display');

    emitText('s1', '后台');
    expect(await screen.findByTestId('streaming-bubble')).toHaveTextContent('后台');

    // 切到 s2（切换器真实路径）
    const user = userEvent.setup();
    // 侧栏会话查询独立于 ChatPanel 的 ['sessions', workspaceId]，需等它到位
    await user.click(await screen.findByTestId('session-option-s2'));
    await waitFor(() => expect(screen.getByTestId('model-display')).toHaveTextContent('codex · m1'));

    // A 在后台继续流式：累积进 store，B 视图不显示 A 的内容
    emitText('s1', '继续');
    emitText('s1', '累积');
    expect(screen.queryByTestId('streaming-bubble')).not.toBeInTheDocument();

    // 切回 A：完整累积文本（含切走期间的 delta）
    await user.click(screen.getByTestId('session-option-s1'));
    const bubble = await screen.findByTestId('streaming-bubble');
    expect(bubble).toHaveTextContent('后台继续累积');
  });

  it('切走再切回聊天：进行中的流式内容不丢，卸载期间 delta 继续累积', async () => {
    sessionsList = [makeSession()];
    const first = renderChat();
    await screen.findByTestId('model-display');

    emitText('s1', '收起前');
    expect(await screen.findByTestId('streaming-bubble')).toHaveTextContent('收起前');

    // S2b：聊天整屏化 —— ChatPanel 随主区视图切换整块卸载（不再有右侧面板收起态）
    cleanup();
    act(() => useNavStore.getState().setView('board'));
    expect(screen.queryByTestId('chat-panel')).toBeNull();
    // 卸载期间流式增量仍进 store（全局 WS 层照常收流）
    emitText('s1', '期间');
    expect(usePanelStore.getState().view).toBeNull();

    // 切回聊天 → 累积内容完整呈现
    renderChat();
    const bubble = await screen.findByTestId('streaming-bubble');
    expect(screen.getByTestId('chat-panel')).toBeInTheDocument();
    expect(bubble).toHaveTextContent('收起前期间');
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

  it('thinking 折叠块：默认收起、正文纯文本、可开合', async () => {
    sessionsList = [makeSession()];
    msgStore['s1'] = [
      makeMessage({ id: 'mu1', content: 'hi', ts: 100 }),
      makeMessage({
        id: 'mt1',
        role: 'event',
        content: JSON.stringify({ kind: 'thinking', text: '内部推理过程' }),
        ts: 105,
      }),
    ];
    renderChat();

    const block = await screen.findByTestId('thinking-block-mt1');
    expect(within(block).getByText('思考')).toBeInTheDocument();
    expect(block).not.toHaveAttribute('open');
    expect(within(block).getByText('内部推理过程')).toBeInTheDocument();

    const user = userEvent.setup();
    await user.click(within(block).getByText('思考'));
    expect(block).toHaveAttribute('open');
    await user.click(within(block).getByText('思考'));
    expect(block).not.toHaveAttribute('open');
  });

  it('无 thinking 消息不出现空思考块；旧格式 event 消息仍按工具块/原文渲染', async () => {
    sessionsList = [makeSession()];
    msgStore['s1'] = [
      makeMessage({ id: 'mu1', content: 'hi', ts: 100 }),
      makeMessage({ id: 'me1', role: 'event', content: JSON.stringify({ name: 'read_file', input: 'p' }), ts: 110 }),
      makeMessage({ id: 'mr1', role: 'event', content: '无法解析的原文', ts: 115 }),
    ];
    renderChat();

    await screen.findByTestId('event-block-me1');
    expect(within(screen.getByTestId('event-block-me1')).getByText('工具 · read_file')).toBeInTheDocument();
    expect(within(screen.getByTestId('event-block-mr1')).getByText('无法解析的原文')).toBeInTheDocument();
    expect(screen.queryByTestId('thinking-block-me1')).not.toBeInTheDocument();
    expect(screen.queryByTestId('thinking-block-mr1')).not.toBeInTheDocument();
  });

  // AUDIT-SRV（F-04 / F-06）：错误归类卡片、重试动作、长 URL 截断、编码丢失标记
  it('error_code 卡片：额度错误给原因与用量入口；限流错误可重试（重发上一条 user）；长 URL 截断；编码丢失标记', async () => {
    sessionsList = [makeSession()];
    const longUrl = `https://example.com/oauth/callback?token=${'a'.repeat(80)}`;
    msgStore['s1'] = [
      makeMessage({ id: 'mu1', content: '帮我查一下', ts: 100 }),
      makeMessage({
        id: 'mq1',
        role: 'error',
        content: `额度已用尽 429 ${longUrl}`,
        ts: 110,
        error_code: 'QUOTA_EXCEEDED',
        retryable: false,
      }),
      makeMessage({
        id: 'mr1',
        role: 'error',
        content: '429 Too Many Requests',
        ts: 120,
        error_code: 'RATE_LIMITED',
        retryable: true,
      }),
      makeMessage({ id: 'ma1', role: 'assistant', content: '???? ???', ts: 130, encoding_lost: true }),
    ];
    renderChat();
    const user = userEvent.setup();

    // 额度错误：中文原因 + 用量入口，明确不可直接重试（不给重试按钮）
    const quota = await screen.findByTestId('error-block-mq1');
    expect(within(quota).getByTestId('error-code-mq1')).toHaveTextContent('额度已用尽');
    expect(within(quota).getByTestId('error-open-usage')).toBeInTheDocument();
    expect(within(quota).queryByTestId('error-retry-mq1')).not.toBeInTheDocument();
    // 长 URL 截断显示，完整正文留在 title
    const body = within(quota).getByTestId('error-body-mq1');
    expect(body.textContent).not.toContain('a'.repeat(80));
    expect(body.textContent).toContain('…');
    expect(body).toHaveAttribute('title', `额度已用尽 429 ${longUrl}`);

    // 限流错误：可重试 → 点击后重发上一条 user 消息
    const rate = screen.getByTestId('error-block-mr1');
    postResponses = [{ queued: false }];
    await user.click(within(rate).getByTestId('error-retry-mr1'));
    await waitFor(() => expect(postBodies.at(-1)?.text).toBe('帮我查一下'));

    // 切换模型入口：点击打开模型弹窗（复用既有 ModelSelector）
    await user.click(within(rate).getByTestId('error-switch-model'));
    expect(await screen.findByTestId('model-input')).toBeInTheDocument();

    // 编码丢失：旧消息显示标记
    expect(within(screen.getByTestId('msg-ma1')).getByTestId('encoding-lost-ma1')).toHaveTextContent('原始编码不可用');
  });
});

describe('ChatPanel 排队与停止', () => {
  it('POST 返回 queued:true 计数递增；轮 end 后等服务端 session.runtime(queued_count=0) 清零；POST 体带 text', async () => {
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

    // end 事件不本地清零：排队消息在服务端合并前仍处于排队态
    act(() => emitEnd('s1'));
    expect(screen.getByTestId('queue-hint')).toHaveTextContent('排队中 2 条');

    // 服务端合并起下一轮后广播 runtime → 计数归零
    act(() => {
      emitWsEvent({ type: 'session.runtime', session_id: 's1', queued_count: 0, waiting_slot: false });
    });
    await waitFor(() => expect(screen.queryByTestId('queue-hint')).not.toBeInTheDocument());
  });

  it('切换会话/刷新后计数与等待槽位取自服务端 sessions 字段；session.runtime 事件到达即校正', async () => {
    sessionsList = [makeSession({ queued_count: 2, waiting_slot: true })];
    renderChat();

    // 初始挂载即从 sessions query 字段回填（此前纯本地计数在切换/刷新后归零的缺陷）
    expect(await screen.findByTestId('queue-hint')).toHaveTextContent('排队中 2 条');
    expect(screen.getByTestId('waiting-slot-badge')).toHaveTextContent('等待槽位');

    act(() => {
      emitWsEvent({ type: 'session.runtime', session_id: 's1', queued_count: 3, waiting_slot: false });
    });
    expect(await screen.findByTestId('queue-hint')).toHaveTextContent('排队中 3 条');
    expect(screen.queryByTestId('waiting-slot-badge')).not.toBeInTheDocument();
  });

  it('排队中可展开只读队列内容列表（GET /sessions/:id/queue 打开即拉，含停止后场景）', async () => {
    sessionsList = [makeSession({ queued_count: 2 })];
    queueStore['s1'] = ['排队消息甲', '排队消息乙'];
    renderChat();
    const user = userEvent.setup();

    expect(await screen.findByTestId('queue-hint')).toHaveTextContent('排队中 2 条');
    expect(screen.queryByTestId('queue-list')).not.toBeInTheDocument();

    await user.click(screen.getByTestId('queue-toggle'));
    const list = await screen.findByTestId('queue-list');
    expect(list).toHaveTextContent('排队消息甲');
    expect(list).toHaveTextContent('排队消息乙');

    // 收起
    await user.click(screen.getByTestId('queue-toggle'));
    await waitFor(() => expect(screen.queryByTestId('queue-list')).not.toBeInTheDocument());
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

describe('ChatPanel 标记待验收', () => {
  it('任务会话占用中：顶部工具条显示「标记待验收」按钮', async () => {
    issueStore = makeIssue({ claimed_by: 'agent:codebuddy' });
    sessionsList = [makeSession({ issue_id: 'iss-1' })];
    renderChat(makeSession({ issue_id: 'iss-1' }));

    expect(await screen.findByTestId('chat-done-btn')).toBeInTheDocument();
  });

  it('点击标记待验收：POST /api/issues/:id/done {agent_id:user}，占用释放后按钮消失', async () => {
    issueStore = makeIssue({ claimed_by: 'agent:codebuddy' });
    sessionsList = [makeSession({ issue_id: 'iss-1' })];
    renderChat(makeSession({ issue_id: 'iss-1' }));
    const user = userEvent.setup();

    await user.click(await screen.findByTestId('chat-done-btn'));
    await waitFor(() => expect(doneCalls).toEqual([{ id: 'iss-1', body: { agent_id: 'user' } }]));
    // done 响应释放占用 → ['issue', id] 失效重取（claimed_by null）→ 按钮自然消失
    await waitFor(() => expect(screen.queryByTestId('chat-done-btn')).not.toBeInTheDocument());
  });

  it('自由会话：不渲染按钮且不拉取关联任务', async () => {
    sessionsList = [makeSession({ issue_id: null })];
    renderChat(makeSession({ issue_id: null }));

    await screen.findByTestId('model-display');
    expect(screen.queryByTestId('chat-done-btn')).not.toBeInTheDocument();
    expect(issueGetCount).toBe(0);
  });
});

describe('ChatPanel 会话切换器与模型', () => {
  it('修改模型 → PATCH /api/sessions/:id {model} 且显示更新', async () => {
    sessionsList = [makeSession()];
    renderChat();
    const user = userEvent.setup();

    expect(await screen.findByTestId('model-display')).toHaveTextContent('codebuddy · m1');
    // AUDIT-3：「修改」收进头部 ⋯ 菜单
    await user.click(screen.getByTestId('chat-header-menu-btn'));
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

  it('修改模型：旧会话模型不在新清单时保留并可返回列表', async () => {
    sessionsList = [makeSession({ model: 'legacy-model' })];
    renderChat(makeSession({ model: 'legacy-model' }));
    const user = userEvent.setup();

    await screen.findByTestId('model-display');
    await user.click(screen.getByTestId('chat-header-menu-btn'));
    await user.click(await screen.findByTestId('edit-model-btn'));
    const input = screen.getByTestId('model-input') as HTMLInputElement;
    expect(input).toHaveValue('legacy-model');
    expect(await screen.findByTestId('model-input-not-in-list')).toHaveTextContent('当前模型不在此 CLI 列表中');

    await user.click(screen.getByTestId('model-input-back'));
    const select = screen.getByTestId('model-input') as HTMLSelectElement;
    expect(select).toHaveValue('legacy-model');
    expect(within(select).getByRole('option', { name: 'legacy-model（不在当前列表）' })).toBeInTheDocument();

    await user.selectOptions(select, 'm-a');
    await user.click(screen.getByTestId('model-confirm'));
    await waitFor(() => expect(patchBodies).toEqual([{ model: 'm-a' }]));
  });

  it('左栏分组显示任务/自由会话与徽标；非当前会话新消息未读 +1，选中后清零', async () => {
    sessionsList = [
      makeSession({ id: 's1', issue_id: 'iss-1' }),
      makeSession({ id: 's2', issue_id: null, cli: 'codex', status: '失败' }),
    ];
    renderChat(makeSession({ id: 's1', issue_id: 'iss-1' }));
    const user = userEvent.setup();
    await screen.findByTestId('model-display');

    emitMessageAdded(makeMessage({ id: 'mo1', session_id: 's2', content: '后台消息', ts: 300 }));
    // S3：会话列表常驻左栏（不再是下拉菜单）——按工作空间分组 + 无任务会话分组
    const list = await screen.findByTestId('chat-session-list');
    await screen.findByTestId('session-row-s2');
    expect(within(list).getByText('主项目')).toBeInTheDocument();
    expect(within(list).getByText('无任务会话')).toBeInTheDocument();
    expect(screen.getByTestId('unread-s2')).toHaveTextContent('1');
    expect(screen.getByTestId('option-failed-s2')).toBeInTheDocument();

    await user.click(screen.getByTestId('session-option-s2'));
    // 切到 s2：消息流按 s2 拉取，未读清零
    await waitFor(() => expect(screen.getByTestId('model-display')).toHaveTextContent('codex · m1'));
    expect(screen.queryByTestId('unread-s2')).not.toBeInTheDocument();
  });

  it('session.deleted：当前会话被删 → 清空回空态，切换器不再出现该会话', async () => {
    sessionsList = [makeSession({ id: 's1' }), makeSession({ id: 's2', cli: 'codex' })];
    const qc = renderChat();
    await screen.findByTestId('model-display');
    // 等左列表就位（默认选中已发生，后续删除不应触发重新选中）
    await screen.findByTestId('session-option-s1');

    // 服务端删除：['sessions'] 失效刷新剔除 s1（connectWs 事件失效语义），并广播 session.deleted
    sessionsList = [makeSession({ id: 's2', cli: 'codex' })];
    act(() => {
      emitWsEvent({ type: 'session.deleted', session_id: 's1' });
    });
    await waitFor(() => expect(usePanelStore.getState().sessionId).toBeNull());
    await qc.invalidateQueries({ queryKey: ['sessions'] });

    expect(screen.getByTestId('chat-empty')).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByTestId('session-option-s1')).not.toBeInTheDocument());
    expect(screen.getByTestId('session-option-s2')).toBeInTheDocument();
  });

  it('session.deleted：非当前会话被删 → 仅从切换器剔除，当前会话不受影响', async () => {
    sessionsList = [makeSession({ id: 's1' }), makeSession({ id: 's2', cli: 'codex' })];
    const qc = renderChat();
    await screen.findByTestId('model-display');

    await screen.findByTestId('session-option-s2');
    sessionsList = [makeSession({ id: 's1' })];
    act(() => {
      emitWsEvent({ type: 'session.deleted', session_id: 's2' });
    });
    await qc.invalidateQueries({ queryKey: ['sessions'] });

    expect(screen.getByTestId('model-display')).toHaveTextContent('codebuddy · m1');
    await waitFor(() => expect(screen.queryByTestId('session-option-s2')).not.toBeInTheDocument());
    expect(screen.getByTestId('session-option-s1')).toBeInTheDocument();
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

  it('新建会话：CLI 切换恢复旧 localStorage 模型并显示它不在当前清单', async () => {
    sessionsList = [makeSession()];
    localStorage.setItem('agentboard.last-model.codex', 'old-codex-model');
    renderChat();
    const user = userEvent.setup();

    await user.click(await screen.findByTestId('new-session-btn'));
    await user.selectOptions(screen.getByTestId('ns-cli'), 'codex');

    const notInList = await screen.findByTestId('ns-model-not-in-list');
    expect(notInList).toHaveTextContent('当前模型不在此 CLI 列表中');
    const input = screen.getByTestId('ns-model') as HTMLInputElement;
    expect(input).toHaveValue('old-codex-model');

    await user.click(screen.getByTestId('ns-model-back'));
    const select = screen.getByTestId('ns-model') as HTMLSelectElement;
    expect(select).toHaveValue('old-codex-model');
    expect(within(select).getByRole('option', { name: 'old-codex-model（不在当前列表）' })).toBeInTheDocument();

    await user.selectOptions(select, 'm-a');
    await waitFor(() => expect(select).toHaveValue('m-a'));
  });

  it('无选中会话：引导空态 + 新建入口', async () => {
    sessionsList = [];
    renderChat(null);
    expect(await screen.findByTestId('chat-empty')).toBeInTheDocument();
    expect(screen.queryByTestId('composer')).not.toBeInTheDocument();
    expect(screen.getByTestId('empty-new-session-btn')).toBeInTheDocument();
    expect(await screen.findByTestId('chat-session-list-empty')).toBeInTheDocument();
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
    usePanelStore.setState({ view: null, sessionId: 'sx', chatSession: null, rightOpen: false });
    useNavStore.setState({ view: 'chat' });
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={qc}>
        <ChatPanel />
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

describe('ChatPanel 运行态以服务端为准（会话对象优先级）', () => {
  it('持久化快照为运行中、服务端已结束：刷新后不显示运行三点与停止按钮', async () => {
    // 复现：会话在「运行中」时打开（持久化 chatSession=运行中），轮次结束后刷新页面，
    // 持久化快照不回写 → 必须以 sessions 列表的服务端状态校正，否则假忙。
    // 落定条件用正向信号：列表带回 waiting_slot=true 才渲染「等待槽位」徽标，
    // 该徽标出现即证明列表已被采纳（不靠对「消失」的反向等待碰超时窗口）。
    sessionsList = [makeSession({ status: '已结束', waiting_slot: true })];
    renderChat(makeSession({ status: '运行中' }));
    await screen.findByTestId('model-display');

    expect(await screen.findByTestId('waiting-slot-badge', {}, { timeout: 5000 })).toBeInTheDocument();
    expect(screen.queryByTestId('running-indicator')).not.toBeInTheDocument();
    expect(screen.queryByTestId('stop-btn')).not.toBeInTheDocument();
  });

  it('WS session.changed 仍优先于列表：新一轮开始（运行中）后立刻显示运行三点与停止按钮', async () => {
    sessionsList = [makeSession({ status: '已结束' })];
    renderChat(makeSession({ status: '已结束' }));
    await screen.findByTestId('model-display');

    act(() => {
      emitWsEvent({ type: 'session.changed', session: makeSession({ status: '运行中' }) });
    });
    expect(await screen.findByTestId('running-indicator')).toBeInTheDocument();
    expect(screen.getByTestId('stop-btn')).toBeInTheDocument();
  });

  it('列表不含该会话时保留持久化快照状态，不误清显示', async () => {
    sessionsList = [makeSession({ id: 'other', cli: 'codex' })];
    renderChat(makeSession({ status: '运行中' }));
    await screen.findByTestId('model-display');

    expect(screen.getByTestId('running-indicator')).toBeInTheDocument();
    expect(screen.getByTestId('stop-btn')).toBeInTheDocument();
  });
});

describe('ChatPanel 删除会话（持久删除 + 安全回退）', () => {
  it('确认删除非当前会话：调用 DELETE，列表剔除，未读清零，当前选中不变', async () => {
    sessionsList = [makeSession({ id: 's1' }), makeSession({ id: 's2', cli: 'codex' })];
    usePanelStore.setState({ unread: { s2: 3, other: 1 } });
    renderChat(makeSession({ id: 's1' }));
    const user = userEvent.setup();
    await screen.findByTestId('model-display');

    await user.click(await screen.findByTestId('session-delete-s2'));
    // 二次确认：未确认前不调用 DELETE
    expect(deleteCalls).toEqual([]);
    await user.click(screen.getByTestId('session-delete-confirm-s2'));

    await waitFor(() => expect(deleteCalls).toEqual(['s2']));
    await waitFor(() => expect(screen.queryByTestId('session-option-s2')).not.toBeInTheDocument());
    // 未读条目被清（其它会话未读保留）
    await waitFor(() => expect(usePanelStore.getState().unread.s2).toBeUndefined());
    expect(usePanelStore.getState().unread.other).toBe(1);
    // 选中不变
    expect(usePanelStore.getState().sessionId).toBe('s1');
    expect(screen.queryByTestId('chat-session-error')).not.toBeInTheDocument();
  });

  it('删除当前会话：清选中与流式缓冲，回空态且不再显示残留消息', async () => {
    sessionsList = [makeSession({ id: 's1' })];
    renderChat(makeSession({ id: 's1' }));
    const user = userEvent.setup();
    await screen.findByTestId('model-display');

    emitText('s1', '流式中残留内容');
    expect(await screen.findByTestId('streaming-bubble')).toHaveTextContent('流式中残留内容');

    await user.click(await screen.findByTestId('session-delete-s1'));
    await user.click(screen.getByTestId('session-delete-confirm-s1'));

    await waitFor(() => expect(deleteCalls).toEqual(['s1']));
    await waitFor(() => expect(usePanelStore.getState().sessionId).toBeNull());
    expect(screen.getByTestId('chat-empty')).toBeInTheDocument();
    expect(useStreamingStore.getState().streams.has('s1')).toBe(false);
    expect(screen.queryByTestId('streaming-bubble')).not.toBeInTheDocument();
  });

  it('运行中会话删除被服务端拒绝：展示服务端原文，选中与列表保持不变', async () => {
    sessionsList = [makeSession({ id: 's1', status: '运行中' })];
    deleteResponse = {
      status: 409,
      body: { error: { code: 'CONFLICT', message: '会话正在运行，请先停止再删除' } },
    };
    renderChat(makeSession({ id: 's1', status: '运行中' }));
    const user = userEvent.setup();
    await screen.findByTestId('model-display');

    await user.click(await screen.findByTestId('session-delete-s1'));
    await user.click(screen.getByTestId('session-delete-confirm-s1'));

    expect(await screen.findByTestId('chat-session-error')).toHaveTextContent('会话正在运行，请先停止再删除');
    // 未删除：选中仍是 s1，列表仍有该项
    expect(usePanelStore.getState().sessionId).toBe('s1');
    expect(screen.getByTestId('session-option-s1')).toBeInTheDocument();
  });

  it('取消二次确认：不调用 DELETE，恢复删除入口', async () => {
    sessionsList = [makeSession({ id: 's1' })];
    renderChat(makeSession({ id: 's1' }));
    const user = userEvent.setup();
    await screen.findByTestId('model-display');

    await user.click(await screen.findByTestId('session-delete-s1'));
    await user.click(screen.getByTestId('session-delete-cancel-s1'));

    expect(deleteCalls).toEqual([]);
    expect(screen.getByTestId('session-delete-s1')).toBeInTheDocument();
    expect(screen.queryByTestId('session-delete-confirm-s1')).not.toBeInTheDocument();
    expect(usePanelStore.getState().sessionId).toBe('s1');
  });

  it('session.deleted 全局层清流式缓冲：已删会话不再残留增量内容', async () => {
    sessionsList = [makeSession({ id: 's1' }), makeSession({ id: 's2', cli: 'codex' })];
    renderChat(makeSession({ id: 's1' }));
    await screen.findByTestId('model-display');

    emitText('s2', '后台残留');
    expect(useStreamingStore.getState().streams.get('s2')).toBe('后台残留');

    act(() => {
      emitWsEvent({ type: 'session.deleted', session_id: 's2' });
    });
    expect(useStreamingStore.getState().streams.has('s2')).toBe(false);
  });
});

describe('ChatPanel 跨端删除同步', () => {
  it('其它视图删除当前会话：WS session.deleted → 回空态，选中/未读/流式缓冲一并清空', async () => {
    sessionsList = [makeSession({ id: 's1' }), makeSession({ id: 's2', cli: 'codex' })];
    const qc = renderChat(makeSession({ id: 's1' }));
    const user = userEvent.setup();
    await screen.findByTestId('model-display');

    emitText('s1', '正在输出的内容');
    expect(await screen.findByTestId('streaming-bubble')).toHaveTextContent('正在输出的内容');
    usePanelStore.setState({ unread: { s1: 2 } });

    // 另一端删除：列表先剔除，再广播 session.deleted
    sessionsList = [makeSession({ id: 's2', cli: 'codex' })];
    act(() => {
      emitWsEvent({ type: 'session.deleted', session_id: 's1' });
    });
    await qc.invalidateQueries({ queryKey: ['sessions'] });

    await waitFor(() => expect(usePanelStore.getState().sessionId).toBeNull());
    expect(screen.getByTestId('chat-empty')).toBeInTheDocument();
    expect(usePanelStore.getState().unread.s1).toBeUndefined();
    expect(useStreamingStore.getState().streams.has('s1')).toBe(false);
    expect(screen.queryByTestId('streaming-bubble')).not.toBeInTheDocument();
    expect(screen.queryByTestId('session-option-s1')).not.toBeInTheDocument();
  });
});

describe('ChatPanel 工作空间名称（CHAT-WORKSPACE-LABEL）', () => {
  const ws2: Workspace = { id: 'ws-2', name: '第二项目', path: 'D:/ws/second', created_at: 2 };

  it('显示当前会话所属工作空间名称（与顶栏共用 workspaces 缓存）', async () => {
    sessionsList = [makeSession({ id: 's1', workspace_id: 'ws-1' })];
    renderChat(makeSession({ id: 's1', workspace_id: 'ws-1' }));
    expect(await screen.findByTestId('chat-workspace-label')).toHaveTextContent('主项目');
    expect(screen.getByTestId('chat-workspace-label')).toHaveAttribute('title', '当前会话所属工作空间');
  });

  it('切换会话到另一个工作空间：名称跟随更新，不残留旧空间', async () => {
    workspacesList = [ws, ws2];
    sessionsList = [makeSession({ id: 's1', workspace_id: 'ws-1' })];
    renderChat(makeSession({ id: 's1', workspace_id: 'ws-1' }));
    expect(await screen.findByTestId('chat-workspace-label')).toHaveTextContent('主项目');

    act(() => {
      usePanelStore.setState({ sessionId: 's2', chatSession: makeSession({ id: 's2', workspace_id: 'ws-2' }) });
    });
    await waitFor(() => expect(screen.getByTestId('chat-workspace-label')).toHaveTextContent('第二项目'));
    expect(screen.getByTestId('chat-workspace-label')).not.toHaveTextContent('主项目');
  });

  it('工作空间已删除（列表查不到该 id）：显示占位而非空串', async () => {
    workspacesList = [ws];
    sessionsList = [makeSession({ id: 's9', workspace_id: 'ws-gone' })];
    renderChat(makeSession({ id: 's9', workspace_id: 'ws-gone' }));

    const label = await screen.findByTestId('chat-workspace-label');
    expect(label).toHaveTextContent('工作空间不可用');
    expect(label.textContent?.trim()).not.toBe('');
  });

  it('没有选中会话且未选工作空间：显示明确的未选择占位', async () => {
    sessionsList = [];
    usePanelStore.setState({ view: null, sessionId: null, chatSession: null, rightOpen: false });
    useNavStore.setState({ view: 'chat' });
    useAppStore.setState({ workspaceId: null });
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={qc}>
        <ChatPanel />
      </QueryClientProvider>,
    );

    const label = await screen.findByTestId('chat-workspace-label');
    expect(label).toHaveTextContent('未选择工作空间');
  });
});





