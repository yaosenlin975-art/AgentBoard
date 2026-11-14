/**
 * KB-PAGE-3：`knowledge_page.domain` 列（幂等加列）+ 词表校验 + 回填口径。
 *
 * 本卡只做「列 + 校验 + 回填机制」；真实 44 页的逐页归域是内容判断，见卡评论的分类表。
 * P2-01：新页走文件事实源（REST）；「迁移幂等 / initSchema 列存在」两条属旧库只读回退层
 * （legacyKnowledge 夹具显式建旧表结构）。
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
import { initSchema } from '../src/db/schema.js';
import { KNOWLEDGE_DOMAINS, migrateKnowledge } from '../src/db/migrations/knowledge.js';
import { normalizeKnowledgeDomain } from '../src/db/repos/knowledge.js';
import { createWorkspace } from '../src/db/repos/workspace.js';

describe('KB-PAGE-3 domain 列与词表', () => {
  let t: TestDb;
  let app: Express;
  let root: string;

  const restBody = (over: Record<string, unknown> = {}) => ({
    domain: 'knowledge',
    scope: 'common',
    slug: `slug-${Math.random().toString(36).slice(2, 8)}`,
    title: '标题',
    body_md: '正文',
    sources: [{ source_id: 'file:README.md', source_type: 'file', locator: 'README.md', captured_at: 1, content_hash: 'a'.repeat(64) }],
    evidence: [{ source_id: 'file:README.md', locator: 'file:1-20' }],
    actor: 'tester',
    ...over,
  });

  beforeEach(async () => {
    t = createTestDb({ legacyKnowledge: true });
    root = mkdtempSync(join(tmpdir(), 'agentboard-kb3-'));
    const adapter = new FakeAdapter();
    const created = await createApp({ db: t.db, getAdapter: (_id: string): AgentAdapter => adapter, adapters: [adapter], refreshClisOnBoot: false });
    app = created.app;
  });
  afterEach(() => {
    t.cleanup();
    rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  });

  it('迁移幂等：跑两次结构不变、页数/revision 不变（旧库只读回退层）', () => {
    const wsPath = join(root, 'ws');
    mkdirSync(wsPath, { recursive: true });
    const ws = createWorkspace(t.db, { name: '区', path: wsPath }).id;
    // 直接落旧库行（legacy 层验证的是迁移幂等，不经文件仓储）
    t.db.prepare(`INSERT INTO knowledge_page (id,scope,workspace_id,slug,title,body_md,status,revision,expires_at,created_by,updated_by,created_at,updated_at,category,landed,domain)
      VALUES ('p1','workspace',?,'s1','t','b','active',1,NULL,'x','x',1,1,'open',NULL,'knowledge')`).run(ws);
    t.db.prepare(`INSERT INTO knowledge_revision (id,page_id,revision,title_snapshot,body_snapshot,sources_json,evidence_json,change_kind,status_snapshot,expires_at_snapshot,change_note,actor,created_at)
      VALUES ('r1','p1',1,'t','b','[]','[]','create','active',NULL,'','x',1)`);

    const columns = () => (t.db.prepare('PRAGMA table_info(knowledge_page)').all() as Array<{ name: string }>).map((c) => c.name);
    const counts = () => ({
      pages: (t.db.prepare('SELECT COUNT(*) AS n FROM knowledge_page').get() as { n: number }).n,
      revisions: (t.db.prepare('SELECT COUNT(*) AS n FROM knowledge_revision').get() as { n: number }).n,
    });
    const before = { columns: columns(), counts: counts() };
    migrateKnowledge(t.db);
    const afterFirst = { columns: columns(), counts: counts() };
    migrateKnowledge(t.db);
    const afterSecond = { columns: columns(), counts: counts() };

    expect(afterFirst.columns).toEqual(before.columns);
    expect(afterSecond.columns).toEqual(before.columns);
    expect(afterFirst.columns).toContain('domain');
    expect(afterSecond.counts).toEqual(before.counts);
  });

  // KB-CR-1：创建强制归域（KB-PAGE-3 时只校验非空，现在缺省即 400）
  it('KB-CR-1：创建必填 domain——缺省 / null / 空串 → 中文 400 并列出词表；合法值原样落库', async () => {
    const withDomain = await request(app).post('/api/knowledge/pages').send(restBody({ domain: 'accounts' }));
    expect(withDomain.status).toBe(200);
    expect(withDomain.body.domain).toBe('accounts');
    expect(KNOWLEDGE_DOMAINS).toEqual(['accounts', 'knowledge', 'board', 'chat', 'ui', 'infra']);

    const body = restBody({ slug: 'no-domain' });
    delete (body as Record<string, unknown>).domain;
    for (const patch of [{}, { domain: null }, { domain: '' }]) {
      const res = await request(app).post('/api/knowledge/pages').send({ ...body, ...patch });
      expect(res.status, JSON.stringify(patch)).toBe(400);
      expect(res.body.error.message).toContain('创建知识页必须指定 domain');
      expect(res.body.error.message).toContain('infra');
    }
    // 落库断言：三条都被拒，没留下半成品（文件事实源：列表里没有 no-domain）
    const list = await request(app).get('/api/knowledge/pages').query({ scope: 'common', status: 'all' });
    expect((list.body.items as Array<{ slug: string }>).some(item => item.slug === 'no-domain')).toBe(false);
  });

  it('domain 非法 → 中文报错并列出词表（服务层校验，不加 schema CHECK）', async () => {
    expect(() => normalizeKnowledgeDomain('bogus')).toThrow(/accounts \/ knowledge \/ board \/ chat \/ ui \/ infra/);
    const res = await request(app).post('/api/knowledge/pages').send(restBody({ slug: 'bad-domain', domain: 'bogus' }));
    expect(res.status).toBe(400);
    expect(res.body.error.message).toContain('domain 只能是');
    expect(res.body.error.message).toContain('infra');
  });

  it('revise 可改 domain，且不改 slug（CAS）', async () => {
    const created = await request(app).post('/api/knowledge/pages').send(restBody({ domain: 'board' }));
    expect(created.status).toBe(200);
    const res = await request(app).put(`/api/knowledge/pages/${created.body.id}`).send({
      scope: 'common', actor: 'tester', expected_revision: created.body.revision, domain: 'infra',
    });
    expect(res.status).toBe(200);
    expect(res.body.domain).toBe('infra');
    expect(res.body.slug).toBe(created.body.slug);
  });

  it('initSchema 后 domain 列存在且默认 NULL（老页不被改写）', () => {
    const cols = (t.db.prepare('PRAGMA table_info(knowledge_page)').all() as Array<{ name: string }>).map((c) => c.name);
    expect(cols).toContain('domain');
    initSchema(t.db);
    const cols2 = (t.db.prepare('PRAGMA table_info(knowledge_page)').all() as Array<{ name: string }>).map((c) => c.name);
    expect(cols2.filter((c) => c === 'domain')).toHaveLength(1);
  });
});
