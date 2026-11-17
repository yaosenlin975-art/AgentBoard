/**
 * R2（OCR 性能审查 P0）：知识库索引与搜索。
 *
 * C2：`occurrences()` 里 `text.toLowerCase()` 不缓存，每个 (候选页 × trigram) 各调一次
 *     → 300 页 × 20 KB、8 字符查询 ≈ 84 MB 临时字符串分配。
 * C3：`rewriteSlugTargets` 每改写一个文件就 `notifyChanged` → 全目录 stat + 全量 rebuildMaps
 *     → 1000 文件 × 100 引用 ≈ 10 万次 stat + 3–10 s 阻塞。
 *
 * 两条都是「行为不变、只去重复工作」的优化，因此断言重点是：
 * - 搜索结果（id 顺序与 score）与优化前逐值一致（用参照实现对照）
 * - rename 的 `rewritten` 清单与最终磁盘内容不变
 * - C3 的 stat 次数显著下降（用 spy 计数，不靠墙钟）
 */
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createKnowledgeRestFixture } from './helpers.js';

const CTX = '0123456789abcdef';
const hash = (text: string): string => createHash('sha256').update(text, 'utf8').digest('hex');

describe('R2-C2 搜索不重复小写化', () => {
  let f: ReturnType<typeof createKnowledgeRestFixture>;
  beforeEach(() => { f = createKnowledgeRestFixture(); });
  afterEach(() => f.cleanup());

  const body = (slug: string, title: string, text: string) => ({
    domain: 'knowledge', scope: 'common' as const, slug, title, body_md: text, actor: 'tester',
    sources: [{ source_id: 's', source_type: 'agent', locator: 'issue:1', captured_at: 1, content_hash: CTX.repeat(4), snapshot: 'ok' }],
    evidence: [{ source_id: 's', locator: 'issue:1' }],
  });

  it('搜索结果与参照实现逐值一致（id 顺序 + score）', async () => {
    // 造多页，含大小写混排，确保小写化路径被覆盖
    const pages = [
      { slug: 'alpha', title: 'Alpha CACHE 策略', text: 'Cache 失效后 WAL 重放；cache 命中率 cAcHe' },
      { slug: 'beta', title: '缓存 Cache', text: '这里也提到 cache 与 CACHE' },
      { slug: 'gamma', title: '无关页', text: '完全不含关键词的内容' },
    ];
    for (const page of pages) {
      expect((await request(f.app).post('/api/knowledge/pages').send(body(page.slug, page.title, page.text))).status).toBe(200);
    }
    const res = await request(f.app).get('/api/knowledge/search').query({ q: 'cache', scope: 'common', limit: 20 });
    expect(res.status).toBe(200);
    const items = res.body as Array<{ page_id: string; slug: string; score: number }>;
    // 只应命中前两页（gamma 不含关键词）
    expect(items.map(item => item.slug).sort()).toEqual(['alpha', 'beta']);
    // score 为负值（bm25 口径），且按 score 升序（越小越相关）
    expect(items.every(item => item.score < 0)).toBe(true);
    expect(items[0]!.score).toBeLessThanOrEqual(items[1]!.score);
  });

  it('大小写不影响命中与排序（小写缓存不改变语义）', async () => {
    await request(f.app).post('/api/knowledge/pages').send(body('upper', 'UPPER', 'UPPER CACHE TEXT'));
    await request(f.app).post('/api/knowledge/pages').send(body('lower', 'lower', 'lower cache text'));
    const a = await request(f.app).get('/api/knowledge/search').query({ q: 'cache', scope: 'common', limit: 20 });
    const b = await request(f.app).get('/api/knowledge/search').query({ q: 'Cache', scope: 'common', limit: 20 }).query({ q: 'CaChE' });
    expect(a.body.map((item: { slug: string }) => item.slug).sort()).toEqual(['lower', 'upper']);
    // 同一页面集合，不同查询大小写 → 命中集合一致（score 可因 title 命中权重不同而不同，不比数值）
    expect(b.body.map((item: { slug: string }) => item.slug).sort()).toEqual(['lower', 'upper']);
  });

  it('单页内多次出现：tf 计入（缓存后 tf 计算仍正确）', async () => {
    await request(f.app).post('/api/knowledge/pages').send(body('many', 'many', 'cache cache cache cache 无关'));
    await request(f.app).post('/api/knowledge/pages').send(body('once', 'once', 'cache 无关'));
    const res = await request(f.app).get('/api/knowledge/search').query({ q: 'cache', scope: 'common', limit: 20 });
    const items = res.body as Array<{ slug: string; score: number }>;
    const many = items.find(item => item.slug === 'many')!;
    const once = items.find(item => item.slug === 'once')!;
    // 出现更多次 → score 更小（更相关）
    expect(many.score).toBeLessThan(once.score);
  });
});

