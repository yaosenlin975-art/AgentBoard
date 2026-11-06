/**
 * KB-CLI-4（CLI-20）：`GET /api/statuses?workspace_ids=a,b` 聚合端点 —— 真实 app 接线（RULE-3）。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import type { AgentAdapter } from '@agentboard/adapters';
import { createTestDb, type TestDb } from './helpers.js';
import { FakeAdapter } from './fakeAdapter.js';
import { createApp } from '../src/index.js';
import { createWorkspace } from '../src/db/repos/workspace.js';

let t: TestDb;
let app: Express;
let wsA: string;
let wsB: string;

beforeEach(async () => {
  t = createTestDb();
  const adapter = new FakeAdapter();
  const created = await createApp({
    db: t.db,
    getAdapter: (_id: string): AgentAdapter => adapter,
    adapters: [adapter],
    refreshClisOnBoot: false,
  });
  app = created.app;
  wsA = createWorkspace(t.db, { name: 'A 区', path: 'D:\\ws-status-a' }).id;
  wsB = createWorkspace(t.db, { name: 'B 区', path: 'D:\\ws-status-b' }).id;
});
afterEach(() => {
  t.cleanup();
});

describe('KB-CLI-4：状态字典聚合端点', () => {
  it('一次取回多个工作区的字典，顺序与入参一致', async () => {
    const res = await request(app).get(`/api/statuses?workspace_ids=${wsB},${wsA}`);
    expect(res.status).toBe(200);
    expect(res.body.items.map((item: { workspace_id: string }) => item.workspace_id)).toEqual([wsB, wsA]);
    for (const item of res.body.items as Array<{ statuses: Array<{ name: string; kind: string }> }>) {
      expect(item.statuses.length).toBeGreaterThan(0);
      expect(item.statuses.some(status => status.name === '待规划')).toBe(true);
    }
  }, 30_000);

  it('缺参 → 400；未知工作区 → 404；重复项 → 400', async () => {
    expect((await request(app).get('/api/statuses')).status).toBe(400);
    expect((await request(app).get('/api/statuses?workspace_ids=nope')).status).toBe(404);
    expect((await request(app).get(`/api/statuses?workspace_ids=${wsA},${wsA}`)).status).toBe(400);
  }, 30_000);
});
