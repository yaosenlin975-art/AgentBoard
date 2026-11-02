/**
 * KB-GRAPH 服务端图聚合：边规则（来源 3/4、关键词阈值）、scope 隔离、孤立点开关、
 * 上限裁剪与真实 total、响应体积。
 */
import { createHash, randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import type { KnowledgeSource } from '@agentboard/shared';
import type { AgentAdapter } from '@agentboard/adapters';
import { createTestDb, type TestDb } from './helpers.js';
import { FakeAdapter } from './fakeAdapter.js';
import { createApp } from '../src/index.js';
import { createKnowledgePage } from '../src/db/repos/knowledge.js';
import { createWorkspace } from '../src/db/repos/workspace.js';
import { GRAPH_MAX_EDGES, GRAPH_MAX_NODES, entityTerms, trigrams } from '../src/services/knowledgeGraph.js';
import { listKnowledgeGraphRows } from '../src/db/repos/knowledge.js';

describe('knowledge graph', () => {
  let t: TestDb;
  let app: Express;
  let spaceDir: string;
  let workspaceId: string;

  const hex = (value: string): string => createHash('sha256').update(value).digest('hex');
  const source = (locator: string, contentHash = hex(locator)): KnowledgeSource => ({
    source_id: randomUUID(), source_type: 'file', locator, captured_at: 1_700_000_000_000, content_hash: contentHash,
  });

  const page = (slug: string, title: string, body: string, sources: KnowledgeSource[], target = workspaceId) => createKnowledgePage(t.db, {
    scope: 'workspace', workspace_id: target, slug, title, body_md: body, sources, evidence: sources.map(item => ({ source_id: item.source_id, locator: item.locator })), actor: 'user',
  });

  const graph = async (query: string) => {
    const res = await request(app).get(`/api/knowledge/graph?${query}`);
    return res;
  };

  beforeEach(async () => {
    t = createTestDb();
    spaceDir = mkdtempSync(join(tmpdir(), 'agentboard-graph-'));
    const adapter = new FakeAdapter();
    const resolver = (id: string): AgentAdapter => {
      if (id === 'fake') return adapter;
      throw new Error(`未知适配器 id: ${id}`);
    };
    const created = await createApp({ db: t.db, getAdapter: resolver, adapters: [adapter], refreshClisOnBoot: false });
    app = created.app;
    workspaceId = createWorkspace(t.db, { name: '图空间', path: spaceDir }).id;
  });
  afterEach(() => {
    t.cleanup();
    rmSync(spaceDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  });

  it('emptyScopeReturnsEmptyGraph', async () => {
    const res = await graph(`scope=both&workspace_id=${workspaceId}`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ nodes: [], edges: [], truncated: false, truncated_reason: null, pages_truncated: false, page_total: 0, pages_loaded: 0, node_total: 0, edge_total: 0 });
  });

  it('isolatedNodesFollowIncludeIsolated', async () => {
    page('lonely', '孤立页', '完全独立的内容 abcdef', [source('file:lonely.ts')]);
    const hidden = await graph(`scope=workspace&workspace_id=${workspaceId}`);
    expect(hidden.body.nodes).toHaveLength(0);
    expect(hidden.body.node_total).toBe(0);
    expect(hidden.body.truncated).toBe(false);

    const shown = await graph(`scope=workspace&workspace_id=${workspaceId}&include_isolated=true`);
    expect(shown.body.nodes).toHaveLength(1);
    expect(shown.body.nodes[0]).toMatchObject({ title: '孤立页', scope: 'workspace', workspace_id: workspaceId, source_count: 1, degree: 0 });
    expect(shown.body.node_total).toBe(1);
  });

  it('sourceEdgeWeightsLocatorThreeAndHashFourAndMergesWithKeyword', async () => {
    const shared = [source('file:apps/server/src/services/dispatch.ts', hex('same-hash'))];
    const first = page('a', '派发链路', '派发链路 会话 队列 重试 alpha beta', shared);
    const second = page('b', '派发链路二', '派发链路 会话 队列 重试 alpha beta gamma', [
      source('file:apps/server/src/services/dispatch.ts', hex('same-hash')),
    ]);
    const res = await graph(`scope=workspace&workspace_id=${workspaceId}`);
    expect(res.body.edges).toHaveLength(1);
    expect(res.body.edges[0]).toMatchObject({ kind: 'source', weight: 3 + 4 });
    expect([res.body.edges[0].source, res.body.edges[0].target].sort()).toEqual([first.id, second.id].sort());
    const degrees = res.body.nodes.map((node: { degree: number }) => node.degree);
    expect(degrees).toEqual([1, 1]);
  });

  it('keywordEdgeNeedsTwoTermsOrThreeTrigrams', async () => {
    const first = page('k1', '甲类 主题 记录', '甲类 主题 记录 内容', [source('file:k1.ts', hex('h1'))]);
    const second = page('k2', '甲类 主题 摘要', '甲类 主题 摘要 内容', [source('file:k2.ts', hex('h2'))]);
    const third = page('k3', 'zeta quokka', 'zeta quokka note', [source('file:k3.ts', hex('h3'))]);
    const fourth = page('k4', 'omega yonder', 'omega yonder memo', [source('file:k4.ts', hex('h4'))]);

    const withKeyword = await graph(`scope=workspace&workspace_id=${workspaceId}`);
    const keywordPairs = withKeyword.body.edges.filter((edge: { kind: string }) => edge.kind === 'keyword');
    expect(keywordPairs).toHaveLength(1);
    expect(keywordPairs[0]).toMatchObject({ kind: 'keyword', weight: 1 });
    expect([keywordPairs[0].source, keywordPairs[0].target].sort()).toEqual([first.id, second.id].sort());
    // k3/k4 只共享 1 个词且 trigram 重叠不足 → 无边
    const pairs = withKeyword.body.edges.map((edge: { source: string; target: string }) => [edge.source, edge.target].sort().join('|'));
    expect(pairs).not.toContain([third.id, fourth.id].sort().join('|'));

    const sourceOnly = await graph(`scope=workspace&workspace_id=${workspaceId}&edge_kinds=source&include_isolated=true`);
    expect(sourceOnly.body.edges).toHaveLength(0);
    const keywordOnly = await graph(`scope=workspace&workspace_id=${workspaceId}&edge_kinds=keyword&include_isolated=true`);
    expect(keywordOnly.body.edges).toHaveLength(1);
    expect(keywordOnly.body.edges[0].kind).toBe('keyword');
  });

  it('scopeIsolatesWorkspacesAndCommon', async () => {
    const otherDir = mkdtempSync(join(tmpdir(), 'agentboard-graph2-'));
    const otherWorkspace = createWorkspace(t.db, { name: '另一空间', path: otherDir }).id;
    try {
      page('mine', '我的页', '共享来源 alpha beta', [source('file:shared.ts')]);
      page('other', '别人页', '共享来源 alpha beta', [source('file:shared.ts')], otherWorkspace);
      const commonSource = source('file:shared.ts');
      createKnowledgePage(t.db, {
        scope: 'common', workspace_id: null, slug: 'common', title: '公共页', body_md: '共享来源 alpha beta',
        sources: [commonSource], evidence: [{ source_id: commonSource.source_id, locator: commonSource.locator }], actor: 'user',
      });

      const onlyWorkspace = await graph(`scope=workspace&workspace_id=${workspaceId}&include_isolated=true`);
      expect(onlyWorkspace.body.nodes.map((node: { title: string }) => node.title)).toEqual(['我的页']);
      // page_total 与加载过滤条件同口径（不混入 common / 其它 workspace）
      expect(onlyWorkspace.body.page_total).toBe(1);
      expect(onlyWorkspace.body.pages_loaded).toBe(1);

      const onlyCommon = await graph(`scope=common&include_isolated=true`);
      expect(onlyCommon.body.nodes.map((node: { title: string }) => node.title)).toEqual(['公共页']);
      expect(onlyCommon.body.page_total).toBe(1);

      const both = await graph(`scope=both&workspace_id=${workspaceId}&include_isolated=true`);
      expect(both.body.nodes.map((node: { title: string }) => node.title).sort()).toEqual(['公共页', '我的页'].sort());
      expect(both.body.nodes.map((node: { workspace_id: string | null }) => node.workspace_id)).not.toContain(otherWorkspace);
      expect(both.body.page_total).toBe(2);
    } finally {
      rmSync(otherDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
    }
  });

  it('truncatesLargeGraphToHardCapsWithRealTotals', async () => {
    const shared = [source('file:shared-big.ts')];
    for (let index = 0; index < 200; index += 1) {
      page(`p${index}`, `页 ${index}`, `共享内容 ${index}`, shared);
    }
    const started = Date.now();
    const res = await graph(`scope=workspace&workspace_id=${workspaceId}&limit_nodes=300&limit_edges=900`);
    const elapsed = Date.now() - started;
    expect(res.status).toBe(200);
    expect(res.body.nodes).toHaveLength(GRAPH_MAX_NODES);
    expect(res.body.edges).toHaveLength(GRAPH_MAX_EDGES);
    expect(res.body.node_total).toBe(200);
    expect(res.body.edge_total).toBe(200 * 199 / 2);
    expect(res.body.truncated).toBe(true);
    expect(res.body.truncated_reason).toBe('nodes');
    expect(res.body.pages_truncated).toBe(false);
    expect(res.body.page_total).toBe(200);
    expect(res.body.pages_loaded).toBe(200);
    // 截断按 degree 降序：所有节点度相同 → 取 id 最小的一批，仍保持 degree 排序稳定
    const degrees = res.body.nodes.map((node: { degree: number }) => node.degree);
    expect(degrees.every((degree: number) => degree === degrees[0])).toBe(true);
    const bytes = Buffer.byteLength(JSON.stringify(res.body));
    expect(bytes).toBeLessThan(300 * 1024);
    expect(elapsed).toBeLessThan(5000);
  }, 20000);

  it('rejectsInvalidQuery', async () => {
    expect((await graph(`scope=workspace`)).status).toBe(400);
    expect((await graph(`scope=workspace&workspace_id=${workspaceId}&edge_kinds=foo`)).status).toBe(400);
    expect((await graph(`scope=workspace&workspace_id=${workspaceId}&edge_kinds=`)).status).toBe(400);
    expect((await graph(`scope=nope&workspace_id=${workspaceId}`)).status).toBe(400);
    expect((await graph(`scope=both&workspace_id=${workspaceId}&limit_nodes=0`)).status).toBe(400);
  });

  it('entityTermsDropStopwordsAndSingleChars', () => {
    const terms = entityTerms('the 的 alpha 中单字 beta 以及');
    expect(terms.has('alpha')).toBe(true);
    expect(terms.has('beta')).toBe(true);
    expect(terms.has('the')).toBe(false);
    expect(terms.has('以及')).toBe(false);
    expect([...terms].every(term => term.length >= 2)).toBe(true);
    expect(trigrams('abc abc').size).toBe(3); // 去空格后 abcabc → abc/bca/cab 三个不同 3-gram
  });

  it('pageSetTruncationIsExplicitNotSilent', async () => {
    // 等价于 >5000 页：把页面加载上限临时调到 3
    const adapter = new FakeAdapter();
    const created = await createApp({
      db: t.db,
      getAdapter: (id: string) => { if (id === 'fake') return adapter; throw new Error(`未知适配器 id: ${id}`); },
      adapters: [adapter],
      refreshClisOnBoot: false,
      knowledgeGraphPageLimit: 3,
    });
    app = created.app;
    const shared = [source('file:bulk.ts')];
    for (let index = 0; index < 6; index += 1) page(`bulk${index}`, `批量页 ${index}`, `共享内容 ${index}`, shared);

    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const res = await graph(`scope=workspace&workspace_id=${workspaceId}&include_isolated=true`);
    expect(res.status).toBe(200);
    expect(res.body.pages_truncated).toBe(true);
    expect(res.body.truncated_reason).toBe('pages');
    expect(res.body.page_total).toBe(6);
    expect(res.body.pages_loaded).toBe(3);
    expect(res.body.truncated).toBe(true);
    // node_total 只反映已加载的子集（≤3），不冒充全量
    expect(res.body.node_total).toBeLessThanOrEqual(3);
    expect(res.body.nodes.length).toBeLessThanOrEqual(3);
    // 不静默：日志带真实行数与上限
    expect(warn).toHaveBeenCalledWith('[knowledge-graph] 页面集合被上限截断：图只覆盖已加载页', expect.objectContaining({ loaded: 3, limit: 3 }));
    warn.mockRestore();

    // 未超限时标志为 false（同一上限，页面数 2）
    const single = await createWorkspace(t.db, { name: '小空间', path: mkdtempSync(join(tmpdir(), 'agentboard-graph3-')) });
    for (const name of ['一', '二']) {
      const smallSource = source('file:small.ts');
      createKnowledgePage(t.db, {
        scope: 'workspace', workspace_id: single.id, slug: `s-${name}`, title: `页${name}`, body_md: '共享 主题 内容',
        sources: [smallSource], evidence: [{ source_id: smallSource.source_id, locator: smallSource.locator }], actor: 'user',
      });
    }
    const small = await graph(`scope=workspace&workspace_id=${single.id}&include_isolated=true`);
    expect(small.body.pages_truncated).toBe(false);
    expect(small.body.truncated_reason).toBeNull();
    expect(small.body.page_total).toBe(2);
    expect(small.body.pages_loaded).toBe(2);
  });

  it('repoReportsPageTruncationFlag', () => {
    const shared = [source('file:repo-bulk.ts')];
    for (let index = 0; index < 5; index += 1) page(`repo${index}`, `仓库页 ${index}`, `共享 ${index}`, shared);
    const limited = listKnowledgeGraphRows(t.db, { scope: 'workspace', workspace_id: workspaceId }, 3);
    expect(limited.rows).toHaveLength(3);
    expect(limited.pagesTruncated).toBe(true);
    const full = listKnowledgeGraphRows(t.db, { scope: 'workspace', workspace_id: workspaceId }, 10);
    expect(full.rows).toHaveLength(5);
    expect(full.pagesTruncated).toBe(false);
  });
});
