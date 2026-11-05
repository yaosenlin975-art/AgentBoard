/**
 * BORROW-4.3：会话暂停 / 恢复。
 *
 * 覆盖：paused_at 幂等加列（老库补列、连跑两次一致、存量行不丢）；暂停不 kill 在途工具、
 * 轮次跑完不自动起新轮；暂停期入站消息落库并入队、恢复后按序交付；恢复不重放已完成步骤
 * （resume_after_seq 之后只有新事件）；PATCH 端点真实挂载（createApp 后非 404）。
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import type { AgentAdapter } from '@agentboard/adapters';
import type { ServerWsEvent } from '@agentboard/shared';
import { createTestDb, type TestDb } from './helpers.js';
import { FakeAdapter, settle, type FakeTurnControl } from './fakeAdapter.js';
import { createApp, type CreatedApp } from '../src/index.js';
import { openDb } from '../src/db/connection.js';
import { initSchema } from '../src/db/schema.js';
import { createWorkspace } from '../src/db/repos/workspace.js';
import { getSession as getSessionRow } from '../src/db/repos/session.js';
import { listSessionEvents } from '../src/db/repos/sessionEvent.js';
import { listMessagesBySession } from '../src/db/repos/message.js';
import {
  createSession,
  getSessionRuntime,
  initSessionManager,
  pauseSession,
  resetSessionManager,
  resumeSession,
  sendToSession,
  setBroadcaster,
} from '../src/services/sessionManager.js';

let t: TestDb;
let adapter: FakeAdapter;
let created: CreatedApp;
let app: Express;
let wsId: string;
/** 被脚本挂起的在途轮次（用于断言暂停不 kill） */
let held: FakeTurnControl[];

function fakeResolver(id: string): AgentAdapter {
  if (id === adapter.id) return adapter;
  throw new Error(`未知适配器 id: ${id}`);
}

beforeEach(async () => {
  t = createTestDb();
  wsId = createWorkspace(t.db, { name: 'ws', path: 'D:\\ws\\pause' }).id;
  adapter = new FakeAdapter();
  held = [];
  initSessionManager(t.db, fakeResolver, { maxConcurrentTurns: 3 });
  created = await createApp({ db: t.db, getAdapter: fakeResolver, adapters: [adapter] });
  app = created.app;
});

afterEach(() => {
  resetSessionManager();
  t.cleanup();
});

