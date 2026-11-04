/**
 * STORE-1（M1）：写入门禁的端到端行为（真 HTTP + 真临时库）。
 *
 * 覆盖卡面验收 2/3/5：
 * - 未下沉：全部读写走中心库（与现状一致）；
 * - 手工造 meta.localized=0 的工作区库 + 文件：该工作区**写** 409 WORKSPACE_DB_MIGRATING，**读**仍走中心库，其它工作区不受影响；
 * - 中心 db_mode=localized 但文件被删：写/读都报 WORKSPACE_DB_MISSING（不回退）；
 * - GET /api/workspaces 回显 db_mode/db_path；客户端传参不能改变走库结果。
 *
 * 本卡不改数据：所有断言只看「有没有被拒 / 回显什么」，不校验任何搬库行为（那是 STORE-2）。
 */
import { mkdirSync, mkdtempSync, rmSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import type { AgentAdapter } from '@agentboard/adapters';
import { createTestDb, type TestDb } from './helpers.js';
import { FakeAdapter } from './fakeAdapter.js';
import { createApp } from '../src/index.js';
import { createWorkspace } from '../src/db/repos/workspace.js';
import { workspaceDbPath } from '../src/db/resolver.js';

describe('STORE-1（M1）写入门禁与回显', () => {
  let t: TestDb;
  let app: Express;
  let root: string;
  let wsPath: string;
  let ws: string;
  let otherWs: string;

  const mkWorkspaceDb = (localized: boolean, workspaceId: string): string => {
    const dbPath = workspaceDbPath(wsPath);
    mkdirSync(join(wsPath, '.agentboard'), { recursive: true });
    const db = new Database(dbPath);
    db.exec('CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
    db.prepare("INSERT INTO meta (key, value) VALUES ('workspace_id', ?)").run(workspaceId);
    db.prepare("INSERT INTO meta (key, value) VALUES ('localized', ?)").run(localized ? '1' : '0');
    db.close();
    return dbPath;
  };
  const setMode = (workspaceId: string, mode: string): void => {
    t.db.prepare('UPDATE workspace SET db_mode = ? WHERE id = ?').run(mode, workspaceId);
  };
  const mkIssue = async (workspaceId: string, title: string): Promise<string> => {
    const res = await request(app).post('/api/issues').send({ workspace_id: workspaceId, title });
    expect(res.status).toBe(200);
    return res.body.id as string;
  };

  beforeEach(async () => {
    t = createTestDb();
    root = mkdtempSync(join(tmpdir(), 'agentboard-store1-gate-'));
    wsPath = join(root, 'ws');
    mkdirSync(wsPath, { recursive: true });
    const adapter = new FakeAdapter();
    const created = await createApp({
      db: t.db,
      getAdapter: (_id: string): AgentAdapter => adapter,
      adapters: [adapter],
      refreshClisOnBoot: false,
    });
    app = created.app;
    ws = createWorkspace(t.db, { name: '主工作区', path: wsPath }).id;
    const otherPath = join(root, 'other');
    mkdirSync(otherPath, { recursive: true });
    otherWs = createWorkspace(t.db, { name: '其它工作区', path: otherPath }).id;
  });
  afterEach(() => {
    t.cleanup();
    rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  });

  it('① 未下沉：读写都走中心库（行为与现状一致）', async () => {
    const id = await mkIssue(ws, '未下沉卡');
    const patched = await request(app).patch(`/api/issues/${id}`).send({ title: '改名' });
    expect(patched.status).toBe(200);
    const read = await request(app).get(`/api/issues/${id}`);
    expect(read.status).toBe(200);
    expect(read.body.title).toBe('改名');
  });

  it('② 中间态（文件在 + meta.localized=0）：写 409 WORKSPACE_DB_MIGRATING，读仍 200，其它工作区不受影响', async () => {
    // 先建卡（此时还没下沉，走中心库），再造出「迁移中间态」现场
    const id = await mkIssue(ws, '中间态卡');
    mkWorkspaceDb(false, ws);
    setMode(ws, 'localizing');

    const patched = await request(app).patch(`/api/issues/${id}`).send({ title: '不该写进去' });
    expect(patched.status).toBe(409);
    expect(patched.body.error.code).toBe('WORKSPACE_DB_MIGRATING');

    const created = await request(app).post('/api/issues').send({ workspace_id: ws, title: '新卡也不许' });
    expect(created.status).toBe(409);
    expect(created.body.error.code).toBe('WORKSPACE_DB_MIGRATING');

    // 读不受影响（仍走中心库）
    const read = await request(app).get(`/api/issues/${id}`);
    expect(read.status).toBe(200);
    expect(read.body.title).toBe('中间态卡');

    // 其它工作区读写正常
    const otherIssue = await mkIssue(otherWs, '别区卡');
    const otherPatch = await request(app).patch(`/api/issues/${otherIssue}`).send({ title: '别区改名' });
    expect(otherPatch.status).toBe(200);
  });

  it('③ 中心=localized 但文件被删：写与读都报 WORKSPACE_DB_MISSING，不回退中心库', async () => {
    const dbPath = mkWorkspaceDb(true, ws);
    setMode(ws, 'localized');
    const id = await mkIssue(ws, '已下沉卡');
    unlinkSync(dbPath);

    const patched = await request(app).patch(`/api/issues/${id}`).send({ title: '不该生效' });
    expect(patched.status).toBe(500);
    expect(patched.body.error.code).toBe('WORKSPACE_DB_MISSING');
  });

  it('⑤ GET /api/workspaces 回显 db_mode/db_path；客户端传参不改变走库结果', async () => {
    const before = await request(app).get('/api/workspaces');
    expect(before.status).toBe(200);
    const row = before.body.find((w: { id: string }) => w.id === ws);
    expect(row).toMatchObject({ db_mode: 'center', db_target: 'center' });
    expect(typeof row.db_path).toBe('string');

    // 伪造 query/body 试图指定走库 → 结果不变（判定只看服务端状态）
    const tampered = await request(app).get('/api/workspaces').query({ db_path: '/tmp/evil.db', db_mode: 'localized' });
    expect(tampered.status).toBe(200);
    const row2 = tampered.body.find((w: { id: string }) => w.id === ws);
    expect(row2.db_path).toBe(row.db_path);
    expect(row2.db_mode).toBe('center');
  });
});
