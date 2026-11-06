/**
 * DEC-V4-UNDO-SERVER：撤销回答服务端真回滚（墓碑 / 6 秒窗口 / 幂等与竞态）。
 *
 * RULE-3 接线证据：本文件用真实 `createApp`（不是单测 router）跑
 * `POST /issues/:id/ask` → `POST /decisions/:id/answer` → `POST /decisions/:id/undo` 全链路，
 * 并通过 `vi.spyOn(created.hub, 'broadcast')` 断言 `decision.undone` + `issue.changed` 真发出。
 */
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import type { AgentAdapter } from '@agentboard/adapters';
import type { ServerWsEvent } from '@agentboard/shared';
import { createTestDb, type TestDb } from './helpers.js';
import { FakeAdapter } from './fakeAdapter.js';
import { createApp, type CreatedApp } from '../src/index.js';
import { createWorkspace } from '../src/db/repos/workspace.js';
import { createIssue, getIssue } from '../src/db/repos/issue.js';
import { claimIssue } from '../src/services/claim.js';
import { DECISION_UNDO_WINDOW_MS } from '../src/services/decision.js';

let t: TestDb;
let created: CreatedApp;
let app: Express;
let workspaceId: string;
let issueId: string;
let fence: number;
let broadcastSpy: MockInstance;

const OPTIONS = [
  { label: '继续', consequence: '继续执行' },
  { label: '停止', consequence: '停在检查点' },
];

beforeEach(async () => {
  t = createTestDb();
  const adapter = new FakeAdapter();
  const resolve = (id: string): AgentAdapter => {
    if (id === 'fake') return adapter;
    throw new Error(`未知适配器 id: ${id}`);
  };
  created = await createApp({
    db: t.db,
    getAdapter: resolve,
    adapters: [adapter],
    maxConcurrentTurns: 1,
    refreshClisOnBoot: false,
  });
  app = created.app;
  broadcastSpy = vi.spyOn(created.hub, 'broadcast');
  workspaceId = createWorkspace(t.db, { name: 'ws', path: 'D:\\ws' }).id;
  const issue = createIssue(t.db, { workspace_id: workspaceId, title: '撤销回答卡' });
  const claimed = claimIssue(t.db, issue.id, 'agent-1', null);
  issueId = claimed.id;
  fence = claimed.claim_fence;
});

afterEach(() => {
  broadcastSpy.mockRestore();
  t.cleanup();
});

function broadcastEvents(): ServerWsEvent[] {
  return broadcastSpy.mock.calls.map((call) => call[0] as ServerWsEvent);
}

async function ask(overrides: Record<string, unknown> = {}) {
  const response = await request(app)
    .post(`/api/issues/${issueId}/ask`)
    .send({ agent_id: 'agent-1', fence, question: '继续还是停止？', options: OPTIONS, ...overrides });
  expect(response.status).toBe(201);
  return response.body.decision as { id: string; state: string; grace_until: number };
}

async function answer(decisionId: string, overrides: Record<string, unknown> = {}) {
  const response = await request(app)
    .post(`/api/decisions/${decisionId}/answer`)
    .send({ option_id: (await optionId(decisionId)), source: 'web', ...overrides });
  expect(response.status).toBe(200);
  return response.body.decision as Record<string, unknown>;
}

async function optionId(decisionId: string): Promise<string> {
  const response = await request(app).get(`/api/decisions/${decisionId}`);
  expect(response.status).toBe(200);
  return response.body.decision.options[0].id as string;
}

function undo(decisionId: string, body: Record<string, unknown> = { by: 'user', expected_revision: 1 }) {
  return request(app).post(`/api/decisions/${decisionId}/undo`).send(body);
}

function issueRow() {
  return t.db.prepare('SELECT status,claimed_by,claim_fence FROM issue WHERE id=?').get(issueId) as {
    status: string;
    claimed_by: string | null;
    claim_fence: number;
  };
}

function answerRow(answerId: string) {
  return t.db
    .prepare('SELECT revision,revoked_at,revoked_by FROM issue_decision_answer WHERE id=?')
    .get(answerId) as { revision: number; revoked_at: number | null; revoked_by: string | null };
}

