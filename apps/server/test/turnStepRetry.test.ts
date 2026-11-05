/**
 * CHAT-RETRY1（契约 #15）：单步重试服务端。
 *
 * 覆盖卡面验收：
 * 1：running/done 步骤 → 409；failed 但 retryable=false → 409 且文案说明原因；
 * 2：合法重试 → 200，`session_turn` 行数不变（不新建 turn），只该步重做，plan failed → running → done；
 * 3：同一重试请求重复提交 → 工具只执行一次（FakeAdapter 调用数与台账 attempt 断言）；
 * 4：重试后已完成步骤的 message 条数与 step_id 集合不变；
 * 5：部分成功（有写入记录）但报失败 → 判定不可重试；
 * 6：既有整轮能力未移除（重试后仍可发消息起新轮次）。
 * 另覆盖 404（会话/轮次/步骤）、awaiting 态 409、重试执行失败终态与事件只推一次。
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
import { createSession as insertSessionRow } from '../src/db/repos/session.js';
import { addMessage, listMessagesBySession } from '../src/db/repos/message.js';
import { createTurn, getTurn, nextTurnSeq, updateTurn } from '../src/db/repos/sessionTurn.js';
import { getStepLedger, recordStepFinish, recordStepStart, recordStepWrites } from '../src/db/repos/stepLedger.js';
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

function mkSession() {
  return insertSessionRow(t.db, { workspace_id: wsId, cli: 'fake' });
}

function mkTurn(sessionId: string, plan: { step_id: string; title: string; state: 'failed' | 'done' | 'pending' | 'running' }[], state: 'failed' | 'awaiting_input' | 'running' = 'failed') {
  return createTurn(t.db, {
    session_id: sessionId,
    seq: nextTurnSeq(t.db, sessionId),
    state,
    started_at: Date.now(),
    current_index: 0,
    plan_json: plan,
  });
}

/** 按真实观测顺序落台账：开始 → （可选写入）→ 失败收口 */
function seedFailedStepLedger(sessionId: string, turnId: string, stepId: string, toolName = 'Bash', writes: string[] = []) {
  recordStepStart(t.db, { session_id: sessionId, turn_id: turnId, step_id: stepId, tool_name: toolName });
  if (writes.length > 0) recordStepWrites(t.db, turnId, stepId, writes);
  recordStepFinish(t.db, { turn_id: turnId, step_id: stepId, failed: true });
}

function turnEvents(spy: ReturnType<typeof vi.spyOn>): SessionTurnEvent[] {
  return spy.mock.calls
    .map(([event]) => event as { type: string })
    .filter((event) => event.type === 'session.turn') as SessionTurnEvent[];
}

function retryUrl(sessionId: string, turnId: string, stepId: string): string {
  return `/api/sessions/${sessionId}/turns/${turnId}/steps/${stepId}/retry`;
}

