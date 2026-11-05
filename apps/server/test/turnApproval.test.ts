/**
 * CHAT-APP1：三档确认服务端（approval_rule + 审批/规则/撤销端点 + scope 解析）。
 *
 * 覆盖卡面验收：
 * 1：迁移幂等 + 部分唯一索引（同键重复 409、撤销后可再建）；
 * 2：三档落库差异（once 不落、task 带 issue_id、workspace 不带）；
 * 3：非 awaiting_approval → 409；deny → stopped(approval_denied)；
 * 4：写类工具 + workspace → 403（明确错误码/文案）；只读工具通过；
 * 5：GET 只列未撤销；DELETE 软撤销（行保留）；撤销后同类请求重新弹审批；
 * 6：session.approval_request 四字段齐全；allow 后回 running；
 * 7：任务关闭后 task 规则不再命中。
 * 另覆盖 400/404 边界与 awaiting_approval 超时兜底。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentAdapter } from '@agentboard/adapters';
import request from 'supertest';
import type { Express } from 'express';
import type { SessionApprovalRequestEvent, SessionTurnEvent } from '@agentboard/shared';
import { createTestDb, type TestDb } from './helpers.js';
import { FakeAdapter } from './fakeAdapter.js';
import { createApp, type CreatedApp } from '../src/index.js';
import { createWorkspace } from '../src/db/repos/workspace.js';
import { createSession as insertSessionRow } from '../src/db/repos/session.js';
import { createIssue } from '../src/db/repos/issue.js';
import { createTurn, getTurn, nextTurnSeq } from '../src/db/repos/sessionTurn.js';
import {
  createApprovalRule,
  listActiveApprovalRules,
  revokeApprovalRule,
} from '../src/db/repos/approvalRule.js';
import { initSchema } from '../src/db/schema.js';
import { closedStatusNames } from '../src/services/workspaceStatus.js';
import {
  TURN_AWAITING_MAX_MS,
  markTurnAwaiting,
  sweepAwaitingTurns,
} from '../src/services/turnAwaiting.js';
import {
  approvalMatchKey,
  isReadOnlyApprovalTool,
  requestTurnApproval,
} from '../src/services/turnApproval.js';

let t: TestDb;
let wsId: string;
let adapter: FakeAdapter;
let created: CreatedApp;
let app: Express;

function fakeResolver(id: string): AgentAdapter {
  if (id === 'fake') return adapter;
  throw new Error(`未知适配器 id: ${id}`);
}

function mkTurn(sessionId: string) {
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

function mkSession(issueId: string | null = null) {
  return insertSessionRow(t.db, { workspace_id: wsId, issue_id: issueId, cli: 'fake' });
}

/** 通过请求入口把 running 轮次推进到 awaiting_approval，返回 request_id */
function mkPending(sessionId: string, turnId: string, tool = 'Read', target = 'README.md', matchKey?: string) {
  return requestTurnApproval(t.db, { broadcast: created.hub.broadcast }, sessionId, turnId, {
    tool,
    target,
    risk: 'low',
    match_key: matchKey,
  });
}

function approvalEvents(spy: ReturnType<typeof vi.spyOn>): SessionApprovalRequestEvent[] {
  return spy.mock.calls
    .map(([event]) => event as { type: string })
    .filter((event) => event.type === 'session.approval_request') as SessionApprovalRequestEvent[];
}

function turnEvents(spy: ReturnType<typeof vi.spyOn>): SessionTurnEvent[] {
  return spy.mock.calls
    .map(([event]) => event as { type: string })
    .filter((event) => event.type === 'session.turn') as SessionTurnEvent[];
}

