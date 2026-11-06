/**
 * DEC-V4-PERM-SERVER：决策端点权限校验（身份头 / 角色矩阵 / capability / 401-403）。
 *
 * RULE-3 接线证据：全部用例走真实 `createApp`（不是单测 router），
 * 断言 401 / 403 的真实 HTTP 形状、403 路径零写入（读库对比 + broadcast spy）、
 * `scope=accessible` / `workspace_ids` 的跨区过滤与 counts 口径。
 *
 * 说明：卡面把测试路径写成 `apps/server/src/test/...`，仓库实际约定在 `apps/server/test/`；
 * 本文件为新建文件，不改动既有测试夹具。
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
import { createIssue } from '../src/db/repos/issue.js';
import { claimIssue } from '../src/services/claim.js';
import type { WorkspaceRole } from '../src/db/repos/workspaceMember.js';
import { resolveActor } from '../src/services/permission.js';

const ACTOR = 'X-AgentBoard-Actor';

const OPTIONS = [
  { label: '继续', consequence: '继续执行' },
  { label: '停止', consequence: '停在检查点' },
];

let t: TestDb;
let created: CreatedApp;
let app: Express;
let wsA: string;
let wsB: string;
let broadcastSpy: MockInstance;

function addMember(workspaceId: string, actorId: string, role: WorkspaceRole): void {
  const now = Date.now();
  t.db
    .prepare(
      `INSERT INTO workspace_member (id, workspace_id, actor_id, role, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run(`member-${workspaceId}-${actorId}`, workspaceId, actorId, role, now, now);
}

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
  wsA = createWorkspace(t.db, { name: 'ws-a', path: 'D:\\ws-a' }).id;
  wsB = createWorkspace(t.db, { name: 'ws-b', path: 'D:\\ws-b' }).id;
  // user 由 PERM-1 迁移/建区自动 seed 为 owner；这里补 member / viewer
  addMember(wsA, 'agent:member', 'member');
  addMember(wsA, 'agent:viewer', 'viewer');
  // 只属于 wsB 的身份，用于验证「只返回有成员关系的区」
  addMember(wsB, 'agent:b-only', 'member');
});

afterEach(() => {
  broadcastSpy.mockRestore();
  t.cleanup();
});

function broadcastEvents(): ServerWsEvent[] {
  return broadcastSpy.mock.calls.map((call) => call[0] as ServerWsEvent);
}

/** 建卡 → claim → ask（身份头固定 user/owner） */
async function seedDecision(
  workspaceId: string,
  agentId: string,
  overrides: Record<string, unknown> = {},
): Promise<{ decisionId: string; issueId: string }> {
  const issue = createIssue(t.db, { workspace_id: workspaceId, title: `权限测试卡-${workspaceId.slice(0, 4)}` });
  const claimed = claimIssue(t.db, issue.id, agentId, null);
  const response = await request(app)
    .post(`/api/issues/${issue.id}/ask`)
    .set(ACTOR, 'user')
    .send({ agent_id: agentId, fence: claimed.claim_fence, question: '继续还是停止？', options: OPTIONS, ...overrides });
  expect(response.status).toBe(201);
  return { decisionId: response.body.decision.id as string, issueId: issue.id };
}

function snapshot(decisionId: string, issueId: string) {
  return {
    decision: t.db.prepare('SELECT * FROM issue_decision WHERE id=?').get(decisionId),
    answers: t.db.prepare('SELECT * FROM issue_decision_answer WHERE decision_id=? ORDER BY revision').all(decisionId),
    issue: t.db.prepare('SELECT * FROM issue WHERE id=?').get(issueId),
  };
}

describe('PERM-2：身份解析与 401', () => {
  it('不带身份头 → 按 user 放行（单机兼容）', async () => {
    const response = await request(app).get(`/api/decisions?workspace_id=${wsA}`);
    expect(response.status).toBe(200);
    expect(response.body.capabilities).toMatchObject({ can_answer: true, can_withdraw: true });
  });

  it('X-AgentBoard-Actor 为空/超长/含控制字符 → 401 UNAUTHENTICATED（不降级成 user）', async () => {
    const empty = await request(app).get(`/api/decisions?workspace_id=${wsA}`).set(ACTOR, '   ');
    expect(empty.status).toBe(401);
    expect(empty.body.error.code).toBe('UNAUTHENTICATED');

    const tooLong = await request(app).get(`/api/decisions?workspace_id=${wsA}`).set(ACTOR, 'a'.repeat(101));
    expect(tooLong.status).toBe(401);
    expect(tooLong.body.error.code).toBe('UNAUTHENTICATED');

    // 控制字符无法通过 HTTP 客户端发送（Node 直接拒绝），按单元口径验证解析器本身
    const codeOf = (header: string): string | undefined => {
      try {
        resolveActor({ get: () => header } as never);
        return undefined;
      } catch (error) {
        return (error as { code?: string }).code;
      }
    };
    expect(codeOf('')).toBe('UNAUTHENTICATED');
    expect(codeOf('agent:bad\u0001name')).toBe('UNAUTHENTICATED');
    expect(codeOf('agent:')).toBe('UNAUTHENTICATED');
    expect(codeOf('agent:ok')).toBeUndefined();
  });
});

