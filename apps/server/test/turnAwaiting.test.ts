/**
 * CHAT-AWAIT1：阻塞态服务端——answer 端点（契约 #13/#19）+ 心跳 / 超时 failed(awaiting_timeout) + 启动恢复。
 *
 * 覆盖卡面验收：
 * - 1：合法 answer → 200，同一 turn_id 继续（无新行、seq 不变）；
 * - 2：option_id / text 都缺 → 400；非 awaiting_input → 409；
 * - 3：恢复后已完成步骤的 message 条数与 step_id 集合不变（不重放）；
 * - 4：awaiting 期间心跳持续更新；超阈值后 state=failed 且原因 awaiting_timeout，只推一次 session.turn；
 * - 5：重新初始化 sessionManager（模拟重启）后 awaiting_input 转 failed，会话详情可直接读到；
 * - 7：session.status 仍为四态（阻塞态只落 session_turn）。
 *
 * 防重复口径：心跳=同一列覆盖写（不新增行/不计数/不推送）；超时=条件 UPDATE（changes=1 才广播）；
 * 回答的第二次天然 409（awaiting_input 之外一律冲突）。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentAdapter } from '@agentboard/adapters';
import request from 'supertest';
import type { Express } from 'express';
import type { SessionTurnEvent } from '@agentboard/shared';
import { createTestDb, type TestDb } from './helpers.js';
import { FakeAdapter } from './fakeAdapter.js';
import { createApp, type CreatedApp } from '../src/index.js';
import { createWorkspace } from '../src/db/repos/workspace.js';
import { createSession as insertSessionRow, getSession } from '../src/db/repos/session.js';
import { addMessage, listMessagesBySession } from '../src/db/repos/message.js';
import {
  createTurn,
  getTurn,
  listTurnsBySession,
  nextTurnSeq,
} from '../src/db/repos/sessionTurn.js';
import {
  initSessionManager,
  resetSessionManager,
} from '../src/services/sessionManager.js';
import {
  TURN_AWAITING_TIMEOUT_MS,
  markTurnAwaiting,
  sweepAwaitingTurns,
} from '../src/services/turnAwaiting.js';
import { initSchema } from '../src/db/schema.js';

let t: TestDb;
let wsId: string;
let adapter: FakeAdapter;
let created: CreatedApp;
let app: Express;

function fakeResolver(id: string): AgentAdapter {
  if (id === 'fake') return adapter;
  throw new Error(`未知适配器 id: ${id}`);
}

function turnRowCount(sessionId: string): number {
  return (t.db.prepare('SELECT COUNT(*) AS n FROM session_turn WHERE session_id = ?').get(sessionId) as { n: number }).n;
}

/** 新建「已跑完两步」的轮次：s1 running（current_index=0），s2 pending */
function mkTurnWithPlan(sessionId: string) {
  return createTurn(t.db, {
    session_id: sessionId,
    seq: nextTurnSeq(t.db, sessionId),
    state: 'running',
    started_at: Date.now(),
    current_index: 0,
    plan_json: [
      { step_id: 's1', title: 'Bash', state: 'running' },
      { step_id: 's2', title: 'Read', state: 'pending' },
    ],
  });
}

/** 建会话 + 两步轮次 + 进入 awaiting_input（返回 turn 与阻塞起点） */
function mkAwaiting() {
  const session = insertSessionRow(t.db, { workspace_id: wsId, cli: 'fake' });
  const turn = mkTurnWithPlan(session.id);
  const awaiting = markTurnAwaiting(t.db, session.id, turn.id, {
    state: 'awaiting_input',
    reason: 'ask_user',
    message: '请选择下一步',
    stepId: 's1',
  });
  return { session, turn: awaiting, at: awaiting.awaiting_json?.at ?? 0 };
}

/** hub 广播里的 session.turn 事件（路由与 sweeper 都经 hub.broadcast） */
function turnEvents(spy: ReturnType<typeof vi.spyOn>): SessionTurnEvent[] {
  return spy.mock.calls
    .map(([event]) => event as SessionTurnEvent)
    .filter((event) => event.type === 'session.turn');
}