function countRows(table: 'session_turn' | 'message'): number {
  return (t.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
}

beforeEach(async () => {
  t = createTestDb();
  wsId = createWorkspace(t.db, { name: 'ws', path: 'D:\\ws\\retry' }).id;
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
  t.cleanup();
});

describe('验收 1：迁移与台账唯一性', () => {
  it('重复 initSchema 不报错；同一幂等键只留一行', () => {
    initSchema(t.db);
    const session = mkSession();
    const turn = mkTurn(session.id, [{ step_id: 's1', title: 'Bash', state: 'failed' }]);
    seedFailedStepLedger(session.id, turn.id, 's1');
    const again = recordStepStart(t.db, { session_id: session.id, turn_id: turn.id, step_id: 's1', tool_name: 'Bash' });

    const rows = t.db.prepare('SELECT * FROM session_step_ledger WHERE turn_id = ?').all(turn.id) as { idempotency_key: string }[];
    expect(rows).toHaveLength(1);
    expect(again.idempotency_key).toBe(`${turn.id}:s1:no-tool-call`);
    expect(getStepLedger(t.db, turn.id, 's1')!.attempt).toBe(1);
  });
});

describe('验收 2/3/4：合法重试与重复提交', () => {
  it('只重该步、不新建 turn、不重复落消息、事件只推一次；重复提交不再执行', async () => {
    const session = mkSession();
    const turn = mkTurn(session.id, [
      { step_id: 's1', title: 'Bash', state: 'failed' },
      { step_id: 's2', title: 'Read', state: 'done' },
    ]);
    updateTurn(t.db, turn.id, { ended_at: Date.now() });
    seedFailedStepLedger(session.id, turn.id, 's1');
    addMessage(t.db, { session_id: session.id, role: 'event', content: '已完成步骤', turn_id: turn.id, step_id: 's2' });

    const turnsBefore = countRows('session_turn');
    const messagesBefore = countRows('message');
    const stepIdsBefore = listMessagesBySession(t.db, session.id).map((m) => m.step_id);
    const spy = vi.spyOn(created.hub, 'broadcast');

    const first = await request(app).post(retryUrl(session.id, turn.id, 's1')).send({});
    expect(first.status).toBe(200);
    expect(first.body.turn.plan_json.map((s: { state: string }) => s.state)).toEqual(['done', 'done']);
    expect(first.body.turn.state).toBe('done');
    expect(first.body.ledger).toMatchObject({ status: 'done', attempt: 2, idempotency_key: `${turn.id}:s1:no-tool-call` });
    expect(adapter.calls).toHaveLength(1);
    expect(adapter.calls[0]!.prompt).toContain('【单步重试】');

    expect(countRows('session_turn')).toBe(turnsBefore);
    expect(countRows('message')).toBe(messagesBefore);
    expect(listMessagesBySession(t.db, session.id).map((m) => m.step_id)).toEqual(stepIdsBefore);
    expect(turnEvents(spy)).toHaveLength(1);

    // 同一请求重复提交：步骤已 done → 409，执行器不再被调用，也不再推事件
    const second = await request(app).post(retryUrl(session.id, turn.id, 's1')).send({});
    expect(second.status).toBe(409);
    expect(second.body.error.code).toBe('STEP_NOT_FAILED');
    expect(adapter.calls).toHaveLength(1);
    expect(turnEvents(spy)).toHaveLength(1);

    const ledger = getStepLedger(t.db, turn.id, 's1')!;
    expect(ledger.attempt).toBe(2);
    expect(ledger.status).toBe('done');
  });

  it('执行器失败 → 终态 failed(step_retry_failed)，步骤回到 failed 且仍可再次重试', async () => {
    const session = mkSession();
    const turn = mkTurn(session.id, [{ step_id: 's1', title: 'Bash', state: 'failed' }]);
    seedFailedStepLedger(session.id, turn.id, 's1');
    adapter.script = (control) => control.finish(1, null);
    const spy = vi.spyOn(created.hub, 'broadcast');

    const response = await request(app).post(retryUrl(session.id, turn.id, 's1')).send({});
    expect(response.status).toBe(200);
    expect(response.body.turn.state).toBe('failed');
    expect(response.body.turn.awaiting_json.reason).toBe('step_retry_failed');
    expect(response.body.turn.plan_json[0].state).toBe('failed');
    expect(getStepLedger(t.db, turn.id, 's1')).toMatchObject({ status: 'failed', retryable: true });
    expect(turnEvents(spy)).toHaveLength(1);
  });
});

describe('验收 1/5：错误边界（409/404）', () => {
  it('running/done 步骤、无台账、部分成功、awaiting 轮次均 409 且文案明确', async () => {
    const session = mkSession();
    const doneTurn = mkTurn(session.id, [{ step_id: 's1', title: 'Read', state: 'done' }]);
    const done = await request(app).post(retryUrl(session.id, doneTurn.id, 's1')).send({});
    expect(done.status).toBe(409);
    expect(done.body.error.code).toBe('STEP_NOT_FAILED');

    const runningTurn = mkTurn(session.id, [{ step_id: 's1', title: 'Bash', state: 'running' }]);
    const running = await request(app).post(retryUrl(session.id, runningTurn.id, 's1')).send({});
    expect(running.status).toBe(409);
    expect(running.body.error.code).toBe('STEP_NOT_FAILED');

    const noLedgerTurn = mkTurn(session.id, [{ step_id: 's1', title: 'Bash', state: 'failed' }]);
    const noLedger = await request(app).post(retryUrl(session.id, noLedgerTurn.id, 's1')).send({});
    expect(noLedger.status).toBe(409);
    expect(noLedger.body.error.code).toBe('STEP_NOT_RETRYABLE');
    expect(noLedger.body.error.message).toContain('缺少执行台账');

    const partialTurn = mkTurn(session.id, [{ step_id: 's1', title: 'Bash', state: 'failed' }]);
    seedFailedStepLedger(session.id, partialTurn.id, 's1', 'Bash', ['src/a.ts']);
    const partial = await request(app).post(retryUrl(session.id, partialTurn.id, 's1')).send({});
    expect(partial.status).toBe(409);
    expect(partial.body.error.code).toBe('STEP_NOT_RETRYABLE');
    expect(partial.body.error.message).toContain('已有写入记录');

    const awaitingTurn = mkTurn(session.id, [{ step_id: 's1', title: 'Bash', state: 'failed' }], 'awaiting_input');
    seedFailedStepLedger(session.id, awaitingTurn.id, 's1');
    const awaiting = await request(app).post(retryUrl(session.id, awaitingTurn.id, 's1')).send({});
    expect(awaiting.status).toBe(409);
    expect(awaiting.body.error.code).toBe('TURN_NOT_RETRYABLE');
    expect(adapter.calls).toHaveLength(0);
  });

  it('未知会话/轮次/步骤 → 404', async () => {
    const session = mkSession();
    const turn = mkTurn(session.id, [{ step_id: 's1', title: 'Bash', state: 'failed' }]);
    seedFailedStepLedger(session.id, turn.id, 's1');
    const other = mkSession();

    const unknownSession = await request(app).post(retryUrl('00000000-0000-4000-8000-000000000000', turn.id, 's1')).send({});
    expect(unknownSession.status).toBe(404);

    const unknownTurn = await request(app).post(retryUrl(session.id, '00000000-0000-4000-8000-000000000000', 's1')).send({});
    expect(unknownTurn.status).toBe(404);

    const unknownStep = await request(app).post(retryUrl(session.id, turn.id, 's9')).send({});
    expect(unknownStep.status).toBe(404);

    const wrongSession = await request(app).post(retryUrl(other.id, turn.id, 's1')).send({});
    expect(wrongSession.status).toBe(404);
    expect(adapter.calls).toHaveLength(0);
  });
});

describe('验收 6：既有整轮能力保留', () => {
  it('单步重试后仍可发消息起新轮次', async () => {
    const session = mkSession();
    const turn = mkTurn(session.id, [{ step_id: 's1', title: 'Bash', state: 'failed' }]);
    seedFailedStepLedger(session.id, turn.id, 's1');

    const retried = await request(app).post(retryUrl(session.id, turn.id, 's1')).send({});
    expect(retried.status).toBe(200);

    const sent = await request(app).post(`/api/sessions/${session.id}/messages`).send({ text: '继续' });
    expect(sent.status).toBe(200);
    expect(countRows('session_turn')).toBe(2);
    expect(adapter.calls).toHaveLength(2);
  });
});