describe('PERM-2：跨区查看与 403', () => {
  it('非成员查单区 → 403 WORKSPACE_FORBIDDEN；owner 同请求 200', async () => {
    await seedDecision(wsA, 'agent-1');
    const forbidden = await request(app)
      .get(`/api/decisions?workspace_id=${wsA}`)
      .set(ACTOR, 'agent:outsider');
    expect(forbidden.status).toBe(403);
    expect(forbidden.body.error.code).toBe('WORKSPACE_FORBIDDEN');

    const ok = await request(app).get(`/api/decisions?workspace_id=${wsA}`).set(ACTOR, 'user');
    expect(ok.status).toBe(200);
    expect(ok.body.decisions).toHaveLength(1);
  });

  it('非成员查详情 → 403；成员查详情 200 且带 capabilities', async () => {
    const { decisionId } = await seedDecision(wsA, 'agent-1');
    const forbidden = await request(app).get(`/api/decisions/${decisionId}`).set(ACTOR, 'agent:outsider');
    expect(forbidden.status).toBe(403);
    expect(forbidden.body.error.code).toBe('WORKSPACE_FORBIDDEN');

    const ok = await request(app).get(`/api/decisions/${decisionId}`).set(ACTOR, 'agent:viewer');
    expect(ok.status).toBe(200);
    expect(ok.body.decision.capabilities).toEqual({
      can_answer: false,
      can_revise: false,
      can_undo: false,
      can_withdraw: false,
      can_extend: false,
    });
  });

  it('scope=accessible 只返回有成员的区，counts 与逐区之和一致', async () => {
    // b-only 只属于 wsB（member）与 wsC（viewer）；wsA 的决策必须被排除
    const wsC = createWorkspace(t.db, { name: 'ws-c', path: 'D:\\ws-c' }).id;
    addMember(wsC, 'agent:b-only', 'viewer');
    await seedDecision(wsA, 'agent-1');
    await seedDecision(wsB, 'agent-2');
    await seedDecision(wsC, 'agent-3', { grace_seconds: 0 });

    const accessible = await request(app).get('/api/decisions?scope=accessible').set(ACTOR, 'agent:b-only');
    expect(accessible.status).toBe(200);
    const workspaceIds = (accessible.body.decisions as Array<{ workspace_id: string; workspace_name: string }>).map(
      (item) => item.workspace_id,
    );
    expect(new Set(workspaceIds)).toEqual(new Set([wsB, wsC]));
    expect(workspaceIds).not.toContain(wsA);
    expect(accessible.body.decisions[0].workspace_name).toMatch(/^ws-[bc]$/);

    // counts 必须等于两个可访问区逐区查询之和
    const countB = await request(app).get(`/api/decisions?workspace_id=${wsB}`).set(ACTOR, 'agent:b-only');
    const countC = await request(app).get(`/api/decisions?workspace_id=${wsC}`).set(ACTOR, 'agent:b-only');
    expect(accessible.body.counts).toEqual({
      grace: countB.body.counts.grace + countC.body.counts.grace,
      open: countB.body.counts.open + countC.body.counts.open,
      stale_open: countB.body.counts.stale_open + countC.body.counts.stale_open,
      answered_recent: countB.body.counts.answered_recent + countC.body.counts.answered_recent,
    });
    expect(accessible.body.counts).toMatchObject({ grace: 1, open: 1 });
  });

  it('workspace_ids 逐区校验：无权限的区被跳过且响应不出现其 workspace_id', async () => {
    await seedDecision(wsA, 'agent-1');
    await seedDecision(wsB, 'agent-2');

    const response = await request(app)
      .get(`/api/decisions?workspace_ids=${wsA},${wsB}`)
      .set(ACTOR, 'agent:b-only');
    expect(response.status).toBe(200);
    expect(response.body.decisions).toHaveLength(1);
    expect(response.body.decisions[0].workspace_id).toBe(wsB);
    expect(
      (response.body.decisions as Array<{ workspace_id: string }>).some((item) => item.workspace_id === wsA),
    ).toBe(false);
    expect(response.body.counts).toMatchObject({ grace: 1 });
  });

  it('scope=accessible 对零成员身份 → 403 WORKSPACE_FORBIDDEN', async () => {
    const response = await request(app).get('/api/decisions?scope=accessible').set(ACTOR, 'agent:nowhere');
    expect(response.status).toBe(403);
    expect(response.body.error.code).toBe('WORKSPACE_FORBIDDEN');
  });
});