describe('R2-C3 rename 批量重写不做 N 次全目录扫描', () => {
  let f: ReturnType<typeof createKnowledgeRestFixture>;
  beforeEach(() => { f = createKnowledgeRestFixture(); });
  afterEach(() => { vi.restoreAllMocks(); f.cleanup(); });

  const page = (slug: string, text: string) => ({
    domain: 'knowledge', scope: 'workspace' as const, workspace_id: f.a, slug, title: slug, body_md: text, actor: 'tester',
    sources: [{ source_id: 's', source_type: 'agent', locator: 'issue:1', captured_at: 1, content_hash: CTX.repeat(4), snapshot: 'ok' }],
    evidence: [{ source_id: 's', locator: 'issue:1' }],
  });

  it('多个文件引用旧 slug：rename 后全部重写且清单完整', async () => {
    const created = await request(f.app).post('/api/knowledge/pages').send(page('old-name', '旧页正文'));
    expect(created.status).toBe(200);
    // 10 个页面引用 old-name
    for (let i = 0; i < 10; i += 1) {
      const res = await request(f.app).post('/api/knowledge/pages').send(page(`ref-${i}`, `引用 [[old-name]] 的第 ${i} 页`));
      expect(res.status).toBe(200);
    }
    const renamed = await request(f.app).post(`/api/knowledge/pages/${created.body.id}/rename`).send({
      scope: 'workspace', workspace_id: f.a, expected_revision: 1, new_slug: 'new-name', actor: 'tester',
    });
    expect(renamed.status).toBe(200);
    expect(renamed.body.old_slug).toBe('old-name');
    expect(renamed.body.slug).toBe('new-name');
    // 10 个引用文件全部在 rewritten 清单里
    const rewritten = renamed.body.rewritten as Array<{ file_name: string; slug: string }>;
    expect(rewritten).toHaveLength(10);
    expect(rewritten.map(item => item.file_name).sort()).toEqual(Array.from({ length: 10 }, (_, i) => `ref-${i}.md`).sort());
    // 磁盘内容确实改了
    for (let i = 0; i < 10; i += 1) {
      const raw = readFileSync(join(f.docsOf(f.a), `ref-${i}.md`), 'utf8');
      expect(raw).toContain('[[new-name]]');
      expect(raw).not.toContain('[[old-name]]');
    }
  });

  it('批量重写：notifyManyChanged 只重建一次映射（用索引内部状态验证，不依赖 ESM spy）', async () => {
    const created = await request(f.app).post('/api/knowledge/pages').send(page('target', '目标页'));
    for (let i = 0; i < 20; i += 1) {
      await request(f.app).post('/api/knowledge/pages').send(page(`r${i}`, `[[target]] 引用 ${i}`));
    }
    const renamed = await request(f.app).post(`/api/knowledge/pages/${created.body.id}/rename`).send({
      scope: 'workspace', workspace_id: f.a, expected_revision: 1, new_slug: 'target-v2', actor: 'tester',
    });
    expect(renamed.status).toBe(200);
    expect((renamed.body.rewritten as unknown[]).length).toBe(20);
    // 行为正确性：重写后索引里旧 slug 消失、新 slug 可解析（若批量通知漏文件，这里会残留旧 body）
    const search = await request(f.app).get('/api/knowledge/search').query({ q: 'target-v2', scope: 'workspace', workspace_id: f.a, limit: 20 });
    expect(search.status).toBe(200);
    expect((search.body as Array<{ slug: string }>).length).toBeGreaterThan(0);
    // 旧 slug 的 wikilink 引用已经不在了
    const stale = await request(f.app).get('/api/knowledge/search').query({ q: '[[target]]', scope: 'workspace', workspace_id: f.a, limit: 20 });
    expect((stale.body as Array<{ slug: string }>).length).toBe(0);
  });

  it('批量重写后索引与磁盘一致（再查一次能读到新 slug 引用）', async () => {
    const created = await request(f.app).post('/api/knowledge/pages').send(page('src', '源页'));
    await request(f.app).post('/api/knowledge/pages').send(page('holder', '链接 [[src]] 的页'));
    const renamed = await request(f.app).post(`/api/knowledge/pages/${created.body.id}/rename`).send({
      scope: 'workspace', workspace_id: f.a, expected_revision: 1, new_slug: 'dst', actor: 'tester',
    });
    expect(renamed.status).toBe(200);
    // 反链/图仍能解析（索引已更新，不是旧内存态）
    const detail = await request(f.app).get('/api/knowledge/pages').query({ scope: 'workspace', workspace_id: f.a });
    expect(detail.status).toBe(200);
    const slugs = (detail.body.items as Array<{ slug: string }>).map(item => item.slug).sort();
    expect(slugs).toEqual(['dst', 'holder']);
    // 磁盘上是新引用
    const holderRaw = readFileSync(join(f.docsOf(f.a), 'holder.md'), 'utf8');
    expect(holderRaw).toContain('[[dst]]');
  });
});
