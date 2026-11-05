/**
 * BORROW-3.2：知识深链 /k/:id/:slug 与 ?kb=（服务端路由）。
 * id 权威、slug 任意值忽略；uuid 预检三态（404/410/回壳）；非 uuid 回壳交前端 resolve；
 * 无权限工作区页不泄露标题（深链壳 200 不含标题 + detail API 403 不含标题）。
 */
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
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

describe('BORROW-3.2 知识深链', () => {
  let t: TestDb;
  let app: Express;
  let root: string;
  let webDist: string;
  let ws: string;

  const mk = (input: { scope: 'common' } | { scope: 'workspace'; workspace_id: string }, slug: string, title: string) => createKnowledgePage(t.db, { domain: 'knowledge',
    ...input,
    slug,
    title,
    body_md: '深链正文 机密标题占位',
    sources: [{ source_id: 'file:README.md', source_type: 'file', locator: 'README.md', captured_at: 1, content_hash: 'a'.repeat(64) }],
    evidence: [{ source_id: 'file:README.md', locator: 'file:1-20' }],
    actor: 'tester',
  });

  beforeEach(async () => {
    t = createTestDb();
    root = mkdtempSync(join(tmpdir(), 'agentboard-kdl-'));
    // 假 dist：深链路由回壳用（与 webDist 托管条件一致）
    webDist = join(root, 'dist');
    mkdirSync(webDist, { recursive: true });
    writeFileSync(join(webDist, 'index.html'), '<!doctype html><html><body>SPA-SHELL</body></html>');
    const adapter = new FakeAdapter();
    const created = await createApp({ db: t.db, getAdapter: (_id: string): AgentAdapter => adapter, adapters: [adapter], refreshClisOnBoot: false, webDist });
    app = created.app;
    const spaceDir = join(root, 'space');
    mkdirSync(spaceDir, { recursive: true });
    ws = createWorkspace(t.db, { name: '主区', path: spaceDir }).id;
  });
  afterEach(() => {
    t.cleanup();
    rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  });

  it('/k/<uuid> 与 /k/<uuid>/<任意slug> 回壳 200（id 权威、slug 不符不报错）', async () => {
    const page = mk({ scope: 'common' }, 'deep-slug', '深链页');
    const direct = await request(app).get(`/k/${page.id}`);
    expect(direct.status).toBe(200);
    expect(direct.headers['content-type']).toContain('text/html');
    expect(direct.text).toContain('SPA-SHELL');

    // slug 段任意值（含与真实 slug 不符）都由 id 权威解析，不报错
    const wrongSlug = await request(app).get(`/k/${page.id}/not-the-real-slug`);
    expect(wrongSlug.status).toBe(200);
    expect(wrongSlug.text).toContain('SPA-SHELL');
  });

  it('uuid 不存在 → 404 纯文本；已删除 → 410（均不泄露标题）', async () => {
    const missing = await request(app).get('/k/00000000-0000-4000-8000-000000000000');
    expect(missing.status).toBe(404);
    expect(missing.text).toContain('知识页不存在');

    const page = mk({ scope: 'common' }, 'gone-deep', '将被删除的机密标题');
    t.db.prepare("UPDATE knowledge_page SET status='deleted' WHERE id=?").run(page.id);
    const gone = await request(app).get(`/k/${page.id}`);
    expect(gone.status).toBe(410);
    expect(gone.text).toContain('知识页已删除');
    expect(gone.text).not.toContain('机密标题');
  });

  it('workspace 页深链回壳 200 不泄露标题；无权限上下文的 detail API 403 也不泄露标题', async () => {
    const page = mk({ scope: 'workspace', workspace_id: ws }, 'secret-deep', '工作区机密标题');
    const shell = await request(app).get(`/k/${page.id}/随便-slug`);
    expect(shell.status).toBe(200);
    expect(shell.text).toContain('SPA-SHELL');
    expect(shell.text).not.toContain('机密标题');

    // 权限校验由 API 层承担（跨工作区上下文 resolve → 403 且不回显标题；detail 路由 404 隐藏存在性）
    const otherDir = join(root, 'other');
    mkdirSync(otherDir, { recursive: true });
    const other = createWorkspace(t.db, { name: '别区', path: otherDir }).id;
    const denied = await request(app).get('/api/knowledge/resolve').query({ ref: page.id, scope: 'workspace', workspace_id: other });
    expect(denied.status).toBe(403);
    expect(JSON.stringify(denied.body)).not.toContain('机密标题');
  });

  it('非 uuid 引用（短 id 前缀）回壳交前端 resolve；?kb= 由前端解析不受服务端路由影响', async () => {
    const page = mk({ scope: 'common' }, 'short-deep', '短链页');
    const shell = await request(app).get(`/k/${page.id.slice(0, 8)}`);
    expect(shell.status).toBe(200);
    expect(shell.text).toContain('SPA-SHELL');

    // ?kb=<id> 不经过服务端深链路由（普通 GET / 回壳；SPA 内部读 query）——路径本身仍是 /
    const home = await request(app).get('/?kb=' + page.id);
    expect(home.status).toBe(200);
    expect(home.text).toContain('SPA-SHELL');
  });
});
