/**
 * KB-PAGE-2：统一 resolve 四态 + link 字段 + 8 位前缀歧义。
 * 真 HTTP + 真临时库；四态对应 200 / 404 / 409 / 410，403 不回显标题。
 */
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
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
import { createKnowledgePage } from '../src/db/repos/knowledge.js';

describe('KB-PAGE-2 统一 resolve', () => {
  let t: TestDb;
  let app: Express;
  let root: string;
  let ws: string;

  const mk = (input: { scope: 'common' } | { scope: 'workspace'; workspace_id: string }, slug: string, title: string) => createKnowledgePage(t.db, {
    ...input,
    slug,
    title,
    body_md: '正文 cache 关键词',
    sources: [{ source_id: 'file:README.md', source_type: 'file', locator: 'README.md', captured_at: 1, content_hash: 'a'.repeat(64) }],
    evidence: [{ source_id: 'file:README.md', locator: 'file:1-20' }],
    actor: 'tester',
  });

  beforeEach(async () => {
    t = createTestDb();
    root = mkdtempSync(join(tmpdir(), 'agentboard-kb2-'));
    const adapter = new FakeAdapter();
    const created = await createApp({ db: t.db, getAdapter: (_id: string): AgentAdapter => adapter, adapters: [adapter], refreshClisOnBoot: false });
    app = created.app;
    const spaceDir = join(root, 'space');
    mkdirSync(spaceDir, { recursive: true });
    ws = createWorkspace(t.db, { name: '主区', path: spaceDir }).id;
  });
  afterEach(() => {
    t.cleanup();
    rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  });

  it('resolved：完整 id → 200 + link（knowledge:<uuid>）+ redirect_to=null', async () => {
    const page = mk({ scope: 'common' }, 'a-slug', '页 A');
    const res = await request(app).get('/api/knowledge/resolve').query({ ref: page.id, scope: 'common' });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ id: page.id, title: '页 A', scope: 'common', status: 'active', revision: 1, redirect_to: null });
    expect(res.body.link).toEqual({
      id: page.id, scope: 'common', workspace_id: null, slug: 'a-slug',
      ref: `knowledge:${page.id}`, markdown: `[页 A](knowledge:${page.id})`,
    });
  });

  it('not_found：未知 id → 404 KNOWLEDGE_NOT_FOUND', async () => {
    const res = await request(app).get('/api/knowledge/resolve').query({ ref: '00000000-0000-4000-8000-000000000000', scope: 'common' });
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('KNOWLEDGE_NOT_FOUND');
  });

  it('ambiguous：同 slug 在 common 与 workspace 各一份（默认 both）→ 409 + 候选 id', async () => {
    const a = mk({ scope: 'common' }, 'dup', '公共页');
    const b = mk({ scope: 'workspace', workspace_id: ws }, 'dup', '工作区页');
    const res = await request(app).get('/api/knowledge/resolve').query({ ref: 'dup', workspace_id: ws });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('KNOWLEDGE_REF_AMBIGUOUS');
    expect(res.body.error.details.candidates.sort()).toEqual([a.id, b.id].sort());
  });

  it('deleted：软删后 → 410 KNOWLEDGE_DELETED', async () => {
    const page = mk({ scope: 'common' }, 'gone', '将被删');
    t.db.prepare("UPDATE knowledge_page SET status='deleted' WHERE id=?").run(page.id);
    const res = await request(app).get('/api/knowledge/resolve').query({ ref: page.id, scope: 'common' });
    expect(res.status).toBe(410);
    expect(res.body.error.code).toBe('KNOWLEDGE_DELETED');
  });

  it('403：workspace 页属于别的工作区 → KNOWLEDGE_SCOPE_FORBIDDEN 且**不含标题**', async () => {
    const otherDir = join(root, 'other');
    mkdirSync(otherDir, { recursive: true });
    const other = createWorkspace(t.db, { name: '别区', path: otherDir }).id;
    const page = mk({ scope: 'workspace', workspace_id: other }, 'secret-slug', '机密标题');
    const res = await request(app).get('/api/knowledge/resolve').query({ ref: page.id, scope: 'workspace', workspace_id: ws });
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('KNOWLEDGE_SCOPE_FORBIDDEN');
    expect(JSON.stringify(res.body)).not.toContain('机密标题');
    expect(JSON.stringify(res.body)).not.toContain('secret-slug');
  });

  it('8 位 id 前缀：唯一命中解析到同一页；多命中 → 409（不猜）', async () => {
    const page = mk({ scope: 'common' }, 'pfx', '前缀页');
    const hit = await request(app).get('/api/knowledge/resolve').query({ ref: page.id.slice(0, 8), scope: 'common' });
    expect(hit.status).toBe(200);
    expect(hit.body.id).toBe(page.id);

    // 两页共享同一 8 位前缀：直接插入行（改 id 会触发 knowledge_revision 外键），resolve 只需 page 行
    const insert = t.db.prepare(`INSERT INTO knowledge_page
      (id,scope,workspace_id,slug,title,body_md,status,revision,expires_at,created_by,updated_by,created_at,updated_at,category,landed)
      VALUES (?,?,?,?,?,'正文','active',1,NULL,'t','t',1,1,'legacy',NULL)`);
    insert.run('deadbeef-0000-4000-8000-000000000001', 'common', null, 'pfx-a', '前缀 A');
    insert.run('deadbeef-0000-4000-8000-000000000002', 'common', null, 'pfx-b', '前缀 B');
    const amb = await request(app).get('/api/knowledge/resolve').query({ ref: 'deadbeef', scope: 'common' });
    expect(amb.status).toBe(409);
    expect(amb.body.error.code).toBe('KNOWLEDGE_REF_AMBIGUOUS');
    expect(amb.body.error.details.candidates).toHaveLength(2);
  });

  it('show 与 search 结果都带 link（KB-PAGE-2 A7）', async () => {
    const page = mk({ scope: 'common' }, 'linked', '带链接页');
    const shown = await request(app).get(`/api/knowledge/pages/${page.id}`).query({ scope: 'common' });
    expect(shown.body.link.ref).toBe(`knowledge:${page.id}`);
    const search = await request(app).get('/api/knowledge/search').query({ scope: 'common', q: 'cache', limit: '5' });
    expect(search.body[0].link).toMatchObject({ id: page.id, ref: `knowledge:${page.id}`, markdown: `[带链接页](knowledge:${page.id})` });
  });

  it('list/create/revise 响应都带 link（KB-PAGE-2b A7 全覆盖）', async () => {
    const page = mk({ scope: 'common' }, 'linked-list', '列表页');
    const list = await request(app).get('/api/knowledge/pages').query({ scope: 'common' });
    expect(list.body.items[0].link.ref).toBe(`knowledge:${page.id}`);

    const created = await request(app).post('/api/knowledge/pages').send({
      scope: 'common', slug: 'created-link', title: '新建页', body_md: '正文',
      sources: [{ source_id: 'file:README.md', source_type: 'file', locator: 'README.md', captured_at: 1, content_hash: 'a'.repeat(64) }],
      evidence: [{ source_id: 'file:README.md', locator: 'file:1-20' }], actor: 'tester',
    });
    expect(created.status).toBe(200);
    expect(created.body.link.ref).toBe(`knowledge:${created.body.id}`);

    const revised = await request(app).put(`/api/knowledge/pages/${page.id}`).send({ scope: 'common', expected_revision: 1, title: '改名页', actor: 'tester' });
    expect(revised.status).toBe(200);
    expect(revised.body.link).toMatchObject({ ref: `knowledge:${page.id}`, markdown: `[改名页](knowledge:${page.id})` });
  });

  it('find-source：按当前 revision 的 sources 反查，改名来源后旧路径不再命中', async () => {
    const page = mk({ scope: 'common' }, 'src-page', '引用页');
    const hit = await request(app).get('/api/knowledge/find-source').query({ path: 'README.md', scope: 'common' });
    expect(hit.status).toBe(200);
    expect(hit.body.items.map((item: { id: string }) => item.id)).toContain(page.id);
    expect(hit.body.items[0].link.ref).toBe(`knowledge:${page.id}`);

    const miss = await request(app).get('/api/knowledge/find-source').query({ path: 'NOT-REFERENCED.md', scope: 'common' });
    expect(miss.body.items).toEqual([]);

    // 修订 sources 后旧 locator 不再命中（只看当前 revision，历史版本不参与）
    const revised = await request(app).put(`/api/knowledge/pages/${page.id}`).send({
      scope: 'common', expected_revision: 1, actor: 'tester',
      sources: [{ source_id: 'file:CHANGELOG.md', source_type: 'file', locator: 'CHANGELOG.md', captured_at: 2, content_hash: 'b'.repeat(64) }],
      evidence: [{ source_id: 'file:CHANGELOG.md', locator: 'file:1-20' }],
    });
    expect(revised.status).toBe(200);
    const oldPath = await request(app).get('/api/knowledge/find-source').query({ path: 'README.md', scope: 'common' });
    expect(oldPath.body.items).toEqual([]);
    const newPath = await request(app).get('/api/knowledge/find-source').query({ path: 'CHANGELOG.md', scope: 'common' });
    expect(newPath.body.items.map((item: { id: string }) => item.id)).toContain(page.id);
  });
});