describe('DEC-V4-UNDO-SERVER 窗口内成功（RULE-3 真实 createApp 全链路）', () => {
  it('answer → undo：回 grace、current_answer_id 置空、墓碑落库，广播 decision.undone + issue.changed', async () => {
    const decision = await ask();
    const answered = await answer(decision.id);
    expect(answered.state).toBe('answered');
    expect(answered.answered_from_state).toBe('grace');
    const answerId = answered.current_answer_id as string;

    broadcastSpy.mockClear();
    const response = await undo(decision.id);
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      reverted_to: 'grace',
      undo_window_ms: DECISION_UNDO_WINDOW_MS,
      already_undone: false,
    });
    expect(response.body.decision).toMatchObject({
      state: 'grace',
      current_answer_id: null,
      answer_revision: 1,
      answered_from_state: 'grace',
      undone_by: 'user',
      last_undone_revision: 1,
    });
    expect(response.body.decision.undone_at).toBeTypeOf('number');

    // 墓碑：不删行，revoked_at/revoked_by 非空
    expect(answerRow(answerId)).toMatchObject({ revision: 1, revoked_by: 'user' });
    expect(answerRow(answerId).revoked_at).toBeTypeOf('number');

    // 卡：grace 内回答不涉及解锁，撤销后仍是进行中、占用不变、fence 不变
    expect(issueRow()).toEqual({ status: '进行中', claimed_by: 'agent-1', claim_fence: fence });

    const events = broadcastEvents();
    expect(events.filter((event) => event.type === 'decision.undone')).toHaveLength(1);
    expect(events.find((event) => event.type === 'decision.undone')).toMatchObject({
      type: 'decision.undone',
      workspace_id: workspaceId,
      issue_id: issueId,
      decision_id: decision.id,
      state: 'grace',
      reverted_to: 'grace',
      last_undone_revision: 1,
    });
    expect(events.filter((event) => event.type === 'issue.changed')).toHaveLength(1);

    // GET 详情读回：answers 含墓碑、current_answer_id 为空
    const detail = await request(app).get(`/api/decisions/${decision.id}`);
    expect(detail.status).toBe(200);
    expect(detail.body.decision.current_answer_id).toBeNull();
    const revoked = (detail.body.decision.answers as Array<{ revision: number; revoked_at: number | null }>).find(
      (row) => row.revision === 1,
    );
    expect(revoked?.revoked_at).toBeTypeOf('number');
  });

  it('open 场景撤销回 open：卡保持待规划、claimed_by 保持 NULL', async () => {
    const decision = await ask({ grace_seconds: 0 });
    expect(decision.state).toBe('open');
    const answered = await answer(decision.id);
    expect(answered.answered_from_state).toBe('open');

    const response = await undo(decision.id);
    expect(response.status).toBe(200);
    expect(response.body.reverted_to).toBe('open');
    expect(response.body.decision.state).toBe('open');
    expect(response.body.decision.current_answer_id).toBeNull();
    expect(issueRow()).toMatchObject({ status: '待规划', claimed_by: null });
  });
});

describe('DEC-V4-UNDO-SERVER 窗口与幂等', () => {
  it('窗口过期 409 UNDO_WINDOW_EXPIRED，库内仍为 answered', async () => {
    const decision = await ask();
    const answered = await answer(decision.id);
    t.db.prepare('UPDATE issue_decision SET undo_until=? WHERE id=?').run(Date.now() - 1, decision.id);

    const response = await undo(decision.id);
    expect(response.status).toBe(409);
    expect(response.body.error.code).toBe('UNDO_WINDOW_EXPIRED');
    const row = t.db.prepare('SELECT state,current_answer_id FROM issue_decision WHERE id=?').get(decision.id) as {
      state: string;
      current_answer_id: string | null;
    };
    expect(row).toEqual({ state: 'answered', current_answer_id: answered.current_answer_id });
  });

  it('同一 body 连发两次：第二次 200 already_undone，undone_at / 墓碑不变，不重复广播', async () => {
    const decision = await ask();
    const answered = await answer(decision.id);
    const answerId = answered.current_answer_id as string;

    const first = await undo(decision.id);
    expect(first.status).toBe(200);
    const undoneAt = first.body.decision.undone_at as number;
    const revokedAt = answerRow(answerId).revoked_at;

    broadcastSpy.mockClear();
    const second = await undo(decision.id);
    expect(second.status).toBe(200);
    expect(second.body.already_undone).toBe(true);
    expect(second.body.decision.undone_at).toBe(undoneAt);
    expect(answerRow(answerId).revoked_at).toBe(revokedAt);
    // 幂等重放不再广播（网络重试安全）
    expect(broadcastEvents()).toEqual([]);
  });

  it('窗口常量不可被请求体覆盖', async () => {
    const decision = await ask();
    await answer(decision.id);
    const response = await undo(decision.id, {
      by: 'user',
      expected_revision: 1,
      undo_window_ms: 999_999,
      grace_seconds: 0,
    });
    expect(response.status).toBe(200);
    expect(response.body.undo_window_ms).toBe(DECISION_UNDO_WINDOW_MS);
  });
});

