/**
 * 聊天会话重命名（会话级 title）。
 * 验收：PATCH /api/sessions/:id 接受 title（200 且回显）；GET 列表每条含 title；
 * 空串 / 超 50 字 400；null 旧会话照常返回；迁移幂等（连续两次启动不炸、含 title 列、不重建表）。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import { createTestDb, type TestDb } from './helpers.js';
import { FakeAdapter } from './fakeAdapter.js';
import { createApp } from '../src/index.js';
import { createWorkspace } from '../src/db/repos/workspace.js';
import { createIssue } from '../src/db/repos/issue.js';
import { createSession, getSession } from '../src/db/repos/session.js';
import { initSchema } from '../src/db/schema.js';

let t: TestDb;
let app: Express;
let workspaceId: string;

beforeEach(async () => {
  t = createTestDb();
  workspaceId = createWorkspace(t.db, { name: 'W', path: 'D:\\w' }).id;
  const adapter = new FakeAdapter();
  const created = await createApp({ db: t.db, getAdapter: (id) => {
    if (id === 'fake') return adapter;
    throw new Error(`未知适配器 id: ${id}`);
  }, adapters: [adapter], maxConcurrentTurns: 3 });
  app = created.app;
});

afterEach(() => {
  t.cleanup();
});

describe('会话标题', () => {
  it('复现/回归：PATCH title 200 且 GET 列表含 title 字段', async () => {
    const session = createSession(t.db, { workspace_id: workspaceId, cli: 'fake' });
    const res = await request(app).patch(`/api/sessions/${session.id}`).send({ title: '测试改名' });
    expect(res.status).toBe(200);
    expect(res.body.title).toBe('测试改名');
    expect(getSession(t.db, session.id)?.title).toBe('测试改名');

    const list = await request(app).get('/api/sessions').query({ workspace: workspaceId });
    expect(list.status).toBe(200);
    expect(list.body[0]).toHaveProperty('title');
    expect(list.body[0].title).toBe('测试改名');
  });

  it('空串与超 50 字返回 400，且不写入', async () => {
    const session = createSession(t.db, { workspace_id: workspaceId, cli: 'fake' });
    const empty = await request(app).patch(`/api/sessions/${session.id}`).send({ title: '   ' });
    expect(empty.status).toBe(400);
    const long = await request(app).patch(`/api/sessions/${session.id}`).send({ title: 'x'.repeat(51) });
    expect(long.status).toBe(400);
    expect(getSession(t.db, session.id)?.title).toBeNull();
  });

  it('title 为 null 的旧会话列表照常返回（不改名）', async () => {
    const issue = createIssue(t.db, { workspace_id: workspaceId, title: '任务标题' });
    createSession(t.db, { workspace_id: workspaceId, issue_id: issue.id, cli: 'fake' });
    const list = await request(app).get('/api/sessions').query({ workspace: workspaceId });
    expect(list.status).toBe(200);
    expect(list.body[0].title).toBeNull();
  });

  it('PATCH 同时给 model 与 title 都生效；两者都不给 400', async () => {
    const session = createSession(t.db, { workspace_id: workspaceId, cli: 'fake', model: 'a' });
    const both = await request(app).patch(`/api/sessions/${session.id}`).send({ model: 'b', title: '改名' });
    expect(both.status).toBe(200);
    expect(both.body.model).toBe('b');
    expect(both.body.title).toBe('改名');
    const none = await request(app).patch(`/api/sessions/${session.id}`).send({});
    expect(none.status).toBe(400);
  });

  it('迁移幂等：旧库连续 initSchema 两次不报错，session 含 title，且不丢数据', () => {
    const legacy = createSession(t.db, { workspace_id: workspaceId, cli: 'fake', model: 'm' });
    t.db.prepare("UPDATE session SET title='旧名' WHERE id=?").run(legacy.id);
    initSchema(t.db);
    initSchema(t.db);
    const columns = (t.db.prepare('PRAGMA table_info(session)').all() as Array<{ name: string }>).map((c) => c.name);
    expect(columns).toContain('title');
    expect(getSession(t.db, legacy.id)?.title).toBe('旧名');
    expect(getSession(t.db, legacy.id)?.model).toBe('m');
  });
});
