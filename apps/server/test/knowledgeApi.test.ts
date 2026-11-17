import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import request from 'supertest';
import { beforeEach, afterEach, describe, expect, it } from 'vitest';
import { createKnowledgeRestFixture } from './helpers.js';

/**
 * P2-01：知识 REST 全部走文件事实源（Docs/*.md）——夹具用临时工作区目录 + 公共 Docs 注入。
 * page_commit 每页 git 快照随文件仓储退役（响应 committed=false + skipped=true）；
 * /revisions 返回空集（§8 #5 放弃单页历史）；
 * 外部编辑（绕过 API 改文件）→ 下次写 409 KNOWLEDGE_FILE_CONFLICT。
 */
describe('knowledge REST', () => {
  let f: ReturnType<typeof createKnowledgeRestFixture>; let a: string; let b: string;
  beforeEach(() => { f = createKnowledgeRestFixture(); a = f.a; b = f.b; });
  afterEach(() => f.cleanup());
  const body = () => ({ domain: 'knowledge', scope: 'workspace', workspace_id: a, slug: 'cache', title: '缓存知识', body_md: '缓存失效后 WAL', actor: 'codex', sources: [{ source_id: 's', source_type: 'agent', locator: 'issue:1', captured_at: 1, content_hash: '0123456789abcdef'.repeat(4), snapshot: 'verified' }], evidence: [{ source_id: 's', locator: 'issue:1' }] });
  it('knowledgePageRouteRejectsOtherWorkspace and explicit scope validation', async () => {
    const created = await request(f.app).post('/api/knowledge/pages').send(body()); expect(created.status).toBe(200);
    // 验收探针：POST 后 Docs/<slug>.md 真实落盘且回读正文一致
    const docPath = join(f.docsOf(a), 'cache.md');
    expect(readFileSync(docPath, 'utf8')).toContain('缓存失效后 WAL');
    expect((await request(f.app).get(`/api/knowledge/pages/${created.body.id}`).query({ scope: 'workspace', workspace_id: b })).status).toBe(404);
    expect((await request(f.app).get(`/api/knowledge/pages/${created.body.id}`)).status).toBe(400);
    expect((await request(f.app).post('/api/knowledge/pages').send({ ...body(), scope: 'common' })).status).toBe(400);
    expect((await request(f.app).post('/api/knowledge/pages').send(body())).status).toBe(409);
    // P2-01 过渡态：删空间占用只看旧库行（文件页不阻断，Docs 文件留在盘上不丢）；
    // 文件页占用判定归 P2-04 契约收口
    expect((await request(f.app).delete(`/api/workspaces/${a}`)).status).toBe(204);
  });
  it('reviseKnowledgeRouteReturns409ForStaleRevision and action lifecycle', async () => {
    const created = await request(f.app).post('/api/knowledge/pages').send(body()); const id = created.body.id;
    const scope = { scope: 'workspace', workspace_id: a };
    expect((await request(f.app).put(`/api/knowledge/pages/${id}`).send({ ...scope, expected_revision: 1, body_md: '修改', actor: 'dsh' })).body.revision).toBe(2);
    const stale = await request(f.app).put(`/api/knowledge/pages/${id}`).send({ ...scope, expected_revision: 1, title: 'stale', actor: 'codex' });
    expect(stale.status).toBe(409);
    expect(stale.body.error).toMatchObject({ code: 'KNOWLEDGE_REVISION_CONFLICT', details: { current_revision: 2 } });
    // §8 #5：文件事实源放弃单页历史——revisions 返回空集
    const history = await request(f.app).get(`/api/knowledge/pages/${id}/revisions`).query(scope); expect(history.body.items).toHaveLength(0);
    for (const [i, action] of ['archive', 'restore', 'delete'].entries()) expect((await request(f.app).post(`/api/knowledge/pages/${id}/actions`).send({ ...scope, expected_revision: 2 + i, action, actor: 'user' })).status).toBe(200);
    // 软删撤文件：删掉即不可寻址（404）
    expect((await request(f.app).get(`/api/knowledge/pages/${id}`).query(scope)).status).toBe(404);
  });
  it('scope-bound search list pagination and literal symbols', async () => {
    await request(f.app).post('/api/knowledge/pages').send(body());
    await request(f.app).post('/api/knowledge/pages').send({ ...body(), scope: 'common', workspace_id: undefined });
    await request(f.app).post('/api/knowledge/pages').send({ ...body(), workspace_id: b });
    const rows = await request(f.app).get('/api/knowledge/search').query({ q: '缓存', scope: 'both', workspace_id: a }); expect(rows.status).toBe(200); expect(rows.body).toHaveLength(2);
    const list = await request(f.app).get('/api/knowledge/pages').query({ scope: 'both', workspace_id: a, limit: 1 }); expect(list.body.items).toHaveLength(1); expect(list.body.next_offset).toBe(1);
    expect((await request(f.app).get('/api/knowledge/pages').query({ scope: 'common', workspace_id: a })).status).toBe(400);
    expect((await request(f.app).get('/api/knowledge/search').query({ scope: 'workspace', workspace_id: a, q: '', limit: 100 })).status).toBe(400);
  });
  it('external edit surfaces as 409 KNOWLEDGE_FILE_CONFLICT (write protocol L3)', async () => {
    const created = await request(f.app).post('/api/knowledge/pages').send(body());
    const scope = { scope: 'workspace', workspace_id: a };
    const docPath = join(f.docsOf(a), 'cache.md');
    // 外部编辑（绕过 API 改正文）→ 写前 content_hash 比对失败 → 409，不覆盖外部内容
    const original = readFileSync(docPath, 'utf8');
    const { writeFileSync } = await import('node:fs');
    writeFileSync(docPath, original.replace('缓存失效后 WAL', '外部改动'), 'utf8');
    const conflict = await request(f.app).put(`/api/knowledge/pages/${created.body.id}`).send({ ...scope, expected_revision: 1, body_md: '内部修改', actor: 'codex' });
    expect(conflict.status).toBe(409);
    expect(conflict.body.error.code).toBe('KNOWLEDGE_FILE_CONFLICT');
    expect(readFileSync(docPath, 'utf8')).toContain('外部改动');
  });
});
