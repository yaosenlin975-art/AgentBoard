/**
 * BORROW-4.2：session_event 双写与事件查询。
 *
 * 覆盖：迁移可重入、seq 单调递增与 after_seq 翻页不重不漏、老会话空列表、
 * 事件与消息写入顺序一致、端点真实挂载（createApp 后非 404）。
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import type { AgentAdapter } from '@agentboard/adapters';
import { createTestDb, type TestDb } from './helpers.js';
import { FakeAdapter, settle } from './fakeAdapter.js';
import { createApp, type CreatedApp } from '../src/index.js';
import { initSchema } from '../src/db/schema.js';
import { createWorkspace } from '../src/db/repos/workspace.js';
import { createSession as createSessionRow } from '../src/db/repos/session.js';
import { appendSessionEvent, listSessionEvents } from '../src/db/repos/sessionEvent.js';
import { listMessagesBySession } from '../src/db/repos/message.js';
import {
  createSession,
  initSessionManager,
  resetSessionManager,
  sendToSession,
} from '../src/services/sessionManager.js';

let t: TestDb;
let adapter: FakeAdapter;
let created: CreatedApp;
let app: Express;
let wsId: string;

function fakeResolver(id: string): AgentAdapter {
  if (id === 'fake') return adapter;
  throw new Error(`未知适配器 id: ${id}`);
}

beforeEach(async () => {
  t = createTestDb();
  wsId = createWorkspace(t.db, { name: 'ws', path: 'D:\\ws\\events' }).id;
  adapter = new FakeAdapter();
  initSessionManager(t.db, fakeResolver, { maxConcurrentTurns: 3 });
  created = await createApp({ db: t.db, getAdapter: fakeResolver, adapters: [adapter] });
  app = created.app;
  // 消息按 ts 排序；钉死单调时钟避免同毫秒内乱序
  let clock = 1_000_000;
  vi.spyOn(Date, 'now').mockImplementation(() => ++clock);
});

afterEach(() => {
  vi.restoreAllMocks();
  resetSessionManager();
  t.cleanup();
});

describe('迁移与仓储', () => {
  it('迁移可重入：initSchema 重复执行不报错', () => {
    expect(() => initSchema(t.db)).not.toThrow();
    expect(t.db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'session_event'").get())
      .toBeTruthy();
  });

  it('seq 按会话单调递增，after_seq 翻页稳定不重不漏', () => {
    const session = createSessionRow(t.db, { workspace_id: wsId, cli: 'fake' });
    const other = createSessionRow(t.db, { workspace_id: wsId, cli: 'fake' });
    for (let i = 1; i <= 5; i += 1) {
      appendSessionEvent(t.db, session.id, 'message.added', { i });
    }
    appendSessionEvent(t.db, other.id, 'message.added', { foreign: true });

    const all = listSessionEvents(t.db, session.id);
    expect(all.map((event) => event.seq)).toEqual([1, 2, 3, 4, 5]);
    expect(all.map((event) => event.payload)).toEqual([{ i: 1 }, { i: 2 }, { i: 3 }, { i: 4 }, { i: 5 }]);

    const page1 = listSessionEvents(t.db, session.id, 0);
    const page2 = listSessionEvents(t.db, session.id, 2);
    expect([...page1.slice(0, 2), ...page2].map((event) => event.seq)).toEqual([1, 2, 3, 4, 5]);
    expect(new Set([...page1, ...page2].map((event) => event.seq)).size).toBe(5);

    // 其他会话的事件不会串进来
    expect(listSessionEvents(t.db, other.id).map((event) => event.payload)).toEqual([{ foreign: true }]);
  });

  it('老会话没有事件时返回空数组，不报错', () => {
    const session = createSessionRow(t.db, { workspace_id: wsId, cli: 'fake' });
    expect(listSessionEvents(t.db, session.id)).toEqual([]);
  });
});

describe('sessionManager 双写', () => {
  it('事件与消息顺序一致：每条消息一条 message.added', async () => {
    await createSession({ cli: 'fake', workspace_id: wsId, prompt: '第一问' });
    await settle();

    const sessions = t.db.prepare('SELECT id FROM session').all() as Array<{ id: string }>;
    const last = sessions[sessions.length - 1]!;
    const messages = listMessagesBySession(t.db, last.id);
    const events = listSessionEvents(t.db, last.id);

    expect(messages.length).toBeGreaterThanOrEqual(2);
    expect(events.map((event) => event.seq)).toEqual(events.map((_, index) => index + 1));
    expect(events).toHaveLength(messages.length);
    expect(events.map((event) => event.type)).toEqual(messages.map(() => 'message.added'));
    expect(events.map((event) => (event.payload as { id: string }).id))
      .toEqual(messages.map((message) => message.id));

    // 继续第二轮：seq 接着涨，不回退
    await sendToSession(last.id, '第二问');
    await settle();
    const after = listSessionEvents(t.db, last.id, events.length);
    expect(after.length).toBeGreaterThan(0);
    expect(after[0]!.seq).toBe(events.length + 1);
  });
});

describe('GET /api/sessions/:id/events', () => {
  it('端点已接线：返回事件数组，支持 after_seq，会话不存在 404', async () => {
    const session = createSessionRow(t.db, { workspace_id: wsId, cli: 'fake' });
    appendSessionEvent(t.db, session.id, 'message.added', { n: 1 });
    appendSessionEvent(t.db, session.id, 'message.added', { n: 2 });

    const res = await request(app).get(`/api/sessions/${session.id}/events`);
    expect(res.status).toBe(200);
    expect(res.body.map((event: { seq: number }) => event.seq)).toEqual([1, 2]);

    const paged = await request(app).get(`/api/sessions/${session.id}/events?after_seq=1`);
    expect(paged.status).toBe(200);
    expect(paged.body.map((event: { seq: number }) => event.seq)).toEqual([2]);

    const empty = await request(app).get(`/api/sessions/${session.id}/events?after_seq=99`);
    expect(empty.status).toBe(200);
    expect(empty.body).toEqual([]);

    const missing = await request(app).get('/api/sessions/00000000-0000-4000-8000-000000000000/events');
    expect(missing.status).toBe(404);

    const bad = await request(app).get(`/api/sessions/${session.id}/events?after_seq=-1`);
    expect(bad.status).toBe(400);
  });
});
