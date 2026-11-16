/**
 * P2-03 S-8：契约不回退——「迁移前（knowledge_link 表链路）」与「迁移后（扫 Docs/*.md）」
 * 逐项等价：节点集、link 边集（source/target/weight）、反链、unresolved 列表。
 * 另按 §8 #1 对 embed/tag/attachment/unresolved 四类节点/边各有断言（S-7 尾句）。
 */
import { createHash } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import { createKnowledgeRestFixture, createTestDb } from './helpers.js';
import { createKnowledgePage } from '../src/db/repos/knowledge.js';
import { listResolvedLinks, listBacklinks, listUnresolvedLinks } from '../src/services/knowledgeLinks.js';
import { createWorkspace } from '../src/db/repos/workspace.js';
import { FakeAdapter } from './fakeAdapter.js';
import { createApp } from '../src/index.js';

vi.setConfig({ testTimeout: 120_000, hookTimeout: 60_000 });

/** 两个链路共用同一组页面正文（覆盖四形态 + unresolved + 重复出现 weight 合并） */
const PAGES: Array<{ slug: string; body: string }> = [
  { slug: 'alpha', body: '目标页正文' },
  { slug: 'beta', body: '见 [[alpha]] 与 [[alpha|别名]] 与 [[alpha#节标题]] 与 [[alpha#节标题|带别名锚]]' },
  { slug: 'gamma', body: '三次引用 [[alpha]]、[[alpha]]、[[alpha]]；未解析 [[ghost-page]]' },
  { slug: 'delta', body: '反向 [[alpha]]；互链 [[beta]]' },
];

