/**
 * STATUS-2：工作区状态字典 REST（列表 / 新建 / 删除 + 强制迁移）。
 * 真库 + 真实 HTTP（supertest），不 mock 仓储层。
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
import { createWorkspace } from '../src/db/repos/workspace.js';
import { assertMigrationCount } from '../src/services/workspaceStatus.js';

describe('workspace status CRUD (STATUS-2)', () => {
  let t: TestDb;
  let app: Express;
  let spaceDir: string;
  let ws: string;

  const api = (path: string) => `/api/workspaces/${ws}/statuses${path}`;
  const createStatus = (body: Record<string, unknown>) => request(app).post(api('')).send(body);
  const listStatuses = async () => (await request(app).get(api(''))).body as Array<{ id: string; name: string; kind: string; sort_order: number; is_builtin: number }>;
  const mkIssue = async (title: string, status?: string): Promise<string> => {
    const res = await request(app).post('/api/issues').send({ workspace_id: ws, title, description: '' });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const id = res.body.id as string;
    if (status) {
      const patched = await request(app).patch(`/api/issues/${id}`).send({ status });
      expect(patched.status, JSON.stringify(patched.body)).toBe(200);
    }
    return id;
  };

  beforeEach(async () => {
    t = createTestDb();
    spaceDir = mkdtempSync(join(tmpdir(), 'agentboard-status-api-'));
    const adapter = new FakeAdapter();
    const created = await createApp({
      db: t.db,
      getAdapter: (id: string): AgentAdapter => {
        if (id === 'fake') return adapter;
        throw new Error(`未知适配器 id: ${id}`);
      },
      adapters: [adapter],
      refreshClisOnBoot: false,
    });
    app = created.app;
    ws = createWorkspace(t.db, { name: '状态 CRUD 空间', path: spaceDir }).id;
  });
  afterEach(() => {
    t.cleanup();
    rmSync(spaceDir, { recursive: true, force: true });
  });

  it('listsFiveBuiltinStatuses', async () => {
    const rows = await listStatuses();
    expect(rows.map(row => [row.name, row.kind, row.sort_order, row.is_builtin])).toEqual([
      ['待规划', 'open', 0, 1],
      ['进行中', 'started', 10, 1],
      ['待验收', 'review', 20, 1],
      ['已关闭', 'done', 30, 1],
      ['已废弃', 'deprecated', 40, 1],
    ]);
  });

  it('createsCustomStatusAndRejectsDuplicateName', async () => {
    const created = await createStatus({ name: '待复测', kind: 'review' });
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({ name: '待复测', kind: 'review', is_builtin: 0 });
    expect(created.body.sort_order).toBe(50); // 最大值 +10

    const rows = await listStatuses();
    expect(rows.map(row => row.name)).toContain('待复测');
    // 新建状态可以真正写进卡（服务层字典校验跟着走）
    const issueId = await mkIssue('用自定义状态', '待复测');
    expect((t.db.prepare('SELECT status FROM issue WHERE id=?').get(issueId) as { status: string }).status).toBe('待复测');

    const dup = await createStatus({ name: '待复测', kind: 'open' });
    expect(dup.status).toBe(409);
    expect(dup.body.error.code).toBe('WORKSPACE_STATUS_EXISTS');
    // 内置名字也算重名
    const dupBuiltin = await createStatus({ name: '待规划', kind: 'open' });
    expect(dupBuiltin.status).toBe(409);
  });

  it('rejectsInvalidKindAndMismatchedWorkspace', async () => {
    const badKind = await createStatus({ name: '怪状态', kind: 'whatever' });
    expect(badKind.status).toBe(400);
    const mismatch = await createStatus({ name: '错区状态', kind: 'open', workspace_id: 'ws-other' });
    expect(mismatch.status).toBe(400);
    expect(mismatch.body.error.message).toContain('workspace_id 与路径不一致');
  });

  it('refusesToDeleteBuiltinStatus', async () => {
    const builtin = (await listStatuses()).find(row => row.name === '待规划')!;
    const res = await request(app).delete(`${api(`/${builtin.id}`)}?migrate_to=进行中`);
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('WORKSPACE_STATUS_BUILTIN');
    expect((await listStatuses()).some(row => row.name === '待规划')).toBe(true);
  });

  it('requiresMigrateToAndMovesIssuesBeforeDeleting', async () => {
    const created = await createStatus({ name: '待复测', kind: 'review' });
    const statusId = created.body.id as string;
    const moved1 = await mkIssue('卡一', '待复测');
    const moved2 = await mkIssue('卡二', '待复测');
    const untouched = await mkIssue('卡三');

    const noTarget = await request(app).delete(api(`/${statusId}`));
    expect(noTarget.status).toBe(400);
    expect(noTarget.body.error.code).toBe('MIGRATION_TARGET_REQUIRED');
    // 400 后什么都没变
    expect((await listStatuses()).some(row => row.name === '待复测')).toBe(true);
    expect((t.db.prepare("SELECT COUNT(*) AS n FROM issue WHERE status='待复测'").get() as { n: number }).n).toBe(2);

    const invalidTarget = await request(app).delete(`${api(`/${statusId}`)}?migrate_to=不存在的状态`);
    expect(invalidTarget.status).toBe(400);
    expect(invalidTarget.body.error.code).toBe('MIGRATION_TARGET_INVALID');

    const ok = await request(app).delete(`${api(`/${statusId}`)}?migrate_to=进行中`);
    expect(ok.status).toBe(200);
    expect(ok.body).toMatchObject({ migrate_to: '进行中', migrated_issue_count: 2 });
    expect(ok.body.removed).toMatchObject({ name: '待复测', is_builtin: 0 });

    // 该状态卡数 = 0，状态消失，未涉及卡不受影响
    expect((t.db.prepare("SELECT COUNT(*) AS n FROM issue WHERE status='待复测'").get() as { n: number }).n).toBe(0);
    expect((t.db.prepare('SELECT status FROM issue WHERE id=?').get(moved1) as { status: string }).status).toBe('进行中');
    expect((t.db.prepare('SELECT status FROM issue WHERE id=?').get(moved2) as { status: string }).status).toBe('进行中');
    expect((t.db.prepare('SELECT status FROM issue WHERE id=?').get(untouched) as { status: string }).status).toBe('待规划');
    expect((await listStatuses()).some(row => row.name === '待复测')).toBe(false);
    // 删掉的状态不能再被写入
    const writeBack = await request(app).patch(`/api/issues/${moved1}`).send({ status: '待复测' });
    expect(writeBack.status).toBe(400);
  });

  it('reportsZeroWhenDeletedStatusHasNoIssues', async () => {
    const created = await createStatus({ name: '空状态', kind: 'open' });
    const statusId = created.body.id as string;
    const ok = await request(app).delete(`${api(`/${statusId}`)}?migrate_to=待规划`);
    expect(ok.status).toBe(200);
    // 该状态本来就没有卡：0 是真实计数，不是统计失败
    expect(ok.body).toMatchObject({ migrate_to: '待规划', migrated_issue_count: 0 });
    expect((await listStatuses()).some(row => row.name === '空状态')).toBe(false);
  });

  it('reportsExactCountWhenFiveIssuesMigrate', async () => {
    const created = await createStatus({ name: '待复测', kind: 'review' });
    const statusId = created.body.id as string;
    const ids = await Promise.all([1, 2, 3, 4, 5].map(async n => mkIssue(`批量卡${n}`, '待复测')));
    const ok = await request(app).delete(`${api(`/${statusId}`)}?migrate_to=已关闭`);
    expect(ok.status).toBe(200);
    expect(ok.body.migrated_issue_count).toBe(5);
    // 与实际迁移数逐一比对
    for (const id of ids) {
      expect((t.db.prepare('SELECT status FROM issue WHERE id=?').get(id) as { status: string }).status).toBe('已关闭');
    }
    expect((t.db.prepare("SELECT COUNT(*) AS n FROM issue WHERE status='待复测'").get() as { n: number }).n).toBe(0);
  });

  it('returns404ForUnknownWorkspaceOrStatus', async () => {
    const unknownWs = await request(app).get('/api/workspaces/00000000-0000-4000-8000-000000000000/statuses');
    expect(unknownWs.status).toBe(404);
    const unknownStatus = await request(app).delete(`${api('/00000000-0000-4000-8000-000000000000')}?migrate_to=进行中`);
    expect(unknownStatus.status).toBe(404);
  });
});

describe('迁移计数守卫（STATUS-MIGRATE-COUNT）', () => {
  it('应迁数与实际变更数一致时原样返回', () => {
    expect(assertMigrationCount(0, 0, '空状态')).toBe(0);
    expect(assertMigrationCount(2, 2, '待复测')).toBe(2);
    expect(assertMigrationCount(5, 5, '待复测')).toBe(5);
  });

  it('不一致时报错而不是谎报 0（不把统计失败说成「没有卡」）', () => {
    expect(() => assertMigrationCount(3, 0, '待复测')).toThrow(/迁移计数不一致/);
    try {
      assertMigrationCount(3, 0, '待复测');
    } catch (error) {
      expect((error as { code?: string }).code).toBe('MIGRATION_COUNT_MISMATCH');
      expect((error as { status?: number }).status).toBe(500);
    }
  });
});
