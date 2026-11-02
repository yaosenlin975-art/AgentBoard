/**
 * CHAT-DELETE01：DELETE /api/sessions/:id 契约测试。
 * 覆盖：成功删除（message/session 行清空 + session.deleted 广播 + 列表剔除）、
 * 运行中 409、正占用任务 409（任务归属不变）、不存在 404、重复删除幂等 404。
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import type { AgentAdapter } from '@agentboard/adapters';
import type { WsEvent } from '@agentboard/shared';
import { createTestDb, type TestDb } from './helpers.js';
import { FakeAdapter, settle } from './fakeAdapter.js';
import { createApp, type CreatedApp } from '../src/index.js';
import { resetSessionManager } from '../src/services/sessionManager.js';

let t: TestDb;
let adapter: FakeAdapter;
let created: CreatedApp;
let app: Express;
let spaceDir: string;

function fakeResolver(id: string): AgentAdapter {
  if (id === 'fake' || id === 'codebuddy') return adapter;
  throw new Error(`未知适配器 id: ${id}`);
}

beforeEach(async () => {
  t = createTestDb();
  adapter = new FakeAdapter();
  spaceDir = mkdtempSync(join(tmpdir(), 'agentboard-space-'));
  created = await createApp({ db: t.db, getAdapter: fakeResolver, adapters: [adapter], maxConcurrentTurns: 3 });
  app = created.app;
});

afterEach(() => {
  vi.restoreAllMocks();
  resetSessionManager();
  t.cleanup();
  rmSync(spaceDir, { recursive: true, force: true });
});

async function mkSpace(name = 'demo'): Promise<string> {
  const res = await request(app).post('/api/workspaces').send({ name, path: spaceDir });
  expect(res.status).toBe(200);
  return res.body.id as string;
}

async function mkIssue(workspaceId: string, title = '任务'): Promise<Record<string, unknown>> {
  const res = await request(app)
    .post('/api/issues')
    .send({ workspace_id: workspaceId, title, description: '描述', priority: '高', labels: ['p1'] });
  expect(res.status).toBe(200);
  return res.body as Record<string, unknown>;
}

function messageCount(sessionId: string): number {
  return (t.db.prepare('SELECT COUNT(*) AS n FROM message WHERE session_id = ?').get(sessionId) as { n: number }).n;
}

function sessionRow(sessionId: string): unknown {
  return t.db.prepare('SELECT * FROM session WHERE id = ?').get(sessionId);
}

function issueRow(issueId: string): Record<string, unknown> {
  return t.db.prepare('SELECT * FROM issue WHERE id = ?').get(issueId) as Record<string, unknown>;
}

describe('DELETE /api/sessions/:id', () => {
  it('成功删除自由会话：204 无 body，message 与 session 行全删并广播 session.deleted，列表剔除该 id', async () => {
    const wsId = await mkSpace();
    const created0 = await request(app)
      .post('/api/sessions')
      .send({ cli: 'codebuddy', workspace_id: wsId, prompt: '问一句' });
    expect(created0.status).toBe(200);
    const id = created0.body.id as string;
    await settle();
    expect(messageCount(id)).toBeGreaterThan(0);

    const spy = vi.spyOn(created.hub, 'broadcast');
    const res = await request(app).delete(`/api/sessions/${id}`);

    expect(res.status).toBe(204);
    expect(res.text).toBe('');
    const deletedEvents = spy.mock.calls
      .map(([event]) => event as WsEvent)
      .filter((event) => event.type === 'session.deleted');
    expect(deletedEvents).toEqual([{ type: 'session.deleted', session_id: id }]);
    expect(messageCount(id)).toBe(0);
    expect(sessionRow(id)).toBeUndefined();

    const list = await request(app).get(`/api/sessions?workspace=${wsId}`);
    expect(list.status).toBe(200);
    expect((list.body as Array<{ id: string }>).map((s) => s.id)).not.toContain(id);
  });

  it('重复删除已删会话：幂等 404（不 500，信封为既有 NOT_FOUND）', async () => {
    const wsId = await mkSpace();
    const created0 = await request(app).post('/api/sessions').send({ cli: 'codebuddy', workspace_id: wsId });
    const id = created0.body.id as string;
    expect((await request(app).delete(`/api/sessions/${id}`)).status).toBe(204);

    const again = await request(app).delete(`/api/sessions/${id}`);
    expect(again.status).toBe(404);
    expect(again.body.error).toMatchObject({ code: 'NOT_FOUND', message: '会话不存在' });
  });

  it('不存在的会话：404', async () => {
    const res = await request(app).delete('/api/sessions/00000000-0000-4000-8000-0000000000ff');
    expect(res.status).toBe(404);
    expect(res.body.error).toMatchObject({ code: 'NOT_FOUND', message: '会话不存在' });
  });

  it('运行中会话：409 拒绝，message 与 session 行都保留', async () => {
    adapter.script = () => undefined; // 挂起：轮次在途 → status 运行中
    const wsId = await mkSpace();
    const created0 = await request(app)
      .post('/api/sessions')
      .send({ cli: 'codebuddy', workspace_id: wsId, prompt: '长任务' });
    const id = created0.body.id as string;
    await settle();
    expect((await request(app).get(`/api/sessions/${id}`)).body.status).toBe('运行中');
    const before = messageCount(id);
    expect(before).toBeGreaterThan(0);

    const res = await request(app).delete(`/api/sessions/${id}`);
    expect(res.status).toBe(409);
    expect(res.body.error).toMatchObject({ code: 'CONFLICT', message: '会话正在运行，请先停止再删除' });
    expect(messageCount(id)).toBe(before);
    expect(sessionRow(id)).toBeDefined();
  });

  it('正占用任务的会话：409 拒绝，任务归属与消息均不变', async () => {
    adapter.script = () => undefined;
    const wsId = await mkSpace();
    const issue = await mkIssue(wsId, '实现登录');
    const dispatched = await request(app)
      .post('/api/sessions')
      .send({ cli: 'codebuddy', model: 'm1', issue_id: issue.id });
    expect(dispatched.status).toBe(200);
    const id = dispatched.body.id as string;
    await settle();
    // 先停止：status 转已结束但任务仍被该会话占用
    expect((await request(app).post(`/api/sessions/${id}/stop`)).status).toBe(200);
    const claimedBefore = issueRow(issue.id as string);
    expect(claimedBefore.claimed_by).toBe('codebuddy');
    expect(claimedBefore.session_id).toBe(id);
    const before = messageCount(id);

    const res = await request(app).delete(`/api/sessions/${id}`);
    expect(res.status).toBe(409);
    expect(res.body.error).toMatchObject({
      code: 'CONFLICT',
      message: '该会话正占用任务「实现登录」，请先标记待验收或释放占用后再删除',
    });
    const claimedAfter = issueRow(issue.id as string);
    expect(claimedAfter.claimed_by).toBe('codebuddy');
    expect(claimedAfter.session_id).toBe(id);
    expect(claimedAfter.status).toBe(claimedBefore.status);
    expect(messageCount(id)).toBe(before);
    expect(sessionRow(id)).toBeDefined();
  });
});
