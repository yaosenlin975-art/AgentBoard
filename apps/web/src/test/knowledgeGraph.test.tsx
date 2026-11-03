import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { server } from './server';
import { KnowledgeGraph } from '../components/knowledge/KnowledgeGraph';
import {
  KEYWORD_THRESHOLDS,
  applyEdgeKinds,
  composeGraph,
  entityTerms,
  graphStats,
  keywordWeight,
  layoutGraph,
  normalizeGraph,
  type GraphNode,
  type GraphPayload,
} from '../lib/knowledgeGraph';

const page = (id: string, extra: Record<string, unknown> = {}) => ({
  id,
  title: `页面 ${id}`,
  scope: 'workspace' as const,
  workspace_id: 'A',
  revision: 1,
  body_md: '',
  sources: [] as Array<{ source_type: string; locator: string; content_hash?: string }>,
  ...extra,
});

describe('knowledgeGraph 纯函数（边合成与阈值、截断）', () => {
  it('E1：共享 locator 成 source 边（weight 3），共享 content_hash 加强为 4', () => {
    const graph = composeGraph([
      page('a', { sources: [{ source_type: 'file', locator: 'src/x.ts', content_hash: 'h1' }] }),
      page('b', { sources: [{ source_type: 'file', locator: 'src/x.ts' }] }),
      page('c', { sources: [{ source_type: 'file', locator: 'src/x.ts', content_hash: 'h1' }] }),
    ]);
    const edges = graph.edges.filter((e) => e.kind === 'source');
    expect(edges).toHaveLength(3);
    const ab = edges.find((e) => [e.source, e.target].sort().join() === 'a,b')!;
    const ac = edges.find((e) => [e.source, e.target].sort().join() === 'a,c')!;
    // 服务端公式：3×共享 locator 数 + 4×共享 hash 数\n    expect(ab.weight).toBe(3);
    expect(ac.weight).toBe(7);
    expect(ab.key).toContain('source:');
    expect(graph.edge_total).toBe(3);
  });

  it('E2：共享实体词 ≥2 成 keyword 边；仅 1 个不成边；trigram 重叠 ≥3 也成边', () => {
    expect(KEYWORD_THRESHOLDS.sharedEntityTerms).toBe(2);
    expect(KEYWORD_THRESHOLDS.trigramOverlap).toBe(3);
    // 2 个共享实体词：缓存/失效
    expect(keywordWeight('缓存 失效', '', '缓存 失效 策略', '')).toBe(1);
    // 1 个共享实体词 + trigram 重叠不足
    expect(keywordWeight('缓存', '', '缓存 无关词', '')).toBe(0);
    // 停用词不算实体词
    expect(keywordWeight('的 了', '', '的 了 是', '')).toBe(0);
    expect(entityTerms('的 缓存 the cache')).toEqual(new Set(['缓存', 'cache']));
    // 长串 trigram 重叠 ≥3（实体词只有 1 个重叠）
    expect(keywordWeight('abcdefg', '', 'abcdefg xy', '')).toBe(1);
  });

  it('E2 与 E1 不重复成边：已有 source 边的两页不再加 keyword 边', () => {
    const graph = composeGraph([
      page('a', { title: '缓存 失效', sources: [{ source_type: 'file', locator: 'src/x.ts' }] }),
      page('b', { title: '缓存 失效', sources: [{ source_type: 'file', locator: 'src/x.ts' }] }),
    ]);
    expect(graph.edges).toHaveLength(1);
    expect(graph.edges[0]!.kind).toBe('source');
  });

  it('截断：节点按 degree 降序保留，truncated=true 且 node_total 为真实总数', () => {
    const pages = [
      page('hub', { sources: [{ source_type: 'file', locator: 'src/hub.ts' }] }),
      page('x', { sources: [{ source_type: 'file', locator: 'src/hub.ts' }] }),
      page('y', { title: '完全不同 甲乙丙', sources: [{ source_type: 'file', locator: 'src/y.ts' }] }),
      page('z', { title: '毫无关联 丁戊己', sources: [{ source_type: 'file', locator: 'src/z.ts' }] }),
    ];
    const graph = composeGraph(pages, { limitNodes: 2, edgeKinds: ['source'] });
    expect(graph.nodes).toHaveLength(2);
    expect(graph.nodes.map((n) => n.id).sort()).toEqual(['hub', 'x']);
    expect(graph.node_total).toBe(4);
    expect(graph.truncated).toBe(true);
    expect(graph.droppedNodes).toBe(2);
  });

  it('applyEdgeKinds：本地开关只过滤可见边并按可见边重算度数', () => {
    const payload: GraphPayload = {
      nodes: [
        { id: 'a', title: 'a', scope: 'workspace', workspace_id: 'A', revision: 1, degree: 2 },
        { id: 'b', title: 'b', scope: 'workspace', workspace_id: 'A', revision: 1, degree: 2 },
      ],
      edges: [
        { source: 'a', target: 'b', kind: 'source', weight: 3, key: 'file:x' },
        { source: 'a', target: 'b', kind: 'keyword', weight: 1, key: 'kw' },
      ],
      truncated: false,
      truncated_reason: null,
      pages_truncated: false,
      node_total: 2,
      edge_total: 2,
    };
    const onlySource = applyEdgeKinds(payload, ['source']);
    expect(onlySource.edges).toHaveLength(1);
    expect(onlySource.nodes.every((n) => n.degree === 1)).toBe(true);
    expect(applyEdgeKinds(payload, ['source', 'keyword']).edges).toHaveLength(2);
  });

  it('normalizeGraph：丢弃非法项、补默认值、透传服务端 truncated', () => {
    const result = normalizeGraph({
      nodes: [
        { id: 'a', title: 'A' },
        { id: '', title: '非法' },
        { title: '缺 id' },
      ],
      edges: [
        { source: 'a', target: 'b', kind: 'source', weight: 3 },
        { source: 'a', target: 'ghost', kind: 'source', weight: 3 },
        { source: 'a', target: 'b', kind: 'weird', weight: 1 },
      ],
      truncated: true,
      node_total: 99,
      edge_total: 77,
    });
    expect(result.nodes).toHaveLength(1);
    expect(result.malformed).toBe(5);
    expect(result.truncated).toBe(true);
    expect(result.node_total).toBe(99);
  });

  it('服务端契约：degree 为截断前真实度数，前端保留不重算', () => {
    const result = normalizeGraph({
      nodes: [
        { id: 'a', title: 'A', scope: 'workspace', workspace_id: 'A', degree: 5 },
        { id: 'b', title: 'B', scope: 'workspace', workspace_id: 'A', degree: 1 },
      ],
      edges: [{ source: 'a', target: 'b', kind: 'source', weight: 7 }],
      truncated: true,
      node_total: 202,
      edge_total: 19901,
    });
    expect(result.nodes.find((n) => n.id === 'a')?.degree).toBe(5);
    expect(result.edges[0]?.weight).toBe(7);
    expect(result.truncated).toBe(true);
    expect(result.node_total).toBe(202);
    expect(result.edge_total).toBe(19901);
  });

  it('服务端契约：150 节点 / 500 边上限不在前端二次裁剪', () => {
    const nodes = Array.from({ length: 150 }, (_, i) => ({ id: `n${i}`, title: `N${i}`, scope: 'workspace', workspace_id: 'A', degree: 7 }));
    const edges: Array<{ source: string; target: string; kind: 'source'; weight: number }> = [];
    for (let a = 1; a < 150 && edges.length < 500; a += 1) {
      for (let b = 0; b < a && edges.length < 500; b += 1) edges.push({ source: `n${a}`, target: `n${b}`, kind: 'source', weight: 3 });
    }
    const result = normalizeGraph({ nodes, edges, truncated: true, node_total: 202, edge_total: 19901 });
    expect(result.nodes).toHaveLength(150);
    expect(result.edges).toHaveLength(500);
    expect(result.malformed).toBe(0);
  });
  it('服务端契约：page_total / pages_loaded 透传（pages 截断时 loaded < total）', () => {
    const result = normalizeGraph({
      nodes: [{ id: 'a', title: 'A', scope: 'workspace', workspace_id: 'A', degree: 0 }],
      edges: [],
      truncated: true,
      truncated_reason: 'pages',
      pages_truncated: true,
      node_total: 1,
      edge_total: 0,
      page_total: 6000,
      pages_loaded: 5000,
    });
    expect(result.page_total).toBe(6000);
    expect(result.pages_loaded).toBe(5000);
    expect(result.pages_truncated).toBe(true);
    // 服务端未给时退化为节点数，避免文案出现 undefined
    const fallback = normalizeGraph({ nodes: [{ id: 'b', title: 'B' }], edges: [] });
    expect(fallback.page_total).toBe(1);
    expect(fallback.pages_loaded).toBe(1);
  });
  /**
   * CPU 标尺（TEST-FLAKE）：固定工作量的纯计算，用来把墙钟毫秒换成无量纲的 CPU 成本。
   * 并发跑全量时 CPU 抢占会让布局与标尺**同比例**变慢，相除即抵消；真实复杂度回归只影响布局一侧。
   */
  function measureCpuScale(): number {
    const started = performance.now();
    let acc = 0;
    for (let i = 0; i < 300000; i += 1) acc += Math.sqrt(i) * 1.0000001;
    if (acc < 0) throw new Error('unreachable');
    return performance.now() - started;
  }

  it('layoutGraph：300 节点 / 900 边 预跑 120 tick（CPU 归一化口径，非墙钟）', () => {
    const nodes: GraphNode[] = Array.from({ length: 300 }, (_, i) => ({
      id: `n${i}`,
      title: `节点 ${i}`,
      scope: 'workspace',
      workspace_id: 'A',
      revision: 1,
      degree: 0,
    }));
    const edges = Array.from({ length: 900 }, (_, i) => ({
      source: `n${i % 300}`,
      target: `n${(i * 7 + 3) % 300}`,
      kind: 'source' as const,
      weight: 3,
      key: `k${i}`,
    })).filter((e) => e.source !== e.target);

    // 标尺先热身一次（首调用含 JIT 预热），再取 3 次中位数当基准
    measureCpuScale();
    const scales = [measureCpuScale(), measureCpuScale(), measureCpuScale()].sort((a, b) => a - b);
    const cpuScale = scales[1] ?? scales[0] ?? 1;

    const runs = [0, 1, 2].map(() => {
      const layout = layoutGraph(nodes, edges, { width: 720, height: 480, iterations: 120, measure: true });
      const sorted = [...layout.tickMs].sort((a, b) => a - b);
      const avg = layout.totalMs / (layout.tickMs.length || 1);
      const p95 = sorted[Math.floor(sorted.length * 0.95)] ?? 0;
      return {
        layout,
        avg,
        p95,
        /** 无量纲 CPU 成本：布局耗时 / 标尺耗时（并发抢占对两边同比，抵消） */
        avgRatio: avg / cpuScale,
        p95Ratio: p95 / cpuScale,
        totalRatio: layout.totalMs / cpuScale,
        spanOk: p95 >= 0 && (sorted[0] ?? 0) <= p95,
      };
    });
    for (const run of runs) {
      console.info(
        `[KB-GRAPH] layout 300n/900e ticks=${run.layout.tickMs.length} rawAvg=${run.avg.toFixed(2)}ms rawP95=${run.p95.toFixed(2)}ms ` +
          `cpuScale=${cpuScale.toFixed(2)}ms avgRatio=${run.avgRatio.toFixed(3)} p95Ratio=${run.p95Ratio.toFixed(3)}`,
      );
    }
    const best = runs.reduce((a, b) => (b.avgRatio < a.avgRatio ? b : a));
    console.info(`[KB-GRAPH] best-of-3 avgRatio=${best.avgRatio.toFixed(3)} p95Ratio=${best.p95Ratio.toFixed(3)}`);
    expect(best.layout.positions.size).toBe(300);
    expect(best.layout.tickMs).toHaveLength(120);
    // 归一化阈值：本机实测基线 avgRatio≈0.24 / p95Ratio≈0.35 / totalRatio≈29（标尺≈0.60ms），各留 ~3x 余量。
    // 复杂度抬 10 倍 → avgRatio≈2.4，必红。
    expect(best.avgRatio).toBeLessThanOrEqual(0.7);
    expect(best.p95Ratio).toBeLessThanOrEqual(1.2);
    expect(best.totalRatio).toBeLessThanOrEqual(90);

    // 规模伸缩性：同样 120 tick，300n 的 CPU 成本 / 100n 的 CPU 成本。
    // 网格桶近似 O(n)，基线约 2.5–3.5；退化成 O(n²) 时约 9，这条专门抓「复杂度结构变坏」。
    const small = layoutGraph(nodes.slice(0, 100), edges.filter((e) => Number(e.source.slice(1)) < 100 && Number(e.target.slice(1)) < 100), {
      width: 720,
      height: 480,
      iterations: 120,
      measure: true,
    });
    const smallRatio = small.totalMs / (small.tickMs.length || 1) / cpuScale;
    const scaling = best.avgRatio / (smallRatio || 1e-6);
    console.info(`[KB-GRAPH] scaling 300n/100n = ${scaling.toFixed(2)}（smallRatio=${smallRatio.toFixed(3)}）`);
    expect(scaling).toBeLessThanOrEqual(8);
    // 分位数自洽（确定性口径，不受负载影响）
    for (const run of runs) expect(run.spanOk).toBe(true);
    // 注：layoutGraph 内部对邻居做随机抽样（NEIGHBOR_SAMPLE），同输入不同次的坐标本就不完全相同，
    // 因此不做坐标级 determinism 断言；这里只锁确定性的结构量（tick 数、节点数、坐标边界、分位自洽）。
    for (const [, p] of best.layout.positions) {
      expect(p.x).toBeGreaterThanOrEqual(20);
      expect(p.x).toBeLessThanOrEqual(700);
    }
  });
});

