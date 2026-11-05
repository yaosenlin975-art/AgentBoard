/**
 * STORE-4b（M3）：entity_locator 定位索引。
 *
 * 覆盖卡面验收四条：
 * 1. 按 id 取库命中索引（索引优先于扫描——扫描会先撞上他区同名旧拷贝，断言命中的是索引指向的库）；
 * 2. 创建/删除后索引一致（issue / session / 知识页，含 fork 与知识页软删/归档口径）；
 * 3. 删表重建可重入（DROP TABLE 后读侧回退扫描仍可读；migrate+rebuild 回填，重复执行结果一致）；
 * 4. fan-out 兜底仍在（清掉索引行后按 id 读仍命中；索引指向已下沉区而行在中心库的会话由兜底接住）。
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdirSync } from 'node:fs';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import type { AgentAdapter } from '@agentboard/adapters';
import { createTestDb, type TestDb } from './helpers.js';
import { FakeAdapter } from './fakeAdapter.js';
import { createApp } from '../src/index.js';
import { createWorkspace } from '../src/db/repos/workspace.js';
import { resetLocalizeJobs } from '../src/services/workspaceLocalizeJob.js';
import { closeWorkspaceDbs, locateDbForEntity, resetResolverState, workspaceDbPath, type ResolverDeps, type WorkspaceLike } from '../src/db/resolver.js';
import { migrateEntityLocator } from '../src/db/migrations/entityLocator.js';
import { entityLocatorNeedsBackfill, findEntityLocator, rebuildEntityLocator, upsertEntityLocator } from '../src/db/repos/entityLocator.js';
import { getIssue } from '../src/db/repos/issue.js';

const locatorRow = (db: TestDb['db'], entityId: string): { kind: string; workspace_id: string | null } | undefined =>
  db.prepare('SELECT kind, workspace_id FROM entity_locator WHERE entity_id=?').get(entityId) as
    | { kind: string; workspace_id: string | null }
    | undefined;

describe('STORE-4b entity_locator 定位索引', () => {
  let t: TestDb;
  let app: Express;
  let root: string;
  let wsPath: string;
  let otherPath: string;
  let ws: string;
  let otherWs: string;
  let probes: Database.Database[];

  const mkIssue = async (workspaceId: string, title: string): Promise<string> => {
    const res = await request(app).post('/api/issues').send({ workspace_id: workspaceId, title });
    expect(res.status).toBe(200);
    return res.body.id as string;
  };
  const postLocalize = (id: string) => request(app).post(`/api/workspaces/${id}/db/localize`).send({});
  const waitSettled = async (id: string, jobId: string): Promise<{ status: string }> => {
    for (let i = 0; i < 400; i += 1) {
      const res = await request(app).get(`/api/workspaces/${id}/db/localize/${jobId}`);
      expect(res.status).toBe(200);
      if (res.body.status !== 'running') return res.body;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    throw new Error('localize 任务未在期限内结束');
  };
  const localize = async (id: string): Promise<void> => {
    const created = await postLocalize(id);
    expect(created.status).toBe(202);
    const job = await waitSettled(id, created.body.jobId);
    expect(job.status).toBe('done');
  };
  /** 读写探针：直开工作区库文件（验证行落位/注入跨区旧拷贝），随 afterEach 关闭 */
  const probeWsDb = (path: string, readonly = true): Database.Database => {
    const db = new Database(workspaceDbPath(path), { readonly });
    probes.push(db);
    return db;
  };
  const pageBody = (over: Record<string, unknown> = {}) => ({
    domain: 'knowledge', slug: 'locator-page', title: '定位索引验收页', body_md: '定位索引验收正文', actor: 'tester',
    sources: [{ source_id: 's', source_type: 'agent', locator: 'issue:1', captured_at: 1, content_hash: 'a'.repeat(64), snapshot: 'verified' }],
    evidence: [{ source_id: 's', locator: 'issue:1' }],
    ...over,
  });

  beforeEach(async () => {
    probes = [];
    resetLocalizeJobs();
    resetResolverState();
    t = createTestDb();
    root = mkdtempSync(join(tmpdir(), 'agentboard-store4b-'));
    wsPath = join(root, 'ws');
    otherPath = join(root, 'other');
    mkdirSync(wsPath, { recursive: true });
    mkdirSync(otherPath, { recursive: true });
    const adapter = new FakeAdapter();
    const created = await createApp({
      db: t.db,
      getAdapter: (_id: string): AgentAdapter => adapter,
      adapters: [adapter],
      refreshClisOnBoot: false,
    });
    app = created.app;
    ws = createWorkspace(t.db, { name: '下沉区', path: wsPath }).id;
    otherWs = createWorkspace(t.db, { name: '别区', path: otherPath }).id;
  });
  afterEach(() => {
    for (const probe of probes) {
      try { probe.close(); } catch { /* 忽略 */ }
    }
    resetLocalizeJobs();
    closeWorkspaceDbs('store4b-cleanup');
    resetResolverState();
    t.cleanup();
    rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  });

  it('未下沉区：创建即登记索引（workspace_id=归属区），删除后索引一致', async () => {
    const id = await mkIssue(otherWs, '中心库卡');
    expect(locatorRow(t.db, id)).toEqual({ kind: 'issue', workspace_id: otherWs });

    const deleted = await request(app).delete(`/api/issues/${id}`);
    expect(deleted.status).toBe(204);
    expect(locatorRow(t.db, id)).toBeUndefined();
  });

  it('localized 区：新卡落工作区库且索引指向该区，按 id 读命中索引；删卡后索引同步清', async () => {
    await localize(ws);
    const id = await mkIssue(ws, '工作区库卡');

    // 行落工作区库、中心库无行；索引行登记归属
    const wsDb = probeWsDb(wsPath);
    expect((wsDb.prepare('SELECT COUNT(*) AS n FROM issue WHERE id=?').get(id) as { n: number }).n).toBe(1);
    expect((t.db.prepare('SELECT COUNT(*) AS n FROM issue WHERE id=?').get(id) as { n: number }).n).toBe(0);
    expect(locatorRow(t.db, id)).toEqual({ kind: 'issue', workspace_id: ws });

    const show = await request(app).get(`/api/issues/${id}`);
    expect(show.status).toBe(200);
    expect(show.body.title).toBe('工作区库卡');

    const deleted = await request(app).delete(`/api/issues/${id}`);
    expect(deleted.status).toBe(204);
    expect(locatorRow(t.db, id)).toBeUndefined();
    expect((await request(app).get(`/api/issues/${id}`)).status).toBe(404);
  });

  it('索引优先于扫描：扫描顺序在前的工作区放同名旧拷贝，按 id 读命中的是索引指向的库；清掉索引行后兜底扫描接住', async () => {
    await localize(ws);
    await localize(otherWs); // 候选顺序 = workspace 行序：ws 在前、otherWs 在后
    // 真实卡放 otherWs（扫描顺序在后），旧拷贝注入扫描顺序在前的 ws 库：纯扫描会先命中旧拷贝
    const id = await mkIssue(otherWs, '真实卡在别区');

    const staleDb = probeWsDb(wsPath, false);
    staleDb.prepare("INSERT INTO issue (id, workspace_id, title, created_at, updated_at) VALUES (?,?,?,?,?)")
      .run(id, ws, '旧拷贝在扫描首位', Date.now(), Date.now());

    const viaIndex = await request(app).get(`/api/issues/${id}`);
    expect(viaIndex.status).toBe(200);
    expect(viaIndex.body.title).toBe('真实卡在别区');

    // 清掉索引行 → 兜底扫描接管（中心未中 → 逐区探测先撞旧拷贝），定位索引不是事实来源
    t.db.prepare('DELETE FROM entity_locator WHERE entity_id=?').run(id);
    const viaScan = await request(app).get(`/api/issues/${id}`);
    expect(viaScan.status).toBe(200);
    expect(viaScan.body.title).toBe('旧拷贝在扫描首位');
  });

  it('会话：创建登记索引、读路由经索引+兜底可达、删除清索引、fork 新会话同样登记', async () => {
    await localize(ws);
    const created = await request(app).post('/api/sessions').send({ cli: 'codebuddy', workspace_id: ws });
    expect(created.status).toBe(200);
    const sid = created.body.id as string;
    // 4d 前 sessionManager 仍写中心库：索引行记归属区，读侧索引探测未命中由兜底扫描在中心库接住
    expect(locatorRow(t.db, sid)).toEqual({ kind: 'session', workspace_id: ws });
    expect((await request(app).get(`/api/sessions/${sid}`)).status).toBe(200);

    const forked = await request(app).post(`/api/sessions/${sid}/fork`).send({});
    expect(forked.status).toBe(200);
    expect(locatorRow(t.db, forked.body.id as string)).toEqual({ kind: 'session', workspace_id: ws });

    const deleted = await request(app).delete(`/api/sessions/${sid}`);
    expect(deleted.status).toBe(204);
    expect(locatorRow(t.db, sid)).toBeUndefined();
    expect((await request(app).get(`/api/sessions/${sid}`)).status).toBe(404);
  });

  it('知识页：common 页索引 workspace_id=NULL、workspace 页指向该区；软删清索引、归档不动、恢复回填', async () => {
    await localize(ws);
    const created = await request(app).post('/api/knowledge/pages')
      .send(pageBody({ scope: 'common' }));
    expect(created.status).toBe(200);
    const commonId = created.body.id as string;
    expect(locatorRow(t.db, commonId)).toEqual({ kind: 'knowledge_page', workspace_id: null });

    // 归档：行仍在原库可寻址，索引不动
    const archived = await request(app).post(`/api/knowledge/pages/${commonId}/actions`)
      .send({ scope: 'common', action: 'archive', expected_revision: 1, actor: 'tester' });
    expect(archived.status).toBe(200);
    expect(locatorRow(t.db, commonId)).toEqual({ kind: 'knowledge_page', workspace_id: null });

    // 软删：不再可按 id 寻址，清索引
    const deleted = await request(app).post(`/api/knowledge/pages/${commonId}/actions`)
      .send({ scope: 'common', action: 'delete', expected_revision: 2, actor: 'tester' });
    expect(deleted.status).toBe(200);
    expect(locatorRow(t.db, commonId)).toBeUndefined();

    // workspace 页（localized 区）落工作区库，索引指向该区
    const wsPage = await request(app).post('/api/knowledge/pages')
      .send(pageBody({ scope: 'workspace', workspace_id: ws, slug: 'locator-ws-page' }));
    expect(wsPage.status).toBe(200);
    expect(locatorRow(t.db, wsPage.body.id as string)).toEqual({ kind: 'knowledge_page', workspace_id: ws });
  });

  it('删表重建可重入：DROP 后读侧回退扫描仍可读；migrate+rebuild 回填且重复执行结果一致', async () => {
    const id = await mkIssue(otherWs, '重建路径卡');
    const page = await request(app).post('/api/knowledge/pages').send(pageBody({ scope: 'common', slug: 'rebuild-page' }));
    expect(page.status).toBe(200);
    const pageId = page.body.id as string;
    expect((t.db.prepare('SELECT COUNT(*) AS n FROM entity_locator').get() as { n: number }).n).toBe(2);

    // 删表（模拟索引损坏/重建起点）：读侧不报错，回退 fan-out 扫描
    t.db.exec('DROP TABLE entity_locator');
    expect((await request(app).get(`/api/issues/${id}`)).status).toBe(200);

    // 迁移幂等重建空表 + 全量重建回填；重复执行结果一致（可重入）
    migrateEntityLocator(t.db);
    rebuildEntityLocator(t.db, [t.db]);
    rebuildEntityLocator(t.db, [t.db]);
    expect(locatorRow(t.db, id)).toEqual({ kind: 'issue', workspace_id: otherWs });
    expect(locatorRow(t.db, pageId)).toEqual({ kind: 'knowledge_page', workspace_id: null });
    expect((await request(app).get(`/api/issues/${id}`)).status).toBe(200);
  });

  it('启动回填判定：索引空且有实体时需要回填；有索引行或无实体时不需要', () => {
    expect(entityLocatorNeedsBackfill(t.db)).toBe(false); // 无实体
    // 直插实体行（模拟本功能上线前的存量数据——API 建卡会经钩子先写索引，不走回填）
    t.db.prepare("INSERT INTO issue (id, workspace_id, title, created_at, updated_at) VALUES ('issue-legacy',?,'存量卡',1,1)").run(otherWs);
    expect(entityLocatorNeedsBackfill(t.db)).toBe(true); // 有实体、索引空
    upsertEntityLocator(t.db, 'issue', 'seed-row', otherWs);
    expect(entityLocatorNeedsBackfill(t.db)).toBe(false); // 索引非空
  });

  it('resolver.locateDbForEntity：索引命中不需要候选（candidates=[]）；无索引/过期索引/异 kind 行均回退扫描', () => {
    const wsDb = createTestDb();
    // 工作区路径必须是真实可写目录：索引命中路径会经 getDbForWorkspace 真实获取每工作区锁
    const fakeWsPath = join(root, 'wsfake');
    mkdirSync(join(fakeWsPath, '.agentboard'), { recursive: true });
    try {
      const wsRow: WorkspaceLike = { id: 'ws-fake', path: fakeWsPath, dbMode: 'localized' };
      const deps: ResolverDeps = {
        centerDb: t.db,
        openWorkspaceDbs: true,
        instanceId: 'store4b-unit',
        port: 0,
        fileExists: () => true,
        readMeta: () => ({ localized: true, workspaceId: 'ws-fake' }),
        open: () => wsDb.db,
      };
      const probe = (db: TestDb['db']): string | null => (getIssue(db, 'issue-1') !== null ? 'hit' : null);
      const resolveWorkspace = (workspaceId: string): WorkspaceLike | null => (workspaceId === 'ws-fake' ? wsRow : null);
      wsDb.db.prepare("INSERT INTO workspace (id, name, path, created_at) VALUES ('ws-fake','替身区','/nonexistent',1)").run();
      wsDb.db.prepare("INSERT INTO issue (id, workspace_id, title, created_at, updated_at) VALUES ('issue-1','ws-fake','索引库卡',1,1)").run();

      // 索引命中：候选为空也能定位（证明走的是索引不是扫描）
      upsertEntityLocator(t.db, 'issue', 'issue-1', 'ws-fake');
      const hit = locateDbForEntity(deps, [], 'issue', 'issue-1', probe, resolveWorkspace);
      expect(hit).not.toBeNull();
      expect(hit?.db).toBe(wsDb.db);

      // 无索引行：候选为空 → null；候选给出 → 扫描命中（fan-out 兜底仍在）
      t.db.prepare("DELETE FROM entity_locator WHERE entity_id='issue-1'").run();
      expect(locateDbForEntity(deps, [], 'issue', 'issue-1', probe, resolveWorkspace)).toBeNull();
      expect(locateDbForEntity(deps, [wsRow], 'issue', 'issue-1', probe, resolveWorkspace)?.db).toBe(wsDb.db);

      // 索引过期（指向另一个探不到的区）：探测未命中 → 回退扫描命中
      upsertEntityLocator(t.db, 'issue', 'issue-1', 'ws-gone');
      const stale = locateDbForEntity(deps, [wsRow], 'issue', 'issue-1', probe, resolveWorkspace);
      expect(stale?.db).toBe(wsDb.db);

      // 异 kind 行（session 行、按 issue 查）：索引未命中 → 兜底
      t.db.prepare("UPDATE entity_locator SET kind='session' WHERE entity_id='issue-1'").run();
      expect(locateDbForEntity(deps, [wsRow], 'issue', 'issue-1', probe, resolveWorkspace)?.db).toBe(wsDb.db);
      // findEntityLocator 只按 kind 精确匹配
      expect(findEntityLocator(t.db, 'issue', 'issue-1')).toBeUndefined();
    } finally {
      wsDb.cleanup();
    }
  });
});
