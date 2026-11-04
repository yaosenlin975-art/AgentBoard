/**
 * KB-GRAPH-V2-4：双链解析、反向链接、图 link 边、存量回填。
 * 解析规则逐条覆盖（含 lead 补的三条：重复权重、跨行、超长 target），并测 100KB 正文的解析耗时。
 */
import { describe, expect, it } from 'vitest';
import { createTestDb, type TestDb } from './helpers.js';
import { createWorkspace } from '../src/db/repos/workspace.js';
import { createKnowledgePage, getKnowledgePage, reviseKnowledgePage } from '../src/db/repos/knowledge.js';
import {
  MAX_TARGET_CHARS,
  countBacklinks,
  countOutgoingLinks,
  listBacklinks,
  listUnresolvedLinks,
  normalizeLinkTarget,
  parseKnowledgeLinks,
  reparseAllPages,
} from '../src/services/knowledgeLinks.js';
import { buildKnowledgeGraph } from '../src/services/knowledgeGraph.js';
import request from 'supertest';
import type { AgentAdapter } from '@agentboard/adapters';
import { createApp } from '../src/index.js';
import { FakeAdapter } from './fakeAdapter.js';
import { listKnowledgeGraphRows } from '../src/db/repos/knowledge.js';

const self = 'source-page';
const parse = (body: string) => parseKnowledgeLinks(body, self);

describe('link parsing rules (V2-4)', () => {
  it('parsesPlainAliasHeadingAndHeadingWithAlias', () => {
    expect(parse('see [[target-a]]')).toEqual([{ raw_target: 'target-a', alias: null, heading: null, target_slug_norm: 'target-a', weight: 1 }]);
    expect(parse('see [[target-a|别名]]')[0]).toMatchObject({ raw_target: 'target-a', alias: '别名', heading: null });
    expect(parse('see [[target-a#小节]]')[0]).toMatchObject({ raw_target: 'target-a', heading: '小节' });
    expect(parse('see [[target-a#小节|别名]]')[0]).toMatchObject({ raw_target: 'target-a', alias: '别名', heading: '小节' });
  });

  it('normalizesCaseWhitespaceAndWidth', () => {
    expect(normalizeLinkTarget('  My   Note ')).toBe('my-note');
    expect(normalizeLinkTarget('Ｍｙ　Ｎｏｔｅ')).toBe('my-note');
    expect(parse('[[My   Note]]')[0]).toMatchObject({ target_slug_norm: 'my-note' });
  });

  it('ignoresLinksInFencedAndInlineCode', () => {
    const body = ['```', '[[in-fence]]', '```', '~~~', '[[in-tilde-fence]]', '~~~', 'inline `[[in-inline]]` here', 'real [[target-a]]'].join('\n');
    expect(parse(body).map(link => link.target_slug_norm)).toEqual(['target-a']);
  });

  it('skipsMalformedEmptyAndSelfLinks', () => {
    expect(parse('[[ ]] [[source-page]] [[SOURCE-PAGE|self]]')).toEqual([]);
    expect(parse('[[a]]]')).toEqual([]);
    expect(parse('[[unclosed')).toEqual([]);
    expect(parse('[[a]]')).toHaveLength(1);
  });

  it('mergesRepeatedTargetsWithWeight', () => {
    const links = parse('[[a]] then [[A]] then [[a#h]]');
    expect(links).toHaveLength(1);
    expect(links[0]).toMatchObject({ target_slug_norm: 'a', weight: 3 });
  });

  it('doesNotParseAcrossLines', () => {
    expect(parse('[[target\nname]]')).toEqual([]);
    expect(parse('[[target-a]]\n[[target-b]]')).toHaveLength(2);
  });

  it('skipsOverlongTargets', () => {
    const overlong = 'x'.repeat(MAX_TARGET_CHARS + 1);
    expect(parse(`[[${overlong}]]`)).toEqual([]);
    expect(parse(`[[${'y'.repeat(MAX_TARGET_CHARS)}]]`)).toHaveLength(1);
  });

  it('parses100kbBodyUnderBudget', () => {
    const filler = '这是一段用于压测的正文内容，包含 [[target-a]] 与 `[[code]]` 片段。\n'.repeat(2300);
    expect(filler.length).toBeGreaterThan(100_000);
    const started = process.hrtime.bigint();
    const links = parse(filler);
    const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;
    expect(links[0]).toMatchObject({ target_slug_norm: 'target-a', weight: 2300 });
    // 记录实测值供交付说明；超过 50ms 才考虑挪出事务（当前实现为线性扫描）
    console.info(`[v2-4] 100KB 正文解析耗时 ${elapsedMs.toFixed(1)}ms，边数 ${links.length}`);
    expect(elapsedMs).toBeLessThan(2000);
  });
});

