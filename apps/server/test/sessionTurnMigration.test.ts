/**
 * CHAT-TURN1 验收 1：`session_turn` + `message` 三列的迁移在**老库上幂等**。
 *
 * 做法：先按 CHAT-TURN1 之前的 DDL 建一个真实的老库文件（无 session_turn、message 无三列）并写入数据，
 * 再重复执行 `initSchema`（服务每次启动都会跑），断言：
 * - 新表存在、3 个新列存在；
 * - 旧消息 `meta_json IS NULL`（不回填、不改写历史）；
 * - 重复执行不报错、不重复加列、数据条数与内容不变；
 * - 消息列表接口不受影响（老会话照常返回，三个新字段为 null）；
 * - 升级后的老库能正常写入轮次与新列（新链路可用）。
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import type { AgentAdapter } from '@agentboard/adapters';
import { openDb, type Db } from '../src/db/connection.js';
import { initSchema } from '../src/db/schema.js';
import { migrateSessionTurn } from '../src/db/migrations/sessionTurn.js';
import { createApp, type CreatedApp } from '../src/index.js';
import { resetSessionManager } from '../src/services/sessionManager.js';
import { FakeAdapter, settle } from './fakeAdapter.js';

/** CHAT-TURN1 之前的最小结构：message 只有 5 列，没有 session_turn 表 */
const LEGACY_DDL = `
CREATE TABLE workspace (id TEXT PRIMARY KEY, name TEXT NOT NULL, path TEXT NOT NULL UNIQUE, created_at INTEGER NOT NULL);
CREATE TABLE issue (
  id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
  title TEXT NOT NULL, description TEXT NOT NULL DEFAULT '',
  priority TEXT NOT NULL DEFAULT '中' CHECK (priority IN ('低','中','高')),
  labels TEXT NOT NULL DEFAULT '[]',
  status TEXT NOT NULL DEFAULT '待规划',
  sort_order INTEGER NOT NULL DEFAULT 0,
  claimed_by TEXT, claimed_at INTEGER, session_id TEXT, last_seen_comment_id TEXT,
  parent_issue_id TEXT REFERENCES issue(id) ON DELETE RESTRICT,
  due_date TEXT, due_time TEXT,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
CREATE TABLE issue_comment (
  id TEXT PRIMARY KEY, issue_id TEXT NOT NULL REFERENCES issue(id) ON DELETE CASCADE,
  author TEXT NOT NULL, content TEXT NOT NULL, ts INTEGER NOT NULL);
CREATE TABLE session (
  id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
  issue_id TEXT REFERENCES issue(id) ON DELETE SET NULL,
  cli TEXT NOT NULL, model TEXT, status TEXT NOT NULL DEFAULT '运行中'
    CHECK (status IN ('运行中','已结束','失败')),
  adapter_session_id TEXT, created_at INTEGER NOT NULL);
CREATE TABLE message (
  id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES session(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('user','assistant','event','error')),
  content TEXT NOT NULL, ts INTEGER NOT NULL);
`;

let dir: string;
let db: Db;

