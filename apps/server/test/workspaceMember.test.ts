/**
 * PERM-1：工作区成员表 + 幂等迁移 + 既有工作区 owner seed。
 * 设计口径：`knowledge:41cc78e5-946e-4b03-a79c-0a93f13aad12（知识卡：跨工作区决策权限：最小可行方案（路线 A））` §2/§3/§8。
 * 用真实 HTTP（supertest）+ 真实临时 SQLite，不 mock 仓储层。
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import type { AgentAdapter } from '@agentboard/adapters';
import { createTestDb, type TestDb } from './helpers.js';
import { FakeAdapter } from './fakeAdapter.js';
import { createApp } from '../src/index.js';
import { migrateWorkspaceMember } from '../src/db/migrations/workspaceMember.js';
import { getRole, listWorkspacesForActor } from '../src/db/repos/workspaceMember.js';

describe('workspace member (PERM-1)', () => {
  let t: TestDb;
  let app: Express;
  let adapter: FakeAdapter;
  let spaceDir: string;
  let ws: string;

  const ownerRows = (): number =>
    (t.db
      .prepare("SELECT COUNT(*) AS n FROM workspace_member WHERE role='owner' AND actor_id='user'")
      .get() as { n: number }).n;

  const insertRawWorkspace = (suffix: string): string => {
    const id = `00000000-0000-4000-8000-00000000000${suffix}`;
    t.db
      .prepare('INSERT INTO workspace (id, name, path, created_at) VALUES (?, ?, ?, ?)')
      .run(id, `种子 ${suffix}`, join(spaceDir, `raw-${suffix}`), Date.now());
    return id;
  };

  beforeEach(async () => {
    t = createTestDb();
    adapter = new FakeAdapter();
    spaceDir = mkdtempSync(join(tmpdir(), 'agentboard-perm-'));
    const created = await createApp({
      db: t.db,
      getAdapter: (id: string): AgentAdapter => {
        if (id === 'codebuddy') return adapter;
        throw new Error(`未知适配器 id: ${id}`);
      },
      adapters: [adapter],
      refreshClisOnBoot: false,
    });
    app = created.app;
    const res = await request(app).post('/api/workspaces').send({ name: 'perm 空间', path: spaceDir });
    expect(res.status).toBe(200);
    ws = res.body.id as string;
  });

  afterEach(() => {
    t.cleanup();
    rmSync(spaceDir, { recursive: true, force: true });
  });

  it('真实 app 下：workspace_member 6 列 + ux_workspace_member 唯一索引', () => {
    const columns = t.db.prepare('PRAGMA table_info(workspace_member)').all() as Array<{ name: string }>;
    expect(columns.map((column) => column.name)).toEqual([
      'id',
      'workspace_id',
      'actor_id',
      'role',
      'created_at',
      'updated_at',
    ]);

    const indexes = t.db.prepare('PRAGMA index_list(workspace_member)').all() as Array<{ name: string; unique: number }>;
    const ux = indexes.find((index) => index.name === 'ux_workspace_member');
    expect(ux).toBeDefined();
    expect(ux!.unique).toBe(1);

    const indexed = t.db.prepare('PRAGMA index_info(ux_workspace_member)').all() as Array<{ name: string }>;
    expect(indexed.map((column) => column.name)).toEqual(['workspace_id', 'actor_id']);
  });

  it('迁移回填：既有 N 个工作区 → N 条 (user, owner)，每区恰好 1 条', () => {
    // 模拟升级前就存在、且没有成员行的老工作区（连同 beforeEach 建的那个一起清空）
    t.db.prepare('DELETE FROM workspace_member').run();
    insertRawWorkspace('01');
    insertRawWorkspace('02');
    expect(ownerRows()).toBe(0);

    migrateWorkspaceMember(t.db);

    const total = (t.db.prepare('SELECT COUNT(*) AS n FROM workspace').get() as { n: number }).n;
    expect(total).toBe(3);
    expect(ownerRows()).toBe(total);
    const perWorkspace = t.db
      .prepare('SELECT workspace_id, COUNT(*) AS n FROM workspace_member GROUP BY workspace_id')
      .all() as Array<{ workspace_id: string; n: number }>;
    expect(perWorkspace).toHaveLength(total);
    expect(perWorkspace.every((row) => row.n === 1)).toBe(true);
    expect(getRole(t.db, ws, 'user')).toBe('owner');
  });

  it('连续执行两次迁移：行数不变、无异常（no-op）', () => {
    const before = (t.db.prepare('SELECT COUNT(*) AS n FROM workspace_member').get() as { n: number }).n;
    expect(before).toBe(1);

    expect(() => migrateWorkspaceMember(t.db)).not.toThrow();
    expect(() => migrateWorkspaceMember(t.db)).not.toThrow();

    expect((t.db.prepare('SELECT COUNT(*) AS n FROM workspace_member').get() as { n: number }).n).toBe(before);
    expect(ownerRows()).toBe(1);
  });

  it('建工作区接口：新区立即有 (user, owner)，getRole 返回 owner', async () => {
    const res = await request(app).post('/api/workspaces').send({ name: '第二个空间', path: spaceDir });
    // 同路径重复 → 409，不重复建区；这里换个子目录避免撞 path UNIQUE
    expect(res.status).toBe(409);

    const otherDir = mkdtempSync(join(tmpdir(), 'agentboard-perm-new-'));
    try {
      const created = await request(app).post('/api/workspaces').send({ name: '第二个空间', path: otherDir });
      expect(created.status).toBe(200);
      const newId = created.body.id as string;
      const row = t.db
        .prepare('SELECT actor_id, role FROM workspace_member WHERE workspace_id = ?')
        .get(newId) as { actor_id: string; role: string } | undefined;
      expect(row).toEqual({ actor_id: 'user', role: 'owner' });
      expect(getRole(t.db, newId, 'user')).toBe('owner');
    } finally {
      rmSync(otherDir, { recursive: true, force: true });
    }
  });

  it('listWorkspacesForActor：只返回有成员关系的区；回填后 user 拿到全部，agent:nobody 为空', () => {
    insertRawWorkspace('03');
    // 裸插入的区没有成员行 → 匿名，不在「所有工作区」视图里
    expect(listWorkspacesForActor(t.db, 'user').map((row) => row.id)).toEqual([ws]);

    migrateWorkspaceMember(t.db);
    expect(listWorkspacesForActor(t.db, 'user').map((row) => row.id).sort()).toEqual(
      (t.db.prepare('SELECT id FROM workspace').all() as Array<{ id: string }>).map((row) => row.id).sort(),
    );
    expect(listWorkspacesForActor(t.db, 'agent:nobody')).toEqual([]);
  });

  it('删工作区：成员行随 ON DELETE CASCADE 一起消失', async () => {
    const removed = await request(app).delete(`/api/workspaces/${ws}`);
    expect(removed.status).toBe(204);
    expect(getRole(t.db, ws, 'user')).toBeNull();
    expect((t.db.prepare('SELECT COUNT(*) AS n FROM workspace_member').get() as { n: number }).n).toBe(0);
  });
});