beforeEach(async () => {
  t = createTestDb();
  wsId = createWorkspace(t.db, { name: 'ws', path: 'D:\\ws\\approval' }).id;
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

describe('验收 1：迁移幂等与规则唯一性', () => {
  it('重复 initSchema 不丢规则；同键未撤销重复插入 409，撤销后可再建', () => {
    const base = {
      workspace_id: wsId,
      issue_id: null,
      session_id: null,
      turn_id: null,
      tool_name: 'read',
      match_key: approvalMatchKey('Read', 'README.md'),
      scope: 'workspace' as const,
      created_by: 'test',
    };
    const first = createApprovalRule(t.db, base);
    expect(() => createApprovalRule(t.db, base)).toThrowError(/同键的审批规则已存在/);

    initSchema(t.db);
    expect((t.db.prepare('SELECT COUNT(*) AS n FROM approval_rule').get() as { n: number }).n).toBe(1);

    revokeApprovalRule(t.db, wsId, first.id);
    const again = createApprovalRule(t.db, base);
    expect(again.id).not.toBe(first.id);
    expect(listActiveApprovalRules(t.db, wsId).map((rule) => rule.id)).toEqual([again.id]);

    const columns = (t.db.prepare('PRAGMA table_info(approval_rule)').all() as Array<{ name: string }>)
      .map((column) => column.name);
    expect(columns).toEqual(expect.arrayContaining([
      'id', 'workspace_id', 'issue_id', 'session_id', 'turn_id', 'tool_name', 'match_key',
      'scope', 'created_at', 'created_by', 'revoked_at',
    ]));
  });
});

describe('验收 2/6：三档落库、WS 四字段与 allow 恢复 running', () => {
  it('once 不落规则；allow 后轮次回 running、awaiting 清空，且推了一次 session.turn', async () => {
    const session = mkSession();
    const turn = mkTurn(session.id);
    const spy = vi.spyOn(created.hub, 'broadcast');
    const pending = mkPending(session.id, turn.id);
    expect(pending.request_id).not.toBeNull();
    expect(approvalEvents(spy)).toHaveLength(1);

    const response = await request(app)
      .post(`/api/sessions/${session.id}/turns/${turn.id}/approvals/${pending.request_id}`)
      .send({ decision: 'allow', scope: 'once' });
    expect(response.status).toBe(200);
    expect(response.body.rule).toBeNull();

    const updated = getTurn(t.db, turn.id)!;
    expect(updated.state).toBe('running');
    expect(updated.awaiting_json).toBeNull();
    expect(updated.ended_at).toBeNull();
    expect(updated.plan_json?.map((step) => step.state)).toEqual(['running', 'pending']);
    expect(listActiveApprovalRules(t.db, wsId)).toEqual([]);
    expect(turnEvents(spy)).toHaveLength(1);
    expect(turnEvents(spy)[0]).toMatchObject({ turn_id: turn.id, state: 'running', awaiting: null });
  });

  it('task 档写入 issue_id；workspace 档 issue_id 为 NULL 且只接受只读工具', async () => {
    const issue = createIssue(t.db, { workspace_id: wsId, title: '任务档' });
    const taskSession = mkSession(issue.id);
    const taskTurn = mkTurn(taskSession.id);
    const taskPending = mkPending(taskSession.id, taskTurn.id, 'Grep', 'src/**');

    const taskResponse = await request(app)
      .post(`/api/sessions/${taskSession.id}/turns/${taskTurn.id}/approvals/${taskPending.request_id}`)
      .send({ decision: 'allow', scope: 'task' });
    expect(taskResponse.status).toBe(200);
    expect(taskResponse.body.rule).toMatchObject({ scope: 'task', issue_id: issue.id, workspace_id: wsId });

    const wsSession = mkSession();
    const wsTurn = mkTurn(wsSession.id);
    const wsPending = mkPending(wsSession.id, wsTurn.id, 'Read', 'a.txt');
    const wsResponse = await request(app)
      .post(`/api/sessions/${wsSession.id}/turns/${wsTurn.id}/approvals/${wsPending.request_id}`)
      .send({ decision: 'allow', scope: 'workspace' });
    expect(wsResponse.status).toBe(200);
    expect(wsResponse.body.rule).toMatchObject({ scope: 'workspace', issue_id: null, workspace_id: wsId });
    expect(isReadOnlyApprovalTool('Read')).toBe(true);
    expect(isReadOnlyApprovalTool('Bash')).toBe(false);
  });

  it('session.approval_request 四字段齐全（tool/target/risk/request_id）', () => {
    const session = mkSession();
    const turn = mkTurn(session.id);
    const spy = vi.spyOn(created.hub, 'broadcast');
    const pending = mkPending(session.id, turn.id, 'Read', 'docs/a.md');

    const events = approvalEvents(spy);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: 'session.approval_request',
      session_id: session.id,
      turn_id: turn.id,
      request_id: pending.request_id,
      tool: 'Read',
      target: 'docs/a.md',
      risk: 'low',
    });
  });
});

