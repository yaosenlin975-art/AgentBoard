/**
 * PERF-4a：`/api/issues` 的 `fields=` 白名单、`GET /api/issues/counts` 聚合、回滚开关。
 * RULE-3：全部通过真实 `createApp` 的 HTTP 断言（端点真挂载、非 404）。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import type { AgentAdapter } from '@agentboard/adapters';
import { createTestDb, type TestDb } from './helpers.js';
import { FakeAdapter } from './fakeAdapter.js';
import { createApp } from '../src/index.js';
import { createWorkspace } from '../src/db/repos/workspace.js';
import { createIssue, updateIssue } from '../src/db/repos/issue.js';

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
  wsA = createWorkspace(t.db, { name: 'PERF-4a 区', path: 'D:\\perf4-ws-a' }).id;
  wsB = createWorkspace(t.db, { name: 'PERF-4b 区', path: 'D:\\perf4-ws-b' }).id;
  const accepted = createIssue(t.db, { workspace_id: wsA, title: 'A1', description: '正文'.repeat(20) });
  createIssue(t.db, { workspace_id: wsA, title: 'A2' });
  updateIssue(t.db, accepted.id, { status: '待验收' });
  createIssue(t.db, { workspace_id: wsB, title: 'B1' });
});

afterEach(() => {
  delete process.env.AGENTBOARD_ISSUES_V2;
  t.cleanup();
});

describe('PERF-4a：GET /api/issues fields= 白名单', () => {
  it('只返回所列字段，未请求正文时不出现 description', async () => {
    const res = await request(app).get(`/api/issues?workspace=${wsA}&limit=50&fields=id,title,status`);
    expect(res.status).toBe(200);
    expect(res.body.items).toHaveLength(2);
    for (const item of res.body.items as Array<Record<string, unknown>>) {
      expect(Object.keys(item).sort()).toEqual(['id', 'status', 'title']);
    }
  }, 30_000);

  it('缺省 fields 仍是完整字段（description / comment_count 都在）', async () => {
    const res = await request(app).get(`/api/issues?workspace=${wsA}&limit=50`);
    expect(res.status).toBe(200);
    const item = res.body.items[0] as Record<string, unknown>;
    expect(typeof item.description).toBe('string');
    expect(item.comment_count).toBe(0);
    expect(item.description_truncated).toBe(false);
  }, 30_000);

  it('fields 含未知字段 → 400', async () => {
    const res = await request(app).get(`/api/issues?workspace=${wsA}&limit=50&fields=id,nope`);
    expect(res.status).toBe(400);
  }, 30_000);

  it('请求 description 时仍做文本窗口并附截断标记', async () => {
    const res = await request(app).get(`/api/issues?workspace=${wsA}&limit=50&fields=id,description`);
    expect(res.status).toBe(200);
    const item = res.body.items.find((row: { id: string }) => row.id !== undefined) as Record<string, unknown>;
    for (const row of res.body.items as Array<Record<string, unknown>>) {
      expect(Object.keys(row).sort()).toEqual(['description', 'description_truncated', 'id', 'next_description_offset_chars']);
      expect(typeof row.description).toBe('string');
    }
    expect(item).toBeDefined();
  }, 30_000);
});

describe('PERF-4a：GET /api/issues/counts 聚合', () => {
  it('端点非 404，按状态聚合且与全量列表逐状态一致', async () => {
    const res = await request(app).get(`/api/issues/counts?workspace_ids=${wsA},${wsB}`);
    expect(res.status).toBe(200);
    expect(res.body.items.map((item: { workspace_id: string }) => item.workspace_id)).toEqual([wsA, wsB]);
    const [a, b] = res.body.items as Array<{ total: number; counts: Record<string, number> }>;
    const full = await request(app).get(`/api/issues?workspace=${wsA}`);
    const grouped: Record<string, number> = {};
    for (const issue of full.body as Array<{ status: string }>) grouped[issue.status] = (grouped[issue.status] ?? 0) + 1;
    expect(a.counts).toEqual(grouped);
    expect(a.total).toBe(2);
    expect(b.counts).toEqual({ 待规划: 1 });
    expect(b.total).toBe(1);
  }, 30_000);

  it('缺参 400 / 重复项 400 / 未知工作区 404 / 超 50 400', async () => {
    expect((await request(app).get('/api/issues/counts')).status).toBe(400);
    expect((await request(app).get(`/api/issues/counts?workspace_ids=${wsA},${wsA}`)).status).toBe(400);
    expect((await request(app).get('/api/issues/counts?workspace_ids=nope')).status).toBe(404);
    const many = Array.from({ length: 51 }, (_value, index) => `w${index}`).join(',');
    expect((await request(app).get(`/api/issues/counts?workspace_ids=${many}`)).status).toBe(400);
  }, 30_000);
});

describe('PERF-4a：回滚开关 AGENTBOARD_ISSUES_V2', () => {
  it('off 时 counts 404、fields 被忽略（退回旧完整字段契约）', async () => {
    process.env.AGENTBOARD_ISSUES_V2 = 'off';
    expect((await request(app).get(`/api/issues/counts?workspace_ids=${wsA}`)).status).toBe(404);
    const res = await request(app).get(`/api/issues?workspace=${wsA}&limit=50&fields=id`);
    expect(res.status).toBe(200);
    const item = res.body.items[0] as Record<string, unknown>;
    expect(typeof item.description).toBe('string');
    expect(item.comment_count).toBe(0);
  }, 30_000);
});
