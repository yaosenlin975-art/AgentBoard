/**
 * WS-REORDER：workspace.sort_order 迁移（幂等/回填/回滚）、两处查询排序口径对齐、
 * 批量 reorder（幂等键、集合冲突 409、LWW）。
 */
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import type { AgentAdapter } from '@agentboard/adapters';
import { createTestDb, type TestDb } from './helpers.js';
import { FakeAdapter } from './fakeAdapter.js';
import { createApp } from '../src/index.js';
import { openDb, type Db } from '../src/db/connection.js';
import { initSchema } from '../src/db/schema.js';
import { createWorkspace, listWorkspaces, listWorkspacesPage } from '../src/db/repos/workspace.js';

/** 迁移前的旧 workspace 表（无 sort_order） */
const LEGACY_DDL = `CREATE TABLE IF NOT EXISTS workspace (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, path TEXT NOT NULL UNIQUE, created_at INTEGER NOT NULL);`;

function legacyDb(dir: string, rows: Array<{ id: string; name: string; path: string; created_at: number }>): Db {
  const db = openDb(join(dir, 'legacy.db'));
  db.exec(LEGACY_DDL);
  const insert = db.prepare('INSERT INTO workspace (id, name, path, created_at) VALUES (?,?,?,?)');
  for (const row of rows) insert.run(row.id, row.name, row.path, row.created_at);
  return db;
}

function sortOrders(db: Db): Array<{ id: string; sort_order: number }> {
  return db.prepare('SELECT id, sort_order FROM workspace ORDER BY sort_order, created_at, id').all() as Array<{ id: string; sort_order: number }>;
}

