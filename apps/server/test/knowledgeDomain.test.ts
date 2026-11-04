/**
 * KB-PAGE-3：`knowledge_page.domain` 列（幂等加列）+ 词表校验 + 回填口径。
 *
 * 本卡只做「列 + 校验 + 回填机制」；真实 44 页的逐页归域是内容判断，见卡评论的分类表。
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
import { createKnowledgePage, normalizeKnowledgeDomain } from '../src/db/repos/knowledge.js';
import { createWorkspace } from '../src/db/repos/workspace.js';

describe('KB-PAGE-3 domain 列与词表', () => {
  let t: TestDb;
  let app: Express;
  let root: string;

  const page = (over: Record<string, unknown> = {}) => createKnowledgePage(t.db, {
    scope: 'common',
    slug: `slug-${Math.random().toString(36).slice(2, 8)}`,
    title: '标题',
    body_md: '正文',
    sources: [{ source_id: 'file:README.md', source_type: 'file', locator: 'README.md', captured_at: 1, content_hash: 'a'.repeat(64) }],
    evidence: [{ source_id: 'file:README.md', locator: 'file:1-20' }],
    actor: 'tester',
    ...over,
  } as never);

  beforeEach(async () => {
    t = createTestDb();
    root = mkdtempSync(join(tmpdir(), 'agentboard-kb3-'));
    const adapter = new FakeAdapter();
    const created = await createApp({ db: t.db, getAdapter: (_id: string): AgentAdapter => adapter, adapters: [adapter], refreshClisOnBoot: false });
    app = created.app;
  });
  afterEach(() => {
    t.cleanup();
    rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  });

  it('迁移幂等：跑两次结构不变、页数/revision 不变', () => {
    const wsPath = join(root, 'ws');
    mkdirSync(wsPath, { recursive: true });
    const ws = createWorkspace(t.db, { name: '区', path: wsPath }).id;
    page({ scope: 'workspace', workspace_id: ws });

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

  it('domain 词表：合法值落库，NULL 表示未归', () => {
    const withDomain = page({ domain: 'accounts' }) as unknown as { domain: string | null };
    expect(withDomain.domain).toBe('accounts');
    const withoutDomain = page() as unknown as { domain: string | null };
    expect(withoutDomain.domain).toBeNull();
    expect(KNOWLEDGE_DOMAINS).toEqual(['accounts', 'knowledge', 'board', 'chat', 'ui', 'infra']);
  });

  it('domain 非法 → 中文报错并列出词表（服务层校验，不加 schema CHECK）', async () => {
    expect(() => normalizeKnowledgeDomain('bogus')).toThrow(/accounts \/ knowledge \/ board \/ chat \/ ui \/ infra/);
    const res = await request(app).post('/api/knowledge/pages').send({
      scope: 'common', slug: 'bad-domain', title: '标题', body_md: '正文', domain: 'bogus',
      sources: [{ source_id: 'file:README.md', source_type: 'file', locator: 'README.md', captured_at: 1, content_hash: 'a'.repeat(64) }],
      evidence: [{ source_id: 'file:README.md', locator: 'file:1-20' }], actor: 'tester',
    });
    expect(res.status).toBe(400);
    expect(res.body.error.message).toContain('domain 只能是');
    expect(res.body.error.message).toContain('infra');
  });

  it('revise 可改 domain，且不改 slug（CAS）', async () => {
    const created = page({ domain: 'board' }) as unknown as { id: string; slug: string; revision: number };
    const res = await request(app).put(`/api/knowledge/pages/${created.id}`).send({
      scope: 'common', actor: 'tester', expected_revision: created.revision, domain: 'infra',
    });
    expect(res.status).toBe(200);
    expect(res.body.domain).toBe('infra');
    expect(res.body.slug).toBe(created.slug);
  });

  it('initSchema 后 domain 列存在且默认 NULL（老页不被改写）', () => {
    const cols = (t.db.prepare('PRAGMA table_info(knowledge_page)').all() as Array<{ name: string }>).map((c) => c.name);
    expect(cols).toContain('domain');
    initSchema(t.db);
    const cols2 = (t.db.prepare('PRAGMA table_info(knowledge_page)').all() as Array<{ name: string }>).map((c) => c.name);
    expect(cols2.filter((c) => c === 'domain')).toHaveLength(1);
  });
});