describe('迁移 sessionPaused（幂等加列，不重建表）', () => {
  it('老库自动补 paused_at、连跑两次结果一致、存量会话行不丢', () => {
    const dir = mkdtempSync(join(tmpdir(), 'agentboard-pause-migrate-'));
    const legacy = openDb(join(dir, 'legacy.db'));
    try {
      // 模拟 paused_at 上线前的老库：手建旧版 session 表（无 paused_at）
      legacy.exec(`CREATE TABLE session (
        id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, issue_id TEXT,
        cli TEXT NOT NULL, model TEXT, status TEXT NOT NULL DEFAULT '运行中',
        adapter_session_id TEXT, created_at INTEGER NOT NULL, title TEXT,
        archived_at INTEGER, forked_from_session_id TEXT, fork_message_id TEXT
      )`);
      legacy
        .prepare("INSERT INTO session (id, workspace_id, cli, created_at, status) VALUES ('s1', 'w1', 'codebuddy', 1, '已结束')")
        .run();

      initSchema(legacy);
      initSchema(legacy); // 幂等重入

      const columns = legacy.prepare('PRAGMA table_info(session)').all() as Array<{ name: string }>;
      expect(columns.filter((column) => column.name === 'paused_at')).toHaveLength(1);
      expect(legacy.prepare('SELECT id, status, paused_at FROM session WHERE id = ?').get('s1'))
        .toEqual({ id: 's1', status: '已结束', paused_at: null });
    } finally {
      legacy.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('sessionManager 暂停 / 恢复', () => {
  it('暂停不 kill 在途工具、轮次跑完不起新轮；暂停期消息入队不丢，恢复后按序交付', async () => {
    adapter.script = (control) => {
      held.push(control);
    };
    const session = await createSession({ cli: adapter.id, workspace_id: wsId, prompt: '第一轮' });
    await settle();
    expect(held).toHaveLength(1);

    const paused = await pauseSession(session.id);
    expect(paused.paused_at).toBeTypeOf('number');
    expect(paused.status).toBe('运行中'); // 暂停不改 status 语义
    expect(held[0]!.killed).toBe(false); // 不 kill 在途工具

    // 暂停后在途轮次照常产出工具步骤与文本（不被阻断、不撤销）
    held[0]!.emit({ type: 'tool', name: 'kb.show', input: '{"id":"x"}' });
    held[0]!.emit({ type: 'text', delta: '暂停后仍在跑的步骤' });
    held[0]!.finish(0, 'as-0');
    await settle();

    let row = getSessionRow(t.db, session.id)!;
    expect(row.status).toBe('已结束');
    expect(row.paused_at).toBeTypeOf('number');
    expect(
      listMessagesBySession(t.db, session.id)
        .some((message) => message.role === 'assistant' && message.content.includes('暂停后仍在跑的步骤')),
    ).toBe(true);
    expect(adapter.calls).toHaveLength(1); // 暂停中不自动起下一轮

    // 暂停期两条消息：落 user 行 + 入队，不静默丢弃
    expect(await sendToSession(session.id, '暂停期一')).toEqual({ queued: true });
    expect(await sendToSession(session.id, '暂停期二')).toEqual({ queued: true });
    expect(adapter.calls).toHaveLength(1);
    expect(getSessionRuntime(session.id).queuedCount).toBe(2);
    const userTexts = listMessagesBySession(t.db, session.id)
      .filter((message) => message.role === 'user')
      .map((message) => message.content);
    expect(userTexts).toEqual(['第一轮', '暂停期一', '暂停期二']);

    await resumeSession(session.id);
    await settle();
    expect(adapter.calls).toHaveLength(2);
    expect(adapter.calls[1]!.prompt).toBe('暂停期一\n\n暂停期二');
    row = getSessionRow(t.db, session.id)!;
    expect(row.paused_at).toBeNull();
    expect(row.status).toBe('运行中');
    expect(getSessionRuntime(session.id).queuedCount).toBe(0);
  });

  it('恢复不重放已完成步骤：resume_after_seq 之后只有新事件，旧消息不重复、seq 连续', async () => {
    const session = await createSession({ cli: adapter.id, workspace_id: wsId, prompt: '已完成的第一轮' });
    await settle();
    expect(adapter.calls).toHaveLength(1);

    await pauseSession(session.id);
    expect(await sendToSession(session.id, '暂停期消息')).toEqual({ queued: true });

    const beforeResume = listSessionEvents(t.db, session.id);
    expect(beforeResume.map((event) => event.type)).toEqual([
      'message.added',
      'message.added',
      'session.paused',
      'message.added',
    ]);
    const oldMessageIds = new Set(
      beforeResume
        .filter((event) => event.type === 'message.added')
        .map((event) => (event.payload as { id: string }).id),
    );

    const resumed = await resumeSession(session.id);
    expect(resumed.resume_after_seq).toBe(beforeResume.at(-1)!.seq + 1); // 锚点 = 恢复事件自身 seq
    await settle();
    expect(adapter.calls).toHaveLength(2);
    expect(adapter.calls[1]!.prompt).toBe('暂停期消息');

    // after_seq 续拉：只有恢复事件之后的新轮次事件，不含暂停/恢复标记、不重放旧消息
    const after = listSessionEvents(t.db, session.id, resumed.resume_after_seq);
    expect(after.length).toBeGreaterThan(0);
    expect(after.every((event) => event.seq > resumed.resume_after_seq)).toBe(true);
    expect(after.some((event) => event.type === 'session.paused' || event.type === 'session.resumed')).toBe(false);
    expect(
      after.some(
        (event) => event.type === 'message.added' && oldMessageIds.has((event.payload as { id: string }).id),
      ),
    ).toBe(false);

    // 不重写、不跳号：全量 seq 仍为 1..n
    const all = listSessionEvents(t.db, session.id);
    expect(all.map((event) => event.seq)).toEqual(all.map((_, index) => index + 1));
  });

  it('重复暂停 / 未暂停时恢复都是幂等空操作（不重复写事件）', async () => {
    const session = await createSession({ cli: adapter.id, workspace_id: wsId });
    await pauseSession(session.id);
    await pauseSession(session.id);
    const pausedEvents = listSessionEvents(t.db, session.id).filter((event) => event.type === 'session.paused');
    expect(pausedEvents).toHaveLength(1);

    await resumeSession(session.id);
    const firstSeq = listSessionEvents(t.db, session.id).at(-1)!.seq;
    const again = await resumeSession(session.id);
    expect(again.resume_after_seq).toBe(firstSeq);
    expect(listSessionEvents(t.db, session.id).filter((event) => event.type === 'session.resumed')).toHaveLength(1);
  });
});

describe('PATCH /api/sessions/:id 暂停 / 恢复接线（createApp 真实挂载）', () => {
  it('暂停与恢复端点非 404；读接口返回派生 paused；WS 各推一条事件；非法组合 400', async () => {
    const session = await createSession({ cli: adapter.id, workspace_id: wsId });
    const events: ServerWsEvent[] = [];
    setBroadcaster((event) => {
      events.push(event);
    });

    const paused = await request(app).patch(`/api/sessions/${session.id}`).send({ paused: true });
    expect(paused.status).toBe(200);
    expect(paused.body.paused).toBe(true);
    expect(paused.body.paused_at).toBeTypeOf('number');
    expect(paused.body.status).toBe('已结束'); // status 语义不变

    const detail = await request(app).get(`/api/sessions/${session.id}`);
    expect(detail.status).toBe(200);
    expect(detail.body.paused).toBe(true);

    const list = await request(app).get('/api/sessions').query({ workspace: wsId });
    expect(list.status).toBe(200);
    expect((list.body as Array<{ id: string; paused: boolean }>).find((item) => item.id === session.id)!.paused)
      .toBe(true);

    const resumed = await request(app).patch(`/api/sessions/${session.id}`).send({ paused: false });
    expect(resumed.status).toBe(200);
    expect(resumed.body.paused).toBe(false);
    expect(typeof resumed.body.resume_after_seq).toBe('number');

    // 暂停/恢复各一条控制事件；persistSessionPatch 的 session.changed 是既有的通用快照事件，忽略之
    expect(
      events
        .map((event) => event.type)
        .filter((type) => type === 'session.paused' || type === 'session.resumed'),
    ).toEqual(['session.paused', 'session.resumed']);

    const mixed = await request(app).patch(`/api/sessions/${session.id}`).send({ paused: true, title: 'x' });
    expect(mixed.status).toBe(400);

    const missing = await request(app)
      .patch('/api/sessions/00000000-0000-4000-8000-000000000000')
      .send({ paused: true });
    expect(missing.status).toBe(404);
  });
});
