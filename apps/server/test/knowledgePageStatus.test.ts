/**
 * KB-PAGE-1 缺陷 2/3：软删页与归档页的读语义、搜索结果补 slug/status。
 *
 * P2-01（文件事实源）语义更新：
 * - 软删 = 撤文件：删掉的页不可寻址（404），不再有 410「可查看历史」分支（§8 #5 放弃单页历史）；
 * - 归档 = front matter `status: archived`（文件保留），GET 仍 200 且带 status；
 * - search 结果带 slug/status 的契约不变。
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

describe('KB-PAGE-1 缺陷 2/3：deleted 读语义与 search 字段', () => {
  let t: TestDb;
  let app: Express;
  let root: string;

  const mkPage = async (slug: string, body = '正文内容 cache 关键词') => {
    const created = await request(app).post('/api/knowledge/pages').send({
      domain: 'knowledge', scope: 'common', slug, title: `标题 ${slug}`, body_md: body,
      sources: [{ source_id: 'file:README.md', source_type: 'file', locator: 'README.md', captured_at: 1, content_hash: 'a'.repeat(64) }],
      evidence: [{ source_id: 'file:README.md', locator: 'file:1-20' }],
      actor: 'tester',
    });
    expect(created.status).toBe(200);
    return created.body as { id: string; slug: string; revision: number };
  };

  beforeEach(async () => {
    t = createTestDb();
    root = mkdtempSync(join(tmpdir(), 'agentboard-kbpage1-'));
    const adapter = new FakeAdapter();
    const created = await createApp({ db: t.db, getAdapter: (_id: string): AgentAdapter => adapter, adapters: [adapter], refreshClisOnBoot: false, knowledgeDocsPaths: { commonDocsDir: () => join(root, 'common-docs') } });
    app = created.app;
  });
  afterEach(() => {
    t.cleanup();
    rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  });

  it('缺陷 2（P2-01 语义）：软删撤文件 → GET /pages/:id → 404（删掉即不可寻址）', async () => {
    const page = await mkPage('gone-page');
    const deleted = await request(app).post(`/api/knowledge/pages/${page.id}/actions`)
      .send({ scope: 'common', expected_revision: page.revision, action: 'delete', actor: 'tester' });
    expect(deleted.status).toBe(200);
    const res = await request(app).get(`/api/knowledge/pages/${page.id}`).query({ scope: 'common' });
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('KNOWLEDGE_NOT_FOUND');
  });

  it('缺陷 2：不存在的页仍是 404（不能把 404 也变成 410）', async () => {
    const res = await request(app).get('/api/knowledge/pages/does-not-exist').query({ scope: 'common' });
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('KNOWLEDGE_NOT_FOUND');
  });

  it('归档页 → 200 且带 status=archived（卡片可标「已归档」）', async () => {
    const page = await mkPage('archived-page');
    const archived = await request(app).post(`/api/knowledge/pages/${page.id}/actions`)
      .send({ scope: 'common', expected_revision: page.revision, action: 'archive', actor: 'tester' });
    expect(archived.status).toBe(200);
    const res = await request(app).get(`/api/knowledge/pages/${page.id}`).query({ scope: 'common' });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('archived');
  });

  it('缺陷 3：/api/knowledge/search 结果带 slug 与 status（只加字段）', async () => {
    await mkPage('search-target', '正文里有 cache 关键词');
    const res = await request(app).get('/api/knowledge/search').query({ scope: 'common', q: 'cache', limit: '5' });
    expect(res.status).toBe(200);
    expect(res.body.length).toBeGreaterThan(0);
    const hit = res.body[0];
    expect(hit.slug).toBe('search-target');
    expect(hit.status).toBe('active');
    // 既有字段不删
    expect(hit).toMatchObject({ page_id: expect.any(String), title: expect.any(String), revision: expect.any(Number) });
    expect(typeof hit.snippet).toBe('string');
  });
});