beforeEach(async () => {
  t = createTestDb();
  wsId = createWorkspace(t.db, { name: 'ws', path: 'D:\\ws\\await' }).id;
  adapter = new FakeAdapter();
  created = await createApp({
    db: t.db,
    getAdapter: fakeResolver,
    adapters: [adapter],
    maxConcurrentTurns: 3,
    refreshClisOnBoot: false,
  });
  app = created.app;
});

afterEach(() => {
  vi.restoreAllMocks();
  resetSessionManager();
  t.cleanup();
});

describe('迁移与进入阻塞态', () => {
  it('session_turn 有 awaiting_heartbeat_at 列，重复 initSchema 幂等且不丢数据', () => {
    const columns = (t.db.prepare('PRAGMA table_info(session_turn)').all() as Array<{ name: string }>)
      .map((column) => column.name);
    expect(columns).toContain('awaiting_heartbeat_at');

    const { session, turn } = mkAwaiting();
    initSchema(t.db);
    expect(turnRowCount(session.id)).toBe(1);
    expect(getTurn(t.db, turn.id)!.state).toBe('awaiting_input');
  });

  it('进入阻塞：state=awaiting_input、当前步骤 awaiting、awaiting_json 与心跳落库；session.status 不变', () => {
    const { session, turn, at } = mkAwaiting();

    expect(turn.state).toBe('awaiting_input');
    expect(turn.awaiting_json?.reason).toBe('ask_user');
    expect(turn.awaiting_json?.at).toBe(at);
    expect(turn.ended_at).toBeNull();
    expect(turn.plan_json?.map((step) => step.state)).toEqual(['awaiting', 'pending']);

    const heartbeat = (t.db.prepare('SELECT awaiting_heartbeat_at AS h FROM session_turn WHERE id = ?')
      .get(turn.id) as { h: number }).h;
    expect(heartbeat).toBe(at);

    // 验收 7：会话状态仍是既有四态之一（阻塞态只落轮次，不新增 session.status）
    expect(getSession(t.db, session.id)!.status).toBe('运行中');
  });

  it('markTurnAwaiting 对不存在/不属于该会话的轮次返回 404', () => {
    const session = insertSessionRow(t.db, { workspace_id: wsId, cli: 'fake' });
    expect(() => markTurnAwaiting(t.db, session.id, 'not-a-turn', { state: 'awaiting_input', reason: 'ask_user' }))
      .toThrow(expect.objectContaining({ status: 404 }));
  });
});

describe('验收 4：心跳幂等 + 超时终态', () => {
  it('心跳：连续 tick 覆盖同一列（值更新），不新增行、不计数、不推送 session.turn', () => {
    const { session, turn, at } = mkAwaiting();
    const spy = vi.spyOn(created.hub, 'broadcast');

    const first = sweepAwaitingTurns(t.db, { broadcast: created.hub.broadcast, now: () => at + 10_000 });
    expect(first.heartbeated).toBe(1);
    expect(first.timedOut).toEqual([]);
    const h1 = (t.db.prepare('SELECT awaiting_heartbeat_at AS h FROM session_turn WHERE id = ?')
      .get(turn.id) as { h: number }).h;
    expect(h1).toBe(at + 10_000);

    const second = sweepAwaitingTurns(t.db, { broadcast: created.hub.broadcast, now: () => at + 20_000 });
    expect(second.heartbeated).toBe(1);
    expect(second.timedOut).toEqual([]);
    const h2 = (t.db.prepare('SELECT awaiting_heartbeat_at AS h FROM session_turn WHERE id = ?')
      .get(turn.id) as { h: number }).h;
    expect(h2).toBe(at + 20_000);

    expect(turnRowCount(session.id)).toBe(1);
    expect(getTurn(t.db, turn.id)!.state).toBe('awaiting_input');
    expect(turnEvents(spy)).toEqual([]);
  });

  it('超时：超过单一阈值 → failed(awaiting_timeout)，只推一次；重复 tick 不重复收口/推送', () => {
    const { session, turn, at } = mkAwaiting();
    const spy = vi.spyOn(created.hub, 'broadcast');

    const expiredAt = at + TURN_AWAITING_TIMEOUT_MS + 1;
    const first = sweepAwaitingTurns(t.db, { broadcast: created.hub.broadcast, now: () => expiredAt });
    expect(first.timedOut.map((item) => item.id)).toEqual([turn.id]);

    const failed = getTurn(t.db, turn.id)!;
    expect(failed.state).toBe('failed');
    expect(failed.awaiting_json?.reason).toBe('awaiting_timeout');
    expect(failed.ended_at).not.toBeNull();
    const heartbeat = (t.db.prepare('SELECT awaiting_heartbeat_at AS h FROM session_turn WHERE id = ?')
      .get(turn.id) as { h: number }).h;
    expect(heartbeat).toBeNull();

    const events = turnEvents(spy);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: 'session.turn',
      session_id: session.id,
      turn_id: turn.id,
      state: 'failed',
      awaiting: { reason: 'awaiting_timeout' },
    });

    // 重复 tick：行已不是 open 态，不再收口也不再推送
    const second = sweepAwaitingTurns(t.db, { broadcast: created.hub.broadcast, now: () => expiredAt + 60_000 });
    expect(second.timedOut).toEqual([]);
    expect(turnEvents(spy)).toHaveLength(1);
    expect(turnRowCount(session.id)).toBe(1);
  });
});