describe('PERM-2：角色矩阵（使用能力驱动写操作）', () => {
  it('viewer 回答 → 403 ROLE_FORBIDDEN；member 撤回 → 403；owner 撤回 → 200', async () => {
    const { decisionId } = await seedDecision(wsA, 'agent-1', { grace_seconds: 120 });

    const viewerAnswer = await request(app)
      .post(`/api/decisions/${decisionId}/answer`)
      .set(ACTOR, 'agent:viewer')
      .send({ option_ord: 1 });
    expect(viewerAnswer.status).toBe(403);
    expect(viewerAnswer.body.error.code).toBe('ROLE_FORBIDDEN');

    const memberWithdraw = await request(app)
      .post(`/api/decisions/${decisionId}/withdraw`)
      .set(ACTOR, 'agent:member')
      .send({ by: 'agent:member', reason: '我来撤回' });
    expect(memberWithdraw.status).toBe(403);
    expect(memberWithdraw.body.error.code).toBe('ROLE_FORBIDDEN');

    const viewerExtend = await request(app)
      .post(`/api/decisions/${decisionId}/extend`)
      .set(ACTOR, 'agent:viewer')
      .send({ seconds: 30 });
    expect(viewerExtend.status).toBe(403);
    expect(viewerExtend.body.error.code).toBe('ROLE_FORBIDDEN');

    const ownerWithdraw = await request(app)
      .post(`/api/decisions/${decisionId}/withdraw`)
      .set(ACTOR, 'user')
      .send({ by: 'user', reason: 'owner 撤回' });
    expect(ownerWithdraw.status).toBe(200);
    expect(ownerWithdraw.body.decision.state).toBe('withdrawn');
  });

  it('member 回答（本人）→ 200；capabilities 与实际结果一致', async () => {
    const { decisionId } = await seedDecision(wsA, 'agent-1', { grace_seconds: 120 });

    const detail = await request(app).get(`/api/decisions/${decisionId}`).set(ACTOR, 'agent:member');
    expect(detail.body.decision.capabilities).toMatchObject({ can_answer: true, can_withdraw: false });

    const answer = await request(app)
      .post(`/api/decisions/${decisionId}/answer`)
      .set(ACTOR, 'agent:member')
      .send({ option_ord: 1, answered_by: 'user' });
    expect(answer.status).toBe(200);
  });

  it('403 路径零写入：决策 / answer / issue 逐字段不变且不广播', async () => {
    const { decisionId, issueId } = await seedDecision(wsA, 'agent-1', { grace_seconds: 120 });
    const before = snapshot(decisionId, issueId);
    broadcastSpy.mockClear();

    const forbiddenCalls = [
      request(app).post(`/api/decisions/${decisionId}/answer`).set(ACTOR, 'agent:viewer').send({ option_ord: 1 }),
      request(app)
        .post(`/api/decisions/${decisionId}/withdraw`)
        .set(ACTOR, 'agent:member')
        .send({ by: 'agent:member', reason: '无权撤回' }),
      request(app).post(`/api/decisions/${decisionId}/extend`).set(ACTOR, 'agent:viewer').send({ seconds: 30 }),
      request(app).post(`/api/decisions/${decisionId}/undo`).set(ACTOR, 'agent:viewer').send({ by: 'user', expected_revision: 1 }),
    ];
    for (const call of forbiddenCalls) {
      const response = await call;
      expect(response.status).toBe(403);
    }

    expect(snapshot(decisionId, issueId)).toEqual(before);
    expect(broadcastEvents()).toEqual([]);
  });
});

describe('PERM-2：ask 的成员校验', () => {
  it('非成员 agent 提问 → 403 且不建决策', async () => {
    const issue = createIssue(t.db, { workspace_id: wsA, title: '非成员提问卡' });
    const claimed = claimIssue(t.db, issue.id, 'agent:outsider', null);

    const response = await request(app)
      .post(`/api/issues/${issue.id}/ask`)
      .set(ACTOR, 'agent:outsider')
      .send({
        agent_id: 'agent:outsider',
        fence: claimed.claim_fence,
        question: '可以继续吗？',
        options: OPTIONS,
      });
    expect(response.status).toBe(403);
    expect(response.body.error.code).toBe('WORKSPACE_FORBIDDEN');
    const count = t.db.prepare('SELECT COUNT(*) AS n FROM issue_decision WHERE issue_id=?').get(issue.id) as {
      n: number;
    };
    expect(count.n).toBe(0);
  });

  it('成员 agent 持有效 claim 提问 → 201（身份头与 body.agent_id 分离）', async () => {
    const issue = createIssue(t.db, { workspace_id: wsA, title: '成员提问卡' });
    const claimed = claimIssue(t.db, issue.id, 'agent-1', null);

    const response = await request(app)
      .post(`/api/issues/${issue.id}/ask`)
      .set(ACTOR, 'agent:member')
      .send({ agent_id: 'agent-1', fence: claimed.claim_fence, question: '可以继续吗？', options: OPTIONS });
    expect(response.status).toBe(201);
  });
});
