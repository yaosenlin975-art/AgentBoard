import express, { type Express } from 'express';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createRouter, errorHandler } from '../src/api/routes.js';
import { createTestDb, type TestDb } from './helpers.js';
import { createWorkspace } from '../src/db/repos/workspace.js';
import { normalizePageCategory } from '../src/db/repos/knowledge.js';

/**
 * KB-MODEL 服务端：category / landed 的落库、校验、投影（列表 / 详情 / 星图）。
 * 落库规则见 `normalizePageCategory`：缺省 legacy；design 缺 landed → proposed；非 design 的 landed 一律 null。
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

  it('缺省 category → legacy + landed=null（不阻断写入）', async () => {
    const created = await request(app).post('/api/knowledge/pages').send(base('legacy-page'));
    expect(created.status).toBe(200);
    expect(created.body.category).toBe('legacy');
    expect(created.body.landed).toBeNull();
  });

  it('design 缺 landed → 落 proposed（fail-open），并在响应里回显', async () => {
    const created = await request(app).post('/api/knowledge/pages').send(base('design-no-landed', { category: 'design' }));
    expect(created.status).toBe(200);
    expect(created.body.category).toBe('design');
    expect(created.body.landed).toBe('proposed');
  });

  it('非 design 带 landed → landed 置 null（solved/pinned/open/legacy 没有落地状态）', async () => {
    const solved = await request(app).post('/api/knowledge/pages').send(base('solved-page', { category: 'solved', landed: 'landed' }));
    expect(solved.status).toBe(200);
    expect(solved.body.category).toBe('solved');
    expect(solved.body.landed).toBeNull();
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

  it('normalizePageCategory：纯函数逐值（legacy 兜底 / design 默认 proposed）', () => {
    expect(normalizePageCategory(undefined, undefined)).toEqual({ category: 'legacy', landed: null });
    expect(normalizePageCategory('weird', 'landed')).toEqual({ category: 'legacy', landed: null });
    expect(normalizePageCategory('design', undefined)).toEqual({ category: 'design', landed: 'proposed' });
    expect(normalizePageCategory('design', 'weird')).toEqual({ category: 'design', landed: 'proposed' });
    expect(normalizePageCategory('design', 'landed')).toEqual({ category: 'design', landed: 'landed' });
    expect(normalizePageCategory('open', 'landed')).toEqual({ category: 'open', landed: null });
  });
});
