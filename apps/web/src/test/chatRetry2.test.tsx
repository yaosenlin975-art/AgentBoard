/**
 * CHAT-RETRY2：单步重试前端。
 *
 * 覆盖卡面的硬项：
 * 1. 重试只重跑那一步：请求只打 `/turns/:turnId/steps/:stepId/retry`，不带整轮消息体，
 *    成功后只回填服务端返回的整轮（不新增消息/diff 卡，不重跑整轮）；
 * 2. 幂等：同一张卡连点两次只发一次请求（服务端幂等键 `turn_id:step_id:tool_call_id` 兜底）；
 * 3. 部分成功不可重试：409 `STEP_NOT_RETRYABLE` 展示「该步已有成功写入，不支持重试」并把按钮置灰；
 * 4. 失败步可定位：卡片上有工具名 + 步骤标识 + 失败原因；
 * 5. 超时卡片：有失败步骤时走单步重试，没有时才退回「重发整轮」（文案区分）。
 */
import { beforeEach, describe, expect, it } from 'vitest';
import type { ReactElement } from 'react';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { HttpResponse, http } from 'msw';
import type {
  Message,
  MessageToolMeta,
  SessionStepLedgerEntry,
  SessionStepRetryResult,
  SessionTurn,
  TurnPlanStep,
} from '@agentboard/shared';
import { MessageList } from '../components/chat/MessageList';
import { AwaitingTimeoutCard } from '../components/chat/AwaitingCard';
import { emitWsEvent } from '../api/wsBus';
import { ApiError } from '../api/client';
import { useTurnStore, type TurnObservation } from '../state/turnStore';
import {
  failedPlanStep,
  retryFailureText,
  retryStepGate,
  retryableAfterAttempt,
} from '../lib/turnView';
import { server } from './server';

const step = (id: string, title: string, state: TurnPlanStep['state']): TurnPlanStep => ({
  step_id: id,
  title,
  state,
});

function toolMeta(overrides: Partial<MessageToolMeta> = {}): MessageToolMeta {
  return {
    status: 'failed',
    duration_ms: 4200,
    output_summary: 'tsc 报错：类型不匹配',
    tool_call_id: 'call-1',
    diff: null,
    ...overrides,
  };
}

function msg(overrides: Partial<Message> = {}): Message {
  return {
    id: `m-${Math.random().toString(36).slice(2, 8)}`,
    session_id: 's1',
    role: 'user',
    content: '跑一下测试',
    ts: 100,
    ...overrides,
  };
}

function emitPlan(turnId: string, plan: TurnPlanStep[], currentIndex: number): void {
  act(() => {
    emitWsEvent({ type: 'session.plan', session_id: 's1', turn_id: turnId, plan, current_index: currentIndex });
  });
}

function emitTurn(turnId: string, state: SessionTurn['state']): void {
  act(() => {
    emitWsEvent({ type: 'session.turn', session_id: 's1', turn_id: turnId, state, awaiting: null });
  });
}

function ledger(overrides: Partial<SessionStepLedgerEntry> = {}): SessionStepLedgerEntry {
  return {
    id: 'l1',
    session_id: 's1',
    turn_id: 't1',
    step_id: 's1',
    tool_name: 'Edit',
    tool_call_id: 'call-1',
    idempotency_key: 't1:s1:call-1',
    status: 'done',
    retryable: false,
    writes: ['apps/web/src/a.ts'],
    attempt: 2,
    created_at: 1,
    updated_at: 2,
    ...overrides,
  };
}

function serverTurn(state: SessionTurn['state'], plan: TurnPlanStep[], currentIndex: number): SessionTurn {
  return {
    id: 't1',
    session_id: 's1',
    seq: 1,
    state,
    current_index: currentIndex,
    plan_json: plan,
    awaiting_json: null,
    usage_json: null,
    started_at: 1,
    ended_at: 2,
  };
}

// ---- 可观测 mock 状态 ----
interface RetryCall {
  sessionId: string;
  turnId: string;
  stepId: string;
  body: string;
}
let retryCalls: RetryCall[] = [];
let wholeRoundCalls = 0;
let retryResponse: { status: number; body: SessionStepRetryResult | unknown } = {
  status: 200,
  body: {
    turn: serverTurn('done', [step('s1', 'Edit', 'done'), step('s2', 'Test', 'pending')], 1),
    step_id: 's1',
    ledger: ledger(),
    executed: true,
  },
};

function useApiMocks(): void {
  server.use(
    http.post('/api/sessions/:id/turns/:turnId/steps/:stepId/retry', async ({ params, request }) => {
      retryCalls.push({
        sessionId: String(params.id),
        turnId: String(params.turnId),
        stepId: String(params.stepId),
        body: await request.text(),
      });
      if (retryResponse.status !== 200) {
        return HttpResponse.json(retryResponse.body as never, { status: retryResponse.status });
      }
      return HttpResponse.json(retryResponse.body as never);
    }),
    // 整轮重发的端点：本卡不得被单步重试用到
    http.post('/api/sessions/:id/messages', () => {
      wholeRoundCalls += 1;
      return HttpResponse.json({});
    }),
  );
}

