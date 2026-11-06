import express, { type Express } from 'express';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/index.js';
import { resetSessionManager } from '../src/services/sessionManager.js';
import { createRouter, errorHandler } from '../src/api/routes.js';
import { createTestDb, type TestDb } from './helpers.js';
import { createWorkspace } from '../src/db/repos/workspace.js';
import { normalizePageCategory } from '../src/db/repos/knowledge.js';

/**
 * KB-MODEL 服务端：category / landed 的落库、校验、投影（列表 / 详情 / 星图）。
 * 落库规则见 `normalizePageCategory`：缺省 category → open；design 缺 landed → proposed；
 * KB-LANDED 起 category 与 landed 解耦：显式 landed 对任何 category 都原样落库。
 */
describe('knowledge category / landed（KB-MODEL）', () => {
  let t: TestDb;
  let app: Express;
  let workspaceId: string;
  beforeEach(() => {
    t = createTestDb();
    workspaceId = createWorkspace(t.db, { name: 'A', path: 'A' }).id;
    app = express();
    app.use(express.json());
    app.use('/api', createRouter({ db: t.db, getAdapter: () => { throw Error('unused'); }, broadcast: () => {} }));
    app.use(errorHandler);
  });
  afterEach(() => t.cleanup());

  const base = (slug: string, extra: Record<string, unknown> = {}) => ({
    domain: 'knowledge',
    scope: 'workspace',
    workspace_id: workspaceId,
    slug,
    title: `页 ${slug}`,
    body_md: `正文 ${slug}`,
    actor: 'dsh',
    sources: [{ source_id: 's', source_type: 'agent', locator: 'issue:1', captured_at: 1, content_hash: 'a'.repeat(64), snapshot: 'verified' }],
    evidence: [{ source_id: 's', locator: 'issue:1' }],
    ...extra,
  });
  const scope = () => ({ scope: 'workspace', workspace_id: workspaceId });

  it('新建：design + landed 原样落库，并在详情/列表/星图投影里带出', async () => {
    const created = await request(app).post('/api/knowledge/pages').send(base('design-page', { category: 'design', landed: 'partial' }));
    expect(created.status).toBe(200);
    expect(created.body.category).toBe('design');
    expect(created.body.landed).toBe('partial');

    const detail = await request(app).get(`/api/knowledge/pages/${created.body.id}`).query(scope());
    expect(detail.body.category).toBe('design');
    expect(detail.body.landed).toBe('partial');

    const list = await request(app).get('/api/knowledge/pages').query(scope());
    expect(list.body.items[0]).toMatchObject({ category: 'design', landed: 'partial' });

    const graph = await request(app).get('/api/knowledge/graph').query({ ...scope(), limit_nodes: 50, limit_edges: 50, edge_kinds: 'source,keyword', include_isolated: 'true' });
    expect(graph.status).toBe(200);
    const node = (graph.body.nodes as Array<{ id: string; category?: string; landed?: string }>).find((item) => item.id === created.body.id);
    expect(node).toMatchObject({ category: 'design', landed: 'partial' });
  });

  it('缺省 category → open + landed=null（不阻断写入；KB-CR-1 起不再兜底 legacy）', async () => {
    const created = await request(app).post('/api/knowledge/pages').send(base('legacy-page'));
    expect(created.status).toBe(200);
    expect(created.body.category).toBe('open');
    expect(created.body.landed).toBeNull();
  });

  it('design 缺 landed → 落 proposed（fail-open），并在响应里回显', async () => {
    const created = await request(app).post('/api/knowledge/pages').send(base('design-no-landed', { category: 'design' }));
    expect(created.status).toBe(200);
    expect(created.body.category).toBe('design');
    expect(created.body.landed).toBe('proposed');
  });

  it('KB-LANDED：非 design 带 landed 原样落库（过去被拒的 open+partial 组合）', async () => {
    const open = await request(app).post('/api/knowledge/pages').send(base('open-partial', { category: 'open', landed: 'partial' }));
    expect(open.status).toBe(200);
    expect(open.body).toMatchObject({ category: 'open', landed: 'partial' });
    const detail = await request(app).get(`/api/knowledge/pages/${open.body.id}`).query(scope());
    expect(detail.body).toMatchObject({ category: 'open', landed: 'partial' });

    const solved = await request(app).post('/api/knowledge/pages').send(base('solved-page', { category: 'solved', landed: 'landed' }));
    expect(solved.status).toBe(200);
    expect(solved.body).toMatchObject({ category: 'solved', landed: 'landed' });
  });

  it('KB-LANDED：修订非 design 页的 landed（partial→landed）成功且 revision +1', async () => {
    const created = await request(app).post('/api/knowledge/pages').send(base('open-revise', { category: 'open', landed: 'partial' }));
    const revised = await request(app).put(`/api/knowledge/pages/${created.body.id}`).send({ ...scope(), expected_revision: 1, landed: 'landed', actor: 'dsh' });
    expect(revised.status).toBe(200);
    expect(revised.body).toMatchObject({ category: 'open', landed: 'landed', revision: 2 });
    // 只改标题时保留既有非 design landed（不因 category 回退成 null）
    const kept = await request(app).put(`/api/knowledge/pages/${created.body.id}`).send({ ...scope(), expected_revision: 2, title: '改名', actor: 'dsh' });
    expect(kept.body).toMatchObject({ category: 'open', landed: 'landed', revision: 3 });
  });

  it('非法 category / landed → 400（zod enum 拒绝）', async () => {
    expect((await request(app).post('/api/knowledge/pages').send(base('bad-cat', { category: 'weird' }))).status).toBe(400);
    expect((await request(app).post('/api/knowledge/pages').send(base('bad-landed', { category: 'design', landed: 'done' }))).status).toBe(400);
    // 大小写不做宽容：只认小写字面量
    expect((await request(app).post('/api/knowledge/pages').send(base('upper', { category: 'DESIGN' }))).status).toBe(400);
  });

  it('修订：可改 category/landed，且非法值 400；未传则保持原值', async () => {
    const created = await request(app).post('/api/knowledge/pages').send(base('revise-me', { category: 'design', landed: 'proposed' }));
    const id = created.body.id;
    const revised = await request(app).put(`/api/knowledge/pages/${id}`).send({ ...scope(), expected_revision: 1, category: 'design', landed: 'landed', actor: 'dsh' });
    expect(revised.status).toBe(200);
    expect(revised.body).toMatchObject({ category: 'design', landed: 'landed', revision: 2 });

    const kept = await request(app).put(`/api/knowledge/pages/${id}`).send({ ...scope(), expected_revision: 2, title: '改名', actor: 'dsh' });
    expect(kept.body).toMatchObject({ category: 'design', landed: 'landed' });

    expect((await request(app).put(`/api/knowledge/pages/${id}`).send({ ...scope(), expected_revision: 3, category: 'nope', actor: 'dsh' })).status).toBe(400);
  });

  it('normalizePageCategory：纯函数逐值（缺省/非法兜底 open；design 默认 proposed；category 与 landed 解耦）', () => {
    expect(normalizePageCategory(undefined, undefined)).toEqual({ category: 'open', landed: null });
    expect(normalizePageCategory('weird', undefined)).toEqual({ category: 'open', landed: null });
    expect(normalizePageCategory('design', undefined)).toEqual({ category: 'design', landed: 'proposed' });
    expect(normalizePageCategory('design', 'weird')).toEqual({ category: 'design', landed: 'proposed' });
    expect(normalizePageCategory('design', 'landed')).toEqual({ category: 'design', landed: 'landed' });
    // KB-LANDED：任何 category 都接受显式 landed
    expect(normalizePageCategory('open', 'landed')).toEqual({ category: 'open', landed: 'landed' });
    expect(normalizePageCategory('solved', 'partial')).toEqual({ category: 'solved', landed: 'partial' });
    expect(normalizePageCategory('pinned', 'proposed')).toEqual({ category: 'pinned', landed: 'proposed' });
    expect(normalizePageCategory('legacy', 'landed')).toEqual({ category: 'legacy', landed: 'landed' });
    // 未传/非法 landed：非 design 仍为 null（不凭空造进度）
    expect(normalizePageCategory('open', undefined)).toEqual({ category: 'open', landed: null });
    expect(normalizePageCategory('solved', 'weird')).toEqual({ category: 'solved', landed: null });
  });
});

