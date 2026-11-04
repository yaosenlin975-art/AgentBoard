import express, { type Express } from 'express';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createRouter, errorHandler } from '../src/api/routes.js';
import { createTestDb, type TestDb } from './helpers.js';
import { createWorkspace } from '../src/db/repos/workspace.js';
import { buildKnowledgeGraph, GRAPH_KEYWORD_MIN_TERMS } from '../src/services/knowledgeGraph.js';

/**
 * GRAPH-EDGE-BUG：「不管有没有联系都连成一团」。
 * 根因是关键词共现门槛（旧 2 词 / 3 trigram）在长文档上必然命中 → 完全图；
 * 修复后：稀有项过滤 + 阈值 3 词 / 6 trigram + 相对重叠率（词 25% / trigram 20%）。
 */
describe('GRAPH-EDGE-BUG：4 页 fixture（A↔B 互链，C/D 孤立）', () => {
  let t: TestDb;
  let app: Express;
  let workspaceId: string;
  beforeEach(() => {
    t = createTestDb();
    workspaceId = createWorkspace(t.db, { name: 'A', path: 'A' }).id;
    app = express();
    app.use(express.json());
    app.use('/api', createRouter({ db: t.db, getAdapter: () => { throw Error('unused'); }, broadcast: () => {} }));
    app.use(errorHandler);
  });
  afterEach(() => t.cleanup());

  const createPage = (slug: string, title: string, body: string) =>
    request(app).post('/api/knowledge/pages').send({
      domain: 'knowledge',
      scope: 'workspace',
      workspace_id: workspaceId,
      slug,
      title,
      body_md: body,
      actor: 'dsh',
      sources: [{ source_id: slug, source_type: 'file', locator: `fixture/${slug}.md`, captured_at: 1, content_hash: `${slug}0`.padEnd(64, 'a') }],
      evidence: [{ source_id: slug, locator: `fixture/${slug}.md` }],
      category: 'legacy',
    });

  const fetchGraph = (kinds: string) =>
    request(app).get('/api/knowledge/graph').query({ scope: 'workspace', workspace_id: workspaceId, limit_nodes: 50, limit_edges: 100, edge_kinds: kinds, include_isolated: 'true' });

  it('A↔B 双链 + C/D 无链接 → 只有 1 条边（kind=link，双向合并）；C/D degree=0', async () => {
    // 互链：A 正文含 [[乙页]]，B 正文含 [[甲页]] → knowledge_link 双向各一条
    expect((await createPage('a', '甲页', '甲页正文，链到 [[b]]。')).status).toBe(200);
    expect((await createPage('b', '乙页', '乙页正文，回链 [[a]]。')).status).toBe(200);
    expect((await createPage('c', '丙页', '丙页独立内容：缓存淘汰与 WAL 检查点、fsync 代价。')).status).toBe(200);
    expect((await createPage('d', '丁页', '丁页独立内容：拖拽排序与虚拟滚动、requestAnimationFrame 节流。')).status).toBe(200);

    const res = await fetchGraph('link,source,keyword');
    expect(res.status).toBe(200);
    const edges = res.body.edges as Array<{ source: string; target: string; kind: string; weight: number }>;
    const nodes = res.body.nodes as Array<{ title: string; degree: number }>;

    // 4 节点里只有 A-B 有关系 → 1 条边（双向由 pairKey 合并成一条，weight 累加）
    expect(edges).toHaveLength(1);
    expect(edges[0]!.kind).toBe('link');
    const byTitle = new Map(nodes.map((node) => [node.title, node.degree]));
    expect(byTitle.get('甲页')).toBe(1);
    expect(byTitle.get('乙页')).toBe(1);
    expect(byTitle.get('丙页')).toBe(0);
    expect(byTitle.get('丁页')).toBe(0);
  });

  it('完全图守卫：万一关键词规则再次放松，这条会红（4 页最多 1 条边，远小于 C(4,2)=6）', async () => {
    await createPage('a', '甲页', '甲页正文，链到 [[b]]。');
    await createPage('b', '乙页', '乙页正文，回链 [[a]]。');
    await createPage('c', '丙页', '丙页独立内容：缓存淘汰与 WAL 检查点、fsync 代价。');
    await createPage('d', '丁页', '丁页独立内容：拖拽排序与虚拟滚动、requestAnimationFrame 节流。');
    const res = await fetchGraph('link,source,keyword');
    expect(res.body.edges.length).toBeLessThanOrEqual(1);
    expect(res.body.edge_total).toBeLessThan(6);
  });

  it('长文档只共享通用词 → 至多 1 条边（不连成团；已知限制：共享 4 字以上固定短语仍可能成边）', () => {
    const rows = [
      {
        id: 'x',
        scope: 'workspace' as const,
        workspace_id: workspaceId,
        title: '任务看板 项目状态',
        body_md: '任务 状态 变更 记录 ' + Array.from({ length: 30 }, (_, i) => `指标${i}分项`).join(' ') + ' kpi dashboard metric rollout',
        sources: [],
      },
      {
        id: 'y',
        scope: 'workspace' as const,
        workspace_id: workspaceId,
        title: 'handoff 交接记录',
        body_md: '任务 状态 变更 记录 ' + Array.from({ length: 30 }, (_, i) => `追踪${i}节点`).join(' ') + ' trace node graph render',
        sources: [],
      },
    ];
    const graph = buildKnowledgeGraph(rows, { edgeKinds: ['keyword'], includeIsolated: true, limitNodes: 50, limitEdges: 100 });
    expect(graph.edges.length).toBeLessThanOrEqual(1);
    expect(GRAPH_KEYWORD_MIN_TERMS).toBeGreaterThanOrEqual(3);
  });
});
