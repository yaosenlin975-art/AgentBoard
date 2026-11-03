/**
 * DEP-1：依赖边存储、校验与 claim 门禁。
 * 设计口径：`Docs/design-2026-11-03-issue-dependencies.md` §6/§7/§8/§12/§13/§17。
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
import { initSchema } from '../src/db/schema.js';
import { isBlockerResolved, unresolvedBlockers } from '../src/services/dependency.js';

describe('issue dependency (DEP-1)', () => {
  let t: TestDb;
  let app: Express;
  let adapter: FakeAdapter;
  let spaceDir: string;
  let ws: string;

  const mkIssue = async (title: string): Promise<string> => {
    const res = await request(app).post('/api/issues').send({ workspace_id: ws, title, description: '' });
    expect(res.status).toBe(200);
    return res.body.id as string;
  };
  const addDep = (blocked: string, blocker: string, workspaceId = ws) =>
    request(app).post(`/api/issues/${blocked}/dependencies`).send({ workspace_id: workspaceId, blocker_issue_id: blocker });
  const lsDep = (id: string, workspaceId = ws) =>
    request(app).get(`/api/issues/${id}/dependencies`).query({ workspace_id: workspaceId });
  const rmDep = (blocked: string, blocker: string, workspaceId = ws) =>
    request(app).delete(`/api/issues/${blocked}/dependencies/${blocker}`).query({ workspace_id: workspaceId });
  const claim = (id: string) => request(app).post(`/api/issues/${id}/claim`).send({ agent_id: 'fake' });
  const finish = (id: string, action: 'done' | 'fail', extra: Record<string, unknown> = {}) =>
    request(app).post(`/api/issues/${id}/${action}`).send({ agent_id: 'fake', workspace_id: ws, ...extra });
  const comments = (issueId: string): string[] =>
    (t.db.prepare('SELECT content FROM issue_comment WHERE issue_id=? ORDER BY ts,id').all(issueId) as Array<{ content: string }>).map(row => row.content);
  const dependencyRows = (): number =>
    (t.db.prepare('SELECT COUNT(*) AS n FROM issue_dependency').get() as { n: number }).n;

  beforeEach(async () => {
    t = createTestDb();
    adapter = new FakeAdapter();
    spaceDir = mkdtempSync(join(tmpdir(), 'agentboard-dep-'));
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
    const res = await request(app).post('/api/workspaces').send({ name: 'dep 空间', path: spaceDir });
    ws = res.body.id as string;
  });
  afterEach(() => {
    t.cleanup();
    rmSync(spaceDir, { recursive: true, force: true });
  });

  it('createsEdgeAndProjectsBothDirections', async () => {
    const blocked = await mkIssue('被阻塞卡');
    const blocker = await mkIssue('前置卡');

    const created = await addDep(blocked, blocker);
    expect(created.status).toBe(201);
    expect(created.body.blockers).toEqual([
      { issue_id: blocker, title: '前置卡', status: '待规划', resolved: false },
    ]);

    const blockedView = await lsDep(blocked);
    expect(blockedView.status).toBe(200);
    expect(blockedView.body.blockers.map((b: { issue_id: string }) => b.issue_id)).toEqual([blocker]);
    const blockerView = await lsDep(blocker);
    expect(blockerView.body.blocked.map((b: { issue_id: string }) => b.issue_id)).toEqual([blocked]);

    expect((await rmDep(blocked, blocker)).status).toBe(204);
    expect(dependencyRows()).toBe(0);
    expect((await rmDep(blocked, blocker)).status).toBe(404);
  });

  it('rejectsCrossWorkspaceDependency', async () => {
    const otherDir = mkdtempSync(join(tmpdir(), 'agentboard-dep-other-'));
    try {
      const otherWs = (await request(app).post('/api/workspaces').send({ name: '别处', path: otherDir })).body.id as string;
      const mine = await mkIssue('本区卡');
      const foreign = (await request(app).post('/api/issues').send({ workspace_id: otherWs, title: '外区前置', description: '' })).body.id as string;

      const res = await addDep(mine, foreign);
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('CROSS_WORKSPACE_DEPENDENCY');
      expect(dependencyRows()).toBe(0);
    } finally {
      rmSync(otherDir, { recursive: true, force: true });
    }
  });

  it('rejectsSelfDependency', async () => {
    const only = await mkIssue('自环卡');
    const res = await addDep(only, only);
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('DEPENDENCY_SELF');
  });

  it('rejectsCycleAcrossThreeIssues', async () => {
    const a = await mkIssue('A');
    const b = await mkIssue('B');
    const c = await mkIssue('C');
    expect((await addDep(a, b)).status).toBe(201);
    expect((await addDep(b, c)).status).toBe(201);

    const res = await addDep(c, a); // C←A 会让 A→B→C→A 成环
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('DEPENDENCY_CYCLE');
    expect(dependencyRows()).toBe(2);
  });

  it('rejectsDuplicateEdge', async () => {
    const blocked = await mkIssue('重复卡');
    const blocker = await mkIssue('前置卡');
    expect((await addDep(blocked, blocker)).status).toBe(201);
    const res = await addDep(blocked, blocker);
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('DEPENDENCY_EXISTS');
  });

  it('requiresWorkspaceOnEveryWriteChannel', async () => {
    const blocked = await mkIssue('缺参卡');
    const blocker = await mkIssue('前置卡');
    const created = await request(app).post(`/api/issues/${blocked}/dependencies`).send({ blocker_issue_id: blocker });
    expect(created.status).toBe(400);
    expect(created.body.error.code).toBe('VALIDATION_ERROR');
    const removed = await request(app).delete(`/api/issues/${blocked}/dependencies/${blocker}`);
    expect(removed.status).toBe(400);
    expect(removed.body.error.code).toBe('VALIDATION_ERROR');
    expect((await request(app).get(`/api/issues/${blocked}/dependencies`)).status).toBe(400);
  });

  it('returns404WhenBlockerIsUnknown', async () => {
    const blocked = await mkIssue('缺前置卡');
    const res = await addDep(blocked, '00000000-0000-4000-8000-000000000000');
    expect(res.status).toBe(404);
  });

  it('blocksClaimUntilBlockerIsResolved', async () => {
    const blocked = await mkIssue('等前置', );
    const blocker = await mkIssue('前置未完成');
    expect((await addDep(blocked, blocker)).status).toBe(201);

    const denied = await claim(blocked);
    expect(denied.status).toBe(409);
    expect(denied.body.error.code).toBe('CONFLICT');
    // 文案含前置标题与 uuid 前 8 位
    expect(denied.body.error.message).toContain('前置未完成');
    expect(denied.body.error.message).toContain(blocker.slice(0, 8));
    expect(t.db.prepare('SELECT claimed_by FROM issue WHERE id=?').get(blocked)).toEqual({ claimed_by: null });

    // blocker done → 待验收即视为解除（§5-D2）
    expect((await claim(blocker)).status).toBe(200);
    expect((await finish(blocker, 'done', { notes: '' })).status).toBe(200);
    const allowed = await claim(blocked);
    expect(allowed.status).toBe(200);
    expect(allowed.body.status).toBe('进行中');
  });

  it('doneFailReleaseAreNotBlockedByDependencies', async () => {
    const worker = await mkIssue('收尾卡');
    const blocker = await mkIssue('后加的前置');
    // 已占用的卡按 §17-B4 不能新增前置，这里直接写库模拟历史残留边，验证收尾通道不受影响
    expect((await claim(worker)).status).toBe(200);
    t.db.prepare('INSERT INTO issue_dependency (blocked_issue_id, blocker_issue_id, created_at) VALUES (?,?,?)')
      .run(worker, blocker, Date.now());

    expect((await finish(worker, 'done', { notes: '收尾不受依赖影响' })).status).toBe(200);
    expect(t.db.prepare('SELECT status FROM issue WHERE id=?').get(worker)).toEqual({ status: '待验收' });

    const second = await mkIssue('失败卡');
    expect((await claim(second)).status).toBe(200);
    t.db.prepare('INSERT INTO issue_dependency (blocked_issue_id, blocker_issue_id, created_at) VALUES (?,?,?)')
      .run(second, blocker, Date.now());
    expect((await finish(second, 'fail', { reason: '依赖未解除也要能回报失败' })).status).toBe(200);
    expect(t.db.prepare('SELECT status FROM issue WHERE id=?').get(second)).toEqual({ status: '待规划' });
  });

  it('rejectsNewBlockerOnClaimedIssue', async () => {
    const worker = await mkIssue('已占用卡');
    const blocker = await mkIssue('前置卡');
    expect((await claim(worker)).status).toBe(200);
    const res = await addDep(worker, blocker);
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('ISSUE_CLAIMED');
  });

  it('aggregatesDependencyCountsInListAndTree', async () => {
    const blocked = await mkIssue('被两卡阻塞');
    const open1 = await mkIssue('未解除一');
    const open2 = await mkIssue('未解除二');
    const free = await mkIssue('无依赖卡');
    expect((await addDep(blocked, open1)).status).toBe(201);
    expect((await addDep(blocked, open2)).status).toBe(201);

    const list = async () => (await request(app).get(`/api/issues?workspace=${ws}`)).body as Array<Record<string, number | boolean>>;
    const find = (rows: Array<Record<string, number | boolean>>, id: string) => rows.find(row => row.id === id)!;

    let rows = await list();
    expect(find(rows, blocked)).toMatchObject({ blocked_by_count: 2, blocked_by_open_count: 2, resolved: false });
    expect(find(rows, free)).toMatchObject({ blocked_by_count: 0, blocked_by_open_count: 0, resolved: true });

    expect((await claim(open1)).status).toBe(200);
    expect((await finish(open1, 'done', { notes: '' })).status).toBe(200);
    rows = await list();
    expect(find(rows, blocked)).toMatchObject({ blocked_by_count: 2, blocked_by_open_count: 1, resolved: false });

    const tree = await request(app).get(`/api/issues/tree?workspace=${ws}`);
    expect(tree.status).toBe(200);
    const treeItem = (tree.body.items as Array<Record<string, number | boolean>>).find(item => item.id === blocked)!;
    expect(treeItem).toMatchObject({ blocked_by_count: 2, blocked_by_open_count: 1, resolved: false });
  });

  it('singleIssueAndPagedListCarryDependencyCounts', async () => {
    const blocked = await mkIssue('单卡视角');
    const blocker = await mkIssue('前置卡');
    expect((await addDep(blocked, blocker)).status).toBe(201);
    const one = await request(app).get(`/api/issues/${blocked}`);
    expect(one.body).toMatchObject({ blocked_by_count: 1, blocked_by_open_count: 1, resolved: false });
    const page = await request(app).get(`/api/issues?workspace=${ws}&limit=10&offset=0`);
    const item = (page.body.items as Array<Record<string, unknown>>).find(row => row.id === blocked)!;
    expect(item).toMatchObject({ blocked_by_count: 1, blocked_by_open_count: 1, resolved: false });
  });

  it('idempotentReplayDoesNotDuplicateEdge', async () => {
    const blocked = await mkIssue('幂等卡');
    const blocker = await mkIssue('前置卡');
    const key = '3f1f6f1e-2b7a-4d3f-9a1e-7c2b5f0a9d11';
    const first = await request(app).post(`/api/issues/${blocked}/dependencies`)
      .set('Idempotency-Key', key).send({ workspace_id: ws, blocker_issue_id: blocker });
    expect(first.status).toBe(201);
    const replay = await request(app).post(`/api/issues/${blocked}/dependencies`)
      .set('Idempotency-Key', key).send({ workspace_id: ws, blocker_issue_id: blocker });
    expect(replay.status).toBe(201);
    expect(replay.body).toEqual(first.body);
    expect(dependencyRows()).toBe(1);
  });

  it('dispatchPathIsBlockedAndLeavesNoSession', async () => {
    const blocked = await mkIssue('派发被阻塞');
    const blocker = await mkIssue('前置未完成');
    expect((await addDep(blocked, blocker)).status).toBe(201);
    adapter.script = () => undefined; // 挂起，避免起轮

    const res = await request(app).post('/api/sessions').send({ cli: 'codebuddy', model: 'm1', issue_id: blocked });
    expect(res.status).toBe(409);
    expect(res.body.error.message).toContain('前置未完成');
    expect((t.db.prepare('SELECT COUNT(*) AS n FROM session').get() as { n: number }).n).toBe(0);
    expect(t.db.prepare('SELECT claimed_by, status FROM issue WHERE id=?').get(blocked)).toEqual({ claimed_by: null, status: '待规划' });
  });

  it('deletingBlockerLeavesUnlockCommentAndFreesDependent', async () => {
    const dependent = await mkIssue('依赖方');
    const blocker = await mkIssue('将被删除的前置');
    expect((await addDep(dependent, blocker)).status).toBe(201);

    const removed = await request(app).delete(`/api/issues/${blocker}`);
    expect(removed.status).toBe(204);
    expect(dependencyRows()).toBe(0);
    const note = comments(dependent).join('\n');
    expect(note).toContain('已删除，依赖自动解除');
    expect(note).toContain(blocker.slice(0, 8));
    expect((await claim(dependent)).status).toBe(200);
  });

  it('migrationIsIdempotentAndTriggersBackstopDirectWrites', async () => {
    const dump = () => (t.db.prepare("SELECT type,name FROM sqlite_master WHERE name LIKE 'issue_dependency%' OR name LIKE 'idx_issue_dep%' ORDER BY type,name")
      .all() as Array<{ type: string; name: string }>);
    const before = dump();
    initSchema(t.db); // 重复执行不报错、不重复建对象
    expect(dump()).toEqual(before);
    expect(before.map(row => row.name)).toEqual([
      'idx_issue_dep_blocker',
      'issue_dependency',
      'issue_dependency_no_cycle',
      'issue_dependency_same_workspace',
    ]);

    const mine = await mkIssue('本区卡');
    const otherDir = mkdtempSync(join(tmpdir(), 'agentboard-dep-trigger-'));
    try {
      const otherWs = (await request(app).post('/api/workspaces').send({ name: '别处', path: otherDir })).body.id as string;
      const foreign = (await request(app).post('/api/issues').send({ workspace_id: otherWs, title: '外区', description: '' })).body.id as string;
      // 绕过服务层直写：同工作区触发器兜底
      expect(() => t.db.prepare('INSERT INTO issue_dependency (blocked_issue_id, blocker_issue_id, created_at) VALUES (?,?,?)')
        .run(mine, foreign, Date.now())).toThrow(/workspace mismatch/);
      // 绕过服务层直写成环：防环触发器兜底
      const b = await mkIssue('B');
      const c = await mkIssue('C');
      t.db.prepare('INSERT INTO issue_dependency (blocked_issue_id, blocker_issue_id, created_at) VALUES (?,?,?)').run(mine, b, Date.now());
      t.db.prepare('INSERT INTO issue_dependency (blocked_issue_id, blocker_issue_id, created_at) VALUES (?,?,?)').run(b, c, Date.now());
      expect(() => t.db.prepare('INSERT INTO issue_dependency (blocked_issue_id, blocker_issue_id, created_at) VALUES (?,?,?)')
        .run(c, mine, Date.now())).toThrow(/cycle/);
    } finally {
      rmSync(otherDir, { recursive: true, force: true });
    }
  });

  it('sharesOneResolutionRuleBetweenServiceAndQueryProjection', () => {
    expect(isBlockerResolved('待验收')).toBe(true);
    expect(isBlockerResolved('已关闭')).toBe(true);
    expect(isBlockerResolved('待规划')).toBe(false);
    expect(isBlockerResolved('进行中')).toBe(false);
    expect(unresolvedBlockers(t.db, 'no-such-issue')).toEqual([]);
  });
});