function renderWithClient(node: ReactElement): void {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  render(<QueryClientProvider client={client}>{node}</QueryClientProvider>);
}

const failedMessages = [
  msg({ id: 'u1', turn_id: 't1', role: 'user', content: '跑一下测试' }),
  msg({
    id: 'e1',
    turn_id: 't1',
    step_id: 's1',
    role: 'event',
    content: JSON.stringify({ name: 'Edit', input: 'apps/web/src/a.ts' }),
    meta_json: toolMeta(),
  }),
];

beforeEach(() => {
  cleanup();
  retryCalls = [];
  wholeRoundCalls = 0;
  retryResponse = {
    status: 200,
    body: {
      turn: serverTurn('done', [step('s1', 'Edit', 'done'), step('s2', 'Test', 'pending')], 1),
      step_id: 's1',
      ledger: ledger(),
      executed: true,
    },
  };
  useTurnStore.getState().reset();
  useApiMocks();
});

// ---------- 1：纯函数口径 ----------

describe('retryStepGate / failedPlanStep', () => {
  it('轮次未观测、仍在执行/等待、步骤不在计划、步骤非 failed 都不可点，且给出原因', () => {
    expect(retryStepGate(null, 's1').enabled).toBe(false);
    expect(retryStepGate(null, 's1').reason).toContain('尚未收到该轮次状态');
    expect(retryStepGate({ state: 'running', plan: [] }, 's1').enabled).toBe(false);
    expect(retryStepGate({ state: 'awaiting_input', plan: [] }, 's1').reason).toContain('等待态');
    expect(retryStepGate({ state: 'failed', plan: [step('s2', 'Test', 'failed')] }, 's1').enabled).toBe(false);
    expect(retryStepGate({ state: 'failed', plan: [step('s1', 'Edit', 'done')] }, 's1').reason).toContain(
      '不是失败状态',
    );
    expect(retryStepGate({ state: 'failed', plan: [step('s1', 'Edit', 'failed')] }, 's1')).toEqual({
      enabled: true,
      reason: null,
    });
  });

  it('failedPlanStep 优先当前索引，其次第一个 failed', () => {
    const plan = [step('s0', 'Read', 'failed'), step('s1', 'Edit', 'failed')];
    expect(failedPlanStep({ state: 'failed', plan, current_index: 1 })?.step_id).toBe('s1');
    expect(failedPlanStep({ state: 'failed', plan, current_index: 2 })?.step_id).toBe('s0');
    expect(failedPlanStep({ state: 'running', plan: [step('s2', 'Test', 'running')], current_index: 0 })).toBeNull();
  });

  it('409 机器码映射成可读原因（部分成功明确「不支持重试」）', () => {
    const conflict = (code: string, message: string): ApiError => new ApiError(message, code, 409);
    expect(retryFailureText(conflict('STEP_NOT_RETRYABLE', '该步骤不可重试：已有写入记录，重试可能重复写入'))).toBe(
      '该步已有成功写入，不支持重试',
    );
    expect(retryFailureText(conflict('STEP_NOT_RETRYABLE', '该步骤缺少执行台账，不允许单步重试'))).toContain(
      '缺少执行台账',
    );
    expect(retryFailureText(conflict('STEP_NOT_FAILED', '该步骤当前不是失败状态'))).toContain('不是失败状态');
    expect(retryFailureText(conflict('TURN_NOT_RETRYABLE', '轮次不可重试'))).toContain('等待态');
    expect(retryFailureText(conflict('STEP_RETRY_IN_FLIGHT', '该步骤正在重试'))).toContain('已在处理中');
    expect(retryFailureText(new ApiError('not found', 'NOT_FOUND', 404))).toContain('刷新');
    expect(retryableAfterAttempt(false)).toBe('该步已有成功写入，不支持重试');
    expect(retryableAfterAttempt(true)).toBeNull();
  });
});

// ---------- 2 / 3 / 4：工具卡 ----------