describe('S-8 迁移前后契约等价（P2-03）', () => {
  let fixture: ReturnType<typeof createKnowledgeRestFixture>;
  let app: Express;
  let legacy: ReturnType<typeof createTestDb>;
  let workspaceId: string;
  let legacyWorkspaceId: string;

  beforeEach(async () => {
    fixture = createKnowledgeRestFixture();
    const adapter = new FakeAdapter();
    const created = await createApp({
      db: fixture.t.db,
      getAdapter: (id: string) => { if (id === 'fake') return adapter; throw new Error(`未知适配器 id: ${id}`); },
      adapters: [adapter],
      refreshClisOnBoot: false,
      knowledgeDocsPaths: { commonDocsDir: () => fixture.commonDocs },
    });
    app = created.app;
    workspaceId = fixture.a;
    legacy = createTestDb({ legacyKnowledge: true });
    // 旧库是独立库：legacy 自己建 workspace（对比按 slug 归一，id 不要求一致）
    legacyWorkspaceId = createWorkspace(legacy.db, { name: 'S-8 旧库空间', path: 'D:/nonexistent/legacy-ws' }).id;
    // 旧链路：knowledge_page + knowledge_link（写入时 syncPageLinks）
    for (const item of PAGES) {
      const createdLegacy = createKnowledgePage(legacy.db, {
        domain: 'knowledge', scope: 'workspace', workspace_id: legacyWorkspaceId, slug: item.slug, title: `页 ${item.slug}`,
        body_md: item.body,
        sources: [{ source_id: `file:${item.slug}.ts`, source_type: 'file', locator: `file:${item.slug}.ts`, captured_at: 1_700_000_000_000, content_hash: createHash('sha256').update(item.slug).digest('hex') }],
        evidence: [{ source_id: `file:${item.slug}.ts`, locator: `file:${item.slug}.ts` }],
        actor: 'user',
      });
      expect(createdLegacy.id).toBeDefined();
    }
    // 新链路：同内容走 REST 落 Docs/*.md
    for (const item of PAGES) {
      const res = await request(app).post('/api/knowledge/pages').send({
        domain: 'knowledge', scope: 'workspace', workspace_id: workspaceId, slug: item.slug, title: `页 ${item.slug}`,
        body_md: item.body,
        sources: [{ source_id: `file:${item.slug}.ts`, source_type: 'file', locator: `file:${item.slug}.ts`, captured_at: 1_700_000_000_000, content_hash: createHash('sha256').update(item.slug).digest('hex') }],
        evidence: [{ source_id: `file:${item.slug}.ts`, locator: `file:${item.slug}.ts` }],
        actor: 'user',
      });
      expect(res.status, JSON.stringify(res.body)).toBe(200);
    }
  });
  afterEach(() => {
    fixture.cleanup();
    legacy.cleanup();
  });

  const newPages = async (): Promise<Array<{ id: string; slug: string }>> => {
    const res = await request(app).get(`/api/knowledge/pages?scope=workspace&workspace_id=${workspaceId}&limit=100`);
    return res.body.items;
  };
  const legacyPages = (): Array<{ id: string; slug: string }> =>
    legacy.db.prepare("SELECT id, slug FROM knowledge_page WHERE scope='workspace' AND workspace_id=? AND status<>'deleted' ORDER BY slug").all(legacyWorkspaceId) as Array<{ id: string; slug: string }>;

  it('节点集等价（slug 集与 id 一一对应）', async () => {
    const graph = await request(app).get(`/api/knowledge/graph?scope=workspace&workspace_id=${workspaceId}&edge_kinds=link&include_isolated=true`);
    expect(graph.status).toBe(200);
    const legacyRows = legacyPages();
    const newRows = await newPages();
    expect(newRows.map(row => row.slug).sort()).toEqual(legacyRows.map(row => row.slug).sort());
    const pageNodeIds = graph.body.nodes.filter((node: { node_type?: string }) => node.node_type === undefined || node.node_type === 'page').map((node: { id: string }) => node.id);
    expect(pageNodeIds.sort()).toEqual(newRows.map(row => row.id).sort());
    expect(graph.body.page_total).toBe(legacyRows.length);
  });

  it('link 边集等价（source/target/weight 逐项）', async () => {
    const legacyIds = legacyPages();
    const legacyEdges = listResolvedLinks(legacy.db, legacyIds.map(row => row.id))
      .map(edge => ({ source: edge.source, target: edge.target, weight: edge.weight }));
    const legacyIdBySlug = new Map(legacyIds.map(row => [row.slug, row.id]));
    const newRows = await newPages();
    const newIdBySlug = new Map(newRows.map(row => [row.slug, row.id]));
    // 旧链路 id 与新链路 id 不同（各自生成）→ 按 slug 归一后对比
    const normalizedLegacy = legacyEdges.map(edge => ({
      sourceSlug: legacyIds.find(row => row.id === edge.source)!.slug,
      targetSlug: legacyIds.find(row => row.id === edge.target)!.slug,
      weight: edge.weight,
    })).sort((a, b) => `${a.sourceSlug}>${a.targetSlug}`.localeCompare(`${b.sourceSlug}>${b.targetSlug}`));
    const graph = await request(app).get(`/api/knowledge/graph?scope=workspace&workspace_id=${workspaceId}&edge_kinds=link`);
    const normalizedNew = (graph.body.edges as Array<{ source: string; target: string; kind: string; weight: number }>)
      .filter(edge => edge.kind === 'link')
      .map(edge => ({
        sourceSlug: newRows.find(row => row.id === edge.source)?.slug,
        targetSlug: newRows.find(row => row.id === edge.target)?.slug,
        weight: edge.weight,
      }))
      .filter(edge => edge.sourceSlug !== undefined && edge.targetSlug !== undefined)
      .sort((a, b) => `${a.sourceSlug}>${a.targetSlug}`.localeCompare(`${b.sourceSlug}>${b.targetSlug}`));
    expect(normalizedNew).toEqual(normalizedLegacy);
    // 重量级断言抽查：gamma→alpha weight=3（出现次数语义保留）
    expect(normalizedLegacy).toContainEqual({ sourceSlug: 'gamma', targetSlug: 'alpha', weight: 3 });
    expect(legacyIdBySlug.get('alpha')).toBeDefined();
    expect(newIdBySlug.get('alpha')).toBeDefined();
  });

  it('反链等价（alpha 的反链集与计数）', async () => {
    const legacyIds = legacyPages();
    const legacyAlpha = legacyIds.find(row => row.slug === 'alpha')!;
    const legacyBacklinks = listBacklinks(legacy.db, legacyAlpha.id, { limit: 100, offset: 0 })
      .items.map(item => ({ slug: item.slug, alias: item.alias, heading: item.heading }))
      .sort((a, b) => a.slug.localeCompare(b.slug) || (a.alias ?? '').localeCompare(b.alias ?? ''));
    const newRows = await newPages();
    const newAlpha = newRows.find(row => row.slug === 'alpha')!;
    const res = await request(app).get(`/api/knowledge/pages/${newAlpha.id}/backlinks?scope=workspace&workspace_id=${workspaceId}&limit=100`);
    const newBacklinks = (res.body.items as Array<{ slug: string; alias: string | null; heading: string | null }>)
      .map(item => ({ slug: item.slug, alias: item.alias, heading: item.heading }))
      .sort((a, b) => a.slug.localeCompare(b.slug) || (a.alias ?? '').localeCompare(b.alias ?? ''));
    expect(newBacklinks).toEqual(legacyBacklinks);
    expect(res.body.page_total).toBe(legacyBacklinks.length);
  });

  it('unresolved 列表等价（ghost-page）', async () => {
    const legacyIds = legacyPages();
    const legacyGamma = legacyIds.find(row => row.slug === 'gamma')!;
    const legacyUnresolved = listUnresolvedLinks(legacy.db, legacyGamma.id)
      .map(item => ({ raw_target: item.raw_target, alias: item.alias, heading: item.heading }));
    const newRows = await newPages();
    const newGamma = newRows.find(row => row.slug === 'gamma')!;
    const res = await request(app).get(`/api/knowledge/pages/${newGamma.id}/unresolved?scope=workspace&workspace_id=${workspaceId}`);
    const newUnresolved = (res.body.items as Array<{ raw_target: string; alias: string | null; heading: string | null }>)
      .map(item => ({ raw_target: item.raw_target, alias: item.alias, heading: item.heading }));
    expect(newUnresolved).toEqual(legacyUnresolved);
    expect(legacyUnresolved).toEqual([{ raw_target: 'ghost-page', alias: null, heading: null }]);
  });

  it('S-7：embed/tag/attachment/unresolved 四类节点边在文件链路可断言（旧库无此能力）', async () => {
    const res = await request(app).post('/api/knowledge/pages').send({
      domain: 'knowledge', scope: 'workspace', workspace_id: workspaceId, slug: 'omega', title: '页 omega',
      body_md: '嵌入 ![[alpha]]；标签 #主线；图片 ![[omega.png]]；缺失 [[ghost-page]]',
      sources: [{ source_id: 'file:omega.ts', source_type: 'file', locator: 'file:omega.ts', captured_at: 1_700_000_000_000, content_hash: createHash('sha256').update('omega').digest('hex') }],
      evidence: [{ source_id: 'file:omega.ts', locator: 'file:omega.ts' }],
      actor: 'user',
    });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const omegaId = res.body.id;
    const graph = await request(app).get(`/api/knowledge/graph?scope=workspace&workspace_id=${workspaceId}&edge_kinds=link,embed&include_isolated=true`);
    const nodes = graph.body.nodes as Array<{ id: string; node_type?: string; title: string }>;
    const edges = graph.body.edges as Array<{ source: string; target: string; kind: string; weight: number }>;
    const alphaNode = nodes.find(node => node.title === '页 alpha');
    const tagNode = nodes.find(node => node.node_type === 'tag');
    const attachmentNode = nodes.find(node => node.node_type === 'attachment');
    const unresolvedNode = nodes.find(node => node.node_type === 'unresolved');
    expect(alphaNode).toBeDefined();
    expect(tagNode?.title).toBe('#主线');
    expect(attachmentNode?.title).toBe('omega.png');
    expect(unresolvedNode?.title).toBe('ghost-page');
    expect(edges).toContainEqual(expect.objectContaining({ source: omegaId, target: alphaNode!.id, kind: 'embed' }));
    expect(edges).toContainEqual(expect.objectContaining({ source: omegaId, target: tagNode!.id, kind: 'link' }));
    expect(edges).toContainEqual(expect.objectContaining({ source: omegaId, target: attachmentNode!.id, kind: 'embed' }));
    expect(edges).toContainEqual(expect.objectContaining({ source: omegaId, target: unresolvedNode!.id, kind: 'link' }));
  });
});