describe('验收 3/4：拒绝终态与工作区档工具限制', () => {
  it('deny → stopped(approval_denied)，步骤 failed，推一次 session.turn', async () => {
    const session = mkSession();
    const turn = mkTurn(session.id);
    const pending = mkPending(session.id, turn.id);
    const spy = vi.spyOn(created.hub, 'broadcast');

    const response = await request(app)
      .post(`/api/sessions/${session.id}/turns/${turn.id}/approvals/${pending.request_id}`)
      .send({ decision: 'deny', scope: 'once' });
    expect(response.status).toBe(200);

    const updated = getTurn(t.db, turn.id)!;
    expect(updated.state).toBe('stopped');
    expect(updated.awaiting_json?.reason).toBe('approval_denied');
    expect(updated.ended_at).not.toBeNull();
    expect(updated.plan_json?.map((step) => step.state)).toEqual(['failed', 'pending']);
    expect(turnEvents(spy)).toHaveLength(1);
    expect(listActiveApprovalRules(t.db, wsId)).toEqual([]);
  });

  it('写类工具 + workspace 档 → 403 FORBIDDEN（含撤销入口文案）；轮次仍停在 awaiting_approval', async () => {
    const session = mkSession();
    const turn = mkTurn(session.id);
    const pending = mkPending(session.id, turn.id, 'Bash', 'npm test');

    const response = await request(app)
      .post(`/api/sessions/${session.id}/turns/${turn.id}/approvals/${pending.request_id}`)
      .send({ decision: 'allow', scope: 'workspace' });
    expect(response.status).toBe(403);
    expect(response.body.error.code).toBe('FORBIDDEN');
    expect(response.body.error.message).toContain('需先提供撤销入口');

    const unchanged = getTurn(t.db, turn.id)!;
    expect(unchanged.state).toBe('awaiting_approval');
    expect(unchanged.awaiting_json?.approval?.request_id).toBe(pending.request_id);
  });

  it('非 awaiting_approval 的轮次 → 409；重复决策 → 409', async () => {
    const session = mkSession();
    const turn = mkTurn(session.id); // running，未进入审批
    const response = await request(app)
      .post(`/api/sessions/${session.id}/turns/${turn.id}/approvals/00000000-0000-4000-8000-000000000000`)
      .send({ decision: 'allow', scope: 'once' });
    expect(response.status).toBe(409);

    const pending = mkPending(session.id, turn.id);
    const first = await request(app)
      .post(`/api/sessions/${session.id}/turns/${turn.id}/approvals/${pending.request_id}`)
      .send({ decision: 'allow', scope: 'once' });
    expect(first.status).toBe(200);
    const second = await request(app)
      .post(`/api/sessions/${session.id}/turns/${turn.id}/approvals/${pending.request_id}`)
      .send({ decision: 'allow', scope: 'once' });
    expect(second.status).toBe(409);
  });
});

describe('验收 5：规则列表 / 软撤销 / 撤销后重新弹审批', () => {
  it('GET 只列未撤销；DELETE 软撤销（行保留）后 GET 排除，重新请求再次弹审批', async () => {
    const session = mkSession();
    const turn = mkTurn(session.id);
    const pending = mkPending(session.id, turn.id);
    const allow = await request(app)
      .post(`/api/sessions/${session.id}/turns/${turn.id}/approvals/${pending.request_id}`)
      .send({ decision: 'allow', scope: 'workspace' });
    expect(allow.status).toBe(200);
    const ruleId = allow.body.rule.id as string;

    const list = await request(app).get(`/api/workspaces/${wsId}/approval-rules`);
    expect(list.status).toBe(200);
    expect(list.body.map((rule: { id: string }) => rule.id)).toEqual([ruleId]);

    const removed = await request(app).delete(`/api/workspaces/${wsId}/approval-rules/${ruleId}`);
    expect(removed.status).toBe(200);
    expect(removed.body.revoked_at).toEqual(expect.any(Number));

    const row = t.db.prepare('SELECT revoked_at FROM approval_rule WHERE id = ?').get(ruleId) as { revoked_at: number | null };
    expect(row.revoked_at).not.toBeNull();

    const after = await request(app).get(`/api/workspaces/${wsId}/approval-rules`);
    expect(after.body).toEqual([]);

    // 撤销后同类请求不再自动放行，重新进入审批并再推一次事件
    const nextTurn = mkTurn(session.id);
    const spy = vi.spyOn(created.hub, 'broadcast');
    const retriggered = mkPending(session.id, nextTurn.id);
    expect(retriggered.auto_allowed).toBe(false);
    expect(approvalEvents(spy)).toHaveLength(1);
  });

  it('撤销未知/已撤销规则 → 404；未知工作区 → 404', async () => {
    const missing = await request(app).delete(`/api/workspaces/${wsId}/approval-rules/00000000-0000-4000-8000-000000000000`);
    expect(missing.status).toBe(404);

    const noWs = await request(app).get('/api/workspaces/00000000-0000-4000-8000-000000000000/approval-rules');
    expect(noWs.status).toBe(404);
  });
});

