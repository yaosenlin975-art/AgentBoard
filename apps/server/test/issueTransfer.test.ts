/**
 * BORROW-4.3：`POST /api/issues/:id/transfer` —— 任务交接（卡面验收 2：system 评论 + claimed_by 更新 + 旧 fence 失效）。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Express } from 'express';
import request from 'supertest';
import type { AgentAdapter } from '@agentboard/adapters';
import { createTestDb, type TestDb, issuePayload } from './helpers.js';
import { FakeAdapter } from './fakeAdapter.js';
import { createApp } from '../src/index.js';
import { createWorkspace } from '../src/db/repos/workspace.js';
import { createIssue } from '../src/db/repos/issue.js';
import { listCommentsByIssue } from '../src/db/repos/comment.js';
import { claimIssue, finishClaimedIssue, transferClaimedIssue } from '../src/services/claim.js';

let t: TestDb;
let wsId: string;

beforeEach(() => {
  t = createTestDb();
  wsId = createWorkspace(t.db, { name: 'ws', path: 'D:\\ws-transfer' }).id;
});
afterEach(() => {
  t.cleanup();
});

const claimed = (title = '待交接卡') => {
  const issue = createIssue(t.db, { workspace_id: wsId, title });
  const result = claimIssue(t.db, issue.id, 'agent-a', null);
  return { issueId: issue.id, fence: result.claim_fence };
};

const row = (issueId: string) =>
  t.db.prepare('SELECT claimed_by, status, claim_fence FROM issue WHERE id=?').get(issueId) as
    { claimed_by: string | null; status: string; claim_fence: number };

describe('BORROW-4.3：任务交接（服务层）', () => {
  it('交接成功：claimed_by 更新 + fence bump + system 评论留痕', () => {
    const { issueId, fence } = claimed();
    const result = transferClaimedIssue(t.db, issueId, wsId, 'agent-a', 'agent-b', '夜间交接');
    expect(result.issue.claimed_by).toBe('agent-b');
    expect(result.claim_fence).toBe(fence + 1);
    expect(row(issueId)).toMatchObject({ claimed_by: 'agent-b', status: '进行中', claim_fence: fence + 1 });
    const comment = listCommentsByIssue(t.db, issueId).at(-1)!;
    expect(comment.author).toBe('system');
    expect(comment.content).toBe('任务交接：agent-a → agent-b（夜间交接）');
  });

  it('旧 fence 失效：原占用者用旧 fence 收尾 → STALE_FENCE，且不产生写入', () => {
    const { issueId, fence } = claimed();
    transferClaimedIssue(t.db, issueId, wsId, 'agent-a', 'agent-b');
    expect(() => finishClaimedIssue(t.db, issueId, wsId, 'agent-a', 'done', '旧人收尾', fence))
      .toThrowError(/占用代次已过期/);
    expect(row(issueId)).toMatchObject({ claimed_by: 'agent-b', status: '进行中' });
    // 新占用者用新 fence 可以正常收尾
    finishClaimedIssue(t.db, issueId, wsId, 'agent-b', 'done', '新人收尾', fence + 1);
    expect(row(issueId).status).toBe('待验收');
  });

  it('非当前占用者发起 → NOT_TASK_OWNER', () => {
    const { issueId } = claimed();
    expect(() => transferClaimedIssue(t.db, issueId, wsId, 'agent-c', 'agent-b'))
      .toThrowError(/只有当前占用者/);
  });

  it('交接双方相同 → 400；无人占用 → 409「无需交接」', () => {
    const { issueId } = claimed();
    expect(() => transferClaimedIssue(t.db, issueId, wsId, 'agent-a', 'agent-a'))
      .toThrowError(/不能是同一个 agent/);
    // 释放后无人占用
    t.db.prepare("UPDATE issue SET claimed_by=NULL, claim_lease_until=NULL WHERE id=?").run(issueId);
    expect(() => transferClaimedIssue(t.db, issueId, wsId, 'agent-a', 'agent-b'))
      .toThrowError(/当前无人占用/);
  });

  it('状态非进行中 → 409 中文报错', () => {
    const { issueId } = claimed();
    t.db.prepare("UPDATE issue SET status='待规划' WHERE id=?").run(issueId);
    expect(() => transferClaimedIssue(t.db, issueId, wsId, 'agent-a', 'agent-b'))
      .toThrowError(/不可交接（需=进行中）/);
  });
});

describe('BORROW-4.3：真实 app 接线（RULE-3）', () => {
  let app: Express;
  let apiWs: string;

  beforeEach(async () => {
    const adapter = new FakeAdapter();
    const created = await createApp({
      db: t.db,
      getAdapter: (_id: string): AgentAdapter => adapter,
      adapters: [adapter],
      refreshClisOnBoot: false,
    });
    app = created.app;
    apiWs = createWorkspace(t.db, { name: '交接区', path: 'D:\\ws-transfer-api' }).id;
  });

  it('POST /api/issues/:id/transfer 返回 200，claim_fence 递增且 issue.changed 生效', async () => {
    const created = await request(app).post('/api/issues').send(issuePayload(apiWs, { title: 'HTTP 交接' }));
    expect(created.status).toBe(200);
    const issueId = created.body.id as string;
    const claim = await request(app).post(`/api/issues/${issueId}/claim`).send({ agent_id: 'agent-a' });
    expect(claim.status).toBe(200);
    const fence = claim.body.claim_fence as number;

    const res = await request(app)
      .post(`/api/issues/${issueId}/transfer`)
      .send({ workspace_id: apiWs, from_agent: 'agent-a', to_agent: 'agent-b', reason: '换人', fence });
    expect(res.status).toBe(200);
    expect(res.body.claimed_by).toBe('agent-b');
    expect(res.body.claim_fence).toBe(fence + 1);
    expect(res.body.comment.author).toBe('system');

    const reread = await request(app).get(`/api/issues/${issueId}`);
    expect(reread.body.claimed_by).toBe('agent-b');
  }, 30_000);

  it('缺 workspace_id → 400；旧 fence → 409 STALE_FENCE', async () => {
    const created = await request(app).post('/api/issues').send(issuePayload(apiWs, { title: 'HTTP 交接 2' }));
    const issueId = created.body.id as string;
    const claim = await request(app).post(`/api/issues/${issueId}/claim`).send({ agent_id: 'agent-a' });
    const fence = claim.body.claim_fence as number;

    const missing = await request(app).post(`/api/issues/${issueId}/transfer`).send({ from_agent: 'agent-a', to_agent: 'agent-b' });
    expect(missing.status).toBe(400);

    await request(app).post(`/api/issues/${issueId}/transfer`).send({ workspace_id: apiWs, from_agent: 'agent-a', to_agent: 'agent-b', fence });
    const stale = await request(app)
      .post(`/api/issues/${issueId}/transfer`)
      .send({ workspace_id: apiWs, from_agent: 'agent-a', to_agent: 'agent-b', fence });
    expect(stale.status).toBe(409);
    expect(stale.body.error.code).toBe('STALE_FENCE');
  }, 30_000);
});
