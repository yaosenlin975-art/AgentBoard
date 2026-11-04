import express, { type Express } from 'express';
import request from 'supertest';
import { beforeEach, afterEach, describe, expect, it } from 'vitest';
import { createRouter, errorHandler } from '../src/api/routes.js';
import { createTestDb, type TestDb } from './helpers.js';
import { createWorkspace } from '../src/db/repos/workspace.js';

describe('knowledge REST', () => {
  let t: TestDb; let app: Express; let a: string; let b: string;
  beforeEach(() => {
    t = createTestDb(); a = createWorkspace(t.db, { name: 'A', path: 'A' }).id; b = createWorkspace(t.db, { name: 'B', path: 'B' }).id;
    app = express(); app.use(express.json()); app.use('/api', createRouter({ db: t.db, getAdapter: () => { throw Error('unused'); }, broadcast: () => {} })); app.use(errorHandler);
  });
  afterEach(() => t.cleanup());
  const body = () => ({ domain: 'knowledge', scope: 'workspace', workspace_id: a, slug: 'cache', title: '缓存知识', body_md: '缓存失效后 WAL', actor: 'codex', sources: [{ source_id: 's', source_type: 'agent', locator: 'issue:1', captured_at: 1, content_hash: 'a'.repeat(64), snapshot: 'verified' }], evidence: [{ source_id: 's', locator: 'issue:1' }] });
  it('knowledgePageRouteRejectsOtherWorkspace and explicit scope validation', async () => {
    const created = await request(app).post('/api/knowledge/pages').send(body()); expect(created.status).toBe(200);
    expect((await request(app).get(`/api/knowledge/pages/${created.body.id}`).query({ scope: 'workspace', workspace_id: b })).status).toBe(404);
    expect((await request(app).get(`/api/knowledge/pages/${created.body.id}`)).status).toBe(400);
    expect((await request(app).post('/api/knowledge/pages').send({ ...body(), scope: 'common' })).status).toBe(400);
    expect((await request(app).post('/api/knowledge/pages').send(body())).status).toBe(409);
    expect((await request(app).delete(`/api/workspaces/${a}`)).status).toBe(409);
  });
  it('reviseKnowledgeRouteReturns409ForStaleRevision and action history', async () => {
    const created = await request(app).post('/api/knowledge/pages').send(body()); const id = created.body.id;
    const scope = { scope: 'workspace', workspace_id: a };
    expect((await request(app).put(`/api/knowledge/pages/${id}`).send({ ...scope, expected_revision: 1, body_md: '修改', actor: 'dsh' })).body.revision).toBe(2);
    const stale = await request(app).put(`/api/knowledge/pages/${id}`).send({ ...scope, expected_revision: 1, title: 'stale', actor: 'codex' });
    expect(stale.status).toBe(409);
    expect(stale.body.error).toMatchObject({ code: 'KNOWLEDGE_REVISION_CONFLICT', details: { current_revision: 2 } });
    const history = await request(app).get(`/api/knowledge/pages/${id}/revisions`).query(scope); expect(history.body.items).toHaveLength(2);
    for (const [i, action] of ['archive', 'restore', 'delete'].entries()) expect((await request(app).post(`/api/knowledge/pages/${id}/actions`).send({ ...scope, expected_revision: 2 + i, action, actor: 'user' })).status).toBe(200);
  });
  it('scope-bound search list pagination and literal symbols', async () => {
    await request(app).post('/api/knowledge/pages').send(body());
    await request(app).post('/api/knowledge/pages').send({ ...body(), scope: 'common', workspace_id: undefined });
    await request(app).post('/api/knowledge/pages').send({ ...body(), workspace_id: b });
    const rows = await request(app).get('/api/knowledge/search').query({ q: '缓存', scope: 'both', workspace_id: a }); expect(rows.status).toBe(200); expect(rows.body).toHaveLength(2);
    const list = await request(app).get('/api/knowledge/pages').query({ scope: 'both', workspace_id: a, limit: 1 }); expect(list.body.items).toHaveLength(1); expect(list.body.next_offset).toBe(1);
    expect((await request(app).get('/api/knowledge/pages').query({ scope: 'common', workspace_id: a })).status).toBe(400);
    expect((await request(app).get('/api/knowledge/search').query({ scope: 'workspace', workspace_id: a, q: '', limit: 100 })).status).toBe(400);
  });
});
