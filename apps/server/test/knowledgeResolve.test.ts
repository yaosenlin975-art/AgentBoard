/**
 * KB-PAGE-2：统一 resolve 四态 + link 字段 + 8 位前缀歧义。
 * 真 HTTP + 真临时库；四态对应 200 / 404 / 410，403 不回显标题。
 * P2-01：数据源是 Docs/*.md——页面经 REST 创建落文件；跨工作区 403 由「扫全部注册工作区 Docs」判定。
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
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
import { KNOWLEDGE_SHORT_ID_LEN, docFileNameFor } from '@agentboard/shared';
import { renderDocWithHash } from '../src/knowledge/frontMatter.js';

describe('KB-PAGE-2 统一 resolve', () => {
  let t: TestDb;
  let app: Express;
  let root: string;
  let ws: string;
  let commonDocs: string;

  const restBody = (input: { scope: 'common' } | { scope: 'workspace'; workspace_id: string }, slug: string, title: string) => ({
    domain: 'knowledge',
    ...input,
    slug,
    title,
    body_md: '正文 cache 关键词',
    sources: [{ source_id: 'file:README.md', source_type: 'file', locator: 'README.md', captured_at: 1, content_hash: '0123456789abcdef'.repeat(4) }],
    evidence: [{ source_id: 'file:README.md', locator: 'file:1-20' }],
    actor: 'tester',
  });
  const mk = async (input: { scope: 'common' } | { scope: 'workspace'; workspace_id: string }, slug: string, title: string) => {
    const created = await request(app).post('/api/knowledge/pages').send(restBody(input, slug, title));
    expect(created.status).toBe(200);
    return created.body as { id: string; slug: string; revision: number };
  };
  /** 直接往公共 Docs 写一份合法 md（构造可控 id 的用例用） */
  const writeCommonDoc = (metaOverrides: Record<string, unknown>): string => {
    const meta = {
      id: '00000000-0000-4000-8000-000000000000', slug: 'crafted', title: '构造页', revision: 1,
      scope: 'common', workspace_id: null, status: 'active', domain: 'knowledge', category: 'open', landed: null,
      sources: [{ source_id: 's', source_type: 'file', locator: 'README.md', captured_at: 1, content_hash: '0123456789abcdef'.repeat(4) }],
      evidence: [{ source_id: 's', locator: 'README.md' }],
      expires_at: null, created_at: 1, updated_at: 1, created_by: 't', updated_by: 't', change_note: '',
      ...metaOverrides,
    } as Parameters<typeof renderDocWithHash>[0];
    const { content } = renderDocWithHash(meta, '正文');
    const path = join(commonDocs, docFileNameFor(meta.slug as string));
    writeFileSync(path, content, 'utf8');
    return path;
  };

  beforeEach(async () => {
    t = createTestDb();
    root = mkdtempSync(join(tmpdir(), 'agentboard-kb2-'));
    commonDocs = join(root, 'common-docs');
    mkdirSync(commonDocs, { recursive: true });
    const adapter = new FakeAdapter();
    const created = await createApp({ db: t.db, getAdapter: (_id: string): AgentAdapter => adapter, adapters: [adapter], refreshClisOnBoot: false, knowledgeDocsPaths: { commonDocsDir: () => commonDocs } });
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
    const page = await mk({ scope: 'common' }, 'a-slug', '页 A');
    const res = await request(app).get('/api/knowledge/resolve').query({ ref: page.id, scope: 'common' });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ id: page.id, title: '页 A', scope: 'common', status: 'active', revision: 1, redirect_to: null });
    // BORROW-3.1（D10）：link 收敛为引用串；旧对象字段以 link_info 兼容期保留
    expect(res.body.link).toBe(`knowledge:${page.id}`);
    expect(res.body.link_info).toEqual({
      id: page.id, scope: 'common', workspace_id: null, slug: 'a-slug',
      ref: `knowledge:${page.id}`, markdown: `[知识卡：页 A](knowledge:${page.id})`,
      text: `知识卡《页 A》 knowledge:${page.id} · rev:1`,
    });
  });

  it('not_found：未知 id → 404 KNOWLEDGE_NOT_FOUND', async () => {
    const res = await request(app).get('/api/knowledge/resolve').query({ ref: '00000000-0000-4000-8000-000000000000', scope: 'common' });
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('KNOWLEDGE_NOT_FOUND');
  });

  it('ambiguous：同 slug 在 common 与 workspace 各一份（默认 both）→ 409 + 候选 id', async () => {
    const a = await mk({ scope: 'common' }, 'dup', '公共页');
    const b = await mk({ scope: 'workspace', workspace_id: ws }, 'dup', '工作区页');
    const res = await request(app).get('/api/knowledge/resolve').query({ ref: 'dup', workspace_id: ws });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('KNOWLEDGE_REF_AMBIGUOUS');
    expect(res.body.error.details.candidates.sort()).toEqual([a.id, b.id].sort());
  });

  it('deleted（P2-01 语义）：软删撤文件 → 404（删掉即不可寻址）', async () => {
    const page = await mk({ scope: 'common' }, 'gone', '将被删');
    const del = await request(app).post(`/api/knowledge/pages/${page.id}/actions`)
      .send({ scope: 'common', expected_revision: page.revision, action: 'delete', actor: 'tester' });
    expect(del.status).toBe(200);
    const res = await request(app).get('/api/knowledge/resolve').query({ ref: page.id, scope: 'common' });
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('KNOWLEDGE_NOT_FOUND');
  });

  it('403：workspace 页属于别的工作区 → KNOWLEDGE_SCOPE_FORBIDDEN 且**不含标题**', async () => {
    const otherDir = join(root, 'other');
    mkdirSync(otherDir, { recursive: true });
    const other = createWorkspace(t.db, { name: '别区', path: otherDir }).id;
    const page = await mk({ scope: 'workspace', workspace_id: other }, 'secret-slug', '机密标题');
    const res = await request(app).get('/api/knowledge/resolve').query({ ref: page.id, scope: 'workspace', workspace_id: ws });
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('KNOWLEDGE_SCOPE_FORBIDDEN');
    expect(JSON.stringify(res.body)).not.toContain('机密标题');
    expect(JSON.stringify(res.body)).not.toContain('secret-slug');
  });

  it('8 位 id 前缀：唯一命中解析到同一页；多命中 → 409（不猜）', async () => {
    const page = await mk({ scope: 'common' }, 'pfx', '前缀页');
    const hit = await request(app).get('/api/knowledge/resolve').query({ ref: page.id.slice(0, KNOWLEDGE_SHORT_ID_LEN), scope: 'common' });
    expect(hit.status).toBe(200);
    expect(hit.body.id).toBe(page.id);

    // 两页共享同一 8 位前缀：直接写两份合法 md（文件事实源下无 knowledge_revision 外键约束）
    writeCommonDoc({ id: 'deadbeef-0000-4000-8000-000000000001', slug: 'pfx-a', title: '前缀 A' });
    writeCommonDoc({ id: 'deadbeef-0000-4000-8000-000000000002', slug: 'pfx-b', title: '前缀 B' });
    const amb = await request(app).get('/api/knowledge/resolve').query({ ref: 'deadbeef', scope: 'common' });
    expect(amb.status).toBe(409);
    expect(amb.body.error.code).toBe('KNOWLEDGE_REF_AMBIGUOUS');
    expect(amb.body.error.details.candidates).toHaveLength(2);
  });

  it('show 与 search 结果都带 link（KB-PAGE-2 A7）', async () => {
    const page = await mk({ scope: 'common' }, 'linked', '带链接页');
    const shown = await request(app).get(`/api/knowledge/pages/${page.id}`).query({ scope: 'common' });
    expect(shown.body.link).toBe(`knowledge:${page.id}`);
    expect(shown.body.link_info.markdown).toBe(`[知识卡：带链接页](knowledge:${page.id})`);
    const search = await request(app).get('/api/knowledge/search').query({ scope: 'common', q: 'cache', limit: '5' });
    expect(search.body[0].link).toBe(`knowledge:${page.id}`);
    expect(search.body[0].link_info).toMatchObject({ id: page.id, ref: `knowledge:${page.id}`, markdown: `[知识卡：带链接页](knowledge:${page.id})` });
  });

  it('list/create/revise 响应都带 link（KB-PAGE-2b A7 全覆盖）', async () => {
    const page = await mk({ scope: 'common' }, 'linked-list', '列表页');
    const list = await request(app).get('/api/knowledge/pages').query({ scope: 'common' });
    expect(list.body.items[0].link).toBe(`knowledge:${page.id}`);

    const created = await request(app).post('/api/knowledge/pages').send(restBody({ scope: 'common' }, 'created-link', '新建页'));
    expect(created.status).toBe(200);
    expect(created.body.link).toBe(`knowledge:${created.body.id}`);

    const revised = await request(app).put(`/api/knowledge/pages/${page.id}`).send({ scope: 'common', expected_revision: 1, title: '改名页', actor: 'tester' });
    expect(revised.status).toBe(200);
    expect(revised.body.link).toBe(`knowledge:${page.id}`);
    expect(revised.body.link_info.text).toBe(`知识卡《改名页》 knowledge:${page.id} · rev:2`);
  });

  it('find-source：按当前 front matter sources 反查，改 sources 后旧 locator 不再命中', async () => {
    const page = await mk({ scope: 'common' }, 'src-page', '引用页');
    const hit = await request(app).get('/api/knowledge/find-source').query({ path: 'README.md', scope: 'common' });
    expect(hit.status).toBe(200);
    expect(hit.body.items.map((item: { id: string }) => item.id)).toContain(page.id);
    expect(hit.body.items[0].link).toBe(`knowledge:${page.id}`);

    const miss = await request(app).get('/api/knowledge/find-source').query({ path: 'NOT-REFERENCED.md', scope: 'common' });
    expect(miss.body.items).toEqual([]);

    // 修订 sources 后旧 locator 不再命中（只看当前 front matter，无历史版本）
    const revised = await request(app).put(`/api/knowledge/pages/${page.id}`).send({
      scope: 'common', expected_revision: 1, actor: 'tester',
      sources: [{ source_id: 'file:CHANGELOG.md', source_type: 'file', locator: 'CHANGELOG.md', captured_at: 2, content_hash: '0123456789abcdef'.repeat(4) }],
      evidence: [{ source_id: 'file:CHANGELOG.md', locator: 'file:1-20' }],
    });
    expect(revised.status).toBe(200);
    const oldPath = await request(app).get('/api/knowledge/find-source').query({ path: 'README.md', scope: 'common' });
    expect(oldPath.body.items).toEqual([]);
    const newPath = await request(app).get('/api/knowledge/find-source').query({ path: 'CHANGELOG.md', scope: 'common' });
    expect(newPath.body.items.map((item: { id: string }) => item.id)).toContain(page.id);
  });
});