/**
 * RULE-3：契约变更必须能经真实 app 触达。用 `createApp` 装配完整路由（不是只挂 createRouter），
 * 对「过去会被强制置 null」的组合建/改各一条，断言 200 且回读值一致。
 */
describe('KB-LANDED 接线（真实 createApp）', () => {
  it('open+partial 组合经真实 app 创建与修订均 200', async () => {
    const t = createTestDb();
    try {
      const workspaceId = createWorkspace(t.db, { name: 'A', path: 'A' }).id;
      const { app } = await createApp({ db: t.db, refreshClisOnBoot: false });
      const payload = {
        domain: 'knowledge',
        scope: 'workspace',
        workspace_id: workspaceId,
        slug: 'open-partial-app',
        title: '真实 app 页',
        body_md: '正文',
        actor: 'dsh',
        sources: [{ source_id: 's', source_type: 'agent', locator: 'issue:1', captured_at: 1, content_hash: 'a'.repeat(64), snapshot: 'verified' }],
        evidence: [{ source_id: 's', locator: 'issue:1' }],
        category: 'open',
        landed: 'partial',
      };
      const created = await request(app).post('/api/knowledge/pages').send(payload);
      expect(created.status).toBe(200);
      expect(created.body).toMatchObject({ category: 'open', landed: 'partial' });

      const revised = await request(app).put(`/api/knowledge/pages/${created.body.id}`)
        .send({ scope: 'workspace', workspace_id: workspaceId, expected_revision: 1, landed: 'landed', actor: 'dsh' });
      expect(revised.status).toBe(200);
      expect(revised.body).toMatchObject({ category: 'open', landed: 'landed', revision: 2 });
    } finally {
      resetSessionManager();
      t.cleanup();
    }
  });
});
