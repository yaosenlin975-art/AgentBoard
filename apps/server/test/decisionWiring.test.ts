/**
 * DEC-WIRE：决策路由挂载与宽限 ticker 启动接线。
 *
 * DEC-3 / DEC-9 收尾时 routes.ts 与 index.ts 被 STORE-3a 未提交改动占用，挂载与启动接线未做；
 * 本卡补齐后用 createApp（真实 createRouter）验证端点不再 404。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import type { AgentAdapter } from '@agentboard/adapters';
import { createTestDb, type TestDb } from './helpers.js';
import { FakeAdapter } from './fakeAdapter.js';
import { createApp, type CreatedApp } from '../src/index.js';
import { createWorkspace } from '../src/db/repos/workspace.js';
import { createIssue } from '../src/db/repos/issue.js';
import { claimIssue } from '../src/services/claim.js';

let t: TestDb;
let created: CreatedApp;
let app: Express;
let wsId: string;
let issueId: string;
let fence: number;

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
  created = await createApp({ db: t.db, getAdapter: resolve, adapters: [adapter], maxConcurrentTurns: 1, refreshClisOnBoot: false });
  app = created.app;
  wsId = createWorkspace(t.db, { name: 'ws', path: 'D:\\ws' }).id;
  const issue = createIssue(t.db, { workspace_id: wsId, title: '接线验证卡' });
  const claimed = claimIssue(t.db, issue.id, 'agent-1', null);
  issueId = claimed.id;
  fence = claimed.claim_fence;
});

afterEach(() => {
  t.cleanup();
});

function ask() {
  return request(app)
    .post(`/api/issues/${issueId}/ask`)
    .send({ agent_id: 'agent-1', fence, question: '继续还是停止？', options: OPTIONS });
}

describe('决策路由已挂载到生产 router', () => {
  it('POST /api/issues/:id/ask 不再 404，默认宽限 180 秒', async () => {
    const res = await ask();
    expect(res.status).toBe(201);
    expect(res.body.decision).toMatchObject({ issue_id: issueId, state: 'grace', grace_seconds: 180 });
    expect(res.body.decision.grace_until).toBeGreaterThan(Date.now());
  });

  it('GET /api/decisions 与 count / stats 可达', async () => {
    await ask();

    const list = await request(app).get(`/api/decisions?workspace_id=${wsId}`);
    expect(list.status).toBe(200);
    expect(list.body.decisions).toHaveLength(1);

    const count = await request(app).get(`/api/workspaces/${wsId}/decisions/count`);
    expect(count.status).toBe(200);
    expect(count.body).toMatchObject({ grace: 1, open: 0 });

    const stats = await request(app).get(`/api/workspaces/${wsId}/decisions/stats`);
    expect(stats.status).toBe(200);
    expect(stats.body).toMatchObject({ workspace_id: wsId, created: 1, answered: 0 });
  });

  it('GET /api/issues/:id/stop 可达（停止信号通道已暴露）', async () => {
    const res = await request(app).get(`/api/issues/${issueId}/stop`);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ issue_id: issueId, stop_requested: false });
  });
});
