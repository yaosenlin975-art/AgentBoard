/**
 * CHAT-SB1 侧栏服务端契约（#1–4 / #10–12 / #22）。
 * 覆盖：session 四列迁移幂等；PATCH archived（默认列表过滤、include_archived=1、运行中 409）；
 * title 同步到列表/详情且 trim 后空串 400；fork 复制截止消息、来源标记、继承字段、错误码；
 * WS session.changed 顶层增量字段。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import type { WsEvent } from '@agentboard/shared';
import { createTestDb, type TestDb } from './helpers.js';
import { FakeAdapter, settle } from './fakeAdapter.js';
import { createApp, type CreatedApp } from '../src/index.js';
import { resetSessionManager } from '../src/services/sessionManager.js';
import { createWorkspace } from '../src/db/repos/workspace.js';
import { createIssue } from '../src/db/repos/issue.js';
import { createSession, getSession } from '../src/db/repos/session.js';
import { addMessage, listMessagesBySession } from '../src/db/repos/message.js';
import { initSchema } from '../src/db/schema.js';

let t: TestDb;
let adapter: FakeAdapter;
let created: CreatedApp;
let app: Express;
let workspaceId: string;

beforeEach(async () => {
  t = createTestDb();
  workspaceId = createWorkspace(t.db, { name: 'W', path: 'D:\\w' }).id;
  adapter = new FakeAdapter();
  created = await createApp({
    db: t.db,
    getAdapter: (id) => {
      if (id === 'codebuddy') return adapter;
      throw new Error(`未知适配器 id: ${id}`);
    },
    adapters: [adapter],
    maxConcurrentTurns: 3,
  });
  app = created.app;
});

afterEach(() => {
  vi.restoreAllMocks();
  resetSessionManager();
  t.cleanup();
});

function sessionIdList(body: unknown): string[] {
  return (body as Array<{ id: string }>).map((s) => s.id);
}

function countRows(table: 'session_turn' | 'message', sessionId: string): number {
  return (t.db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE session_id = ?`).get(sessionId) as { n: number }).n;
}

function changedEvents(): WsEvent[] {
  return [...broadcastSpy.mock.calls].map(([event]) => event as WsEvent).filter((e) => e.type === 'session.changed');
}
let broadcastSpy: ReturnType<typeof vi.spyOn>;

describe('CHAT-SB1 会话侧栏服务端', () => {
  it('迁移幂等：连续 initSchema 两次，session 含 title + 三列，存量数据不丢', () => {
    const legacy = createSession(t.db, { workspace_id: workspaceId, cli: 'codebuddy', model: 'm1' });
    t.db.prepare("UPDATE session SET title = '旧名' WHERE id = ?").run(legacy.id);
    initSchema(t.db);
    initSchema(t.db);
    const columns = (t.db.prepare('PRAGMA table_info(session)').all() as Array<{ name: string }>).map((c) => c.name);
    expect(columns).toEqual(expect.arrayContaining(['title', 'archived_at', 'forked_from_session_id', 'fork_message_id']));
    const row = getSession(t.db, legacy.id)!;
    expect(row.title).toBe('旧名');
    expect(row.model).toBe('m1');
    expect(row.archived_at ?? null).toBeNull();
  });

  it('PATCH archived：默认列表排除归档，include_archived=1 含；archived=false 恢复并回到默认列表', async () => {
    const session = createSession(t.db, { workspace_id: workspaceId, cli: 'codebuddy', status: '已结束' });
    const archived = await request(app).patch(`/api/sessions/${session.id}`).send({ archived: true });
    expect(archived.status).toBe(200);
    expect(archived.body.archived_at).toBeGreaterThan(0);
    expect(getSession(t.db, session.id)?.archived_at).toBeGreaterThan(0);

    const byDefault = await request(app).get('/api/sessions').query({ workspace_id: workspaceId });
    expect(byDefault.status).toBe(200);
    expect(sessionIdList(byDefault.body)).not.toContain(session.id);

    const withArchived = await request(app)
      .get('/api/sessions')
      .query({ workspace_id: workspaceId, include_archived: '1' });
    expect(withArchived.status).toBe(200);
    expect(sessionIdList(withArchived.body)).toContain(session.id);

    const restored = await request(app).patch(`/api/sessions/${session.id}`).send({ archived: false });
    expect(restored.status).toBe(200);
    expect(restored.body.archived_at).toBeNull();
    const afterRestore = await request(app).get('/api/sessions').query({ workspace_id: workspaceId });
    expect(sessionIdList(afterRestore.body)).toContain(session.id);
  });

  it('运行中会话归档：409（与删除同口径），archived_at 不变', async () => {
    adapter.script = () => undefined; // 挂起：保持运行中
    const created0 = await request(app)
      .post('/api/sessions')
      .send({ cli: 'codebuddy', workspace_id: workspaceId, prompt: '长任务' });
    expect(created0.status).toBe(200);
    const id = created0.body.id as string;
    await settle();
    expect(getSession(t.db, id)?.status).toBe('运行中');

    const res = await request(app).patch(`/api/sessions/${id}`).send({ archived: true });
    expect(res.status).toBe(409);
    expect(res.body.error).toMatchObject({ code: 'CONFLICT', message: '会话正在运行，请先停止再归档' });
    expect(getSession(t.db, id)?.archived_at ?? null).toBeNull();

    await request(app).post(`/api/sessions/${id}/stop`);
  });

  it('PATCH title 与 archived 同时提交都生效；列表/详情同步；trim 后空串 400', async () => {
    const session = createSession(t.db, { workspace_id: workspaceId, cli: 'codebuddy', status: '已结束' });
    const both = await request(app)
      .patch(`/api/sessions/${session.id}`)
      .send({ title: '  侧栏名  ', archived: true });
    expect(both.status).toBe(200);
    expect(both.body.title).toBe('侧栏名');
    expect((await request(app).get(`/api/sessions/${session.id}`)).body.title).toBe('侧栏名');
    const list = await request(app)
      .get('/api/sessions')
      .query({ workspace_id: workspaceId, include_archived: '1' });
    expect((list.body as Array<{ id: string; title: string }>).find((s) => s.id === session.id)?.title).toBe('侧栏名');

    const blank = await request(app).patch(`/api/sessions/${session.id}`).send({ title: '   ' });
    expect(blank.status).toBe(400);
    expect(getSession(t.db, session.id)?.title).toBe('侧栏名');
  });

  it('fork 指定 from_message_id：复制截止消息、继承 issue/cli/model/title、来源标记、源会话不变', async () => {
    const issue = createIssue(t.db, { workspace_id: workspaceId, title: '任务标题' });
    const source = createSession(t.db, {
      workspace_id: workspaceId,
      issue_id: issue.id,
      cli: 'codebuddy',
      model: 'm1',
    });
    t.db.prepare("UPDATE session SET title = '源标题' WHERE id = ?").run(source.id);
    const messages = [
      addMessage(t.db, { session_id: source.id, role: 'user', content: 'q1' }),
      addMessage(t.db, { session_id: source.id, role: 'assistant', content: 'a1' }),
      addMessage(t.db, { session_id: source.id, role: 'user', content: 'q2' }),
      addMessage(t.db, { session_id: source.id, role: 'assistant', content: 'a2' }),
    ];
    // 固定 ts，避免同一毫秒内 addMessage 让 (ts, id) 排序不确定
    messages.forEach((m, i) => t.db.prepare('UPDATE message SET ts = ? WHERE id = ?').run(1000 + i, m.id));
    broadcastSpy = vi.spyOn(created.hub, 'broadcast');
    const fork = await request(app)
      .post(`/api/sessions/${source.id}/fork`)
      .send({ from_message_id: messages[1]!.id });
    expect(fork.status).toBe(200);
    const forked = fork.body as Record<string, unknown>;

    expect(forked.forked_from_session_id).toBe(source.id);
    expect(forked.fork_message_id).toBe(messages[1]!.id);
    expect(forked.issue_id).toBe(issue.id);
    expect(forked.cli).toBe('codebuddy');
    expect(forked.model).toBe('m1');
    expect(forked.title).toBe('源标题');
    expect(forked.status).toBe('已结束');
    expect(forked.adapter_session_id).toBeNull();
    expect(forked.archived_at).toBeNull();

    const newId = forked.id as string;
    expect(countRows('message', newId)).toBe(2);
    expect(countRows('message', source.id)).toBe(4);
    expect(countRows('session_turn', newId)).toBe(0);
    expect(listMessagesBySession(t.db, newId).map((m) => m.content)).toEqual(['q1', 'a1']);

    const forkedEvent = changedEvents().find((e) => e.type === 'session.changed' && e.session.id === newId);
    expect(forkedEvent).toMatchObject({
      type: 'session.changed',
      session_id: newId,
      forked_from_session_id: source.id,
      archived_at: null,
    });
  });

  it('fork 缺省 from_message_id：复制全部消息，fork_message_id=最后一条', async () => {
    const source = createSession(t.db, { workspace_id: workspaceId, cli: 'codebuddy' });
    const messages = [
      addMessage(t.db, { session_id: source.id, role: 'user', content: 'q1' }),
      addMessage(t.db, { session_id: source.id, role: 'assistant', content: 'a1' }),
    ];
    messages.forEach((m, i) => t.db.prepare('UPDATE message SET ts = ? WHERE id = ?').run(1000 + i, m.id));
    const fork = await request(app).post(`/api/sessions/${source.id}/fork`).send({});
    expect(fork.status).toBe(200);
    expect(fork.body.fork_message_id).toBe(messages[1]!.id);
    expect(countRows('message', fork.body.id as string)).toBe(2);
    expect(countRows('message', source.id)).toBe(2);
  });

  it('fork 错误分支：源会话不存在 404；from_message_id 不属于该会话 400', async () => {
    const missing = await request(app).post('/api/sessions/00000000-0000-4000-8000-0000000000ff/fork').send({});
    expect(missing.status).toBe(404);
    expect(missing.body.error).toMatchObject({ code: 'NOT_FOUND', message: '会话不存在' });

    const source = createSession(t.db, { workspace_id: workspaceId, cli: 'codebuddy' });
    const other = createSession(t.db, { workspace_id: workspaceId, cli: 'codebuddy' });
    const foreign = addMessage(t.db, { session_id: other.id, role: 'user', content: '不属于源会话' });
    const res = await request(app)
      .post(`/api/sessions/${source.id}/fork`)
      .send({ from_message_id: foreign.id });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatchObject({ code: 'VALIDATION_ERROR', message: 'from_message_id 不属于该会话' });
  });

  it('PATCH 归档/恢复广播 session.changed 顶层带增量字段', async () => {
    const session = createSession(t.db, { workspace_id: workspaceId, cli: 'codebuddy', status: '已结束' });
    broadcastSpy = vi.spyOn(created.hub, 'broadcast');
    await request(app).patch(`/api/sessions/${session.id}`).send({ archived: true, title: '改名' });
    const events = changedEvents();
    const last = events[events.length - 1];
    expect(last).toMatchObject({
      type: 'session.changed',
      session_id: session.id,
      title: '改名',
      forked_from_session_id: null,
    });
    expect((last as { archived_at?: number | null }).archived_at).toBeGreaterThan(0);
  });
});