describe('失败步骤卡的单步重试', () => {
  function setupFailedTurn(): void {
    emitPlan('t1', [step('s1', 'Edit', 'failed'), step('s2', 'Test', 'pending')], 0);
    emitTurn('t1', 'failed');
  }

  it('失败步可定位，点击只打单步重试端点且不重发整轮，成功后不新增消息/diff 卡', async () => {
    setupFailedTurn();
    renderWithClient(<MessageList messages={failedMessages} streaming="" running={false} sessionStatus="失败" />);

    const card = screen.getByTestId('tool-card-e1');
    expect(screen.getByTestId('tool-name-e1')).toHaveTextContent('Edit');
    expect(screen.getByTestId('tool-step-e1')).toHaveTextContent('步骤 call-1');
    expect(screen.getByTestId('tool-summary-e1')).toHaveTextContent('类型不匹配');

    const button = screen.getByTestId('retry-step-e1');
    expect(button).toBeEnabled();
    await userEvent.click(button);

    await waitFor(() => expect(retryCalls).toHaveLength(1));
    expect(retryCalls[0]).toMatchObject({ sessionId: 's1', turnId: 't1', stepId: 's1' });
    // 请求体只有空对象：不带整轮的消息正文，也不带客户端自造的幂等键
    expect(JSON.parse(retryCalls[0]!.body)).toEqual({});
    expect(wholeRoundCalls).toBe(0);
    // 只回填服务端返回的整轮：不新增消息、不出现第二张 diff 卡
    expect(screen.queryAllByTestId(/^tool-card-/)).toHaveLength(1);
    await waitFor(() => expect(screen.getByTestId('retry-step-note-e1')).toHaveTextContent('该步重试成功'));
    expect(useTurnStore.getState().turns.get('t1')?.plan[0]).toMatchObject({ step_id: 's1', state: 'done' });
    // 服务端返回 retryable=false → 按钮置灰
    expect(screen.getByTestId('retry-step-e1')).toBeDisabled();
    expect(card).toBeInTheDocument();
  });

  it('连点两次只发一次请求（服务端幂等键兜底，前端不多发一次）', async () => {
    setupFailedTurn();
    renderWithClient(<MessageList messages={failedMessages} streaming="" running={false} sessionStatus="失败" />);
    const button = screen.getByTestId('retry-step-e1');
    await userEvent.dblClick(button);
    await waitFor(() => expect(retryCalls.length).toBeGreaterThan(0));
    expect(retryCalls).toHaveLength(1);
    expect(wholeRoundCalls).toBe(0);
  });

  it('部分成功（409 STEP_NOT_RETRYABLE）展示「不支持重试」并把按钮置灰，且不动本地轮次', async () => {
    setupFailedTurn();
    retryResponse = {
      status: 409,
      body: { error: { code: 'STEP_NOT_RETRYABLE', message: '该步骤不可重试：已有写入记录，重试可能重复写入' } },
    };
    renderWithClient(<MessageList messages={failedMessages} streaming="" running={false} sessionStatus="失败" />);

    await userEvent.click(screen.getByTestId('retry-step-e1'));
    await waitFor(() =>
      expect(screen.getByTestId('retry-step-note-e1')).toHaveTextContent('该步已有成功写入，不支持重试'),
    );
    expect(screen.getByTestId('retry-step-e1')).toBeDisabled();
    // 409 不改本地状态：计划里该步仍是 failed
    expect(useTurnStore.getState().turns.get('t1')?.plan[0]).toMatchObject({ step_id: 's1', state: 'failed' });
  });

  it('轮次仍在等待态时按钮置灰并给出原因（不本地推断 retryable）', () => {
    emitPlan('t1', [step('s1', 'Edit', 'failed')], 0);
    emitTurn('t1', 'awaiting_input');
    renderWithClient(<MessageList messages={failedMessages} streaming="" running={false} sessionStatus="运行中" />);
    const button = screen.getByTestId('retry-step-e1');
    expect(button).toBeDisabled();
    expect(button.getAttribute('title')).toContain('等待态');
  });
});

// ---------- 5：超时卡片 ----------

describe('超时卡片的重试口径', () => {
  const observation = (plan: TurnPlanStep[], currentIndex: number): TurnObservation => ({
    turn_id: 't1',
    session_id: 's1',
    plan,
    current_index: currentIndex,
    usage: null,
    state: 'failed',
    awaiting: { reason: 'awaiting_timeout', message: '等待超时', at: 1, approval: undefined } as never,
  });

  it('有失败步骤：走单步重试端点，不调用整轮重发', async () => {
    let restarted = 0;
    renderWithClient(
      <AwaitingTimeoutCard
        turn={observation([step('s1', '询问', 'failed'), step('s2', 'Test', 'pending')], 0)}
        onRestartRound={async () => {
          restarted += 1;
        }}
      />,
    );
    expect(screen.queryByTestId('awaiting-restart')).toBeNull();
    await userEvent.click(screen.getByTestId('awaiting-retry-step'));
    await waitFor(() => expect(retryCalls).toHaveLength(1));
    expect(retryCalls[0]).toMatchObject({ turnId: 't1', stepId: 's1' });
    expect(restarted).toBe(0);
    expect(wholeRoundCalls).toBe(0);
  });

  it('没有可定位的失败步骤：才退回「重发整轮」，且文案区分', async () => {
    let restarted = 0;
    renderWithClient(
      <AwaitingTimeoutCard
        turn={observation([step('s1', '询问', 'awaiting')], 0)}
        onRestartRound={async () => {
          restarted += 1;
        }}
      />,
    );
    expect(screen.queryByTestId('awaiting-retry-step')).toBeNull();
    const button = screen.getByTestId('awaiting-restart');
    expect(button).toHaveTextContent('重发整轮');
    expect(button.getAttribute('title')).toContain('会重跑全部步骤');
    await userEvent.click(button);
    await waitFor(() => expect(restarted).toBe(1));
    expect(retryCalls).toHaveLength(0);
  });
});