describe('DEC-V4-UNDO-SERVER 冲突与竞态', () => {
  it('修订到 rev2 后用 expected_revision=1 撤销 → 409 DECISION_REVISION_CONFLICT', async () => {
    const decision = await ask();
    await answer(decision.id);
    const revised = await answer(decision.id, { expected_revision: 1 });
    expect(revised.answer_revision).toBe(2);

    const response = await undo(decision.id, { by: 'user', expected_revision: 1 });
    expect(response.status).toBe(409);
    expect(response.body.error.code).toBe('DECISION_REVISION_CONFLICT');
  });

  it('open 卡回答后有人重新 claim → 409 UNDO_CLAIMED_AFTER_LOCK，claimed_by / fence 不变', async () => {
    const decision = await ask({ grace_seconds: 0 });
    await answer(decision.id);
    const claimed = claimIssue(t.db, issueId, 'agent-2', null);
    const before = issueRow();

    const response = await undo(decision.id);
    expect(response.status).toBe(409);
    expect(response.body.error.code).toBe('UNDO_CLAIMED_AFTER_LOCK');
    expect(issueRow()).toEqual(before);
    expect(issueRow()).toMatchObject({ claimed_by: 'agent-2', claim_fence: claimed.claim_fence });
  });

  it('fence 单调：撤销前后不变；决策结束后重新 claim 继续递增', async () => {
    const decision = await ask({ grace_seconds: 0 });
    const lockedRow = issueRow();
    await answer(decision.id);

    const response = await undo(decision.id);
    expect(response.status).toBe(200);
    expect(issueRow().claim_fence).toBe(lockedRow.claim_fence);

    // 撤销回 open 后仍有在途决策，claim 会被 DECISION_LOCKED 拦住；先再次回答解除在途，
    // 再 claim 验证 fence 在撤销后仍单调递增（不回退、不重置）。
    await answer(decision.id);
    const reclaimed = claimIssue(t.db, issueId, 'agent-1', null);
    expect(reclaimed.claim_fence).toBe(lockedRow.claim_fence + 1);
  });

  it('回 grace 但宽限已过期：立即落锁（宽限不因撤销续命）', async () => {
    const decision = await ask();
    await answer(decision.id);
    t.db.prepare('UPDATE issue_decision SET grace_until=? WHERE id=?').run(Date.now() - 1, decision.id);

    const response = await undo(decision.id);
    expect(response.status).toBe(200);
    expect(response.body.reverted_to).toBe('grace');
    expect(response.body.decision.state).toBe('open');
    const row = issueRow();
    expect(row).toMatchObject({ status: '待规划', claimed_by: null });
    expect(row.claim_fence).toBe(fence + 1);
  });

  it('非回答者 / 非提问者撤销 → 409 UNDO_FORBIDDEN_ACTOR', async () => {
    const decision = await ask();
    await answer(decision.id);
    const response = await undo(decision.id, { by: 'stranger', expected_revision: 1 });
    expect(response.status).toBe(409);
    expect(response.body.error.code).toBe('UNDO_FORBIDDEN_ACTOR');
  });

  it('已撤回决策 → 409 DECISION_WITHDRAWN', async () => {
    const decision = await ask();
    await request(app)
      .post(`/api/decisions/${decision.id}/withdraw`)
      .send({ by: 'user', reason: '不做了' });
    const response = await undo(decision.id);
    expect(response.status).toBe(409);
    expect(response.body.error.code).toBe('DECISION_WITHDRAWN');
  });

  it('从未回答（grace）→ 409 UNDO_NOT_ANSWERED', async () => {
    const decision = await ask();
    const response = await undo(decision.id);
    expect(response.status).toBe(409);
    expect(response.body.error.code).toBe('UNDO_NOT_ANSWERED');
  });

  it('缺 by / expected_revision → 400 VALIDATION_ERROR', async () => {
    const decision = await ask();
    await answer(decision.id);
    expect((await undo(decision.id, { expected_revision: 1 })).body.error.code).toBe('VALIDATION_ERROR');
    expect((await undo(decision.id, { by: 'user' })).body.error.code).toBe('VALIDATION_ERROR');
    expect((await undo(decision.id, { by: 'user', expected_revision: 1.5 })).body.error.code).toBe(
      'VALIDATION_ERROR',
    );
  });

  it('不存在的决策 → 404 DECISION_NOT_FOUND', async () => {
    const response = await undo('no-such-decision');
    expect(response.status).toBe(404);
    expect(response.body.error.code).toBe('DECISION_NOT_FOUND');
  });

  it('撤销后原 agent 可在宽限内继续；再次回答产生新 revision 与新窗口', async () => {
    const decision = await ask();
    await answer(decision.id);
    await undo(decision.id);
    expect(getIssue(t.db, issueId)?.claimed_by).toBe('agent-1');

    const again = await answer(decision.id);
    expect(again.answer_revision).toBe(2);
    expect(again.undo_until as number).toBeGreaterThan(Date.now());
  });
});