function columnNames(database: Db, table: string): string[] {
  return (database.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((c) => c.name);
}

const hasSessionTurn = (database: Db): boolean =>
  (database.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'session_turn'").get() as undefined | { name: string }) !== undefined;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'agentboard-turn-migration-'));
  db = openDb(join(dir, 'legacy.db'));
  db.exec(LEGACY_DDL);
  db.prepare('INSERT INTO workspace (id, name, path, created_at) VALUES (?,?,?,?)').run('w1', '老库', 'D:\\ws\\legacy', 1);
  db.prepare(
    'INSERT INTO session (id, workspace_id, cli, model, status, created_at) VALUES (?,?,?,?,?,?)',
  ).run('s1', 'w1', 'codex', null, '已结束', 1);
  // 历史消息：user + assistant + 一条工具 event（旧格式：内容里带 name/input，没有观测列）
  const rows: Array<[string, string, string, number]> = [
    ['m1', 'user', '老问题', 10],
    ['m2', 'assistant', '老回答', 11],
    ['m3', 'event', '{"name":"Grep","input":"legacy"}', 12],
  ];
  for (const [id, role, content, ts] of rows) {
    db.prepare('INSERT INTO message (id, session_id, role, content, ts) VALUES (?,?,?,?,?)').run(id, 's1', role, content, ts);
  }
  expect(hasSessionTurn(db)).toBe(false);
  expect(columnNames(db, 'message')).not.toContain('meta_json');
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('CHAT-TURN1 验收 1：老库迁移幂等', () => {
  it('initSchema 在老库上建出 session_turn 与 message 三列', () => {
    initSchema(db);

    expect(hasSessionTurn(db)).toBe(true);
    const columns = columnNames(db, 'message');
    expect(columns).toContain('turn_id');
    expect(columns).toContain('step_id');
    expect(columns).toContain('meta_json');
    // 老库既有的 AUDIT-SRV 列不被重建带走
    expect(columns).toContain('error_code');
    expect(columns).toContain('retryable');
  });

  it('迁移可重复执行：第二次不报错、不重复加列、历史数据原样保留', () => {
    initSchema(db);
    const afterFirst = {
      messages: (db.prepare('SELECT COUNT(*) AS n FROM message').get() as { n: number }).n,
      columns: columnNames(db, 'message'),
      turns: (db.prepare('SELECT COUNT(*) AS n FROM session_turn').get() as { n: number }).n,
    };

    // 再各跑一轮：initSchema 与裸迁移都必须收敛到同一结构
    initSchema(db);
    migrateSessionTurn(db);
    migrateSessionTurn(db);

    expect(columnNames(db, 'message')).toEqual(afterFirst.columns);
    expect((db.prepare('SELECT COUNT(*) AS n FROM message').get() as { n: number }).n).toBe(afterFirst.messages);
    expect((db.prepare('SELECT COUNT(*) AS n FROM session_turn').get() as { n: number }).n).toBe(afterFirst.turns);
    expect(db.prepare('SELECT COUNT(*) AS n FROM message WHERE meta_json IS NOT NULL OR turn_id IS NOT NULL OR step_id IS NOT NULL').get()).toEqual({ n: 0 });
  });

  it('旧消息 meta_json IS NULL（不回填），内容与角色不变', () => {
    initSchema(db);
    initSchema(db);

    const legacy = db.prepare('SELECT id, role, content, turn_id, step_id, meta_json FROM message ORDER BY ts').all() as Array<{
      id: string; role: string; content: string; turn_id: string | null; step_id: string | null; meta_json: string | null;
    }>;
    expect(legacy.map((row) => row.id)).toEqual(['m1', 'm2', 'm3']);
    for (const row of legacy) {
      expect(row.turn_id).toBeNull();
      expect(row.step_id).toBeNull();
      expect(row.meta_json).toBeNull();
    }
    expect(legacy[2]!.content).toBe('{"name":"Grep","input":"legacy"}');
  });

  it('历史会话没有 turn 行（不回填旧轮次）', () => {
    initSchema(db);
    expect((db.prepare('SELECT COUNT(*) AS n FROM session_turn').get() as { n: number }).n).toBe(0);
  });
});

describe('CHAT-TURN1 验收 1：迁移后接口与新链路', () => {
  let created: CreatedApp;
  let app: Express;
  let adapter: FakeAdapter;

  beforeEach(async () => {
    initSchema(db);
    initSchema(db); // 两次：模拟服务重复重启
    adapter = new FakeAdapter();
    execFileSync('git', ['init', '-q'], { cwd: dir, windowsHide: true });
    created = await createApp({
      db,
      getAdapter: (id: string): AgentAdapter => {
        if (id === 'fake' || id === 'codex') return adapter;
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
  });

  it('消息列表接口不受影响：老消息照常返回，三个新字段为 null', async () => {
    const res = await request(app).get('/api/sessions/s1/messages').expect(200);
    expect(res.body).toHaveLength(3);
    expect(res.body.map((m: { id: string }) => m.id)).toEqual(['m1', 'm2', 'm3']);
    for (const message of res.body) {
      expect(message.turn_id).toBeNull();
      expect(message.step_id).toBeNull();
      expect(message.meta_json).toBeNull();
    }
    // 既有的 after 增量参数语义不变
    const incremental = await request(app).get('/api/sessions/s1/messages?after=11').expect(200);
    expect(incremental.body.map((m: { id: string }) => m.id)).toEqual(['m3']);
  });

  it('老库升级后新轮次链路可用：跑一轮写入 session_turn 并挂上 turn_id', async () => {
    adapter.script = (control) => {
      control.emit({ type: 'tool', name: 'Grep', input: 'legacy' });
      control.emit({ type: 'text', delta: '升级后的回复' });
      control.finish(0);
    };
    const postRes = await request(app)
      .post('/api/sessions')
      .send({ workspace_id: 'w1', cli: 'codex', prompt: '老库上的新一轮' })
      .expect(200);
    const sessionId = postRes.body.id as string;
    await settle();

    const turns = db.prepare('SELECT * FROM session_turn WHERE session_id = ?').all(sessionId) as Array<{
      id: string; state: string; seq: number; plan_json: string | null; usage_json: string | null;
    }>;
    expect(turns).toHaveLength(1);
    expect(turns[0]!.state).toBe('done');
    expect(turns[0]!.seq).toBe(1);
    expect(JSON.parse(turns[0]!.plan_json!)).toEqual([{ step_id: 's1', title: 'Grep', state: 'done' }]);
    expect(JSON.parse(turns[0]!.usage_json!).estimated).toBe(true);

    const messages = await request(app).get(`/api/sessions/${sessionId}/messages`).expect(200);
    const toolMessage = messages.body.find((m: { step_id: string | null }) => m.step_id !== null);
    expect(toolMessage.turn_id).toBe(turns[0]!.id);
    expect(toolMessage.meta_json.tool_call_id).toBe('s1');
    // 老会话的数据没有被新链路动过
    const legacy = await request(app).get('/api/sessions/s1/messages').expect(200);
    expect(legacy.body).toHaveLength(3);
  });

  it('老会话删除时轮次行随 FK 级联清理（不留孤儿观测）', async () => {
    adapter.script = (control) => control.finish(0);
    const postRes = await request(app)
      .post('/api/sessions')
      .send({ workspace_id: 'w1', cli: 'codex', prompt: '将被删除的会话' })
      .expect(200);
    const sessionId = postRes.body.id as string;
    await settle();
    expect((db.prepare('SELECT COUNT(*) AS n FROM session_turn WHERE session_id = ?').get(sessionId) as { n: number }).n).toBe(1);

    await request(app).delete(`/api/sessions/${sessionId}`).expect(204);
    expect((db.prepare('SELECT COUNT(*) AS n FROM session_turn WHERE session_id = ?').get(sessionId) as { n: number }).n).toBe(0);
  });
});
