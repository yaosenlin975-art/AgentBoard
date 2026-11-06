/**
 * CLI-LIST-GUARD（服务端侧）：查询过滤的状态参数不再限定四值枚举。
 * - 自定义状态 / 已废弃 都能筛；
 * - 非法状态 → 400 并列出该工作区可用状态（不再是「静默返回空列表」）。
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import type { AgentAdapter } from '@agentboard/adapters';
import { createTestDb, type TestDb, issuePayload } from './helpers.js';
import { FakeAdapter } from './fakeAdapter.js';
import { createApp } from '../src/index.js';
import { createWorkspace } from '../src/db/repos/workspace.js';
import { createWorkspaceStatus } from '../src/services/workspaceStatus.js';

describe('issue list status filter (CLI-LIST-GUARD)', () => {
  let t: TestDb;
  let app: Express;
  let spaceDir: string;
  let ws: string;

  const mkIssue = async (title: string): Promise<string> => {
    const res = await request(app).post('/api/issues').send(issuePayload(ws, { title }));
    expect(res.status).toBe(200);
    return res.body.id as string;
  };
  const setStatus = (id: string, status: string) => request(app).patch(`/api/issues/${id}`).send({ status });

  beforeEach(async () => {
    t = createTestDb();
    spaceDir = mkdtempSync(join(tmpdir(), 'agentboard-listfilter-'));
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
    ws = createWorkspace(t.db, { name: '筛选空间', path: spaceDir }).id;
    createWorkspaceStatus(t.db, { workspace_id: ws, name: '待复测', kind: 'review' });
  });
  afterEach(() => {
    t.cleanup();
    rmSync(spaceDir, { recursive: true, force: true });
  });

  it('filtersByBuiltinDeprecatedAndCustomStatus', async () => {
    const open = await mkIssue('普通卡');
    const deprecated = await mkIssue('废弃卡');
    const custom = await mkIssue('自定义状态卡');
    expect((await setStatus(deprecated, '已废弃')).status).toBe(200);
    expect((await setStatus(custom, '待复测')).status).toBe(200);

    const byDeprecated = await request(app).get(`/api/issues?workspace=${ws}&status=已废弃`);
    expect(byDeprecated.status).toBe(200);
    expect((byDeprecated.body as Array<{ id: string }>).map(row => row.id)).toEqual([deprecated]);

    const byCustom = await request(app).get(`/api/issues?workspace=${ws}&status=待复测`);
    expect(byCustom.status).toBe(200);
    expect((byCustom.body as Array<{ id: string }>).map(row => row.id)).toEqual([custom]);

    const all = await request(app).get(`/api/issues?workspace=${ws}`);
    expect((all.body as Array<{ id: string }>).map(row => row.id).sort()).toEqual([open, deprecated, custom].sort());

    // 分页模式也支持自定义状态
    const paged = await request(app).get(`/api/issues?workspace=${ws}&status=待复测&limit=10&offset=0`);
    expect(paged.status).toBe(200);
    expect((paged.body.items as Array<{ id: string }>).map(row => row.id)).toEqual([custom]);
  });

  it('rejectsUnknownStatusWithAvailableList', async () => {
    const res = await request(app).get(`/api/issues?workspace=${ws}&status=不存在的状态`);
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
    expect(res.body.error.message).toContain('待规划');
    expect(res.body.error.message).toContain('已废弃');
    expect(res.body.error.message).toContain('待复测');
  });

  it('filtersTreeByDeprecatedStatus', async () => {
    const root = await mkIssue('根卡');
    const child = await request(app).post('/api/issues').send(issuePayload(ws, { title: '子卡', parent_issue_id: root }));
    expect(child.status).toBe(200);
    expect((await setStatus(child.body.id as string, '已废弃')).status).toBe(200);

    // 树端点按「指定层的直接子节点」过滤：根层筛已废弃为空（根是待规划），子层能筛出那条卡
    const rootLevel = await request(app).get(`/api/issues/tree?workspace=${ws}&status=已废弃`);
    expect(rootLevel.status).toBe(200);
    expect((rootLevel.body.items as Array<{ id: string }>).map(row => row.id)).toEqual([]);
    const childLevel = await request(app).get(`/api/issues/tree?workspace=${ws}&parent_issue_id=${root}&status=已废弃`);
    expect(childLevel.status).toBe(200);
    expect((childLevel.body.items as Array<{ id: string }>).map(row => row.id)).toEqual([child.body.id]);
    // 自定义状态同样能筛
    expect((await setStatus(child.body.id as string, '待复测')).status).toBe(200);
    const byCustom = await request(app).get(`/api/issues/tree?workspace=${ws}&parent_issue_id=${root}&status=待复测`);
    expect((byCustom.body.items as Array<{ id: string }>).map(row => row.id)).toEqual([child.body.id]);

    const bad = await request(app).get(`/api/issues/tree?workspace=${ws}&status=乱写`);
    expect(bad.status).toBe(400);
    expect(bad.body.error.message).toContain('已废弃');
  });
});