describe('验收 1/2/3：answer 端点', () => {
  it('合法 answer → 200：同一 turn_id 继续、seq 不变、无新行、awaiting 步骤 done、下一步 running', async () => {
    const { session, turn } = mkAwaiting();
    const message1 = addMessage(t.db, {
      session_id: session.id, role: 'assistant', content: '步骤一已完成', turn_id: turn.id, step_id: 's1',
    });
    addMessage(t.db, {
      session_id: session.id, role: 'assistant', content: '步骤二输出', turn_id: turn.id, step_id: 's2',
    });
    const stepIdsBefore = turn.plan_json!.map((step) => step.step_id);
    const messagesBefore = listMessagesBySession(t.db, session.id).length;
    const spy = vi.spyOn(created.hub, 'broadcast');

    const res = await request(app)
      .post(`/api/sessions/${session.id}/turns/${turn.id}/answer`)
      .send({ option_id: 'yes' });

    expect(res.status).toBe(200);
    expect(res.body.id).toBe(turn.id);
    expect(res.body.seq).toBe(turn.seq);
    expect(res.body.state).toBe('running');

    const after = getTurn(t.db, turn.id)!;
    expect(after.state).toBe('running');
    expect(after.awaiting_json).toBeNull();
    expect(after.current_index).toBe(1);
    expect(after.plan_json?.map((step) => step.state)).toEqual(['done', 'running']);

    // 验收 1：没有新轮次行、seq 不变
    expect(turnRowCount(session.id)).toBe(1);
    expect(listTurnsBySession(t.db, session.id).map((item) => item.seq)).toEqual([turn.seq]);

    // 验收 3：不重放——完成步骤的 message 条数与 step_id 集合不变
    const messagesAfter = listMessagesBySession(t.db, session.id);
    expect(messagesAfter.length).toBe(messagesBefore);
    expect(messagesAfter.filter((message) => message.turn_id === turn.id && message.step_id === 's1')).toHaveLength(1);
    expect(new Set(messagesAfter.map((message) => message.step_id))).toEqual(new Set(['s1', 's2']));
    expect(after.plan_json!.map((step) => step.step_id)).toEqual(stepIdsBefore);

    // 契约 #19：answer 恢复后同样推送 session.turn
    const events = turnEvents(spy);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: 'session.turn', session_id: session.id, turn_id: turn.id, state: 'running' });
    expect(message1.step_id).toBe('s1');
  });

  it('409：非 awaiting_input（running）回答冲突；成功回答后重复回答同样 409', async () => {
    const session = insertSessionRow(t.db, { workspace_id: wsId, cli: 'fake' });
    const running = mkTurnWithPlan(session.id);

    const first = await request(app)
      .post(`/api/sessions/${session.id}/turns/${running.id}/answer`)
      .send({ text: '收到' });
    expect(first.status).toBe(409);
    expect(first.body.error).toMatchObject({ code: 'CONFLICT' });

    const awaiting = markTurnAwaiting(t.db, session.id, running.id, {
      state: 'awaiting_input', reason: 'ask_user', stepId: 's1',
    });
    const ok = await request(app)
      .post(`/api/sessions/${session.id}/turns/${awaiting.id}/answer`)
      .send({ text: '收到' });
    expect(ok.status).toBe(200);

    const replay = await request(app)
      .post(`/api/sessions/${session.id}/turns/${awaiting.id}/answer`)
      .send({ text: '收到' });
    expect(replay.status).toBe(409);
    expect(replay.body.error).toMatchObject({ code: 'CONFLICT' });
  });

  it('400：option_id 与 text 都缺（含仅空白）→ VALIDATION_ERROR', async () => {
    const { session, turn } = mkAwaiting();

    const empty = await request(app)
      .post(`/api/sessions/${session.id}/turns/${turn.id}/answer`)
      .send({});
    expect(empty.status).toBe(400);
    expect(empty.body.error.code).toBe('VALIDATION_ERROR');

    const blank = await request(app)
      .post(`/api/sessions/${session.id}/turns/${turn.id}/answer`)
      .send({ option_id: '   ', text: '  ' });
    expect(blank.status).toBe(400);
    expect(blank.body.error.code).toBe('VALIDATION_ERROR');

    // 仍是阻塞态（校验失败不改变状态）
    expect(getTurn(t.db, turn.id)!.state).toBe('awaiting_input');
  });

  it('404：会话不存在 / 轮次不存在 / 轮次不属于该会话', async () => {
    const { session, turn } = mkAwaiting();
    const other = insertSessionRow(t.db, { workspace_id: wsId, cli: 'fake' });

    const noSession = await request(app)
      .post(`/api/sessions/not-a-session/turns/${turn.id}/answer`)
      .send({ text: 'hi' });
    expect(noSession.status).toBe(404);

    const noTurn = await request(app)
      .post(`/api/sessions/${session.id}/turns/not-a-turn/answer`)
      .send({ text: 'hi' });
    expect(noTurn.status).toBe(404);

    const wrongSession = await request(app)
      .post(`/api/sessions/${other.id}/turns/${turn.id}/answer`)
      .send({ text: 'hi' });
    expect(wrongSession.status).toBe(404);
  });
});