describe('link persistence, backlinks and revision binding (V2-4)', () => {
  const setup = (): { t: TestDb; workspaceId: string } => {
    const t = createTestDb();
    const workspace = createWorkspace(t.db, { name: 'ws', path: 'C:/ws-v24' });
    return { t, workspaceId: workspace.id };
  };
  const source = [{ source_id: 'doc.md', source_type: 'file' as const, locator: 'doc.md', captured_at: 1_700_000_000_000, content_hash: 'a'.repeat(64) }];
  const evidence = [{ source_id: 'doc.md', locator: 'doc.md#L1' }];
  const page = (t: TestDb, workspaceId: string, slug: string, body_md: string, title = slug) =>
    createKnowledgePage(t.db, { domain: 'knowledge', scope: 'workspace', workspace_id: workspaceId, slug, title, body_md, sources: source, evidence, actor: 'agent:test' });

  it('writesLinksOnCreateAndResolvesTargetPage', () => {
    const { t, workspaceId } = setup();
    try {
      const target = page(t, workspaceId, 'target-page', 'target body');
      const source = page(t, workspaceId, 'source-page', 'link to [[target-page]] and [[missing-page|别名]]');
      expect(countOutgoingLinks(t.db, source.id)).toBe(2);
      expect(countBacklinks(t.db, target.id)).toBe(1);
      expect(listUnresolvedLinks(t.db, source.id)).toEqual([{ raw_target: 'missing-page', alias: '别名', heading: null }]);
    } finally { t.cleanup(); }
  });

  it('reviseRebindsLinksWithoutTouchingOldRevision', () => {
    const { t, workspaceId } = setup();
    try {
      const target = page(t, workspaceId, 'target-page', 'x');
      const source = page(t, workspaceId, 'source-page', 'old [[target-page]]');
      expect(countBacklinks(t.db, target.id)).toBe(1);
      reviseKnowledgePage(t.db, source.id, { scope: 'workspace', workspace_id: workspaceId }, 1, { body_md: 'no links now', actor: 'agent:test' });
      expect(countBacklinks(t.db, target.id)).toBe(0);
      const rows = t.db.prepare('SELECT revision, resolved FROM knowledge_link WHERE source_page_id=? ORDER BY revision').all(source.id) as Array<{ revision: number; resolved: number }>;
      expect(rows).toEqual([{ revision: 1, resolved: 1 }]);
      expect(getKnowledgePage(t.db, source.id, { scope: 'workspace', workspace_id: workspaceId })!.revision).toBe(2);
    } finally { t.cleanup(); }
  });

  it('backlinksPaginateStablyByCreatedAtThenId', () => {
    const { t, workspaceId } = setup();
    try {
      const target = page(t, workspaceId, 'target-page', 'x');
      for (const slug of ['a-page', 'b-page', 'c-page']) page(t, workspaceId, slug, 'see [[target-page]]');
      const first = listBacklinks(t.db, target.id, { limit: 2, offset: 0 });
      const second = listBacklinks(t.db, target.id, { limit: 2, offset: 2 });
      expect(first.page_total).toBe(3);
      const slugs = [...first.items, ...second.items].map(item => item.slug);
      // 排序键 (created_at, id)：只保证「翻页不重复、不漏项」，不保证字典序
      expect(new Set(slugs).size).toBe(3);
    } finally { t.cleanup(); }
  });

  it('reparseIsIdempotentAndRebuildsDeletedLinks', () => {
    const { t, workspaceId } = setup();
    try {
      page(t, workspaceId, 'target-page', 'x');
      page(t, workspaceId, 'source-page', 'see [[target-page]]');
      t.db.prepare('DELETE FROM knowledge_link').run();
      const first = reparseAllPages(t.db);
      expect(first.pages).toBe(2);
      const snapshot = t.db.prepare('SELECT source_page_id, revision, target_slug_norm, weight FROM knowledge_link ORDER BY source_page_id').all();
      const second = reparseAllPages(t.db);
      expect(second.links).toBe(first.links);
      expect(t.db.prepare('SELECT source_page_id, revision, target_slug_norm, weight FROM knowledge_link ORDER BY source_page_id').all()).toEqual(snapshot);
    } finally { t.cleanup(); }
  });

  it('graphAddsLinkEdgesAndWinsOverKeywordOrSource', () => {
    const { t, workspaceId } = setup();
    try {
      page(t, workspaceId, 'target-page', 'shared words here');
      page(t, workspaceId, 'source-page', 'shared words here see [[target-page]]');
      const { rows } = listKnowledgeGraphRows(t.db, { scope: 'workspace', workspace_id: workspaceId }, 100);
      const links = t.db.prepare("SELECT source_page_id AS source, target_page_id AS target, weight FROM knowledge_link WHERE resolved=1").all() as Array<{ source: string; target: string; weight: number }>;
      const graph = buildKnowledgeGraph(rows, { edgeKinds: ['link', 'source', 'keyword'], links, includeIsolated: false, limitNodes: 10, limitEdges: 10 });
      const edge = graph.edges.find(item => item.kind === 'link');
      expect(edge).toBeTruthy();
      expect(graph.edges.filter(item => item.kind !== 'link')).toHaveLength(0);
      const withoutLinks = buildKnowledgeGraph(rows, { edgeKinds: ['link'], links: [], includeIsolated: false, limitNodes: 10, limitEdges: 10 });
      expect(withoutLinks.edges).toHaveLength(0);
    } finally { t.cleanup(); }
  });
});

