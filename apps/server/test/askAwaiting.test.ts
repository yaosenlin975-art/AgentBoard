/** CHAT-ASK-1B：ask 事件 → awaiting_input → 回答回填 / 超时收口（服务端观测层） */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentAdapter, RunTurnOptions, TurnHandle } from '@agentboard/adapters';
import type { ServerWsEvent } from '@agentboard/shared';
import { createTestDb, type TestDb } from './helpers.js';
import { FakeAdapter, settle, type FakeTurnControl } from './fakeAdapter.js';
import { createWorkspace } from '../src/db/repos/workspace.js';
import { getTurn, listTurnsBySession } from '../src/db/repos/sessionTurn.js';
import {
  createSession,
  forgetSession,
  initSessionManager,
  resetSessionManager,
  setBroadcaster,
  type CreateSessionInput,
} from '../src/services/sessionManager.js';
import {
  answerAwaitingTurn,
  sweepAwaitingTurns,
  TURN_AWAITING_TIMEOUT_MS,
} from '../src/services/turnAwaiting.js';

class AskFakeAdapter extends FakeAdapter {
  readonly answers: Array<{ requestId: string; text: string }> = [];
  answerImpl: (requestId: string, text: string) => Promise<void> = async () => undefined;
  override runTurn(opts: RunTurnOptions): TurnHandle {
    const handle = super.runTurn(opts);
    handle.answer = async (requestId, text) => {
      this.answers.push({ requestId, text });
      await this.answerImpl(requestId, text);
    };
    return handle;
  }
}

let t: TestDb;
let wsId: string;
let adapter: FakeAdapter;

function fakeResolver(id: string): AgentAdapter {
  if (id === 'fake') return adapter;
  throw new Error(`未知适配器 id: ${id}`);
}

function newSession(opts: Partial<CreateSessionInput> = {}) {
  return createSession({ cli: 'fake', workspace_id: wsId, ...opts });
}

const askEvent = (requestId = 'toolu_1') => ({
  type: 'ask' as const,
  request_id: requestId,
  question: '继续吗？',
  options: [{ label: '继续' }, { label: '停止', description: '中止本轮' }],
  step_id: 'msg_1',
});

/** 起一轮并挂住子进程，返回会话、控制柄与 turn */
async function startHeldTurn() {
  const held: FakeTurnControl[] = [];
  adapter.script = (control) => {
    held.push(control);
  };
  const session = await newSession({ prompt: '问我' });
  await settle();
  return { session, held, turn: listTurnsBySession(t.db, session.id)[0]! };
}

beforeEach(() => {
  t = createTestDb();
  wsId = createWorkspace(t.db, { name: 'ws', path: 'D:\\ws\\demo' }).id;
  adapter = new AskFakeAdapter();
  initSessionManager(t.db, fakeResolver, { maxConcurrentTurns: 3 });
  let clock = 1_000_000;
  vi.spyOn(Date, 'now').mockImplementation(() => ++clock);
});

afterEach(() => {
  vi.restoreAllMocks();
  resetSessionManager();
  t.cleanup();
});

describe('ask → awaiting_input', () => {
  it('ask 事件推进同轮进入等待态并广播一次 session.turn；普通 tool 事件行为不变', async () => {
    const events: ServerWsEvent[] = [];
    setBroadcaster((e) => events.push(e));
    const { session, held, turn } = await startHeldTurn();

    held[0]!.emit({ type: 'tool', name: 'Bash', input: '{"cmd":"ls"}' });
    await settle();
    expect(events.some((e) => e.type === 'session.event' && e.event.type === 'tool')).toBe(true);

    held[0]!.emit(askEvent());
    await settle();

    const awaiting = getTurn(t.db, turn.id)!;
    expect(awaiting.state).toBe('awaiting_input');
    expect(awaiting.awaiting_json).toMatchObject({ reason: 'ask_user' });
    expect(awaiting.awaiting_json?.message).toBe('继续吗？\n- 继续\n- 停止：中止本轮');
    expect(awaiting.awaiting_heartbeat_at).not.toBeNull();

    const turnEvents = events.filter((e) => e.type === 'session.turn');
    expect(turnEvents).toEqual([
      expect.objectContaining({ session_id: session.id, turn_id: turn.id, state: 'awaiting_input' }),
    ]);
    // ask 不进 session.event（共享 WS 联合类型不含 ask），等待信息统一走 session.turn
    expect(events.filter((e) => e.type === 'session.event' && e.event.type === 'ask')).toHaveLength(0);
  });

  it('同一 request_id 重复 ask 不重复建等待态、不重复广播', async () => {
    const events: ServerWsEvent[] = [];
    setBroadcaster((e) => events.push(e));
    const { held, turn } = await startHeldTurn();

    held[0]!.emit(askEvent('toolu_same'));
    await settle();
    held[0]!.emit(askEvent('toolu_same'));
    await settle();

    expect(getTurn(t.db, turn.id)!.state).toBe('awaiting_input');
    expect(events.filter((e) => e.type === 'session.turn')).toHaveLength(1);
  });
});