describe('验收 7：任务结束后 task 规则失效', () => {
  it('任务关闭后同键请求不再命中 task 规则，重新进入审批', async () => {
    const issue = createIssue(t.db, { workspace_id: wsId, title: '会关闭的任务' });
    const session = mkSession(issue.id);
    const turn = mkTurn(session.id);

    const firstPending = mkPending(session.id, turn.id, 'Read', 'x.txt');
    const allow = await request(app)
      .post(`/api/sessions/${session.id}/turns/${turn.id}/approvals/${firstPending.request_id}`)
      .send({ decision: 'allow', scope: 'task' });
    expect(allow.status).toBe(200);

    // 命中 task 规则 → 自动放行
    const nextTurn = mkTurn(session.id);
    const auto = mkPending(session.id, nextTurn.id, 'Read', 'x.txt');
    expect(auto.auto_allowed).toBe(true);
    expect(auto.rule?.scope).toBe('task');

    // 关闭任务（关闭类状态按工作区字典反查）
    const closed = closedStatusNames(t.db, wsId)[0];
    expect(closed).toBeTruthy();
    t.db.prepare('UPDATE issue SET status = ? WHERE id = ?').run(closed, issue.id);

    const spy = vi.spyOn(created.hub, 'broadcast');
    const reopened = mkPending(session.id, nextTurn.id, 'Read', 'x.txt');
    expect(reopened.auto_allowed).toBe(false);
    expect(approvalEvents(spy)).toHaveLength(1);
  });
});

describe('边界：400/404 与审批超时兜底', () => {
  it('body 非法 → 400；未知轮次 / request_id 不匹配 → 404；task 档无 issue → 400', async () => {
    const session = mkSession();
    const turn = mkTurn(session.id);

    const badBody = await request(app)
      .post(`/api/sessions/${session.id}/turns/${turn.id}/approvals/00000000-0000-4000-8000-000000000000`)
      .send({ decision: 'maybe', scope: 'once' });
    expect(badBody.status).toBe(400);
    expect(badBody.body.error.code).toBe('VALIDATION_ERROR');

    const unknownTurn = await request(app)
      .post(`/api/sessions/${session.id}/turns/00000000-0000-4000-8000-000000000000/approvals/00000000-0000-4000-8000-000000000000`)
      .send({ decision: 'allow', scope: 'once' });
    expect(unknownTurn.status).toBe(404);

    const pending = mkPending(session.id, turn.id);
    const mismatch = await request(app)
      .post(`/api/sessions/${session.id}/turns/${turn.id}/approvals/00000000-0000-4000-8000-000000000000`)
      .send({ decision: 'allow', scope: 'once' });
    expect(mismatch.status).toBe(404);

    const taskNoIssue = await request(app)
      .post(`/api/sessions/${session.id}/turns/${turn.id}/approvals/${pending.request_id}`)
      .send({ decision: 'allow', scope: 'task' });
    expect(taskNoIssue.status).toBe(400);
    expect(taskNoIssue.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('awaiting_approval 复用心跳/超时兜底：超过绝对上限 → failed(awaiting_timeout)', () => {
    const session = mkSession();
    const turn = mkTurn(session.id);
    const awaiting = markTurnAwaiting(t.db, session.id, turn.id, {
      state: 'awaiting_approval',
      reason: 'approval_required',
      stepId: 's1',
      approval: {
        request_id: 'req-timeout',
        tool: 'Bash',
        target: 'rm -rf build',
        risk: 'high',
        match_key: approvalMatchKey('Bash', 'rm -rf build'),
      },
    });
    const at = awaiting.awaiting_json?.at ?? 0;
    t.db.prepare('UPDATE session_turn SET awaiting_heartbeat_at = ? WHERE id = ?')
      .run(at + TURN_AWAITING_MAX_MS - 30_000, turn.id);

    const result = sweepAwaitingTurns(t.db, {
      broadcast: created.hub.broadcast,
      now: () => at + TURN_AWAITING_MAX_MS + 1,
    });
    expect(result.timedOut.map((item) => item.id)).toEqual([turn.id]);
    expect(getTurn(t.db, turn.id)!.awaiting_json?.reason).toBe('awaiting_timeout');
  });
});
