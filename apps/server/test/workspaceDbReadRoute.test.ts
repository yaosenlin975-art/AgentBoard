/**
 * STORE-4a：生产读路径切库 + 知识路由按请求取库（真 HTTP + 真临时库 + 真迁移）。
 *
 * 覆盖卡面验收：
 * - routes.ts 生产装配 openWorkspaceDbs=true：localized 工作区读写落工作区库
 *   （POST /issues 与 PATCH 直查工作区库文件验证落位；GET /issues 与 GET /issues/:id
 *   （无 workspace_id，kb show 路径）从工作区库读回；/issues/:id 子资源同库路由）；
 * - 未下沉工作区行为不变（读写全走中心库）；
 * - localizing 中间态：读可用、写 409 WORKSPACE_DB_MIGRATING（写冻结与切库共存）；
 * - 知识路由按请求 scope 取库：workspace 页建在已下沉区落工作区库、common 页落中心库；
 *   跨区访问 403 且文案不含他区标题。
 *
 * 已知边界（后续卡收口，不在本卡断言）：sessionManager / AttachmentStore 单例仍绑中心库（4d）、
 * scope=both 知识跨库合并（4c）。
 */
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import type { AgentAdapter } from '@agentboard/adapters';
import { createTestDb, type TestDb, issuePayload } from './helpers.js';
import { FakeAdapter } from './fakeAdapter.js';
import { createApp } from '../src/index.js';
import { createWorkspace } from '../src/db/repos/workspace.js';
import { resetLocalizeJobs } from '../src/services/workspaceLocalizeJob.js';
import { closeWorkspaceDbs, resetResolverState, workspaceDbPath } from '../src/db/resolver.js';

