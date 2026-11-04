/**
 * KB-PAGE-1 缺陷 2/3：软删页与归档页的读语义、搜索结果补 slug/status。
 *
 * 复现（修复前）：
 * - 软删（`status='deleted'`）的页 `GET /api/knowledge/pages/:id` 返回 **200 + 正常页**（当正常页渲染）；
 * - `GET /api/knowledge/search` 的结果没有 `slug`，前端只能拿标题/子串猜，`knowledge:<slug>` 无法精确命中。
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
import { createKnowledgePage, getKnowledgePage } from '../src/db/repos/knowledge.js';

describe('KB-PAGE-1 缺陷 2/3：deleted 读语义与 search 字段', () => {
  let t: TestDb;
  let app: Express;
  let root: string;

  const mkPage = (slug: string, body = '正文内容 cache 关键词') => createKnowledgePage(t.db, { domain: 'knowledge',
    scope: 'common',
    slug,
    title: `标题 ${slug}`,
    body_md: body,
    sources: [{ source_id: 'file:README.md', source_type: 'file', locator: 'README.md', captured_at: 1, content_hash: 'a'.repeat(64) }],
    evidence: [{ source_id: 'file:README.md', locator: 'file:1-20' }],
    actor: 'tester',
  });

  beforeEach(async () => {
    t = createTestDb();
    root = mkdtempSync(join(tmpdir(), 'agentboard-kbpage1-'));
    const adapter = new FakeAdapter();
    const created = await createApp({ db: t.db, getAdapter: (_id: string): AgentAdapter => adapter, adapters: [adapter], refreshClisOnBoot: false });
    app = created.app;
  });
  afterEach(() => {
    t.cleanup();
    rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  });

  it('缺陷 2：软删后 GET /pages/:id → 410 KNOWLEDGE_DELETED（不再是 200 正常页）', async () => {
    const page = mkPage('gone-page');
    t.db.prepare("UPDATE knowledge_page SET status='deleted' WHERE id=?").run(page.id);

    const res = await request(app).get(`/api/knowledge/pages/${page.id}`).query({ scope: 'common' });
    expect(res.status).toBe(410);
    expect(res.body.error.code).toBe('KNOWLEDGE_DELETED');
    expect(res.body.error.message).toContain('已删除');

    // 仓储层默认也不再返回它（防止别的读路径继续把 deleted 当正常页）
    expect(getKnowledgePage(t.db, page.id, { scope: 'common' })).toBeNull();
    // 需要区分「已删除」的调用方仍能取到（410 分支用）
    expect(getKnowledgePage(t.db, page.id, { scope: 'common' }, { includeDeleted: true })?.status).toBe('deleted');
  });

  it('缺陷 2：不存在的页仍是 404（不能把 404 也变成 410）', async () => {
    const res = await request(app).get('/api/knowledge/pages/does-not-exist').query({ scope: 'common' });
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('KNOWLEDGE_NOT_FOUND');
  });

  it('归档页 → 200 且带 status=archived（卡片可标「已归档」）', async () => {
    const page = mkPage('archived-page');
    t.db.prepare("UPDATE knowledge_page SET status='archived' WHERE id=?").run(page.id);
    const res = await request(app).get(`/api/knowledge/pages/${page.id}`).query({ scope: 'common' });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('archived');
  });

  it('缺陷 3：/api/knowledge/search 结果带 slug 与 status（只加字段）', async () => {
    mkPage('search-target', '正文里有 cache 关键词');
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
