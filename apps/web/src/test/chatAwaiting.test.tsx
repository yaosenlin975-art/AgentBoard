/**
 * CHAT-AWAIT2 测试：阻塞态 UI（awaiting_input / awaiting_approval / failed(awaiting_timeout)）。
 *
 * 覆盖：
 * - 两种阻塞态可区分（ask 卡片 / 审批卡片）、展示「在等什么、等多久」与超时规则；
 * - 等待态时 running 三点与停止按钮让位（不双显），输入区只读且发送禁用；
 * - answer 成功回 running、失败可读；审批 allow/deny 落库后状态跟得上、403 显示撤销入口说明；
 * - 刷新后按会话详情 `turns` 恢复阻塞卡片；
 * - 超时卡片的「重新开始此步」走整轮重发兜底；
 * - turnView 展示口径纯函数（解析/时长/上限/错误映射）。
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { HttpResponse, http } from 'msw';
import type { Message, Session, SessionTurn, Workspace } from '@agentboard/shared';
import { ChatPanel } from '../components/chat/ChatPanel';
import { emitWsEvent } from '../api/wsBus';
import { ApiError } from '../api/client';
import { useAppStore } from '../state/appStore';
import { usePanelStore } from '../state/panelStore';
import { useStreamingStore } from '../state/streamingStore';
import { useTurnStore } from '../state/turnStore';
import {
  awaitingCapText,
  awaitingElapsedText,
  answerFailureText,
  approvalFailureText,
  parseAskMessage,
} from '../lib/turnView';
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

function makeTurn(overrides: Partial<SessionTurn> = {}): SessionTurn {
  return {
    id: 't1',
    session_id: 's1',
    seq: 1,
    state: 'awaiting_input',
    current_index: 0,
    plan_json: [{ step_id: 's1', title: '等待回答', state: 'awaiting' }],
    awaiting_json: null,
    usage_json: null,
    started_at: 1,
    ended_at: null,
    ...overrides,
  };
}

// ---- 可观测 mock 状态 ----
let sessionsList: Session[] = [];
const msgStore: Record<string, Message[]> = {};
let detailTurns: SessionTurn[] = [];
const answerBodies: Array<{ turnId: string; body: { text?: string; option_id?: string } }> = [];
let answerResponse: { status: number; body: unknown } | SessionTurn = makeTurn({ state: 'running' });
const approvalCalls: Array<{ requestId: string; body: { decision?: string; scope?: string } }> = [];
let approvalResponse: { status: number; body: unknown } | { turn: SessionTurn } = {
  turn: makeTurn({ state: 'running' }),
};
const postBodies: Array<{ text?: string }> = [];

function resetMocks(): void {
  sessionsList = [];
  for (const k of Object.keys(msgStore)) delete msgStore[k];
  detailTurns = [];
  answerBodies.length = 0;
  answerResponse = makeTurn({ state: 'running' });
  approvalCalls.length = 0;
  approvalResponse = { turn: makeTurn({ state: 'running' }) };
  postBodies.length = 0;
}

function mockChatApi(): void {
  server.use(
    http.get('/api/sessions', () => HttpResponse.json(sessionsList)),
    http.get('/api/sessions/:id', ({ params }) => {
      const found = sessionsList.find((s) => s.id === params.id);
      if (found === undefined) {
        return HttpResponse.json({ error: { code: 'NOT_FOUND', message: '会话不存在' } }, { status: 404 });
      }
      return HttpResponse.json({ ...found, turns: detailTurns });
    }),
    http.get('/api/sessions/:id/messages', ({ params }) =>
      HttpResponse.json(msgStore[params.id as string] ?? []),
    ),
    http.get('/api/sessions/:id/queue', () => HttpResponse.json({ texts: [] })),
    http.post('/api/sessions/:id/messages', async ({ request }) => {
      postBodies.push((await request.json()) as { text?: string });
      return HttpResponse.json({ queued: false });
    }),
    http.post('/api/sessions/:id/turns/:turnId/answer', async ({ request, params }) => {
      const body = (await request.json()) as { text?: string; option_id?: string };
      answerBodies.push({ turnId: params.turnId as string, body });
      if ('status' in answerResponse) {
        return HttpResponse.json(answerResponse.body as Record<string, unknown>, {
          status: answerResponse.status,
        });
      }
      return HttpResponse.json(answerResponse);
    }),
    http.post(
      '/api/sessions/:id/turns/:turnId/approvals/:requestId',
      async ({ request, params }) => {
        const body = (await request.json()) as { decision?: string; scope?: string };
        approvalCalls.push({ requestId: params.requestId as string, body });
        if ('status' in approvalResponse) {
          return HttpResponse.json(approvalResponse.body as Record<string, unknown>, {
            status: approvalResponse.status,
          });
        }
        return HttpResponse.json(approvalResponse);
      },
    ),
    http.get('/api/workspaces', () => HttpResponse.json([ws])),
    http.get('/api/clis', () =>
      HttpResponse.json([{ id: 'codebuddy', displayName: 'CodeBuddy', installed: true, version: '2.0.0' }]),
    ),
    http.get('/api/clis/:id/models', () => HttpResponse.json([{ id: 'm-a', source: 'static' }])),
    http.get('/api/skills', () => HttpResponse.json({ items: [] })),
    http.get('/api/issues', () => HttpResponse.json([])),
  );
}

function renderChat(): void {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <ChatPanel />
    </QueryClientProvider>,
  );
}

function emitTurn(overrides: {
  state: SessionTurn['state'];
  awaiting?: SessionTurn['awaiting_json'];
}): void {
  act(() => {
    emitWsEvent({
      type: 'session.turn',
      session_id: 's1',
      turn_id: 't1',
      state: overrides.state,
      awaiting: overrides.awaiting ?? null,
    });
  });
}

function emitApprovalRequest(): void {
  act(() => {
    emitWsEvent({
      type: 'session.approval_request',
      session_id: 's1',
      turn_id: 't1',
      request_id: 'r1',
      tool: 'Bash',
      target: 'rm -rf build',
      risk: 'write',
    });
  });
}

const askPayload = {
  reason: 'ask_user',
  message: '请选择部署环境\n- 预发：先发预发环境\n- 生产：直接上生产',
  at: 1000,
};

beforeEach(() => {
  resetMocks();
  localStorage.clear();
  useTurnStore.getState().reset();
  useAppStore.setState({ workspaceId: 'ws-1' });
  usePanelStore.setState({ view: null, issueId: null, sessionId: null, chatSession: null, unread: {}, rightOpen: false });
  useStreamingStore.setState({ streams: new Map() });
  sessionsList = [makeSession()];
  msgStore['s1'] = [makeMessage({ content: 'hi' })];
  usePanelStore.setState({ sessionId: 's1', chatSession: makeSession() });
  mockChatApi();
});

describe('AWAIT2 询问阻塞态', () => {
  it('awaiting_input 显示询问卡片与已等待时长，运行三点与停止按钮让位', async () => {
    renderChat();
    expect(await screen.findByTestId('composer')).toBeInTheDocument();
    emitTurn({ state: 'awaiting_input', awaiting: askPayload });

    const card = await screen.findByTestId('awaiting-ask-card');
    expect(card).toHaveTextContent('等待你的回答');
    expect(screen.getByTestId('awaiting-question')).toHaveTextContent('请选择部署环境');
    expect(screen.getByTestId('awaiting-option-0')).toHaveTextContent('预发');
    expect(screen.getByTestId('awaiting-option-1')).toHaveTextContent('生产');
    expect(screen.getByTestId('awaiting-elapsed').textContent).toContain('已等待');
    expect(screen.getByTestId('awaiting-rule').textContent).toContain('15 分钟无心跳');
    expect(screen.getByTestId('awaiting-cap').textContent).toContain('2 小时');

    // 不同显：运行三点与停止按钮让位给等待卡片
    expect(screen.queryByTestId('running-indicator')).not.toBeInTheDocument();
    expect(screen.queryByTestId('stop-btn')).not.toBeInTheDocument();
  });

  it('等待回答时输入区只读、发送禁用并展示「在等什么」', async () => {
    renderChat();
    expect(await screen.findByTestId('composer')).toBeInTheDocument();
    emitTurn({ state: 'awaiting_input', awaiting: askPayload });

    await screen.findByTestId('awaiting-ask-card');
    const input = screen.getByTestId('composer-input') as HTMLTextAreaElement;
    expect(input.readOnly).toBe(true);
    expect(screen.getByTestId('composer-send')).toBeDisabled();
    expect(screen.getByTestId('composer-blocked')).toHaveTextContent('等待回答');
  });

  it('点选选项提交 answer，成功返回 running 后卡片消失、运行指示恢复', async () => {
    renderChat();
    expect(await screen.findByTestId('composer')).toBeInTheDocument();
    emitTurn({ state: 'awaiting_input', awaiting: askPayload });
    await screen.findByTestId('awaiting-ask-card');

    await userEvent.click(screen.getByTestId('awaiting-option-0'));
    await waitFor(() => expect(answerBodies).toHaveLength(1));
    expect(answerBodies[0]).toEqual({ turnId: 't1', body: { text: '预发' } });

    await waitFor(() => expect(screen.queryByTestId('awaiting-ask-card')).not.toBeInTheDocument());
    expect(screen.getByTestId('running-indicator')).toBeInTheDocument();
    const input = screen.getByTestId('composer-input') as HTMLTextAreaElement;
    expect(input.readOnly).toBe(false);
  });

  it('answer 失败 409 显示可读原因且不吞掉', async () => {
    answerResponse = {
      status: 409,
      body: { error: { code: 'CONFLICT', message: '轮次不在等待回答' } },
    };
    renderChat();
    expect(await screen.findByTestId('composer')).toBeInTheDocument();
    emitTurn({ state: 'awaiting_input', awaiting: askPayload });
    await screen.findByTestId('awaiting-ask-card');

    await userEvent.click(screen.getByTestId('awaiting-option-1'));
    const error = await screen.findByTestId('awaiting-answer-error');
    expect(error.textContent).toContain('轮次已不在等待回答');
  });

  it('自由文本兜底也可提交回答', async () => {
    renderChat();
    expect(await screen.findByTestId('composer')).toBeInTheDocument();
    emitTurn({
      state: 'awaiting_input',
      awaiting: { reason: 'ask_user', message: '请说明原因', at: 1000 },
    });
    await screen.findByTestId('awaiting-ask-card');

    await userEvent.type(screen.getByTestId('awaiting-answer-input'), '因为线上需要');
    await userEvent.click(screen.getByTestId('awaiting-answer-submit'));
    await waitFor(() => expect(answerBodies).toHaveLength(1));
    expect(answerBodies[0]?.body).toEqual({ text: '因为线上需要' });
  });
});

describe('AWAIT2 审批阻塞态', () => {
  it('session.approval_request 呈现独立审批卡片（与询问卡片可区分）', async () => {
    renderChat();
    expect(await screen.findByTestId('composer')).toBeInTheDocument();
    emitApprovalRequest();

    const card = await screen.findByTestId('awaiting-approval-card');
    expect(card).toHaveTextContent('等待审批');
    expect(screen.getByTestId('awaiting-approval-summary')).toHaveTextContent('Bash · rm -rf build');
    expect(screen.getByTestId('awaiting-approval-risk')).toHaveTextContent('write');
    expect(screen.queryByTestId('awaiting-ask-card')).not.toBeInTheDocument();
    expect(screen.queryByTestId('running-indicator')).not.toBeInTheDocument();
    expect(screen.getByTestId('composer-blocked')).toHaveTextContent('等待审批');
  });

  it('允许（仅本次）提交正确请求体，成功后回到 running', async () => {
    renderChat();
    expect(await screen.findByTestId('composer')).toBeInTheDocument();
    emitApprovalRequest();
    await screen.findByTestId('awaiting-approval-card');

    await userEvent.click(screen.getByTestId('awaiting-allow'));
    await waitFor(() => expect(approvalCalls).toHaveLength(1));
    expect(approvalCalls[0]).toEqual({
      requestId: 'r1',
      body: { decision: 'allow', scope: 'once' },
    });
    await waitFor(() =>
      expect(screen.queryByTestId('awaiting-approval-card')).not.toBeInTheDocument(),
    );
    expect(screen.getByTestId('running-indicator')).toBeInTheDocument();
  });

  it('拒绝后服务端置 stopped，卡片收起且不再显示运行指示', async () => {
    approvalResponse = {
      turn: makeTurn({
        state: 'stopped',
        awaiting_json: { reason: 'approval_denied', message: '用户拒绝执行', at: 1000 },
      }),
    };
    renderChat();
    expect(await screen.findByTestId('composer')).toBeInTheDocument();
    emitApprovalRequest();
    await screen.findByTestId('awaiting-approval-card');

    await userEvent.click(screen.getByTestId('awaiting-deny'));
    await waitFor(() => expect(approvalCalls).toHaveLength(1));
    expect(approvalCalls[0]?.body).toEqual({ decision: 'deny', scope: 'once' });
    await waitFor(() =>
      expect(screen.queryByTestId('awaiting-approval-card')).not.toBeInTheDocument(),
    );
    expect(screen.queryByTestId('running-indicator')).not.toBeInTheDocument();
  });

  it('审批 403 显示可读原因，明确说明本工作区档缺撤销入口', async () => {
    approvalResponse = {
      status: 403,
      body: { error: { code: 'FORBIDDEN', message: '写类工具不允许 workspace 档' } },
    };
    renderChat();
    expect(await screen.findByTestId('composer')).toBeInTheDocument();
    emitApprovalRequest();
    await screen.findByTestId('awaiting-approval-card');

    await userEvent.click(screen.getByTestId('awaiting-allow'));
    const error = await screen.findByTestId('awaiting-approval-error');
    expect(error.textContent).toContain('写类工具不允许 workspace 档');
    expect(error.textContent).toContain('撤销入口');
  });
});

describe('AWAIT2 刷新恢复与超时', () => {
  it('刷新后按详情 turns 恢复询问卡片（含服务端进入时间）', async () => {
    const now = Date.now();
    detailTurns = [
      makeTurn({
        state: 'awaiting_input',
        awaiting_json: { reason: 'ask_user', message: '请选择部署环境\n- 预发\n- 生产', at: now - 125_000 },
      }),
    ];
    renderChat();
    const card = await screen.findByTestId('awaiting-ask-card');
    expect(card).toBeInTheDocument();
    expect(screen.getByTestId('awaiting-elapsed').textContent).toContain('已等待 2 分');
  });

  it('刷新后按详情 turns 恢复审批卡片（工具/目标来自服务端）', async () => {
    detailTurns = [
      makeTurn({
        state: 'awaiting_approval',
        awaiting_json: {
          reason: 'approval_required',
          message: 'Bash 请求确认：rm -rf build',
          at: Date.now(),
          approval: { request_id: 'r1', tool: 'Bash', target: 'rm -rf build', risk: 'write', match_key: '' },
        },
      }),
    ];
    renderChat();
    const card = await screen.findByTestId('awaiting-approval-card');
    expect(card).toBeInTheDocument();
    expect(screen.getByTestId('awaiting-approval-summary')).toHaveTextContent('Bash · rm -rf build');
    expect(screen.getByTestId('awaiting-allow')).toBeInTheDocument();
  });

  it('failed(awaiting_timeout) 显示超时卡片，「重新开始此步」以新轮次重发上一条用户消息', async () => {
    renderChat();
    expect(await screen.findByTestId('composer')).toBeInTheDocument();
    emitTurn({
      state: 'failed',
      awaiting: {
        reason: 'awaiting_timeout',
        message: '等待回答超时（15 分钟无心跳）',
        at: Date.now() - 1000,
      },
    });

    const card = await screen.findByTestId('awaiting-timeout-card');
    expect(card).toHaveTextContent('等待超时');
    expect(screen.getByTestId('awaiting-timeout-message').textContent).toContain('15 分钟无心跳');

    await userEvent.click(screen.getByTestId('awaiting-restart'));
    await waitFor(() => expect(postBodies).toHaveLength(1));
    expect(postBodies[0]?.text).toBe('hi');
  });
});

describe('turnView 阻塞态展示口径', () => {
  it('parseAskMessage 抽出问题与选项（说明可空）', () => {
    expect(parseAskMessage('问题一\n- 选项A：说明A\n- 选项B')).toEqual({
      question: '问题一',
      options: [
        { label: '选项A', description: '说明A' },
        { label: '选项B', description: '' },
      ],
    });
  });

  it('awaitingElapsedText 按服务端 at 计算展示时长', () => {
    expect(awaitingElapsedText(1000, 1000 + 12_000)).toBe('已等待 12 秒');
    expect(awaitingElapsedText(1000, 1000 + 185_000)).toBe('已等待 3 分 05 秒');
    expect(awaitingElapsedText(undefined, 10)).toBe('已等待');
  });

  it('awaitingCapText 只由 at + 2h 推出绝对上限，不产生假时刻', () => {
    const at = new Date(2026, 0, 1, 10, 30, 0).getTime();
    expect(awaitingCapText(at)).toContain('绝对上限 12:30');
    expect(awaitingCapText(undefined)).toContain('待服务端回传');
  });

  it('错误映射：403 审批提示撤销入口，409 answer 提示刷新', () => {
    expect(approvalFailureText(new ApiError('写类工具不允许 workspace 档', 'FORBIDDEN', 403))).toContain(
      '撤销入口',
    );
    expect(answerFailureText(new ApiError('冲突', 'CONFLICT', 409))).toContain('刷新');
  });
});