describe('STORE-4a 读路径切库 + 知识路由按请求取库', () => {
  let t: TestDb;
  let app: Express;
  let root: string;
  let wsPath: string;
  let otherPath: string;
  let ws: string;
  let otherWs: string;
  /** 每条用例结束时需要关闭的只读探针连接 */
  let probes: Database.Database[];

  const mkIssue = async (workspaceId: string, title: string): Promise<string> => {
    const res = await request(app).post('/api/issues').send(issuePayload(workspaceId, { title }));
    expect(res.status).toBe(200);
    return res.body.id as string;
  };
  const postLocalize = (id: string = ws) => request(app).post(`/api/workspaces/${id}/db/localize`).send({});
  const waitSettled = async (jobId: string, id: string = ws): Promise<{ status: string; lastError: string | null }> => {
    for (let i = 0; i < 400; i += 1) {
      const res = await request(app).get(`/api/workspaces/${id}/db/localize/${jobId}`);
      expect(res.status).toBe(200);
      if (res.body.status !== 'running') return res.body;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    throw new Error('localize 任务未在期限内结束');
  };
  const localize = async (id: string = ws): Promise<void> => {
    const created = await postLocalize(id);
    expect(created.status).toBe(202);
    const job = await waitSettled(created.body.jobId, id);
    expect(job.status).toBe('done');
  };
  const setMode = (workspaceId: string, mode: string): void => {
    t.db.prepare('UPDATE workspace SET db_mode = ? WHERE id = ?').run(mode, workspaceId);
  };
  /** 只读探针：直接开工作区库文件验证「写落工作区库」，用完随 afterEach 关闭 */
  const probeWsDb = (path: string): Database.Database => {
    const db = new Database(workspaceDbPath(path), { readonly: true });
    probes.push(db);
    return db;
  };
  const pageBody = (over: Record<string, unknown> = {}) => ({
    domain: 'knowledge', slug: 'route-page', title: '切库区页标题机密', body_md: '切库验收正文 WAL', actor: 'tester',
    sources: [{ source_id: 's', source_type: 'agent', locator: 'issue:1', captured_at: 1, content_hash: 'a'.repeat(64), snapshot: 'verified' }],
    evidence: [{ source_id: 's', locator: 'issue:1' }],
    ...over,
  });

  beforeEach(async () => {
    probes = [];
    resetLocalizeJobs();
    resetResolverState();
    t = createTestDb();
    root = mkdtempSync(join(tmpdir(), 'agentboard-store4a-'));
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
    // 先关 resolver 持有的工作区库句柄（锁文件随后随目录删除，释放返回 false 不影响清理）
    closeWorkspaceDbs('store4a-cleanup');
    resetResolverState();
    t.cleanup();
    rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  });

  it('localized 工作区：存量卡迁移后 GET /issues 与 GET /issues/:id（无 workspace_id，kb show 路径）从工作区库读回', async () => {
    const id1 = await mkIssue(ws, '迁移卡一');
    const id2 = await mkIssue(ws, '迁移卡二');
    await localize();

    const list = await request(app).get('/api/issues').query({ workspace: ws });
    expect(list.status).toBe(200);
    expect(list.body.map((row: { id: string }) => row.id).sort()).toEqual([id1, id2].sort());

    // kb show 路径：不带 workspace_id，服务端自行定位所在库（中心已无该行 → fan-out 工作区库）
    const show = await request(app).get(`/api/issues/${id1}`);
    expect(show.status).toBe(200);
    expect(show.body.title).toBe('迁移卡一');

    // 子资源同库路由（评论读走工作区库，不 404）
    const comments = await request(app).get(`/api/issues/${id1}/comments`);
    expect(comments.status).toBe(200);
    expect(comments.body).toEqual([]);
  });

  it('localized 工作区：POST /issues 与 PATCH 写落工作区库（中心库不再有该行），新卡按 id 仍可读', async () => {
    await localize();

    const created = await request(app).post('/api/issues').send(issuePayload(ws, { title: '迁移后新建' }));
    expect(created.status).toBe(200);
    const newId = created.body.id as string;

    const wsDb = probeWsDb(wsPath);
    expect((wsDb.prepare('SELECT COUNT(*) AS n FROM issue WHERE id=?').get(newId) as { n: number }).n).toBe(1);
    expect((t.db.prepare('SELECT COUNT(*) AS n FROM issue WHERE id=?').get(newId) as { n: number }).n).toBe(0);

    const patched = await request(app).patch(`/api/issues/${newId}`).send({ title: '改在工作区库' });
    expect(patched.status).toBe(200);
    expect((wsDb.prepare('SELECT title FROM issue WHERE id=?').get(newId) as { title: string }).title).toBe('改在工作区库');

    const show = await request(app).get(`/api/issues/${newId}`);
    expect(show.status).toBe(200);
    expect(show.body.title).toBe('改在工作区库');
  });

  it('未下沉工作区行为不变：读写全走中心库、不产生工作区库文件', async () => {
    const otherId = await mkIssue(otherWs, '别区卡');
    expect((t.db.prepare('SELECT COUNT(*) AS n FROM issue WHERE id=?').get(otherId) as { n: number }).n).toBe(1);
    const read = await request(app).get(`/api/issues/${otherId}`);
    expect(read.status).toBe(200);
    expect(read.body.title).toBe('别区卡');
    // 未下沉区不打开工作区库（无文件即无句柄）
    expect((await request(app).get('/api/version')).body.db_scope.localized_open).toEqual([]);
  });

  it('localizing 中间态：该区写 409 WORKSPACE_DB_MIGRATING、读继续（切库与写冻结共存）', async () => {
    const id = await mkIssue(ws, '迁移期卡');
    setMode(ws, 'localizing');

    const patched = await request(app).patch(`/api/issues/${id}`).send({ title: '不许改' });
    expect(patched.status).toBe(409);
    expect(patched.body.error.code).toBe('WORKSPACE_DB_MIGRATING');

    const created = await request(app).post('/api/issues').send(issuePayload(ws, { title: '不许建' }));
    expect(created.status).toBe(409);
    expect(created.body.error.code).toBe('WORKSPACE_DB_MIGRATING');

    const list = await request(app).get('/api/issues').query({ workspace: ws });
    expect(list.status).toBe(200);
    expect(list.body).toHaveLength(1);
    const show = await request(app).get(`/api/issues/${id}`);
    expect(show.status).toBe(200);
    expect(show.body.title).toBe('迁移期卡');

    // 其它工作区无感
    const otherId = await mkIssue(otherWs, '别区迁移期卡');
    expect(otherId).toBeTypeOf('string');
  });

  it('localized 工作区：知识 workspace 页落工作区库、common 页落中心库；按请求 scope 取库读写一致', async () => {
    await localize();

    // workspace 页：建到已下沉区 → 必须落工作区库
    const wsPage = await request(app).post('/api/knowledge/pages').send(pageBody({ scope: 'workspace', workspace_id: ws }));
    expect(wsPage.status).toBe(200);
    const wsPageId = wsPage.body.id as string;

    const wsDb = probeWsDb(wsPath);
    expect((wsDb.prepare('SELECT COUNT(*) AS n FROM knowledge_page WHERE id=?').get(wsPageId) as { n: number }).n).toBe(1);
    expect((t.db.prepare('SELECT COUNT(*) AS n FROM knowledge_page WHERE id=?').get(wsPageId) as { n: number }).n).toBe(0);

    // workspace scope 读：按请求取工作区库
    const detail = await request(app).get(`/api/knowledge/pages/${wsPageId}`).query({ scope: 'workspace', workspace_id: ws });
    expect(detail.status).toBe(200);
    expect(detail.body.title).toBe('切库区页标题机密');
    const search = await request(app).get('/api/knowledge/search').query({ scope: 'workspace', workspace_id: ws, q: '切库验收' });
    expect(search.status).toBe(200);
    expect(search.body.some((row: { page_id: string }) => row.page_id === wsPageId)).toBe(true);

    // workspace 页修订：写走工作区库（revision 推进且落位正确）
    const revised = await request(app).put(`/api/knowledge/pages/${wsPageId}`).send({ scope: 'workspace', workspace_id: ws, expected_revision: 1, body_md: '改在工作区库', actor: 'tester' });
    expect(revised.status).toBe(200);
    expect(revised.body.revision).toBe(2);

    // common 页：始终落中心库
    const commonPage = await request(app).post('/api/knowledge/pages').send(pageBody({ scope: 'common', title: '中心共页', slug: 'common-page' }));
    expect(commonPage.status).toBe(200);
    const commonPageId = commonPage.body.id as string;
    expect((t.db.prepare('SELECT COUNT(*) AS n FROM knowledge_page WHERE id=?').get(commonPageId) as { n: number }).n).toBe(1);
    const commonSearch = await request(app).get('/api/knowledge/search').query({ scope: 'common', q: '中心共页' });
    expect(commonSearch.status).toBe(200);
    expect(commonSearch.body.some((row: { page_id: string }) => row.page_id === commonPageId)).toBe(true);
  });

  it('跨区访问 403：文案不含他区标题（resolve 跨库 owner 探测，不泄露标题）', async () => {
    await localize();
    const wsPage = await request(app).post('/api/knowledge/pages').send(pageBody({ scope: 'workspace', workspace_id: ws }));
    expect(wsPage.status).toBe(200);
    const wsPageId = wsPage.body.id as string;
    const commonPage = await request(app).post('/api/knowledge/pages').send(pageBody({ scope: 'common', title: '中心共页', slug: 'common-page' }));
    expect(commonPage.status).toBe(200);
    const commonPageId = commonPage.body.id as string;

    // 已下沉区的 workspace 页：common scope 与「别区 workspace scope」都要 403，且响应不含标题
    for (const query of [{ scope: 'common' }, { scope: 'workspace', workspace_id: otherWs }]) {
      const res = await request(app).get('/api/knowledge/resolve').query({ ref: wsPageId, ...query });
      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe('KNOWLEDGE_SCOPE_FORBIDDEN');
      expect(JSON.stringify(res.body)).not.toContain('切库区页标题机密');
    }
    // 反向：common 页在 workspace scope 下 403（owner 探测命中中心库），同样不泄露标题
    const res = await request(app).get('/api/knowledge/resolve').query({ ref: commonPageId, scope: 'workspace', workspace_id: ws });
    expect(res.status).toBe(403);
    expect(JSON.stringify(res.body)).not.toContain('中心共页');
  });

  it('会话读路由：localized 区列表不 404；localize 后经 sessionManager 新建的自由会话（中心库）仍可见（并集兜底）', async () => {
    await localize();
    const list = await request(app).get('/api/sessions').query({ workspace: ws });
    expect(list.status).toBe(200);
    expect(list.body).toEqual([]);

    // 4d 前 sessionManager 仍写中心库：读侧并集兜底，新建会话不能因切库消失
    const created = await request(app).post('/api/sessions').send({ cli: 'codebuddy', workspace_id: ws });
    expect(created.status).toBe(200);
    const after = await request(app).get('/api/sessions').query({ workspace: ws });
    expect(after.status).toBe(200);
    expect(after.body.some((row: { id: string }) => row.id === created.body.id)).toBe(true);

    // 按 id 读（fan-out 定位：工作区库无 → 中心库补位）
    const show = await request(app).get(`/api/sessions/${created.body.id}`);
    expect(show.status).toBe(200);
    expect(show.body.id).toBe(created.body.id);
  });
});