describe('answer → 回填执行器', () => {
  it('回答推进轮次回 running，并把 text 写回对应 request_id 的执行器通道', async () => {
    const events: ServerWsEvent[] = [];
    setBroadcaster((e) => events.push(e));
    const { session, held, turn } = await startHeldTurn();
    held[0]!.emit(askEvent('toolu_ans'));
    await settle();

    const answered = answerAwaitingTurn(t.db, session.id, turn.id, { text: '继续' });
    expect(answered.state).toBe('running');
    expect(answered.awaiting_json).toBeNull();

    const askAdapter = adapter as AskFakeAdapter;
    expect(askAdapter.answers).toEqual([{ requestId: 'toolu_ans', text: '继续' }]);

    // 同一轮继续：不新建轮次，结束后轮次正常收口
    held[0]!.finish(0, 'fake-as-0');
    await settle();
    expect(listTurnsBySession(t.db, session.id)).toHaveLength(1);
    expect(getTurn(t.db, turn.id)!.state).toBe('done');

    // 重复回答天然 409（既有语义），不再触发回填
    expect(() => answerAwaitingTurn(t.db, session.id, turn.id, { text: '再答' })).toThrow(/不在等待输入状态/);
    expect(askAdapter.answers).toHaveLength(1);
  });

  it('适配器不支持回填：明确收口为 failed(ask_answer_unsupported)，不静默丢回答', async () => {
    adapter = new FakeAdapter(); // 无 answer 通道
    const events: ServerWsEvent[] = [];
    setBroadcaster((e) => events.push(e));
    const { session, held, turn } = await startHeldTurn();
    held[0]!.emit(askEvent());
    await settle();

    answerAwaitingTurn(t.db, session.id, turn.id, { optionId: '停止' });
    await settle();

    const after = getTurn(t.db, turn.id)!;
    expect(after.state).toBe('failed');
    expect(after.awaiting_json).toMatchObject({ reason: 'ask_answer_unsupported' });
    expect(events.filter((e) => e.type === 'session.turn' && e.state === 'failed')).toHaveLength(1);
  });

  it('写 stdin 失败：失败原因透传并收口为 failed，只推一次', async () => {
    const askAdapter = adapter as AskFakeAdapter;
    askAdapter.answerImpl = async () => {
      throw Object.assign(new Error('写入 stdin 失败：EPIPE'), { code: 'STDIN_WRITE_FAILED' });
    };
    const events: ServerWsEvent[] = [];
    setBroadcaster((e) => events.push(e));
    const { session, held, turn } = await startHeldTurn();
    held[0]!.emit(askEvent('toolu_fail'));
    await settle();

    answerAwaitingTurn(t.db, session.id, turn.id, { text: '好' });
    await settle();

    const after = getTurn(t.db, turn.id)!;
    expect(after.state).toBe('failed');
    expect(after.awaiting_json).toMatchObject({ reason: 'STDIN_WRITE_FAILED' });
    expect(events.filter((e) => e.type === 'session.turn' && e.state === 'failed')).toHaveLength(1);
  });

  it('等待通道已失效（服务重启/通道被清）：明确收口 failed(ask_answer_binding_missing)', async () => {
    const events: ServerWsEvent[] = [];
    setBroadcaster((e) => events.push(e));
    const { session, held, turn } = await startHeldTurn();
    held[0]!.emit(askEvent());
    await settle();

    // forgetSession 会清掉内存通道（服务重启后句柄失效），但 DB 轮次仍是 awaiting_input
    forgetSession(session.id);
    answerAwaitingTurn(t.db, session.id, turn.id, { text: '迟到的回答' });
    await settle();

    const after = getTurn(t.db, turn.id)!;
    expect(after.state).toBe('failed');
    expect(after.awaiting_json).toMatchObject({ reason: 'ask_answer_binding_missing' });
  });
});

describe('超时收口', () => {
  it('超时 → failed(awaiting_timeout) 且只广播一次；重复扫描不再推', async () => {
    const events: ServerWsEvent[] = [];
    setBroadcaster((e) => events.push(e));
    const { held, turn } = await startHeldTurn();
    held[0]!.emit(askEvent());
    await settle();

    const enteredAt = (getTurn(t.db, turn.id)!.awaiting_json as { at: number }).at;
    const swept = sweepAwaitingTurns(t.db, {
      broadcast: (e) => events.push(e),
      now: () => enteredAt + TURN_AWAITING_TIMEOUT_MS,
    });
    expect(swept.timedOut).toHaveLength(1);

    const after = getTurn(t.db, turn.id)!;
    expect(after.state).toBe('failed');
    expect(after.awaiting_json).toMatchObject({ reason: 'awaiting_timeout' });
    expect(events.filter((e) => e.type === 'session.turn' && e.state === 'failed')).toHaveLength(1);

    const again = sweepAwaitingTurns(t.db, {
      broadcast: (e) => events.push(e),
      now: () => enteredAt + TURN_AWAITING_TIMEOUT_MS * 2,
    });
    expect(again.timedOut).toHaveLength(0);
  });
});
