/**
 * DEC-V4-PERM-TEST：跨工作区决策权限矩阵（服务端集成，真实 `createApp`）。
 *
 * 依据 `knowledge:41cc78e5-946e-4b03-a79c-0a93f13aad12（知识卡：跨工作区决策权限：最小可行方案（路线 A））` §4/§5：
 * - 角色：owner / member / viewer / anonymous（无成员记录）；
 * - 动作：查看列表、查看详情、回答、修订、撤销回答、撤回、延长宽限、提问 ask；
 * - 每个 ✗ 必须是正确 403 code，且「零写入」（三张表 `SELECT *` 前后一致）+ 不广播；
 * - capability 投影与实际结果一致：`can_x=false` 时调 x 必 403；
 * - `scope=accessible` 只返回有成员的区；`workspace_ids` 混入无权限区只跳过该区；
 * - 401 只由显式非法身份头触发；无身份头按 `user` 放行（单机兼容）。
 *
 * 「本人答案」口径按设计 §4 补充：`answered_by` 只允许 `user`，因此 agent 身份的
 * member 对 user 的答案没有修订 / 撤销资格（capability 同为 false），矩阵里记 ✗。
 */
import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import type { AgentAdapter } from '@agentboard/adapters';
import type { ServerWsEvent } from '@agentboard/shared';
import { createTestDb, type TestDb } from './helpers.js';
import { FakeAdapter } from './fakeAdapter.js';
import { createApp, type CreatedApp } from '../src/index.js';
import { createWorkspace } from '../src/db/repos/workspace.js';
import { createIssue } from '../src/db/repos/issue.js';
import { claimIssue } from '../src/services/claim.js';
import { ACTOR_HEADER } from '../src/services/permission.js';

const OPTIONS = [
  { label: '继续', consequence: '继续执行' },
  { label: '停止', consequence: '停在检查点' },
];

const OWNER = 'agent:owner';
const MEMBER = 'agent:member';
const VIEWER = 'agent:viewer';
const ANONYMOUS = 'agent:anonymous';
/** 迁移期缺省人类身份（既有无身份头请求 → user 放行） */
const DEFAULT_USER = 'user';

type RoleName = 'owner' | 'member' | 'viewer' | 'anonymous';

let t: TestDb;
let created: CreatedApp;
let app: Express;
let workspaceId: string;
let broadcastSpy: MockInstance;
/** 每个决策用独立 body agent，避开「同 agent 每小时 ≤6 条」限流 */
let agentSeq = 0;

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
  workspaceId = createWorkspace(t.db, { name: '权限矩阵区', path: 'D:\\perm-matrix' }).id;
  addMember(workspaceId, OWNER, 'owner');
  addMember(workspaceId, MEMBER, 'member');
  addMember(workspaceId, VIEWER, 'viewer');
});

afterEach(() => {
  broadcastSpy.mockRestore();
  t.cleanup();
});