describe('验收 5：启动恢复（重新初始化 sessionManager）', () => {
  it('重启后 awaiting_input 转 failed(server_restart)，会话详情可直接读到（不依赖前端内存）', async () => {
    const { session, turn } = mkAwaiting();

    // 模拟进程重启：同一库上重新装配 manager（内存执行器全部丢弃）
    initSessionManager(t.db, fakeResolver, { maxConcurrentTurns: 3 });

    const recovered = getTurn(t.db, turn.id)!;
    expect(recovered.state).toBe('failed');
    expect(recovered.awaiting_json?.reason).toBe('server_restart');
    expect(recovered.ended_at).not.toBeNull();
    expect(turnRowCount(session.id)).toBe(1);

    // 前端经现有会话详情拿状态
    const detail = await request(app).get(`/api/sessions/${session.id}`);
    expect(detail.status).toBe(200);
    const turns = detail.body.turns as Array<{ id: string; state: string; awaiting_json: { reason: string } | null }>;
    expect(turns.find((item) => item.id === turn.id)).toMatchObject({
      state: 'failed',
      awaiting_json: { reason: 'server_restart' },
    });

    // 再次重启仍幂等：已结束轮次不会被重复改写
    initSessionManager(t.db, fakeResolver, { maxConcurrentTurns: 3 });
    expect(getTurn(t.db, turn.id)!.state).toBe('failed');
  });
});
