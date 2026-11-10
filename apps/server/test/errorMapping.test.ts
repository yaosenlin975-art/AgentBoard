import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import express from 'express';
import request from 'supertest';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createTestDb, issuePayload, type TestDb } from './helpers.js';
import { errorHandler } from '../src/api/routes.js';
import { ApiError } from '../src/errors.js';
import { createApp } from '../src/index.js';
import { createWorkspace } from '../src/db/repos/workspace.js';

/**
 * CR-7：仓储层漏出的 SQLite 约束 / 只读错误必须在 errorHandler 被映射，
 * 不能一律塌成 500 INTERNAL（否则 CLI/MCP/前端无法区分参数错误与服务故障）。
 * 用例拿真实 better-sqlite3 错误对象打真实 express + errorHandler，不手写伪造 code。
 */
function probeApp(makeError: () => unknown): express.Express {
  const app = express();
  app.get('/api/probe', (_req, _res, next) => { next(makeError()); });
  app.use(errorHandler);
  return app;
}

function captureError(fn: () => void): Error & { code?: string } {
  try {
    fn();
  } catch (error) {
    return error as Error & { code?: string };
  }
  throw new Error('预期抛错，实际没有');
}

/** 注入：让匹配到的 SQL 在仓储层抛出给定错误，用于走真实路由 → 仓储 → errorHandler 全链路 */
function injectStatementError(db: TestDb['db'], sqlPattern: RegExp, error: unknown): void {
  const original = db.prepare.bind(db);
  vi.spyOn(db, 'prepare').mockImplementation(((sql: string) => {
    if (sqlPattern.test(sql)) {
      const fail = (): never => { throw error; };
      return { run: fail, get: fail, all: fail } as never;
    }
    return original(sql);
  }) as typeof db.prepare);
}

/** 真实 CHECK 错误：用同库临时表造一次违例并捕获 better-sqlite3 抛出的原对象 */
function realCheckError(db: TestDb['db']): Error & { code?: string } {
  db.exec('CREATE TABLE IF NOT EXISTS cr7_probe_check (v INTEGER NOT NULL CHECK (v > 0))');
  const err = captureError(() => { db.prepare('INSERT INTO cr7_probe_check (v) VALUES (?)').run(0); });
  db.exec('DROP TABLE cr7_probe_check');
  return err;
}

let t: TestDb | null = null;
let tempDir: string | null = null;
let spaceDir: string | null = null;

afterEach(() => {
  vi.restoreAllMocks();
  t?.cleanup();
  t = null;
  for (const dir of [tempDir, spaceDir]) {
    if (dir !== null) rmSync(dir, { recursive: true, force: true });
  }
  tempDir = null;
  spaceDir = null;
});

