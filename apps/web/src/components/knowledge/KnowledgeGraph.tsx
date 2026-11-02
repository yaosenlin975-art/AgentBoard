import { useEffect, useMemo, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { KnowledgePage } from '@agentboard/shared';
import { api } from '../../api/client';
import {
  applyEdgeKinds,
  clampScale,
  composeGraph,
  graphStats,
  labelText,
  labelsVisible,
  layoutGraph,
  nodeRadius,
  normalizeGraph,
  type GraphEdgeKind,
  type GraphPayload,
  type GraphNode,
} from '../../lib/knowledgeGraph';

export interface GraphNodeTarget {
  id: string;
  scope: 'workspace' | 'common';
  workspace_id: string | null;
  title: string;
  revision: number;
  status: KnowledgePage['status'];
  expires_at: number | null;
}

type PageItem = Pick<KnowledgePage, 'id' | 'scope' | 'workspace_id' | 'title' | 'revision' | 'status' | 'expires_at'>;

interface Props {
  workspaceId: string | null;
  scope: 'both' | 'workspace' | 'common';
  onSelect: (page: GraphNodeTarget) => void;
}

const FALLBACK_PAGE_CAP = 50;
const CANVAS_W = 720;
const CANVAS_H = 480;

/** 服务端星图接口（server 线排期在 WS-REORDER 之后）：未就绪时回落本地合成 */
function graphParams(workspaceId: string | null, scope: Props['scope']): URLSearchParams {
  const params = new URLSearchParams({
    scope,
    limit_nodes: '300',
    limit_edges: '900',
    edge_kinds: 'source,keyword',
    include_isolated: 'true',
  });
  if (scope !== 'common' && workspaceId !== null) params.set('workspace_id', workspaceId);
  return params;
}

export function KnowledgeGraph({ workspaceId, scope, onSelect }: Props) {
  const [kinds, setKinds] = useState<Record<GraphEdgeKind, boolean>>({ source: true, keyword: true });
  const [showIsolated, setShowIsolated] = useState(true);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  const remote = useQuery({
    queryKey: ['knowledge-graph', workspaceId, scope],
    queryFn: () => api.get<GraphPayload>(`/api/knowledge/graph?${graphParams(workspaceId, scope)}`),
    retry: false,
    staleTime: 15_000,
  });

  // 回落：/pages 列表 + 逐页详情（≤50 页），本地按契约同一套阈值合成
  const fallback = useQuery({
    queryKey: ['knowledge-graph-fallback', workspaceId, scope],
    enabled: remote.isError,
    queryFn: async () => {
      const params = new URLSearchParams({ scope, limit: '100', status: 'active' });
      if (scope !== 'common' && workspaceId !== null) params.set('workspace_id', workspaceId);
      const list = await api.get<{ items: PageItem[] }>(`/api/knowledge/pages?${params}`);
      const pages = list.items.slice(0, FALLBACK_PAGE_CAP);
      const details = await Promise.all(
        pages.map((page) => {
          const detailParams = new URLSearchParams({ scope: page.scope });
          if (page.workspace_id) detailParams.set('workspace_id', page.workspace_id);
          return api.get<KnowledgePage>(`/api/knowledge/pages/${page.id}?${detailParams}`);
        }),
      );
      return composeGraph(
        details.map((page) => ({
          id: page.id,
          title: page.title,
          scope: page.scope,
          workspace_id: page.workspace_id,
          revision: page.revision,
          updated_at: page.updated_at,
          body_md: page.body_md,
          sources: page.sources,
        })),
        { edgeKinds: ['source', 'keyword'], includeIsolated: true },
      );
    },
    retry: false,
  });

  const usingFallback = remote.isError;
  const raw = usingFallback ? (fallback.data ?? null) : remote.data !== undefined ? normalizeGraph(remote.data) : null;
  const loading = remote.isPending || (usingFallback && fallback.isPending);
  const error = usingFallback && fallback.isError ? fallback.error : null;

  const fullGraph: GraphPayload | null = useMemo(() => {
    if (raw === null) return null;
    return {
      nodes: raw.nodes,
      edges: raw.edges,
      truncated: raw.truncated,
      truncated_reason: raw.truncated_reason,
      pages_truncated: raw.pages_truncated,
      node_total: raw.node_total,
      edge_total: raw.edge_total,
      page_total: raw.page_total,
      pages_loaded: raw.pages_loaded,
    };
  }, [raw]);

  const enabledKinds = useMemo<GraphEdgeKind[]>(
    () => (['source', 'keyword'] as GraphEdgeKind[]).filter((k) => kinds[k]),
    [kinds],
  );

  const graph = useMemo(() => {
    if (fullGraph === null) return null;
    const filtered = applyEdgeKinds(fullGraph, enabledKinds);
    return showIsolated ? filtered : { ...filtered, nodes: filtered.nodes.filter((n) => n.degree > 0) };
  }, [fullGraph, enabledKinds, showIsolated]);

  const stats = graph === null ? null : graphStats(graph);
  const positions = useMemo(() => {
    if (graph === null || graph.nodes.length === 0) return new Map();
    return layoutGraph(graph.nodes, graph.edges, { width: CANVAS_W, height: CANVAS_H, iterations: 120 }).positions;
  }, [graph]);

  // 缩放（KB-GRAPH-1）：标签在 scale < LABEL_SCALE_THRESHOLD 时隐藏；KB-GRAPH-2 会接滚轮与平移
  const [scale, setScale] = useState(1);
  const showLabels = labelsVisible(scale);
  const zoomBy = (delta: number): void => setScale((prev) => clampScale(Math.round((prev + delta) * 100) / 100));

  // canvas 绘制（jsdom 无 2d context → 跳过绘制，DOM 统计与节点列表仍可用）
  useEffect(() => {
    const canvas = canvasRef.current;
    if (canvas === null || graph === null) return;
    const ctx = canvas.getContext('2d');
    if (ctx === null) return;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, CANVAS_W, CANVAS_H);
    // 缩放以画布中心为基准（光标为中心留给 KB-GRAPH-2）
    ctx.translate(CANVAS_W / 2, CANVAS_H / 2);
    ctx.scale(scale, scale);
    ctx.translate(-CANVAS_W / 2, -CANVAS_H / 2);
    for (const edge of graph.edges) {
      const a = positions.get(edge.source);
      const b = positions.get(edge.target);
      if (a === undefined || b === undefined) continue;
      ctx.beginPath();
      ctx.strokeStyle = edge.kind === 'source' ? 'rgba(59,130,246,0.55)' : 'rgba(148,163,184,0.45)';
      ctx.lineWidth = edge.kind === 'source' ? 1.6 : 1;
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(b.x, b.y);
      ctx.stroke();
    }
    for (const node of graph.nodes) {
      const p = positions.get(node.id);
      if (p === undefined) continue;
      const radius = nodeRadius(node.degree);
      ctx.beginPath();
      ctx.fillStyle = node.scope === 'common' ? '#94a3b8' : '#3b82f6';
      ctx.arc(p.x, p.y, radius, 0, Math.PI * 2);
      ctx.fill();
    }
    // 标签在节点下方；缩放低于阈值时整体不画（KB-GRAPH-1）
    if (showLabels) {
      ctx.font = '10px ui-sans-serif, system-ui, sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'top';
      ctx.fillStyle = 'rgba(82,82,82,1)';
      for (const node of graph.nodes) {
        const p = positions.get(node.id);
        if (p === undefined) continue;
        ctx.fillText(labelText(node.title), p.x, p.y + nodeRadius(node.degree) + 4);
      }
    }
  }, [graph, positions, scale, showLabels]);

  const pick = (node: GraphNode): void => {
    onSelect({
      id: node.id,
      scope: node.scope,
      workspace_id: node.workspace_id,
      title: node.title,
      revision: node.revision,
      status: 'active',
      expires_at: null,
    });
  };

  return (
    <div
      data-testid="knowledge-graph"
      data-scale={scale}
      data-labels-visible={showLabels ? 'true' : 'false'}
      className="flex min-h-0 flex-col rounded-lg border border-neutral-200 bg-white dark:border-neutral-800 dark:bg-neutral-900"
    >
      <div className="flex flex-wrap items-center gap-3 border-b border-neutral-200 px-3 py-2 text-xs text-neutral-600 dark:border-neutral-800 dark:text-neutral-300">
        <label className="flex items-center gap-1">
          <input
            type="checkbox"
            data-testid="graph-edge-source"
            checked={kinds.source}
            onChange={(e) => setKinds((prev) => ({ ...prev, source: e.target.checked }))}
            className="size-3.5 accent-blue-600"
          />
          来源关联
        </label>
        <label className="flex items-center gap-1">
          <input
            type="checkbox"
            data-testid="graph-edge-keyword"
            checked={kinds.keyword}
            onChange={(e) => setKinds((prev) => ({ ...prev, keyword: e.target.checked }))}
            className="size-3.5 accent-blue-600"
          />
          关键词关联
        </label>
        <label className="flex items-center gap-1">
          <input
            type="checkbox"
            data-testid="graph-isolated"
            checked={showIsolated}
            onChange={(e) => setShowIsolated(e.target.checked)}
            className="size-3.5 accent-blue-600"
          />
          显示孤立点
        </label>
        <span className="flex items-center gap-1" data-testid="graph-zoom-controls">
          <button type="button" data-testid="graph-zoom-out" aria-label="缩小星图" title="缩小（0.8 倍以下隐藏标签）" onClick={() => zoomBy(-0.2)} className="rounded border border-neutral-300 px-1.5 text-xs dark:border-neutral-700">−</button>
          <button type="button" data-testid="graph-zoom-in" aria-label="放大星图" title="放大" onClick={() => zoomBy(0.2)} className="rounded border border-neutral-300 px-1.5 text-xs dark:border-neutral-700">+</button>
          <span data-testid="graph-scale" className="tabular-nums">{scale.toFixed(1)}×</span>
        </span>
        {stats !== null && (
          <span data-testid="knowledge-graph-stats" className="ml-auto tabular-nums">
            {stats.nodeCount} 个节点 · {stats.edgeCount} 条关联（来源 {stats.sourceEdges} / 关键词 {stats.keywordEdges}）
          </span>
        )}
      </div>

      {usingFallback && (
        <p data-testid="graph-fallback-notice" className="border-b border-amber-200 bg-amber-50 px-3 py-1.5 text-xs text-amber-700 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-300">
          服务端星图接口未就绪，已按本地规则合成（来源共现 + 关键词共现，最多 {FALLBACK_PAGE_CAP} 页）
        </p>
      )}

      {loading && <p data-testid="knowledge-graph-loading" className="px-3 py-6 text-center text-sm text-neutral-400">星图加载中…</p>}

      {error !== null && !loading && (
        <p role="alert" className="px-3 py-6 text-center text-sm text-red-600 dark:text-red-400">{error.message}</p>
      )}

      {!loading && error === null && graph !== null && graph.nodes.length === 0 && (
        <div data-testid="graph-empty-no-pages" className="px-4 py-10 text-center">
          <p className="text-sm font-medium text-neutral-700 dark:text-neutral-300">暂无可视化知识</p>
          <p className="mt-1 text-xs text-neutral-500 dark:text-neutral-400">当前范围内还没有知识页，先在左侧新建知识页</p>
        </div>
      )}

      {!loading && error === null && graph !== null && graph.nodes.length > 0 && graph.edges.length === 0 && (
        <div data-testid="graph-empty-no-edges" className="px-4 py-10 text-center">
          <p className="text-sm font-medium text-neutral-700 dark:text-neutral-300">知识页之间还没有关联</p>
          <p className="mt-1 text-xs text-neutral-500 dark:text-neutral-400">
            共 {graph.nodes.length} 个知识页，但彼此没有共享来源，也没有达到关键词阈值的重合
          </p>
          <p className="mt-2 text-xs text-neutral-500 dark:text-neutral-400">
            建立关联：① 给两页填同一个来源文件或 URL；② 打开上方「关键词关联」（共享实体词 ≥2 或 trigram 重叠 ≥3 才成边）；③ 正文双链后续支持
          </p>
        </div>
      )}

      {!loading && error === null && graph !== null && graph.nodes.length > 0 && graph.edges.length > 0 && (
        <canvas
          data-testid="knowledge-graph-canvas"
          ref={canvasRef}
          width={CANVAS_W}
          height={CANVAS_H}
          aria-label={`知识星图：${stats?.nodeCount ?? 0} 个节点，${stats?.edgeCount ?? 0} 条关联`}
          className="h-[480px] w-full max-w-full"
          style={{ maxWidth: '100%' }}
        />
      )}

      {!loading && error === null && graph !== null && graph.truncated_reason !== null && (
        <p data-testid="graph-truncated" className="border-t border-neutral-200 px-3 py-1.5 text-xs text-neutral-500 dark:border-neutral-800 dark:text-neutral-400">
          {graph.truncated_reason === 'pages'
            ? `共 ${graph.page_total ?? graph.node_total} 页，已加载 ${graph.pages_loaded ?? graph.node_total} 页，图仅覆盖已加载部分；缩小范围可获得完整关系`
            : graph.truncated_reason === 'nodes'
              ? `已按关联度显示前 ${graph.nodes.length} 个节点，共 ${graph.node_total} 个`
              : `已显示前 ${graph.edges.length} 条关联，共 ${graph.edge_total} 条`}
        </p>
      )}

      {!loading && error === null && graph !== null && graph.nodes.length > 0 && (
        <ul data-testid="knowledge-graph-nodes" className="sr-only">
          {graph.nodes.map((node) => (
            <li key={node.id}>
              <button type="button" data-testid={`graph-node-${node.id}`} data-degree={node.degree} data-radius={nodeRadius(node.degree)} onClick={() => pick(node)}>
                {node.title}（度 {node.degree}）
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}