function mountGraph(onSelect = vi.fn()) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <KnowledgeGraph workspaceId="A" scope="both" onSelect={onSelect} />
    </QueryClientProvider>,
  );
  return onSelect;
}

const remoteGraph = (nodes: GraphNode[], edges: GraphPayload['edges'], extra: Partial<GraphPayload> = {}): GraphPayload => ({
  nodes,
  edges,
  truncated: false,
  truncated_reason: null,
  pages_truncated: false,
  node_total: nodes.length,
  edge_total: edges.length,
  ...extra,
});

const node = (id: string, title: string, degree = 1): GraphNode => ({
  id,
  title,
  scope: 'workspace',
  workspace_id: 'A',
  revision: 1,
  degree,
});

describe('KnowledgeGraph 组件（契约 / 空态 / 交互）', () => {
  beforeEach(() => {
    // jsdom 未实现 canvas 2d：返回 null，组件跳过绘制（DOM 统计与节点列表仍工作）
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null as unknown as CanvasRenderingContext2D);
  });

  it('渲染服务端图：统计文本、画布、点节点打开详情回调', async () => {
    server.use(
      http.get('/api/knowledge/graph', ({ request }) => {
        const params = new URL(request.url).searchParams;
        expect(params.get('scope')).toBe('both');
        expect(params.get('workspace_id')).toBe('A');
        expect(params.get('edge_kinds')).toBe('source,keyword');
        return HttpResponse.json(
          remoteGraph(
            [node('p1', '缓存策略'), node('p2', '缓存失效')],
            [{ source: 'p1', target: 'p2', kind: 'source', weight: 3, key: 'file:x' }],
          ),
        );
      }),
    );
    const onSelect = mountGraph();
    expect(await screen.findByTestId('knowledge-graph-stats')).toHaveTextContent('2 个节点 · 1 条关联（来源 1 / 关键词 0）');
    expect(screen.getByTestId('knowledge-graph-stage')).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('graph-node-p1'));
    expect(onSelect).toHaveBeenCalledWith(expect.objectContaining({ id: 'p1', title: '缓存策略', scope: 'workspace' }));
  });

  it('空图第一档：没有知识页', async () => {
    server.use(http.get('/api/knowledge/graph', () => HttpResponse.json(remoteGraph([], []))));
    mountGraph();
    expect(await screen.findByTestId('graph-empty-no-pages')).toHaveTextContent('暂无可视化知识');
  });

  it('空图第二档：有页无边 → 明确说明 + 如何建立关联的引导', async () => {
    server.use(
      http.get('/api/knowledge/graph', () =>
        HttpResponse.json(remoteGraph([node('p1', '缓存策略', 0), node('p2', '发布流程', 0)], [])),
      ),
    );
    mountGraph();
    const empty = await screen.findByTestId('graph-empty-no-edges');
    expect(empty).toHaveTextContent('知识页之间还没有关联');
    expect(empty).toHaveTextContent('共 2 个知识页');
    expect(empty).toHaveTextContent('同一个来源文件或 URL');
    expect(empty).toHaveTextContent('关键词关联');
    expect(screen.queryByTestId('knowledge-graph-stage')).not.toBeInTheDocument();
  });

  it('空图第三档：节点截断按 truncated_reason=nodes 提示真实总数', async () => {
    server.use(
      http.get('/api/knowledge/graph', () =>
        HttpResponse.json(
          remoteGraph([node('p1', '缓存策略'), node('p2', '发布流程')], [{ source: 'p1', target: 'p2', kind: 'source', weight: 3, key: 'k' }], {
            truncated: true,
            truncated_reason: 'nodes',
            node_total: 202,
          }),
        ),
      ),
    );
    mountGraph();
    expect(await screen.findByTestId('graph-truncated')).toHaveTextContent('已按关联度显示前 2 个节点，共 202 个');
  });

  it('空图第三档：页面集合本身截断时提示数据不全（pages 优先）', async () => {
    server.use(
      http.get('/api/knowledge/graph', () =>
        HttpResponse.json(
          remoteGraph([node('p1', '缓存策略'), node('p2', '发布流程')], [{ source: 'p1', target: 'p2', kind: 'source', weight: 3, key: 'k' }], {
            truncated: true,
            truncated_reason: 'pages',
            pages_truncated: true,
            node_total: 5000,
            edge_total: 19901,
            page_total: 6000,
            pages_loaded: 5000,
          }),
        ),
      ),
    );
    mountGraph();
    const notice = await screen.findByTestId('graph-truncated');
    expect(notice).toHaveTextContent('共 6000 页，已加载 5000 页，图仅覆盖已加载部分');
    expect(notice).toHaveTextContent('缩小范围可获得完整关系');
  });

  it('未截断（truncated_reason=null）不显示截断提示', async () => {
    server.use(
      http.get('/api/knowledge/graph', () =>
        HttpResponse.json(remoteGraph([node('p1', '缓存策略'), node('p2', '发布流程')], [{ source: 'p1', target: 'p2', kind: 'source', weight: 3, key: 'k' }])),
      ),
    );
    mountGraph();
    await screen.findByTestId('knowledge-graph-stats');
    expect(screen.queryByTestId('graph-truncated')).not.toBeInTheDocument();
  });

  it('边类型开关：默认来源+关键词都开，关掉关键词后边数下降', async () => {
    server.use(
      http.get('/api/knowledge/graph', () =>
        HttpResponse.json(
          remoteGraph(
            [node('p1', '缓存策略'), node('p2', '缓存失效')],
            [
              { source: 'p1', target: 'p2', kind: 'source', weight: 3, key: 'file:x' },
              { source: 'p1', target: 'p2', kind: 'keyword', weight: 1, key: 'kw' },
            ],
          ),
        ),
      ),
    );
    mountGraph();
    expect(await screen.findByTestId('knowledge-graph-stats')).toHaveTextContent('2 条关联（来源 1 / 关键词 1）');
    expect(screen.getByTestId('graph-edge-keyword')).toBeChecked();
    fireEvent.click(screen.getByTestId('graph-edge-keyword'));
    await waitFor(() =>
      expect(screen.getByTestId('knowledge-graph-stats')).toHaveTextContent('1 条关联（来源 1 / 关键词 0）'),
    );
  });

  it('服务端端点未就绪时回落本地合成（共享来源 → 1 条来源关联）', async () => {
    server.use(
      http.get('/api/knowledge/graph', () => HttpResponse.json({ error: { code: 'NOT_FOUND', message: '接口不存在' } }, { status: 404 })),
      http.get('/api/knowledge/pages', () =>
        HttpResponse.json({
          items: [
            { id: 'p1', scope: 'workspace', workspace_id: 'A', title: '缓存策略', revision: 1, status: 'active', expires_at: null },
            { id: 'p2', scope: 'workspace', workspace_id: 'A', title: '缓存失效', revision: 1, status: 'active', expires_at: null },
          ],
          next_offset: null,
        }),
      ),
      http.get('/api/knowledge/pages/:id', ({ params }) =>
        HttpResponse.json({
          id: params.id,
          scope: 'workspace',
          workspace_id: 'A',
          slug: `slug-${params.id}`,
          title: params.id === 'p1' ? '缓存策略' : '缓存失效',
          body_md: '',
          revision: 1,
          status: 'active',
          expires_at: null,
          sources: [{ source_id: 's1', source_type: 'file', locator: 'src/knowledge.ts', captured_at: 1, content_hash: 'h1' }],
          evidence: [],
          created_at: 1,
          updated_at: 1,
        }),
      ),
    );
    mountGraph();
    expect(await screen.findByTestId('graph-fallback-notice')).toHaveTextContent('服务端星图接口未就绪');
    await waitFor(() =>
      expect(screen.getByTestId('knowledge-graph-stats')).toHaveTextContent('2 个节点 · 1 条关联（来源 1 / 关键词 0）'),
    );
    expect(graphStats((await Promise.resolve({ nodes: [], edges: [] })) as unknown as GraphPayload).nodeCount).toBe(0);
  });
});
