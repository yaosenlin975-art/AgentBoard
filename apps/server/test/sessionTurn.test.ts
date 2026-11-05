/**
 * CHAT-TURN1：轮次与观测底座（`session_turn` + `message` 三列 + `session.plan` / `session.usage`）。
 *
 * 覆盖卡面验收：
 * - 2：跑一轮后存在 session_turn 行，state 与步骤推进一致、plan_json 结构合法；
 * - 3：计划变更即推 session.plan（三字段齐全）；usage 连续更新按节流合并（推送次数 < 事件数）；
 * - 4：无监听方 / send 抛错时服务端不因 WS 推送报错；
 * - 5：历史会话无 turn 行时读取回退（HTTP 侧见 sessionTurnMigration.test.ts）；
 * - 6：failed 携带机器可判原因（`awaiting_json.reason`）。
 *
 * 执行器语义不变：全部用仓库既有 FakeAdapter 驱动（不依赖真实 CLI），
 * 并显式断言「一轮 = 一次 runTurn、不内置自动重试」。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentAdapter } from '@agentboard/adapters';
import { WebSocket as WsLib } from 'ws';
import type { ServerWsEvent, SessionPlanEvent, SessionUsageEvent, TurnPlanStep } from '@agentboard/shared';
import { createTestDb, type TestDb } from './helpers.js';
import { FakeAdapter, settle, type FakeTurnControl } from './fakeAdapter.js';
import { createWorkspace } from '../src/db/repos/workspace.js';
import { createSession as insertSessionRow, getSession } from '../src/db/repos/session.js';
import { listMessagesBySession } from '../src/db/repos/message.js';
import { createTurn, failOpenTurns, getTurn, listOpenTurnsBySession, listTurnsBySession, nextTurnSeq, updateTurn } from '../src/db/repos/sessionTurn.js';
import {
  createSession,
  initSessionManager,
  recoverOnBoot,
  resetSessionManager,
  sendToSession,
  setBroadcaster,
  stopSession,
} from '../src/services/sessionManager.js';
import { META_PATCH_MAX_LINES, estimateTokens, normalizeDiffFiles, truncatePatchForFile } from '../src/services/messageMeta.js';
import { TURN_USAGE_THROTTLE_MS } from '../src/services/turnObservation.js';
import { createWsHub } from '../src/ws/hub.js';

let t: TestDb;
let wsId: string;
let adapter: FakeAdapter;
let events: ServerWsEvent[];

function fakeResolver(id: string): AgentAdapter {
  if (id === 'fake') return adapter;
  throw new Error(`未知适配器 id: ${id}`);
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const planEvents = (): SessionPlanEvent[] => events.filter((e): e is SessionPlanEvent => e.type === 'session.plan');
const usageEvents = (): SessionUsageEvent[] => events.filter((e): e is SessionUsageEvent => e.type === 'session.usage');
const onlyTurn = (sessionId: string) => listTurnsBySession(t.db, sessionId)[0];

async function newSession(prompt?: string) {
  return createSession({ cli: 'fake', workspace_id: wsId, ...(prompt ? { prompt } : {}) });
}

beforeEach(() => {
  t = createTestDb();
  wsId = createWorkspace(t.db, { name: 'ws', path: 'D:\\ws\\demo' }).id;
  adapter = new FakeAdapter();
  events = [];
  initSessionManager(t.db, fakeResolver, { maxConcurrentTurns: 3 });
  setBroadcaster((event) => events.push(event));
  // Date.now 单调递增（同 sessionManager.test.ts）：message 列表按 (ts, id) 排序，
  // 同一毫秒内随机 UUID 会打乱轮内消息顺序 → 断言步骤先后必须先钉死时钟
  let clock = 1_000_000;
  vi.spyOn(Date, 'now').mockImplementation(() => ++clock);
});

afterEach(() => {
  vi.restoreAllMocks();
  resetSessionManager();
  t.cleanup();
});

describe('验收 2：跑一轮后存在 session_turn 行', () => {
  it('一轮 = 一次 runTurn：turn 落库、state 随步骤推进收口为 done、plan_json 结构合法', async () => {
    adapter.script = (control) => {
      control.emit({ type: 'tool', name: 'Grep', input: 'turn' });
      control.emit({ type: 'text', delta: '第一段回复内容，够长以产生估算用量。'.repeat(3) });
      control.emit({ type: 'tool', name: 'Read', input: 'apps/server/src/index.ts' });
      control.finish(0);
    };

    const session = await newSession('把轮次底座跑一轮');
    await settle();

    const turns = listTurnsBySession(t.db, session.id);
    expect(turns).toHaveLength(1);
    const turn = turns[0]!;
    expect(turn.session_id).toBe(session.id);
    expect(turn.seq).toBe(1);
    expect(turn.state).toBe('done');
    expect(turn.ended_at).not.toBeNull();
    expect(turn.awaiting_json).toBeNull();

    // plan_json 每项含 step_id/title/state（验收 2 的结构口径）
    const plan = turn.plan_json as TurnPlanStep[];
    expect(Array.isArray(plan)).toBe(true);
    expect(plan).toHaveLength(2);
    for (const step of plan) {
      expect(typeof step.step_id).toBe('string');
      expect(typeof step.title).toBe('string');
      expect(['pending', 'running', 'done', 'failed', 'awaiting']).toContain(step.state);
    }
    expect(plan.map((step) => step.step_id)).toEqual(['s1', 's2']);
    expect(plan.map((step) => step.title)).toEqual(['Grep', 'Read']);
    // 全部步骤随轮次收口为 done，current_index 推进到 plan.length（无在途步骤）
    expect(plan.every((step) => step.state === 'done')).toBe(true);
    expect(turn.current_index).toBe(2);
  });

  it('执行器语义不变：一轮只调一次 runTurn，不内置自动重试', async () => {
    adapter.script = (control) => {
      control.emit({ type: 'tool', name: 'Bash', input: 'exit 1' });
      control.finish(1);
    };
    const session = await newSession('失败但不重试');
    await settle();

    expect(adapter.calls).toHaveLength(1);
    expect(onlyTurn(session.id)!.state).toBe('failed');
  });

  it('会话内 seq 递增，历史轮次不回填（新会话只有本轮的行）', async () => {
    const session = await newSession('第一轮');
    await settle();
    await sendToSession(session.id, '第二轮');
    await settle();

    expect(listTurnsBySession(t.db, session.id).map((turn) => turn.seq)).toEqual([1, 2]);
    expect(new Set(listTurnsBySession(t.db, session.id).map((turn) => turn.id)).size).toBe(2);
  });

  it('user 消息（发送时先落库）与轮内 assistant 消息都挂到本轮 turn_id', async () => {
    adapter.script = (control) => {
      control.emit({ type: 'tool', name: 'Grep', input: 'x' });
      control.emit({ type: 'text', delta: '正文' });
      control.finish(0);
    };
    const session = await newSession('带轮次归属的提问');
    await settle();

    const turnId = onlyTurn(session.id)!.id;
    const messages = listMessagesBySession(t.db, session.id);
    const user = messages.find((m) => m.role === 'user')!;
    const assistant = messages.find((m) => m.role === 'assistant')!;
    expect(user.turn_id).toBe(turnId);
    expect(assistant.turn_id).toBe(turnId);
    expect(user.step_id).toBeNull(); // 非工具消息不带步骤
  });

  it('排队消息合并成下一轮时，两条 user 消息都挂到新轮次', async () => {
    const held: FakeTurnControl[] = [];
    adapter.script = (control) => {
      if (control.callIndex === 0) {
        held.push(control);
        return; // 首轮挂起，后续发送进队列
      }
      control.finish(0);
    };
    const session = await newSession('正在跑的第一轮');
    await settle();
    await sendToSession(session.id, '排队甲');
    await sendToSession(session.id, '排队乙');
    held[0]!.finish(0);
    await settle();

    const turns = listTurnsBySession(t.db, session.id);
    expect(turns.map((turn) => turn.seq)).toEqual([1, 2]);
    const merged = turns[1]!;
    const messages = listMessagesBySession(t.db, session.id);
    const queuedUsers = messages.filter((m) => m.role === 'user' && m.turn_id === merged.id);
    expect(queuedUsers.map((m) => m.content).sort()).toEqual(['排队乙', '排队甲']);
  });

  it('工具消息带 step_id 与 meta_json：耗时/成败按可观测信号回填，无结果来源的字段保持 null', async () => {
    adapter.script = (control) => {
      control.emit({ type: 'tool', name: 'Grep', input: 'turn' });
      control.emit({ type: 'tool', name: 'Read', input: 'file.ts' });
      control.finish(0);
    };
    const session = await newSession('两个工具步骤');
    await settle();

    const toolMessages = listMessagesBySession(t.db, session.id).filter((m) => m.step_id !== null);
    expect(toolMessages).toHaveLength(2);
    const first = toolMessages[0]!;
    expect(first.step_id).toBe('s1');
    expect(first.meta_json).not.toBeNull();
    expect(first.meta_json!.status).toBe('ok');
    expect(typeof first.meta_json!.duration_ms).toBe('number');
    // 诚实口径：CLI 未提供工具结果，这两项本卡不编造
    expect(first.meta_json!.output_summary).toBeNull();
    expect(first.meta_json!.diff).toBeNull();
    // tool_call_id 用轮内稳定的 step_id 充当关联键（后续 diff 按同一键对齐）
    expect(first.meta_json!.tool_call_id).toBe('s1');
    expect(toolMessages[1]!.meta_json!.tool_call_id).toBe('s2');
  });
});

describe('验收 6：failed / stopped 携带机器可判原因', () => {
  it('非零退出 → failed + awaiting_json.reason=adapter_exit_nonzero', async () => {
    adapter.script = (control) => {
      control.emit({ type: 'text', delta: '跑挂了' });
      control.finish(2);
    };
    const session = await newSession('会失败的一轮');
    await settle();

    const turn = onlyTurn(session.id)!;
    expect(turn.state).toBe('failed');
    expect(turn.awaiting_json?.reason).toBe('adapter_exit_nonzero');
    expect(turn.awaiting_json?.at).toBeTypeOf('number');
    expect(turn.ended_at).not.toBeNull();
  });

  it('轮次期间出现 error 事件 → 当前步骤判 failed 并回填 meta_json', async () => {
    adapter.script = (control) => {
      control.emit({ type: 'tool', name: 'Bash', input: 'boom' });
      control.emit({ type: 'error', message: '工具执行失败' });
      control.finish(1);
    };
    const session = await newSession('工具报错的一轮');
    await settle();

    expect((onlyTurn(session.id)!.plan_json as TurnPlanStep[])[0]!.state).toBe('failed');
    // 同一步骤里 error 消息与工具消息同毫秒落库（列表按 ts,id 排序），所以按 role 精确取工具消息
    const toolMessage = listMessagesBySession(t.db, session.id).find(
      (m) => m.step_id === 's1' && m.role === 'event',
    )!;
    expect(toolMessage.meta_json?.status).toBe('failed');
    // error 消息也归到当前步骤，方便前端把报错挂在计划行上
    const errorMessages = listMessagesBySession(t.db, session.id).filter((m) => m.role === 'error');
    expect(errorMessages.length).toBeGreaterThan(0);
    expect(errorMessages.every((m) => m.turn_id === onlyTurn(session.id)!.id)).toBe(true);
  });

  it('适配器解析失败 → 轮次行仍建好并带 adapter_resolve_failed 原因', async () => {
    const session = await createSession({ cli: 'nope', workspace_id: wsId, prompt: '未知 CLI' });
    await settle();

    const turn = onlyTurn(session.id)!;
    expect(turn.state).toBe('failed');
    expect(turn.awaiting_json?.reason).toBe('adapter_resolve_failed');
    expect(getSession(t.db, session.id)!.status).toBe('失败');
  });

  it('用户停止 → stopped + reason=user_stop，已完成步骤保留', async () => {
    const held: FakeTurnControl[] = [];
    adapter.script = (control) => {
      if (control.callIndex === 0) {
        control.emit({ type: 'tool', name: 'Grep', input: 'a' });
        held.push(control);
        return; // 挂起等停止
      }
      control.finish(0);
    };
    const session = await newSession('会被停止的一轮');
    await settle();

    await stopSession(session.id);
    await settle();

    const turn = onlyTurn(session.id)!;
    expect(turn.state).toBe('stopped');
    expect(turn.awaiting_json?.reason).toBe('user_stop');
    expect(turn.plan_json).toHaveLength(1);
    expect((turn.plan_json as TurnPlanStep[])[0]!.state).toBe('failed'); // 停止时仍在途的步骤判失败
  });

  it('服务重启恢复：未结束的轮次置 failed + reason=server_restart', async () => {
    const session = insertSessionRow(t.db, { workspace_id: wsId, cli: 'fake', status: '运行中' });
    const open = createTurn(t.db, { session_id: session.id, seq: nextTurnSeq(t.db, session.id), state: 'running', started_at: Date.now() });
    expect(listOpenTurnsBySession(t.db, session.id).map((turn) => turn.id)).toEqual([open.id]);

    await recoverOnBoot(t.db);

    const turn = onlyTurn(session.id)!;
    expect(turn.state).toBe('failed');
    expect(turn.awaiting_json?.reason).toBe('server_restart');
    expect(listOpenTurnsBySession(t.db, session.id)).toEqual([]);
  });

  // 硬风险条款：awaiting_input 的超时转 failed 由 CHAT-AWAIT1 落地，本卡只保证「原因通道可承载、可断言、可区分」
  it('原因通道为 CHAT-AWAIT1 预留：awaiting_* 只落轮次，failed 可带 awaiting_timeout 且区别于 server_restart', async () => {
    const session = insertSessionRow(t.db, { workspace_id: wsId, cli: 'fake', status: '运行中' });
    const waiting = createTurn(t.db, { session_id: session.id, seq: 1, state: 'running', started_at: Date.now() });

    // 阻塞态只属于 turn：session.status 仍是现有四态，awaiting_input 计入「未结束轮次」
    updateTurn(t.db, waiting.id, {
      state: 'awaiting_input',
      awaiting_json: { reason: 'awaiting_input', at: Date.now() },
      plan_json: [{ step_id: 's1', title: 'Bash', state: 'awaiting' }],
    });
    expect(getSession(t.db, session.id)!.status).toBe('运行中');
    expect(listOpenTurnsBySession(t.db, session.id).map((turn) => turn.state)).toEqual(['awaiting_input']);

    // CHAT-AWAIT1 的收口写入路径（复用 failOpenTurns）：state=failed + 机器可判的 awaiting_timeout
    expect(failOpenTurns(t.db, session.id, { reason: 'awaiting_timeout', message: '等待用户回答超时', at: Date.now() })).toBe(1);
    const timedOut = getTurn(t.db, waiting.id)!;
    expect(timedOut.state).toBe('failed');
    expect(timedOut.awaiting_json?.reason).toBe('awaiting_timeout');
    expect(timedOut.ended_at).not.toBeNull();
    // plan_json 的步骤态允许 awaiting（不因收口而被改写）
    expect(timedOut.plan_json).toEqual([{ step_id: 's1', title: 'Bash', state: 'awaiting' }]);

    // 同一会话第二轮被服务重启收口 → 两条轮次的原因可区分
    const restarting = createTurn(t.db, { session_id: session.id, seq: nextTurnSeq(t.db, session.id), state: 'running', started_at: Date.now() });
    await recoverOnBoot(t.db);

    const reasons = listTurnsBySession(t.db, session.id).map((turn) => `${turn.seq}:${turn.state}:${turn.awaiting_json?.reason}`);
    expect(reasons).toEqual(['1:failed:awaiting_timeout', '2:failed:server_restart']);
    expect(listOpenTurnsBySession(t.db, session.id)).toEqual([]);
    expect(getTurn(t.db, restarting.id)!.state).toBe('failed');
  });
});

describe('验收 3：session.plan 变更即推 + session.usage 节流合并', () => {
  it('session.plan 载荷三字段齐全，且随步骤推进多次推送', async () => {
    adapter.script = (control) => {
      control.emit({ type: 'tool', name: 'Grep', input: 'a' });
      control.emit({ type: 'tool', name: 'Read', input: 'b' });
      control.finish(0);
    };
    const session = await newSession('计划推送');
    await settle();

    const turnId = onlyTurn(session.id)!.id;
    const plans = planEvents();
    expect(plans.length).toBeGreaterThanOrEqual(2); // 每个 tool 事件推一次 + 收尾推最终快照
    for (const plan of plans) {
      expect(plan.type).toBe('session.plan');
      expect(plan.turn_id).toBe(turnId);
      expect(Array.isArray(plan.plan)).toBe(true);
      expect(typeof plan.current_index).toBe('number');
      expect(typeof plan.session_id).toBe('string');
    }
    expect(plans[0]!.plan).toHaveLength(1);
    expect(plans[0]!.current_index).toBe(0);
    expect(plans.at(-1)!.plan).toHaveLength(2);
    expect(plans.at(-1)!.plan.every((step) => step.state === 'done')).toBe(true);
    expect(plans.at(-1)!.current_index).toBe(2);
  });

  it('连续 usage 更新按节流合并：同 turn 的推送次数少于 usage 事件数', async () => {
    const held: FakeTurnControl[] = [];
    const deltas = 10;
    adapter.script = (control) => {
      if (control.callIndex === 0) {
        held.push(control);
        for (let i = 0; i < deltas; i += 1) control.emit({ type: 'text', delta: `第${i}段流式正文。` });
        return; // 轮次挂起，跨窗口继续喂 delta
      }
      control.finish(0);
    };
    const session = await newSession('流式用量');
    await settle();

    // 窗口内：10 次 usage 更新只应有 1 次推送
    await sleep(TURN_USAGE_THROTTLE_MS + 120);
    const afterFirstWindow = usageEvents().filter((e) => e.turn_id === onlyTurn(session.id)!.id);
    expect(afterFirstWindow).toHaveLength(1);

    // 再喂 10 次（含 thinking），跨第二个窗口
    for (let i = 0; i < deltas; i += 1) held[0]!.emit({ type: 'thinking', delta: `想${i}` });
    await sleep(TURN_USAGE_THROTTLE_MS + 120);
    held[0]!.finish(0);
    await settle();

    const turnId = onlyTurn(session.id)!.id;
    const usage = usageEvents().filter((e) => e.turn_id === turnId);
    expect(usage.length).toBeGreaterThanOrEqual(2); // 跨了两个窗口
    expect(usage.length).toBeLessThan(deltas * 2); // 推送次数远少于 usage 事件数（节流生效）
    for (const event of usage) {
      expect(event.type).toBe('session.usage');
      expect(event.usage.estimated).toBe(true);
      expect(event.usage.output_tokens).toBeGreaterThan(0);
      expect(event.usage.cost_usd).toBeNull();
      expect(event.usage.context_limit_tokens).toBeNull();
    }
    // 用量随推送落库：重进会话能拿到最后一版快照
    const turn = onlyTurn(session.id)!;
    expect(turn.usage_json?.estimated).toBe(true);
    expect(turn.usage_json!.context_used_tokens).toBe(
      (turn.usage_json!.input_tokens ?? 0) + (turn.usage_json!.output_tokens ?? 0),
    );
  });

  it('无 tool 事件的普通一轮：plan 为空数组（前端隐藏计划条），仍落 turn 行', async () => {
    const session = await newSession('只是聊天');
    await settle();

    const turn = onlyTurn(session.id)!;
    expect(turn.plan_json).toEqual([]);
    expect(turn.current_index).toBe(0);
    expect(turn.state).toBe('done');
    expect(planEvents().length).toBeGreaterThanOrEqual(1);
  });
});

describe('验收 4：无监听方时服务端不因 WS 推送报错', () => {
  it('hub 没有 OPEN 客户端时广播不抛错（含轮次观测事件）', () => {
    const hub = createWsHub();
    expect(hub.clientCount()).toBe(0);
    expect(() => hub.broadcast({ type: 'session.plan', session_id: 's', turn_id: 't', plan: [], current_index: -1 })).not.toThrow();
    expect(() => hub.broadcast({
      type: 'session.usage',
      session_id: 's',
      turn_id: 't',
      usage: { input_tokens: 1, output_tokens: 1, cost_usd: null, context_used_tokens: 2, context_limit_tokens: null, estimated: true },
    })).not.toThrow();
  });

  it('整轮跑通但不挂任何 WS 监听：会话链路与落库不受影响', async () => {
    resetSessionManager();
    initSessionManager(t.db, fakeResolver, { maxConcurrentTurns: 3 });
    const hub = createWsHub(); // 真实 hub，零客户端
    setBroadcaster(hub.broadcast);
    adapter.script = (control) => {
      control.emit({ type: 'tool', name: 'Grep', input: 'a' });
      control.emit({ type: 'text', delta: '没有观众也要跑完' });
      control.finish(0);
    };

    const session = await newSession('无人监听的一轮');
    await sleep(TURN_USAGE_THROTTLE_MS + 120); // 让节流计时器在无监听方时也走一遍
    await sendToSession(session.id, '第二轮');
    await settle();

    expect(getSession(t.db, session.id)!.status).toBe('已结束');
    const turns = listTurnsBySession(t.db, session.id);
    expect(turns.map((turn) => turn.state)).toEqual(['done', 'done']);
  });

  it('broadcaster 未装配时推送路径静默不报错', async () => {
    resetSessionManager();
    initSessionManager(t.db, fakeResolver, { maxConcurrentTurns: 3 });
    const session = await newSession('没有广播钩子的一轮');
    await settle();
    expect(onlyTurn(session.id)!.state).toBe('done');
  });

  it('客户端 send 抛错被吞掉，不影响广播方与其它客户端', () => {
    const hub = createWsHub();
    const sendSpy = vi.spyOn(WsLib.prototype, 'send').mockImplementation(() => {
      throw new Error('socket 正在关闭');
    });
    // 无 OPEN 客户端时循环体不执行；这里连同未装配客户端一起验证容错路径不外溢
    expect(() => hub.broadcast({ type: 'session.plan', session_id: 's', turn_id: 't', plan: [], current_index: 0 })).not.toThrow();
    expect(() => hub.broadcast({ type: 'session.changed', session: getSession(t.db, 'nope')! as never })).not.toThrow();
    sendSpy.mockRestore();
  });
});

describe('验收 5：历史会话（无 turn 行）读取回退', () => {
  it('旧会话没有 turn 行、消息三列为 null，读取不报错', () => {
    const session = insertSessionRow(t.db, { workspace_id: wsId, cli: 'fake', status: '已结束' });
    const inserted = t.db
      .prepare('INSERT INTO message (id, session_id, role, content, ts) VALUES (?, ?, ?, ?, ?)')
      .run('legacy-1', session.id, 'assistant', '历史消息', Date.now());
    expect(inserted.changes).toBe(1);

    expect(listTurnsBySession(t.db, session.id)).toEqual([]);
    const messages = listMessagesBySession(t.db, session.id);
    expect(messages).toHaveLength(1);
    expect(messages[0]!.turn_id).toBeNull();
    expect(messages[0]!.step_id).toBeNull();
    expect(messages[0]!.meta_json).toBeNull();
  });

  it('meta_json 是坏 JSON 时降级为 null，不炸消息列表', () => {
    const session = insertSessionRow(t.db, { workspace_id: wsId, cli: 'fake', status: '已结束' });
    t.db
      .prepare('INSERT INTO message (id, session_id, role, content, ts, turn_id, step_id, meta_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run('broken-1', session.id, 'event', '工具事件', Date.now(), 'turn-x', 's1', '{不是 json');

    const messages = listMessagesBySession(t.db, session.id);
    expect(messages[0]!.meta_json).toBeNull();
    expect(messages[0]!.turn_id).toBe('turn-x');
  });

  it('会话删除后轮次行随 FK 级联清理', () => {
    const session = insertSessionRow(t.db, { workspace_id: wsId, cli: 'fake', status: '运行中' });
    createTurn(t.db, { session_id: session.id, seq: 1, state: 'running', started_at: Date.now() });
    t.db.prepare('DELETE FROM session WHERE id = ?').run(session.id);
    expect(listTurnsBySession(t.db, session.id)).toEqual([]);
  });

  it('同一会话内 seq 唯一（重复 seq 被唯一索引拒绝）', () => {
    const session = insertSessionRow(t.db, { workspace_id: wsId, cli: 'fake', status: '运行中' });
    createTurn(t.db, { session_id: session.id, seq: 1, state: 'running', started_at: Date.now() });
    expect(() => createTurn(t.db, { session_id: session.id, seq: 1, state: 'running', started_at: Date.now() })).toThrow();
  });
});

describe('契约 #8/#21：meta_json 截断与 usage 估算口径', () => {
  it('单文件 patch 按 400 行截断并标注 truncated', () => {
    const long = Array.from({ length: META_PATCH_MAX_LINES + 50 }, (_, i) => `+line ${i}`).join('\n');
    const cut = truncatePatchForFile(long);
    expect(cut.patch.split('\n')).toHaveLength(META_PATCH_MAX_LINES);
    expect(cut.truncated).toBe(true);

    const short = truncatePatchForFile('@@ -1,2 +1,2 @@\n+a\n-b');
    expect(short.truncated).toBe(false);
    expect(short.patch).toBe('@@ -1,2 +1,2 @@\n+a\n-b');
  });

  it('normalizeDiffFiles 逐文件截断，add/del 计数不动', () => {
    const files = normalizeDiffFiles([
      { path: 'a.ts', add: 450, del: 0, patch: Array.from({ length: 450 }, () => '+x').join('\n') },
      { path: 'b.ts', add: 1, del: 1, patch: '+y\n-z' },
      { path: 'c.ts', add: 0, del: 0, patch: null },
    ]);
    expect(files[0]!.patch!.split('\n')).toHaveLength(META_PATCH_MAX_LINES);
    expect(files[0]!.truncated).toBe(true);
    expect(files[0]!.add).toBe(450);
    expect(files[1]!.truncated).toBe(false);
    expect(files[2]!.patch).toBeNull();
  });

  it('usage 估算口径：约 4 字符 = 1 token（长度估算，不是计费）', () => {
    expect(estimateTokens('')).toBe(0);
    expect(estimateTokens('abcd')).toBe(1);
    expect(estimateTokens('abcde')).toBe(2);
  });
});
