import { useEffect, useMemo, useRef, useState, type MouseEvent, type PointerEvent } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { KnowledgePage } from '@agentboard/shared';
import { api } from '../../api/client';
import {
  applyEdgeKinds,
  clampScale,
  composeGraph,
  fitTransform,
  highlightAround,
  hitTestNode,
  toGraphPoint,
  zoomAt,
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

  // 视口状态（KB-GRAPH-2）：scale + pan 合在一个 state 里，滚轮以光标为中心缩放；标签在 scale < 0.8 时隐藏
  const [view, setView] = useState<{ scale: number; pan: { x: number; y: number } }>({ scale: 1, pan: { x: 0, y: 0 } });
  const [hovered, setHovered] = useState<string | null>(null);
  /** 拖拽固定：节点 id → 图坐标（固定后不随布局变化，双击/右键释放） */
  const [pinned, setPinned] = useState<Map<string, { x: number; y: number }>>(() => new Map());
  const lastDrawMsRef = useRef(0);
  const hoverFrameRef = useRef<number | null>(null);
  const pendingHoverRef = useRef<string | null>(null);
  const dragRef = useRef<{ mode: 'pan' | 'node'; id: string | null; startX: number; startY: number; startPan: { x: number; y: number }; startNode: { x: number; y: number } } | null>(null);
  const scale = view.scale;
  const pan = view.pan;
  const showLabels = labelsVisible(scale);
  const highlight = useMemo(
    () => (graph === null ? { nodes: new Set<string>(), edges: new Set<string>() } : highlightAround(graph, hovered)),
    [graph, hovered],
  );

  /** 固定节点用固定坐标，其余用布局坐标 */
  const displayPositions = useMemo(() => {
    if (pinned.size === 0) return positions;
    const merged = new Map(positions);
    for (const [id, point] of pinned) merged.set(id, point);
    return merged;
  }, [positions, pinned]);

  /** 指针事件 → 画布内屏幕坐标 */
  const localPoint = (event: { clientX: number; clientY: number }): { x: number; y: number } => {
    const rect = canvasRef.current?.getBoundingClientRect();
    if (rect === undefined) return { x: 0, y: 0 };
    return { x: event.clientX - rect.left, y: event.clientY - rect.top };
  };

  const zoomBy = (factor: number): void => {
    setView((prev) => zoomAt(prev.pan, prev.scale, factor, { x: CANVAS_W / 2, y: CANVAS_H / 2 }));
  };

  const fitView = (): void => {
    setView(fitTransform(displayPositions, CANVAS_W, CANVAS_H));
  };

  const unpin = (id: string): void => {
    setPinned((prev) => {
      if (!prev.has(id)) return prev;
      const next = new Map(prev);
      next.delete(id);
      return next;
    });
  };

  // 滚轮缩放：非 passive 监听才能 preventDefault 阻止页面滚动；以光标为中心
  useEffect(() => {
    const canvas = canvasRef.current;
    if (canvas === null) return;
    const onWheel = (event: WheelEvent): void => {
      event.preventDefault();
      const rect = canvas.getBoundingClientRect();
      const cursor = { x: event.clientX - rect.left, y: event.clientY - rect.top };
      const factor = event.deltaY < 0 ? 1.1 : 1 / 1.1;
      setView((prev) => zoomAt(prev.pan, prev.scale, factor, cursor));
    };
    canvas.addEventListener('wheel', onWheel, { passive: false });
    return () => canvas.removeEventListener('wheel', onWheel);
  }, [graph]);

  // canvas 绘制（jsdom 无 2d context → 跳过绘制，DOM 统计与节点列表仍可用）
  useEffect(() => {
    const canvas = canvasRef.current;
    if (canvas === null || graph === null) return;
    const ctx = canvas.getContext('2d');
    if (ctx === null) return;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, CANVAS_W, CANVAS_H);
    ctx.setTransform(scale, 0, 0, scale, pan.x, pan.y);
    const drawStartMs = performance.now();
    const hasFocus = hovered !== null;
    const dim = 0.18;
    // 边：按（kind × 是否高亮）分到 4 条路径，一次 stroke 画完（避免 900 次 stroke）
    const edgeBatches = new Map<string, { path: Path2D; color: string; width: number; alpha: number }>();
    for (const edge of graph.edges) {
      const a = displayPositions.get(edge.source);
      const b = displayPositions.get(edge.target);
      if (a === undefined || b === undefined) continue;
      const lit = !hasFocus || highlight.edges.has(edge.key);
      const key = `${edge.kind}:${lit ? 'lit' : 'dim'}`;
      let batch = edgeBatches.get(key);
      if (batch === undefined) {
        batch = {
          path: new Path2D(),
          color: edge.kind === 'source' ? 'rgba(59,130,246,0.55)' : 'rgba(148,163,184,0.45)',
          width: edge.kind === 'source' ? 1.6 : 1,
          alpha: lit ? 1 : dim,
        };
        edgeBatches.set(key, batch);
      }
      batch.path.moveTo(a.x, a.y);
      batch.path.lineTo(b.x, b.y);
    }
    for (const batch of edgeBatches.values()) {
      ctx.globalAlpha = batch.alpha;
      ctx.strokeStyle = batch.color;
      ctx.lineWidth = batch.width;
      ctx.stroke(batch.path);
    }
    // 节点：按（scope × 是否高亮）分组，同组一次 fill
    const nodeBatches = new Map<string, { path: Path2D; color: string; alpha: number }>();
    for (const node of graph.nodes) {
      const point = displayPositions.get(node.id);
      if (point === undefined) continue;
      const radius = nodeRadius(node.degree);
      const lit = !hasFocus || highlight.nodes.has(node.id);
      const key = `${node.scope}:${lit ? 'lit' : 'dim'}`;
      let batch = nodeBatches.get(key);
      if (batch === undefined) {
        batch = { path: new Path2D(), color: node.scope === 'common' ? '#94a3b8' : '#3b82f6', alpha: lit ? 1 : dim };
        nodeBatches.set(key, batch);
      }
      batch.path.moveTo(point.x + radius, point.y);
      batch.path.arc(point.x, point.y, radius, 0, Math.PI * 2);
    }
    for (const batch of nodeBatches.values()) {
      ctx.globalAlpha = batch.alpha;
      ctx.fillStyle = batch.color;
      ctx.fill(batch.path);
    }
    // 固定态：外圈琥珀环
    if (pinned.size > 0) {
      const ring = new Path2D();
      for (const node of graph.nodes) {
        if (!pinned.has(node.id)) continue;
        const point = displayPositions.get(node.id);
        if (point === undefined) continue;
        const radius = nodeRadius(node.degree) + 3;
        ring.moveTo(point.x + radius, point.y);
        ring.arc(point.x, point.y, radius, 0, Math.PI * 2);
      }
      ctx.globalAlpha = 1;
      ctx.strokeStyle = '#f59e0b';
      ctx.lineWidth = 2;
      ctx.stroke(ring);
    }
    ctx.globalAlpha = 1;
    // 标签：按是否高亮分两批
    if (showLabels) {
      ctx.font = '10px ui-sans-serif, system-ui, sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'top';
      for (const pass of [true, false]) {
        ctx.fillStyle = pass ? 'rgba(82,82,82,1)' : 'rgba(82,82,82,0.25)';
        for (const node of graph.nodes) {
          const lit = !hasFocus || highlight.nodes.has(node.id);
          if (lit !== pass) continue;
          const point = displayPositions.get(node.id);
          if (point === undefined) continue;
          ctx.fillText(labelText(node.title), point.x, point.y + nodeRadius(node.degree) + 4);
        }
      }
    }
    lastDrawMsRef.current = Math.round((performance.now() - drawStartMs) * 10) / 10;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
  }, [graph, displayPositions, pinned, scale, pan, showLabels, hovered, highlight]);

  const onPointerDown = (event: PointerEvent<HTMLCanvasElement>): void => {
    const screen = localPoint(event);
    const point = toGraphPoint(screen, pan, scale);
    const hit = graph === null ? null : hitTestNode(graph.nodes, displayPositions, point);
    dragRef.current = {
      mode: hit === null ? 'pan' : 'node',
      id: hit,
      startX: event.clientX,
      startY: event.clientY,
      startPan: pan,
      startNode: hit === null ? { x: 0, y: 0 } : (displayPositions.get(hit) ?? { x: point.x, y: point.y }),
    };
    event.currentTarget.setPointerCapture?.(event.pointerId);
  };

  const onPointerMove = (event: PointerEvent<HTMLCanvasElement>): void => {
    const screen = localPoint(event);
    const point = toGraphPoint(screen, pan, scale);
    const drag = dragRef.current;
    if (drag === null) {
      // hover 命中测试
      const hit = graph === null ? null : hitTestNode(graph.nodes, displayPositions, point);
      if (hit !== hovered) setHovered(hit);
      return;
    }
    if (drag.mode === 'pan') {
      setView((prev) => ({
        scale: prev.scale,
        pan: { x: drag.startPan.x + (event.clientX - drag.startX), y: drag.startPan.y + (event.clientY - drag.startY) },
      }));
      return;
    }
    if (drag.id !== null) {
      // 拖动节点 → 立即固定到光标位置
      setPinned((prev) => {
        const next = new Map(prev);
        next.set(drag.id as string, point);
        return next;
      });
    }
  };

  useEffect(() => () => {
    if (hoverFrameRef.current !== null) cancelAnimationFrame(hoverFrameRef.current);
  }, []);

  const endDrag = (): void => {
    dragRef.current = null;
  };

  const onDoubleClick = (event: MouseEvent<HTMLCanvasElement>): void => {
    if (graph === null) return;
    const point = toGraphPoint(localPoint(event), pan, scale);
    const hit = hitTestNode(graph.nodes, displayPositions, point);
    if (hit !== null) unpin(hit);
  };

  const onContextMenu = (event: MouseEvent<HTMLCanvasElement>): void => {
    if (graph === null) return;
    const point = toGraphPoint(localPoint(event), pan, scale);
    const hit = hitTestNode(graph.nodes, displayPositions, point);
    if (hit === null) return;
    event.preventDefault();
    unpin(hit);
  };

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
      data-hovered={hovered ?? ''}
      data-pinned-count={pinned.size}
      data-pan-x={Math.round(pan.x)}
      data-pan-y={Math.round(pan.y)}
      data-draw-ms={lastDrawMsRef.current}
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
          <button type="button" data-testid="graph-zoom-out" aria-label="缩小星图" title="缩小（0.8 倍以下隐藏标签）" onClick={() => zoomBy(1 / 1.25)} className="rounded border border-neutral-300 px-1.5 text-xs dark:border-neutral-700">−</button>
          <button type="button" data-testid="graph-zoom-in" aria-label="放大星图" title="放大" onClick={() => zoomBy(1.25)} className="rounded border border-neutral-300 px-1.5 text-xs dark:border-neutral-700">+</button>
          <span data-testid="graph-scale" className="tabular-nums">{scale.toFixed(1)}×</span>
          <button type="button" data-testid="graph-fit" aria-label="适应视图" title="适应视图（全部节点回到视口内）" onClick={fitView} className="rounded border border-neutral-300 px-1.5 text-xs dark:border-neutral-700">适应视图</button>
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
          className={`h-[480px] w-full max-w-full touch-none ${hovered === null ? 'cursor-grab' : 'cursor-pointer'}`}
          style={{ maxWidth: '100%' }}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={endDrag}
          onPointerLeave={() => { endDrag(); setHovered(null); }}
          onDoubleClick={onDoubleClick}
          onContextMenu={onContextMenu}
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