describe('workspace order', () => {
  const dirs: string[] = [];
  let t: TestDb;
  let app: Express;
  let spaceDir: string;

  const makeDir = (): string => {
    const dir = mkdtempSync(join(tmpdir(), 'agentboard-wsorder-'));
    dirs.push(dir);
    return dir;
  };

  beforeEach(async () => {
    t = createTestDb();
    spaceDir = makeDir();
    const adapter = new FakeAdapter();
    const resolver = (id: string): AgentAdapter => {
      if (id === 'fake') return adapter;
      throw new Error(`未知适配器 id: ${id}`);
    };
    const created = await createApp({ db: t.db, getAdapter: resolver, adapters: [adapter], refreshClisOnBoot: false });
    app = created.app;
  });
  afterEach(() => {
    t.cleanup();
    rmSync(spaceDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  });

  const seed = (names: string[]): string[] => names.map(name => {
    const path = join(spaceDir, name);
    mkdirSync(path, { recursive: true });
    return createWorkspace(t.db, { name, path }).id;
  });

  it('migrationAddsSortOrderAndBackfillsByCreatedAt', () => {
    const dir = makeDir();
    const db = legacyDb(dir, [
      { id: 'ws-late', name: 'late', path: 'D:/late', created_at: 3000 },
      { id: 'ws-first', name: 'first', path: 'D:/first', created_at: 1000 },
      { id: 'ws-mid', name: 'mid', path: 'D:/mid', created_at: 2000 },
    ]);
    initSchema(db);
    const columns = (db.prepare('PRAGMA table_info(workspace)').all() as Array<{ name: string; notnull: number; dflt_value: string | null }>);
    const column = columns.find(item => item.name === 'sort_order');
    expect(column).toBeTruthy();
    expect(column!.notnull).toBe(1);
    expect(column!.dflt_value).toBe('0');
    expect(sortOrders(db)).toEqual([
      { id: 'ws-first', sort_order: 0 },
      { id: 'ws-mid', sort_order: 1 },
      { id: 'ws-late', sort_order: 2 },
    ]);
    db.close();
  });

  it('migrationIsIdempotent', () => {
    const dir = makeDir();
    const db = legacyDb(dir, [
      { id: 'a', name: 'a', path: 'D:/a', created_at: 1000 },
      { id: 'b', name: 'b', path: 'D:/b', created_at: 2000 },
    ]);
    initSchema(db);
    const afterFirst = sortOrders(db);
    db.prepare('UPDATE workspace SET sort_order=9 WHERE id=?').run('a');
    const moved = sortOrders(db);
    initSchema(db);
    initSchema(db);
    // 已存在列 → 整段跳过，不重新回填（用户顺序不被迁移覆盖）
    expect(sortOrders(db)).toEqual(moved);
    expect(afterFirst).not.toEqual(moved);
    db.close();
  });

  it('rollbackDropsSortOrderColumn', () => {
    const dir = makeDir();
    const db = legacyDb(dir, [{ id: 'a', name: 'a', path: 'D:/a', created_at: 1000 }]);
    initSchema(db);
    expect((db.prepare('PRAGMA table_info(workspace)').all() as Array<{ name: string }>).some(c => c.name === 'sort_order')).toBe(true);
    // 迁移文件里记录的回滚语句
    db.exec('ALTER TABLE workspace DROP COLUMN sort_order');
    expect((db.prepare('PRAGMA table_info(workspace)').all() as Array<{ name: string }>).some(c => c.name === 'sort_order')).toBe(false);
    initSchema(db);
    expect(sortOrders(db)).toEqual([{ id: 'a', sort_order: 0 }]);
    db.close();
  });

  it('getWorkspacesOrdersBySortOrderThenCreatedAt', () => {
    const ids = seed(['a', 'b', 'c']);
    t.db.prepare('UPDATE workspace SET sort_order=? WHERE id=?').run(5, ids[0]!);
    t.db.prepare('UPDATE workspace SET sort_order=? WHERE id=?').run(5, ids[1]!);
    t.db.prepare('UPDATE workspace SET sort_order=? WHERE id=?').run(1, ids[2]!);
    expect(listWorkspaces(t.db).map(ws => ws.id)).toEqual([ids[2]!, ids[0]!, ids[1]!]);
  });

  it('workspaceSchemaStructureIsStableAcrossFreshAndRepeatedBoot', () => {
    const structure = (db: Db): Array<{ type: string; name: string; sql: string | null }> =>
      db.prepare("SELECT type,name,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name").all() as Array<{ type: string; name: string; sql: string | null }>;
    const first = createTestDb();
    const second = createTestDb();
    const baseline = structure(first.db);
    initSchema(first.db);
    expect(structure(first.db)).toEqual(baseline);
    expect(structure(second.db)).toEqual(baseline);
    first.cleanup();
    second.cleanup();
  });

  it('listPathsShareSameOrder', () => {
    const ids = seed(['a', 'b', 'c', 'd', 'e']);
    t.db.prepare('UPDATE workspace SET sort_order=9 WHERE id=?').run(ids[0]!);
    t.db.prepare('UPDATE workspace SET sort_order=1 WHERE id=?').run(ids[3]!);
    const full = listWorkspaces(t.db).map(ws => ws.id);
    const paged: string[] = [];
    for (let offset = 0; offset < full.length; offset += 2) {
      paged.push(...listWorkspacesPage(t.db, 2, offset).items.map(ws => ws.id));
    }
    expect(paged).toEqual(full);
    // HTTP 分页路径与全量路径必须给同一顺序（MCP agentboard_list_workspaces 与 web 一致）
    return (async () => {
      const unpaged = await request(app).get('/api/workspaces');
      const httpPaged: string[] = [];
      for (let offset = 0; offset < full.length; offset += 2) {
        const page = await request(app).get(`/api/workspaces?limit=2&offset=${offset}`);
        httpPaged.push(...page.body.items.map((ws: { id: string }) => ws.id));
      }
      expect(unpaged.body.map((ws: { id: string }) => ws.id)).toEqual(full);
      expect(httpPaged).toEqual(full);
    })();
  });

  it('postWorkspacesAppendsToEnd', async () => {
    seed(['a', 'b']);
    mkdirSync(join(spaceDir, 'c'), { recursive: true });
    const created = await request(app).post('/api/workspaces').send({ name: 'c', path: join(spaceDir, 'c') });
    expect(created.status).toBe(200);
    const order = listWorkspaces(t.db).map(ws => ws.name);
    expect(order).toEqual(['a', 'b', 'c']);
    const row = t.db.prepare('SELECT sort_order FROM workspace WHERE id=?').get(created.body.id) as { sort_order: number };
    expect(row.sort_order).toBe(2);
  });

  it('reorderPersistsAndReturnsAuthoritativeList', async () => {
    const ids = seed(['a', 'b', 'c']);
    const listed = await request(app).get('/api/workspaces');
    expect(listed.body.map((ws: { name: string }) => ws.name)).toEqual(['a', 'b', 'c']);

    const res = await request(app).post('/api/workspaces/reorder')
      .set('Idempotency-Key', randomUUID())
      .send({ ordered_ids: [ids[2], ids[0], ids[1]] });
    expect(res.status).toBe(200);
    expect(res.body.workspaces.map((ws: { id: string }) => ws.id)).toEqual([ids[2], ids[0], ids[1]]);
    expect(typeof res.body.reordered_at).toBe('number');
    expect(res.body.workspaces.every((ws: { sort_order?: number }) => typeof ws.sort_order === 'number')).toBe(true);

    const after = await request(app).get('/api/workspaces');
    expect(after.body.map((ws: { id: string }) => ws.id)).toEqual([ids[2], ids[0], ids[1]]);
  });

  it('reorderSurvivesDbReopen', async () => {
    const ids = seed(['a', 'b', 'c']);
    await request(app).post('/api/workspaces/reorder').set('Idempotency-Key', randomUUID()).send({ ordered_ids: [ids[1], ids[2], ids[0]] });
    const file = (t.db as unknown as { name: string }).name;
    t.db.close();
    const reopened = openDb(file);
    expect(listWorkspaces(reopened).map(ws => ws.id)).toEqual([ids[1], ids[2], ids[0]]);
    reopened.close();
  });

  it('reorderRejectsInvalidPayload', async () => {
    const ids = seed(['a', 'b']);
    const before = listWorkspaces(t.db).map(ws => ws.id);
    const cases = [
      { ordered_ids: [] },
      { ordered_ids: [ids[0], ids[0]] },
      { ordered_ids: ['not-a-uuid'] },
      { ordered_ids: [ids[0], randomUUID()] },
    ];
    for (const body of cases) {
      const res = await request(app).post('/api/workspaces/reorder').set('Idempotency-Key', randomUUID()).send(body);
      expect(res.status).toBe(400);
    }
    const missingKey = await request(app).post('/api/workspaces/reorder').send({ ordered_ids: [ids[1], ids[0]] });
    expect(missingKey.status).toBe(400);
    expect(listWorkspaces(t.db).map(ws => ws.id)).toEqual(before);
  });

  it('reorderRejectsChangedWorkspaceSet', async () => {
    const ids = seed(['a', 'b']);
    mkdirSync(join(spaceDir, 'c'), { recursive: true });
    await request(app).post('/api/workspaces').send({ name: 'c', path: join(spaceDir, 'c') });
    const res = await request(app).post('/api/workspaces/reorder').set('Idempotency-Key', randomUUID()).send({ ordered_ids: [ids[1], ids[0]] });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('WORKSPACE_SET_CHANGED');
    expect(res.body.error.details.missing).toEqual([expect.any(String)]);
    expect(res.body.error.details.extra).toEqual([]);
    // 既有行顺序不变
    expect(listWorkspaces(t.db).slice(0, 2).map(ws => ws.id)).toEqual([ids[0], ids[1]]);
  });

  it('reorderIsIdempotentPerKey', async () => {
    const ids = seed(['a', 'b', 'c']);
    const key = randomUUID();
    const first = await request(app).post('/api/workspaces/reorder').set('Idempotency-Key', key).send({ ordered_ids: [ids[1], ids[0], ids[2]] });
    expect(first.status).toBe(200);
    const replay = await request(app).post('/api/workspaces/reorder').set('Idempotency-Key', key).send({ ordered_ids: [ids[1], ids[0], ids[2]] });
    expect(replay.status).toBe(200);
    expect(replay.body).toEqual(first.body);

    // 同 key 不同 body → 409，且不改写顺序
    const conflict = await request(app).post('/api/workspaces/reorder').set('Idempotency-Key', key).send({ ordered_ids: [ids[2], ids[1], ids[0]] });
    expect(conflict.status).toBe(409);
    expect(conflict.body.error.code).toBe('IDEMPOTENCY_KEY_REUSED');
    expect(listWorkspaces(t.db).map(ws => ws.id)).toEqual([ids[1], ids[0], ids[2]]);
  });

  it('reorderLastWriteWins', async () => {
    const ids = seed(['a', 'b', 'c']);
    await request(app).post('/api/workspaces/reorder').set('Idempotency-Key', randomUUID()).send({ ordered_ids: [ids[2], ids[1], ids[0]] });
    await request(app).post('/api/workspaces/reorder').set('Idempotency-Key', randomUUID()).send({ ordered_ids: [ids[0], ids[2], ids[1]] });
    expect(listWorkspaces(t.db).map(ws => ws.id)).toEqual([ids[0], ids[2], ids[1]]);
  });
});