describe('CR-7 SQLite 错误映射', () => {
  it('CHECK 违例 → 400 CONSTRAINT_VIOLATION，只回约束类别、不回 SQL 原文', async () => {
    t = createTestDb();
    t.db.exec('CREATE TABLE cr7_check (v INTEGER NOT NULL CHECK (v > 0))');
    const err = captureError(() => { t!.db.prepare('INSERT INTO cr7_check (v) VALUES (?)').run(0); });
    expect(err.code).toBe('SQLITE_CONSTRAINT_CHECK');
    expect(err.message).toContain('CHECK constraint failed');

    const res = await request(probeApp(() => err)).get('/api/probe');

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('CONSTRAINT_VIOLATION');
    expect(res.body.error.message).toContain('CHECK');
    // 不能把 better-sqlite3 的原始文案 / SQL 语句回显给调用方
    expect(res.body.error.message).not.toContain('constraint failed');
    expect(res.body.error.message).not.toContain('INSERT INTO');
  });

  it('UNIQUE 违例 → 400 CONSTRAINT_VIOLATION（扩展码按前缀归并）', async () => {
    t = createTestDb();
    t.db.exec('CREATE TABLE cr7_unique (v INTEGER UNIQUE)');
    t.db.prepare('INSERT INTO cr7_unique (v) VALUES (?)').run(1);
    const err = captureError(() => { t!.db.prepare('INSERT INTO cr7_unique (v) VALUES (?)').run(1); });
    expect(err.code).toBe('SQLITE_CONSTRAINT_UNIQUE');

    const res = await request(probeApp(() => err)).get('/api/probe');

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('CONSTRAINT_VIOLATION');
    expect(res.body.error.message).toContain('UNIQUE');
  });

  it('SQLITE_CONSTRAINT_TRIGGER：未知 RAISE 消息仍保持 500 INTERNAL', async () => {
    t = createTestDb();
    t.db.exec('CREATE TABLE cr7_trigger (v INTEGER)');
    t.db.exec("CREATE TRIGGER cr7_abort BEFORE INSERT ON cr7_trigger BEGIN SELECT RAISE(ABORT, 'test rollback'); END;");
    const err = captureError(() => { t!.db.prepare('INSERT INTO cr7_trigger (v) VALUES (?)').run(1); });
    expect(err.code).toBe('SQLITE_CONSTRAINT_TRIGGER');

    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const res = await request(probeApp(() => err)).get('/api/probe');
      expect(res.status).toBe(500);
      expect(res.body.error.code).toBe('INTERNAL');
    } finally {
      spy.mockRestore();
    }
  });

  it('TRIGGER 跨工作区拒绝 → 400 WORKSPACE_MISMATCH（CR3-04）', async () => {
    t = createTestDb();
    t.db.exec('CREATE TABLE cr3_ws (v INTEGER)');
    t.db.exec("CREATE TRIGGER cr3_ws_abort BEFORE INSERT ON cr3_ws BEGIN SELECT RAISE(ABORT, 'issue parent workspace mismatch'); END;");
    const err = captureError(() => { t!.db.prepare('INSERT INTO cr3_ws (v) VALUES (?)').run(1); });

    const res = await request(probeApp(() => err)).get('/api/probe');

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('WORKSPACE_MISMATCH');
  });

  it('TRIGGER 成环拒绝 → 409 DEPENDENCY_CYCLE（CR3-04）', async () => {
    t = createTestDb();
    t.db.exec('CREATE TABLE cr3_cycle (v INTEGER)');
    t.db.exec("CREATE TRIGGER cr3_cycle_abort BEFORE INSERT ON cr3_cycle BEGIN SELECT RAISE(ABORT, 'issue dependency cycle'); END;");
    const err = captureError(() => { t!.db.prepare('INSERT INTO cr3_cycle (v) VALUES (?)').run(1); });

    const res = await request(probeApp(() => err)).get('/api/probe');

    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('DEPENDENCY_CYCLE');
  });

  it('TRIGGER 知识历史不可变 → 保持 500（服务端不变量，不是调用方错误）', async () => {
    t = createTestDb();
    t.db.exec('CREATE TABLE cr3_kb (v INTEGER)');
    t.db.exec("CREATE TRIGGER cr3_kb_abort BEFORE INSERT ON cr3_kb BEGIN SELECT RAISE(ABORT, 'Knowledge history is immutable'); END;");
    const err = captureError(() => { t!.db.prepare('INSERT INTO cr3_kb (v) VALUES (?)').run(1); });

    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const res = await request(probeApp(() => err)).get('/api/probe');
      expect(res.status).toBe(500);
      expect(res.body.error.code).toBe('INTERNAL');
    } finally {
      spy.mockRestore();
    }
  });

  it('只读库写入 → 503 DB_READONLY', async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'agentboard-cr7-ro-'));
    const file = join(tempDir, 'ro.db');
    const rw = new Database(file);
    rw.exec('CREATE TABLE cr7_ro (v INTEGER)');
    rw.close();
    const ro = new Database(file, { readonly: true });
    const err = captureError(() => { ro.prepare('INSERT INTO cr7_ro (v) VALUES (?)').run(1); });
    ro.close();
    expect(err.code).toBe('SQLITE_READONLY');

    const res = await request(probeApp(() => err)).get('/api/probe');

    expect(res.status).toBe(503);
    expect(res.body.error.code).toBe('DB_READONLY');
  });

  it('真实 createApp：POST /api/issues 命中 CHECK 违例 → 400 CONSTRAINT_VIOLATION', async () => {
    t = createTestDb();
    spaceDir = mkdtempSync(join(tmpdir(), 'agentboard-cr7-space-'));
    const ws = createWorkspace(t.db, { name: 'cr7', path: spaceDir });
    const app = (await createApp({ db: t.db, refreshClisOnBoot: false })).app;
    injectStatementError(t.db, /INSERT INTO issue\s*\(/, realCheckError(t.db));

    const res = await request(app).post('/api/issues').send(issuePayload(ws.id, { title: '约束注入' }));

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('CONSTRAINT_VIOLATION');
    expect(res.body.error.message).toContain('CHECK');
  });

  it('真实 createApp：评论写入命中只读错误 → 503 DB_READONLY', async () => {
    t = createTestDb();
    spaceDir = mkdtempSync(join(tmpdir(), 'agentboard-cr7-space-'));
    const ws = createWorkspace(t.db, { name: 'cr7', path: spaceDir });
    const app = (await createApp({ db: t.db, refreshClisOnBoot: false })).app;
    const created = await request(app).post('/api/issues').send(issuePayload(ws.id, { title: '只读注入' }));
    expect(created.status).toBe(200);
    const readonly = Object.assign(new Error('attempt to write a readonly database'), { code: 'SQLITE_READONLY' });
    injectStatementError(t.db, /INSERT INTO issue_comment/, readonly);

    const res = await request(app)
      .post(`/api/issues/${created.body.id as string}/comments`)
      .send({ workspace_id: ws.id, content: '只读库上写评论' });

    expect(res.status).toBe(503);
    expect(res.body.error.code).toBe('DB_READONLY');
  });

  it('既有映射不回归：ApiError / SQLITE_BUSY / 未知错误', async () => {
    const apiErr = new ApiError(409, 'SNAPSHOT_MISSING', '缺少恢复依据快照，无法回滚');
    const apiRes = await request(probeApp(() => apiErr)).get('/api/probe');
    expect(apiRes.status).toBe(409);
    expect(apiRes.body.error.code).toBe('SNAPSHOT_MISSING');

    const busy = Object.assign(new Error('database is locked'), { code: 'SQLITE_BUSY' });
    const busyRes = await request(probeApp(() => busy)).get('/api/probe');
    expect(busyRes.status).toBe(409);
    expect(busyRes.body.error.code).toBe('DB_BUSY');

    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const unknownRes = await request(probeApp(() => new Error('boom'))).get('/api/probe');
      expect(unknownRes.status).toBe(500);
      expect(unknownRes.body.error.code).toBe('INTERNAL');
    } finally {
      spy.mockRestore();
    }
  });
});
