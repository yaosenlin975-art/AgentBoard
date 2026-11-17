/**
 * K3：坏知识页可见性。
 *
 * 缺陷：content_hash 校验失败的文件进 invalid 集合后，`list` 只取 issues.length===0 的条目 →
 * 坏页被静默过滤成「（无知识）」；`resolve` 命中坏页时空落到 not_found → 路由层再误判成
 * 「该知识页属于另一个工作区，当前范围无权读取」，把排障方向带偏。
 *
 * 修复口径：
 * - list 响应新增 invalid_count / invalid[]（只给 slug/文件名/issues，不回正文），items 结构不变
 * - resolve 区分 NOT_FOUND / INVALID / SCOPE_FORBIDDEN 三态，INVALID → 422 KNOWLEDGE_INVALID
 * - reconcile 报告对 hash 不符与 front matter 问题给 suggestion
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createKnowledgeRestFixture } from './helpers.js';

describe('K3 坏知识页可见性', () => {
  let f: ReturnType<typeof createKnowledgeRestFixture>;
  let a: string;
  let b: string;

  beforeEach(() => {
    f = createKnowledgeRestFixture();
    a = f.a;
    b = f.b;
  });
  afterEach(() => f.cleanup());

  const pageBody = (overrides: Record<string, unknown> = {}) => ({
    domain: 'knowledge',
    scope: 'workspace',
    workspace_id: a,
    slug: 'k3-page',
    title: 'K3 页',
    body_md: '原始正文',
    actor: 'tester',
    sources: [{ source_id: 's', source_type: 'agent', locator: 'issue:1', captured_at: 1, content_hash: 'a'.repeat(64), snapshot: 'ok' }],
    evidence: [{ source_id: 's', locator: 'issue:1' }],
    ...overrides,
  });

  /** 造一个 content_hash 与内容不符的页文件（绕过 API 直接改正文） */
  async function makeBrokenPage(): Promise<{ id: string; slug: string; fileName: string }> {
    const created = await request(f.app).post('/api/knowledge/pages').send(pageBody());
    expect(created.status).toBe(200);
    const fileName = 'k3-page.md';
    const path = join(f.docsOf(a), fileName);
    writeFileSync(path, readFileSync(path, 'utf8').replace('原始正文', '外部篡改的正文'), 'utf8');
    return { id: created.body.id as string, slug: 'k3-page', fileName };
  }

  it('list 不再静默过滤坏页：invalid_count/invalid 暴露，items 结构不变', async () => {
    const broken = await makeBrokenPage();
    const res = await request(f.app).get('/api/knowledge/pages').query({ scope: 'workspace', workspace_id: a });
    expect(res.status).toBe(200);
    // 兼容：items 仍是数组、字段未变
    expect(Array.isArray(res.body.items)).toBe(true);
    expect(res.body.next_offset).toBeNull();
    // 新增：坏页可见
    expect(res.body.invalid_count).toBe(1);
    expect(res.body.invalid).toHaveLength(1);
    expect(res.body.invalid[0].slug).toBe(broken.slug);
    expect(res.body.invalid[0].file_name).toBe(broken.fileName);
    expect(res.body.invalid[0].issues.join('；')).toContain('content_hash');
    // 不返回正文（坏内容不当正常内容传播）
    expect(JSON.stringify(res.body.invalid)).not.toContain('外部篡改的正文');
  });

  it('list --invalid（invalid_only=true）只列坏页', async () => {
    await request(f.app).post('/api/knowledge/pages').send(pageBody({ slug: 'k3-good', title: '好页' }));
    await makeBrokenPage();
    const res = await request(f.app).get('/api/knowledge/pages').query({ scope: 'workspace', workspace_id: a, invalid_only: 'true' });
    expect(res.status).toBe(200);
    expect(res.body.items).toHaveLength(0);
    expect(res.body.invalid_count).toBe(1);
    expect(res.body.invalid[0].slug).toBe('k3-page');
  });

  it('无坏页时 invalid_count=0 且 invalid 为空数组', async () => {
    await request(f.app).post('/api/knowledge/pages').send(pageBody({ slug: 'k3-good', title: '好页' }));
    const res = await request(f.app).get('/api/knowledge/pages').query({ scope: 'workspace', workspace_id: a });
    expect(res.body.invalid_count).toBe(0);
    expect(res.body.invalid).toEqual([]);
    expect(res.body.items).toHaveLength(1);
  });

  it('resolve 命中坏页（uuid）→ 422 KNOWLEDGE_INVALID，不再报「属于另一个工作区」', async () => {
    const broken = await makeBrokenPage();
    const res = await request(f.app).get('/api/knowledge/resolve').query({ ref: broken.id, scope: 'workspace', workspace_id: a });
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('KNOWLEDGE_INVALID');
    expect(res.body.error.message).toContain('校验失败');
    expect(res.body.error.message).toContain('content_hash');
    expect(res.body.error.message).toContain(broken.fileName);
    expect(res.body.error.message).not.toContain('属于另一个工作区');
  });

  it('resolve 命中坏页（slug）→ 同样报 INVALID', async () => {
    const broken = await makeBrokenPage();
    const res = await request(f.app).get('/api/knowledge/resolve').query({ ref: broken.slug, scope: 'workspace', workspace_id: a });
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('KNOWLEDGE_INVALID');
    expect(res.body.error.message).not.toContain('属于另一个工作区');
  });

  it('正常页 resolve 仍正常返回正文', async () => {
    const created = await request(f.app).post('/api/knowledge/pages').send(pageBody({ slug: 'k3-good', title: '好页' }));
    expect(created.status).toBe(200);
    const res = await request(f.app).get('/api/knowledge/resolve').query({ ref: 'k3-good', scope: 'workspace', workspace_id: a });
    expect(res.status).toBe(200);
    expect(res.body.state).toBe('resolved');
    expect(res.body.slug).toBe('k3-good');
  });

  it('真·别的工作区的页仍报「属于另一个工作区」（INVALID 不吞掉 SCOPE_FORBIDDEN）', async () => {
    const createdB = await request(f.app).post('/api/knowledge/pages').send(pageBody({ slug: 'k3-b-page', workspace_id: b, title: 'B 的页' }));
    expect(createdB.status).toBe(200);
    const res = await request(f.app).get('/api/knowledge/resolve').query({ ref: createdB.body.id as string, scope: 'workspace', workspace_id: a });
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('KNOWLEDGE_SCOPE_FORBIDDEN');
    expect(res.body.error.message).toContain('另一个工作区');
  });

  it('页面确实不存在时仍报 404 NOT_FOUND', async () => {
    const res = await request(f.app).get('/api/knowledge/resolve').query({ ref: 'no-such-page', scope: 'workspace', workspace_id: a });
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('KNOWLEDGE_NOT_FOUND');
  });

  it('reconcile 报告对坏页给 suggestion（可操作性）', async () => {
    await makeBrokenPage();
    const res = await request(f.app).post('/api/knowledge/reparse').send({});
    expect(res.status).toBe(200);
    const reports = res.body.reconcile as Array<{ issues: Array<{ fileName: string; kind: string; detail: string; suggestion?: string }> }>;
    const issue = reports
      .flatMap(report => report.issues)
      .find(item => item.fileName === 'k3-page.md' && item.kind === 'content_hash');
    expect(issue).toBeDefined();
    expect(typeof issue!.suggestion).toBe('string');
    expect(issue!.suggestion!.length).toBeGreaterThan(0);
  });
});