describe('knowledge link HTTP surface (V2-4)', () => {
  const openApp = async (t: TestDb) => {
    const adapter = new FakeAdapter();
    return createApp({
      db: t.db,
      getAdapter: (id: string): AgentAdapter => { if (id === 'fake') return adapter; throw new Error(`未知适配器 id: ${id}`); },
      adapters: [adapter],
      refreshClisOnBoot: false,
    });
  };

  it('detailBacklinksGraphAndReparse', async () => {
    const t = createTestDb();
    try {
      const workspace = createWorkspace(t.db, { name: 'ws', path: 'C:/ws-v24-http' });
      const { app } = await openApp(t);
      const target = await request(app).post('/api/knowledge/pages').send({
        domain: 'knowledge', scope: 'workspace', workspace_id: workspace.id, slug: 'target-page', title: 'target',
        body_md: 'target body', actor: 'agent:test', sources: [{ source_id: 'a.md', source_type: 'file', locator: 'a.md', captured_at: 1, content_hash: 'a'.repeat(64) }],
        evidence: [{ source_id: 'a.md', locator: 'a.md#L1' }],
      });
      if (target.status !== 200) throw new Error('CREATE_BODY ' + JSON.stringify(target.body));
      expect(target.status).toBe(200);
      const sourcePage = await request(app).post('/api/knowledge/pages').send({
        domain: 'knowledge', scope: 'workspace', workspace_id: workspace.id, slug: 'source-page', title: 'source',
        body_md: 'see [[target-page]] and [[missing-page]]', actor: 'agent:test',
        sources: [{ source_id: 'b.md', source_type: 'file', locator: 'b.md', captured_at: 1, content_hash: 'b'.repeat(64) }],
        evidence: [{ source_id: 'b.md', locator: 'b.md#L1' }],
      });
      expect(sourcePage.status).toBe(200);

      const detail = await request(app).get(`/api/knowledge/pages/${target.body.id}`).query({ scope: 'workspace', workspace_id: workspace.id });
      expect(detail.status).toBe(200);
      expect(detail.body).toMatchObject({ backlinks_count: 1 });
      expect(detail.body.links_out_count).toBe(0);

      const backlinks = await request(app).get(`/api/knowledge/pages/${target.body.id}/backlinks`).query({ scope: 'workspace', workspace_id: workspace.id });
      expect(backlinks.status).toBe(200);
      expect(backlinks.body.page_total).toBe(1);
      expect(backlinks.body.items[0]).toMatchObject({ slug: 'source-page' });

      const sourceDetail = await request(app).get(`/api/knowledge/pages/${sourcePage.body.id}`).query({ scope: 'workspace', workspace_id: workspace.id });
      expect(sourceDetail.body.unresolved_links).toEqual([{ raw_target: 'missing-page', alias: null, heading: null }]);

      const graph = await request(app).get('/api/knowledge/graph').query({ scope: 'workspace', workspace_id: workspace.id });
      expect(graph.status).toBe(200);
      expect(graph.body.edges.map((edge: { kind: string }) => edge.kind)).toEqual(['link']);

      const onlyKeyword = await request(app).get('/api/knowledge/graph').query({ scope: 'workspace', workspace_id: workspace.id, edge_kinds: 'keyword' });
      // 关闭 link 后不允许再出现 link 边（keyword 边是否存在取决于正文相似度）
      expect((onlyKeyword.body.edges as Array<{ kind: string }>).every(edge => edge.kind !== 'link')).toBe(true);

      const bad = await request(app).get('/api/knowledge/graph').query({ scope: 'workspace', workspace_id: workspace.id, edge_kinds: 'bogus' });
      expect(bad.status).toBe(400);

      t.db.prepare('DELETE FROM knowledge_link').run();
      const reparse = await request(app).post('/api/knowledge/reparse').send({});
      expect(reparse.status).toBe(200);
      expect(reparse.body.pages).toBe(2);
      expect(reparse.body.links).toBe(2);
    } finally { t.cleanup(); }
  }, 30000);
});