function addMember(ws: string, actor: string, role: 'owner' | 'member' | 'viewer'): void {
  const now = Date.now();
  t.db
    .prepare(
      `INSERT OR IGNORE INTO workspace_member (id, workspace_id, actor_id, role, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run(randomUUID(), ws, actor, role, now, now);
}

function actorRequest(actor: string) {
  return { [ACTOR_HEADER]: actor };
}

async function createDecisionViaApi(actor: string = DEFAULT_USER): Promise<{ id: string; issueId: string }> {
  const agent = `agent-${++agentSeq}`;
  const issue = createIssue(t.db, { workspace_id: workspaceId, title: `矩阵卡 ${agent}` });
  const claimed = claimIssue(t.db, issue.id, agent, null);
  const response = await request(app)
    .post(`/api/issues/${issue.id}/ask`)
    .set(actorRequest(actor))
    .send({ agent_id: agent, fence: claimed.claim_fence, question: '继续还是停止？', options: OPTIONS });
  expect(response.status).toBe(201);
  return { id: response.body.decision.id as string, issueId: issue.id };
}

async function optionIdOf(decisionId: string, actor: string = DEFAULT_USER): Promise<string> {
  const response = await request(app).get(`/api/decisions/${decisionId}`).set(actorRequest(actor));
  expect(response.status).toBe(200);
  return response.body.decision.options[0].id as string;
}

function answerAs(actor: string, decisionId: string, body: Record<string, unknown> = {}) {
  return request(app)
    .post(`/api/decisions/${decisionId}/answer`)
    .set(actorRequest(actor))
    .send({ source: 'web', ...body });
}

function snapshot() {
  return {
    decisions: t.db.prepare('SELECT * FROM issue_decision ORDER BY id').all(),
    answers: t.db.prepare('SELECT * FROM issue_decision_answer ORDER BY id').all(),
    issues: t.db.prepare('SELECT * FROM issue ORDER BY id').all(),
  };
}

/** 403 统一断言：状态 / code / 三表零写入 / 不广播 */
async function expectForbidden(run: () => Promise<request.Response>, code: 'WORKSPACE_FORBIDDEN' | 'ROLE_FORBIDDEN') {
  const before = snapshot();
  broadcastSpy.mockClear();
  const response = await run();
  expect(response.status).toBe(403);
  expect(response.body.error?.code).toBe(code);
  expect(snapshot()).toEqual(before);
  expect(broadcastSpy).not.toHaveBeenCalled();
}

/**
 * 409 统一断言：同上，但用于「能力为 false 却源于状态而非角色」的情形。
 *
 * 设计 §4 要求 `can_x=false` 时调 x 必 403；实测「角色够但状态不成立」走的是状态冲突
 * （如 member 对 grace 决策调 undo → `UNDO_NOT_ANSWERED`），因为权限门在状态门之前没有理由
 * 把「状态不对」报成「没权限」。矩阵测试按实测语义断言，并在卡面记录该口径差异。
 */
async function expectStateConflict(run: () => Promise<request.Response>, code: string) {
  const before = snapshot();
  broadcastSpy.mockClear();
  const response = await run();
  expect(response.status).toBe(409);
  expect(response.body.error?.code).toBe(code);
  expect(snapshot()).toEqual(before);
  expect(broadcastSpy).not.toHaveBeenCalled();
}

/** 按角色执行 8 个动作；allowed=false 时逐个断言 403 + 零写入 */
async function runMatrix(role: RoleName) {
  const actor = role === 'owner' ? OWNER : role === 'member' ? MEMBER : role === 'viewer' ? VIEWER : ANONYMOUS;
  const deniedCode = role === 'anonymous' ? 'WORKSPACE_FORBIDDEN' : 'ROLE_FORBIDDEN';
  const writable = role === 'owner' || role === 'member';

  const grace = await createDecisionViaApi();
  const answered = await createDecisionViaApi();
  const optionId = await optionIdOf(answered.id);
  expect((await answerAs(DEFAULT_USER, answered.id, { option_id: optionId })).status).toBe(200);
  const withdrawTarget = await createDecisionViaApi();
  const extendTarget = await createDecisionViaApi();

  // 1. 查看列表
  if (role === 'anonymous') {
    await expectForbidden(
      () => request(app).get('/api/decisions').query({ workspace_id: workspaceId }).set(actorRequest(actor)),
      'WORKSPACE_FORBIDDEN',
    );
  } else {
    const response = await request(app)
      .get('/api/decisions')
      .query({ workspace_id: workspaceId })
      .set(actorRequest(actor));
    expect(response.status).toBe(200);
    expect(response.body.decisions.map((item: { id: string }) => item.id)).toContain(grace.id);
  }

  // 2. 查看详情
  if (role === 'anonymous') {
    await expectForbidden(
      () => request(app).get(`/api/decisions/${grace.id}`).set(actorRequest(actor)),
      'WORKSPACE_FORBIDDEN',
    );
  } else {
    const response = await request(app).get(`/api/decisions/${grace.id}`).set(actorRequest(actor));
    expect(response.status).toBe(200);
    expect(response.body.decision.capabilities).toBeTypeOf('object');
  }

  // 3. 回答
  if (writable) {
    const target = await createDecisionViaApi();
    const response = await answerAs(actor, target.id, { option_id: await optionIdOf(target.id, actor) });
    expect(response.status).toBe(200);
    expect(response.body.decision.state).toBe('answered');
  } else {
    // 不带 option_id：让请求通过 zod 校验，真正落到角色门（option_id:null 会先被 400 拦掉）
    await expectForbidden(
      () => answerAs(actor, grace.id),
      deniedCode,
    );
  }

  // 4. 修订（answered 由 user 作答；agent member 无「本人答案」资格）
  if (role === 'owner') {
    const response = await answerAs(actor, answered.id, {
      option_id: await optionIdOf(answered.id, actor),
      expected_revision: 1,
    });
    expect(response.status).toBe(200);
    expect(response.body.decision.answer_revision).toBe(2);
  } else {
    await expectForbidden(
      () =>
        answerAs(actor, answered.id, {
          option_id: optionId,
          expected_revision: 1,
        }),
      deniedCode,
    );
  }

  // 5. 撤销回答（6 秒窗口内；owner 用修订后的 revision=2）
  if (role === 'owner') {
    const response = await request(app)
      .post(`/api/decisions/${answered.id}/undo`)
      .set(actorRequest(actor))
      .send({ by: DEFAULT_USER, expected_revision: 2 });
    expect(response.status).toBe(200);
    expect(response.body.decision.state).toBe('grace');
    expect(response.body.decision.current_answer_id).toBeNull();
  } else {
    await expectForbidden(
      () =>
        request(app)
          .post(`/api/decisions/${answered.id}/undo`)
          .set(actorRequest(actor))
          .send({ by: DEFAULT_USER, expected_revision: 1 }),
      deniedCode,
    );
  }

  // 6. 撤回
  if (role === 'owner') {
    const response = await request(app)
      .post(`/api/decisions/${withdrawTarget.id}/withdraw`)
      .set(actorRequest(actor))
      .send({ by: DEFAULT_USER, reason: '矩阵测试' });
    expect(response.status).toBe(200);
    expect(response.body.decision.state).toBe('withdrawn');
  } else {
    await expectForbidden(
      () =>
        request(app)
          .post(`/api/decisions/${withdrawTarget.id}/withdraw`)
          .set(actorRequest(actor))
          .send({ by: DEFAULT_USER, reason: '矩阵测试' }),
      deniedCode,
    );
  }

  // 7. 延长宽限
  if (writable) {
    const response = await request(app)
      .post(`/api/decisions/${extendTarget.id}/extend`)
      .set(actorRequest(actor))
      .send({ seconds: 60, by: DEFAULT_USER });
    expect(response.status).toBe(200);
    expect(response.body.extended_seconds).toBeGreaterThanOrEqual(60);
  } else {
    await expectForbidden(
      () =>
        request(app)
          .post(`/api/decisions/${extendTarget.id}/extend`)
          .set(actorRequest(actor))
          .send({ seconds: 60 }),
      deniedCode,
    );
  }

  // 8. 提问 ask（需持卡 claim；身份仍需 member+）
  const askAgent = `agent-${++agentSeq}`;
  const askIssue = createIssue(t.db, { workspace_id: workspaceId, title: `提问卡 ${askAgent}` });
  const claimed = claimIssue(t.db, askIssue.id, askAgent, null);
  const ask = () =>
    request(app)
      .post(`/api/issues/${askIssue.id}/ask`)
      .set(actorRequest(actor))
      .send({ agent_id: askAgent, fence: claimed.claim_fence, question: '继续还是停止？', options: OPTIONS });
  if (writable) {
    const response = await ask();
    expect(response.status).toBe(201);
    expect(response.body.decision.state).toBe('grace');
  } else {
    await expectForbidden(ask, deniedCode);
  }
}

describe('DEC-V4-PERM-TEST 服务端权限矩阵（4 角色 × 8 动作，真实 createApp）', () => {
  it('owner：8 个动作全部允许，数据按预期变化', async () => {
    await runMatrix('owner');
  });

  it('member：查看 / 回答 / 延长 / 提问允许；修订、撤销、撤回 403 ROLE_FORBIDDEN', async () => {
    await runMatrix('member');
  });

  it('viewer：只读；6 个写动作 403 ROLE_FORBIDDEN 且零写入', async () => {
    await runMatrix('viewer');
  });

  it('anonymous：8 个动作全部 403 WORKSPACE_FORBIDDEN 且零写入', async () => {
    await runMatrix('anonymous');
  });
});

describe('DEC-V4-PERM-TEST capability 投影与实际结果一致', () => {
  async function listCapabilities(actor: string, state?: 'grace' | 'answered') {
    const response = await request(app)
      .get('/api/decisions')
      .query({ workspace_id: workspaceId, ...(state === undefined ? {} : { state }) })
      .set(actorRequest(actor));
    expect(response.status).toBe(200);
    return response.body as {
      decisions: Array<{ id: string; state: string; capabilities: Record<string, boolean> }>;
      capabilities: Record<string, boolean>;
    };
  }

  it('owner：answered 决策的 5 个能力均为 true', async () => {
    const answered = await createDecisionViaApi();
    await answerAs(DEFAULT_USER, answered.id, { option_id: await optionIdOf(answered.id) });
    const body = await listCapabilities(OWNER, 'answered');
    const item = body.decisions.find((row) => row.id === answered.id);
    expect(item).toBeDefined();
    expect(item!.capabilities).toEqual({
      can_answer: true,
      can_revise: true,
      can_undo: true,
      can_withdraw: true,
      can_extend: true,
    });
    expect(body.capabilities).toEqual(item!.capabilities);
  });

  it('member：can_withdraw=false → 撤回 403；grace 的 can_revise/can_undo=false 不放大权限', async () => {
    const grace = await createDecisionViaApi();
    const body = await listCapabilities(MEMBER);
    const item = body.decisions.find((row) => row.id === grace.id);
    expect(item!.capabilities).toEqual({
      can_answer: true,
      can_revise: false,
      can_undo: false,
      can_withdraw: false,
      can_extend: true,
    });

    // can_withdraw=false（纯角色不足）→ 403 ROLE_FORBIDDEN
    await expectForbidden(
      () =>
        request(app)
          .post(`/api/decisions/${grace.id}/withdraw`)
          .set(actorRequest(MEMBER))
          .send({ by: DEFAULT_USER, reason: '越权撤回' }),
      'ROLE_FORBIDDEN',
    );

    // can_revise=false：answered 决策由 user 作答，member 没有「管理他人答案」资格 → 403
    // （直接拿 grace 带 expected_revision 调 answer 会先吃 409 DECISION_REVISION_CONFLICT，测不到角色门）
    const answered = await createDecisionViaApi();
    const answeredOptionId = await optionIdOf(answered.id);
    expect((await answerAs(DEFAULT_USER, answered.id, { option_id: answeredOptionId })).status).toBe(200);
    await expectForbidden(
      () =>
        answerAs(MEMBER, answered.id, {
          option_id: answeredOptionId,
          expected_revision: 1,
        }),
      'ROLE_FORBIDDEN',
    );
    // 对照：同一条 answered 决策，member 的 can_revise 仍为 false（本人答案才可改）
    const answeredBody = await listCapabilities(MEMBER, 'answered');
    expect(answeredBody.decisions.find((row) => row.id === answered.id)!.capabilities).toMatchObject({
      can_revise: false,
      can_undo: false,
      can_withdraw: false,
    });
    // 角色够（member）但 grace 没有可撤销答案 → 状态冲突 409，同样零写入、不广播
    await expectStateConflict(
      () =>
        request(app)
          .post(`/api/decisions/${grace.id}/undo`)
          .set(actorRequest(MEMBER))
          .send({ by: DEFAULT_USER, expected_revision: 1 }),
      'UNDO_NOT_ANSWERED',
    );
  });

  it('viewer：5 个能力全 false → 5 个写动作全部 403 且零写入', async () => {
    const grace = await createDecisionViaApi();
    const body = await listCapabilities(VIEWER);
    const item = body.decisions.find((row) => row.id === grace.id);
    expect(item!.capabilities).toEqual({
      can_answer: false,
      can_revise: false,
      can_undo: false,
      can_withdraw: false,
      can_extend: false,
    });

    await expectForbidden(
      () => answerAs(VIEWER, grace.id),
      'ROLE_FORBIDDEN',
    );
    await expectForbidden(
      () => answerAs(VIEWER, grace.id, { expected_revision: 1 }),
      'ROLE_FORBIDDEN',
    );
    await expectForbidden(
      () =>
        request(app)
          .post(`/api/decisions/${grace.id}/undo`)
          .set(actorRequest(VIEWER))
          .send({ by: DEFAULT_USER, expected_revision: 1 }),
      'ROLE_FORBIDDEN',
    );
    await expectForbidden(
      () =>
        request(app)
          .post(`/api/decisions/${grace.id}/withdraw`)
          .set(actorRequest(VIEWER))
          .send({ by: DEFAULT_USER, reason: '越权撤回' }),
      'ROLE_FORBIDDEN',
    );
    await expectForbidden(
      () =>
        request(app)
          .post(`/api/decisions/${grace.id}/extend`)
          .set(actorRequest(VIEWER))
          .send({ seconds: 60 }),
      'ROLE_FORBIDDEN',
    );
  });

  it('anonymous：任何动作都 403 WORKSPACE_FORBIDDEN（先判成员关系）', async () => {
    const grace = await createDecisionViaApi();
    const endpoints: Array<() => Promise<request.Response>> = [
      () => request(app).get('/api/decisions').query({ workspace_id: workspaceId }).set(actorRequest(ANONYMOUS)),
      () => request(app).get(`/api/decisions/${grace.id}`).set(actorRequest(ANONYMOUS)),
      () => answerAs(ANONYMOUS, grace.id),
      () => answerAs(ANONYMOUS, grace.id, { expected_revision: 1 }),
      () =>
        request(app)
          .post(`/api/decisions/${grace.id}/undo`)
          .set(actorRequest(ANONYMOUS))
          .send({ by: DEFAULT_USER, expected_revision: 1 }),
      () =>
        request(app)
          .post(`/api/decisions/${grace.id}/withdraw`)
          .set(actorRequest(ANONYMOUS))
          .send({ by: DEFAULT_USER, reason: '匿名' }),
      () =>
        request(app)
          .post(`/api/decisions/${grace.id}/extend`)
          .set(actorRequest(ANONYMOUS))
          .send({ seconds: 60 }),
    ];
    for (const run of endpoints) await expectForbidden(run, 'WORKSPACE_FORBIDDEN');
  });
});

describe('DEC-V4-PERM-TEST 范围与身份边界', () => {
  it('scope=accessible 只返回有成员关系的区；workspace_ids 混入无权限区只跳过该区', async () => {
    const otherWs = createWorkspace(t.db, { name: '另一个区', path: 'D:\\perm-other' }).id;
    addMember(workspaceId, 'agent:scoped', 'viewer');
    await createDecisionViaApi();
    const otherAgent = `agent-${++agentSeq}`;
    const otherIssue = createIssue(t.db, { workspace_id: otherWs, title: '别区卡' });
    const otherClaim = claimIssue(t.db, otherIssue.id, otherAgent, null);
    const otherAsk = await request(app)
      .post(`/api/issues/${otherIssue.id}/ask`)
      .set(actorRequest(DEFAULT_USER))
      .send({ agent_id: otherAgent, fence: otherClaim.claim_fence, question: '别区？', options: OPTIONS });
    expect(otherAsk.status).toBe(201);

    const accessible = await request(app)
      .get('/api/decisions')
      .query({ scope: 'accessible' })
      .set(actorRequest('agent:scoped'));
    expect(accessible.status).toBe(200);
    expect(accessible.body.decisions.length).toBeGreaterThan(0);
    expect(new Set(accessible.body.decisions.map((item: { workspace_id: string }) => item.workspace_id))).toEqual(
      new Set([workspaceId]),
    );

    const mixed = await request(app)
      .get('/api/decisions')
      .query({ workspace_ids: `${workspaceId},${otherWs}` })
      .set(actorRequest('agent:scoped'));
    expect(mixed.status).toBe(200);
    expect(new Set(mixed.body.decisions.map((item: { workspace_id: string }) => item.workspace_id))).toEqual(
      new Set([workspaceId]),
    );

    const onlyOther = await request(app)
      .get('/api/decisions')
      .query({ workspace_ids: otherWs })
      .set(actorRequest('agent:scoped'));
    expect(onlyOther.status).toBe(200);
    expect(onlyOther.body.decisions).toEqual([]);

    await expectForbidden(
      () =>
        request(app)
          .get('/api/decisions')
          .query({ workspace_id: otherWs })
          .set(actorRequest('agent:scoped')),
      'WORKSPACE_FORBIDDEN',
    );
  });

  it('401 只由显式非法身份头触发；无身份头按 user 放行', async () => {
    const grace = await createDecisionViaApi();

    const empty = await request(app).get('/api/decisions').query({ workspace_id: workspaceId }).set(actorRequest(''));
    expect(empty.status).toBe(401);
    expect(empty.body.error?.code).toBe('UNAUTHENTICATED');

    const tooLong = await request(app)
      .get('/api/decisions')
      .query({ workspace_id: workspaceId })
      .set(actorRequest('a'.repeat(101)));
    expect(tooLong.status).toBe(401);
    expect(tooLong.body.error?.code).toBe('UNAUTHENTICATED');

    // 写动作的非法头同样是 401 而不是 403（且零写入）。body 必须能过 zod，否则先吃 400
    const before = snapshot();
    const badAnswer = await request(app)
      .post(`/api/decisions/${grace.id}/answer`)
      .set(actorRequest(''))
      .send({ source: 'web' });
    expect(badAnswer.status).toBe(401);
    expect(badAnswer.body.error?.code).toBe('UNAUTHENTICATED');
    expect(snapshot()).toEqual(before);

    // 无身份头 → 缺省 user（既有 owner），列表 200
    const legacy = await request(app).get('/api/decisions').query({ workspace_id: workspaceId });
    expect(legacy.status).toBe(200);
    expect(legacy.body.decisions.some((item: { id: string }) => item.id === grace.id)).toBe(true);
  });
});

describe('DEC-V4-PERM-TEST 广播事件', () => {
  it('成功动作会广播；403 不广播（each 已逐个断言）', async () => {
    const decision = await createDecisionViaApi();
    broadcastSpy.mockClear();
    const response = await answerAs(DEFAULT_USER, decision.id, {
      option_id: await optionIdOf(decision.id),
    });
    expect(response.status).toBe(200);
    const events = broadcastSpy.mock.calls.map((call) => call[0] as ServerWsEvent);
    expect(events.some((event) => event.type === 'decision.answered')).toBe(true);
    expect(events.some((event) => event.type === 'issue.changed')).toBe(true);
  });
});
