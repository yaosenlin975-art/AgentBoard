
﻿import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { KnowledgePage } from '@agentboard/shared';
import { api } from '../../api/client';
import {
  applyEdgeKinds,
  buildAdjacency,
  composeGraph,
  edgeStyle,
  filterGraphForView,
  highlightAround,
  graphStats,
  layoutGraph,
  normalizeGraph,
  categoryColor,
  CATEGORY_STYLES,
  KNOWLEDGE_CATEGORIES,
  nodeRadius,
  nodeWeights,
  normalizeCategory,
  normalizeLanded,
  PRESET_UNLANDED_DESIGN,
  searchMatches,
  type GraphEdgeKind,
  type GraphNode,
  type GraphPayload,
} from '../../lib/knowledgeGraph';
import { textAlpha, tintFromCssColor } from '../../lib/graphVisualFormulas';
import { createForceLayoutClient, type ForceLayoutClient } from '../../lib/forceLayoutClient';
import { localGraphSlice } from '../../lib/localGraph';
import { GRAB_CURSOR } from '../../lib/cursor';
import { Kbd } from '../ui/Kbd';
import { FORCE_SLIDER_DEFAULTS, GraphControls, type ForceSliders } from './GraphControls';
import type { PixiGraphData, PixiGraphHandle } from './pixiGraph';

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
/** 布局视口（图坐标，不是画布像素）：layoutGraph 的初始分布区域 */
const LAYOUT_W = 720;
const LAYOUT_H = 480;
/**
 * KB-GRAPH-H：绘制区高度随浏览器视口自适应。
 * 视口高度 − 顶栏/视图 tab/知识库工具条/搜索行/星图工具条/图例等固定占用（≈320px），
 * 再夹在 360–900 之间：1280×720 → 400px，1440×900 → 580px，1920×1080 → 760px。
 */
const STAGE_HEIGHT = 'clamp(360px, calc(100dvh - 320px), 900px)';

/** GRAPH-INIT-FAIL：四类失败原因分开（各自文案 + data-graph-fallback 取值） */
type FallbackRenderer = 'no-webgl' | 'no-size' | 'import-failed' | 'create-failed';
const FALLBACK_RENDERERS: readonly string[] = ['no-webgl', 'no-size', 'import-failed', 'create-failed'];
const FALLBACK_TITLE: Record<FallbackRenderer, string> = {
  'no-webgl': '当前环境不支持 WebGL，已切换为列表视图',
  'no-size': '星图区域暂时没有尺寸，已先切换到列表视图（区域恢复后会自动重试）',
  'import-failed': '星图渲染器加载失败，已切换到列表视图',
  'create-failed': '星图渲染器初始化失败，已切换到列表视图',
};

/** WebGL 前置检测：拿不到 context 就不动态 import PIXI（jsdom 里必然为 null）。
 *  GRAPH-INIT-FAIL：探测本身也会占用一个 WebGL 上下文 → 探完立即用 WEBGL_lose_context 释放，
 *  且同一 document 只探一次（反复进出知识库不再累积探测上下文）。 */
let webglProbeCache: { doc: Document; ok: boolean } | null = null;
function hasWebgl(doc: Document): boolean {
  if (webglProbeCache !== null && webglProbeCache.doc === doc) return webglProbeCache.ok;
  const probe = doc.createElement('canvas');
  const gl = probe.getContext('webgl2') ?? probe.getContext('webgl');
  try {
    (gl as WebGLRenderingContext | null)?.getExtension('WEBGL_lose_context')?.loseContext();
  } catch {
    /* 忽略 */
  }
  const ok = gl !== null;
  webglProbeCache = { doc, ok };
  return ok;
}

/** 仅供测试：清掉探测缓存（同一 document 只探一次，单测里需要按用例切换 WebGL 可用性） */
export function __resetWebglProbeCache(): void {
  webglProbeCache = null;
}

/** 服务端星图接口（server 线排期在 WS-REORDER 之后）：未就绪时回落本地合成 */
function graphParams(workspaceId: string | null, scope: Props['scope']): URLSearchParams {
  const params = new URLSearchParams({
    scope,
    limit_nodes: '300',
    limit_edges: '900',
    // GRAPH-KEYWORD-ALIGN：真实双链（link）必须默认带上，否则页间 `[[双链]]` 在星图上完全不可见
    edge_kinds: 'link,source,keyword',
    include_isolated: 'true',
  });
  if (scope !== 'common' && workspaceId !== null) params.set('workspace_id', workspaceId);
  return params;
}

export function KnowledgeGraph({ workspaceId, scope, onSelect }: Props) {
  const [kinds, setKinds] = useState<Record<GraphEdgeKind, boolean>>({ link: true, source: true, keyword: true });
  const [showIsolated, setShowIsolated] = useState(true);
  const stageRef = useRef<HTMLDivElement | null>(null);
  const handleRef = useRef<PixiGraphHandle | null>(null);
  /**
   * PIXI 挂载状态（GRAPH-INIT-FAIL 五态）：
   * pending 探测中 / webgl 已挂载 / no-webgl 环境不支持 / no-size 容器暂无尺寸 / import-failed 模块加载失败 / create-failed 创建失败
   */
  const [renderer, setRenderer] = useState<'pending' | 'webgl' | 'no-webgl' | 'no-size' | 'import-failed' | 'create-failed'>('pending');
  /** 失败原因（可诊断用，只进 DOM/console，不外发） */
  const [graphError, setGraphError] = useState<{ code: string; message: string; stackTop: string | null } | null>(null);
  /** 尝试次数：自动 1 次 + 手动最多 2 次（合计上限 3） */
  const [attempts, setAttempts] = useState(0);
  /** 手动重试触发器：变化即重跑挂载 effect */
  const [retryToken, setRetryToken] = useState(0);

  const describeError = (code: string, error: unknown): { code: string; message: string; stackTop: string | null } => {
    const message = error instanceof Error ? error.message : typeof error === 'string' ? error : '未知错误';
    const stack = error instanceof Error && typeof error.stack === 'string' ? error.stack.split('\n').slice(0, 2).join(' | ') : null;
    return { code, message: message.slice(0, 300), stackTop: stack === null ? null : stack.slice(0, 300) };
  };

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
    () => (['link', 'source', 'keyword'] as GraphEdgeKind[]).filter((k) => kinds[k]),
    [kinds],
  );

  // 搜索与聚焦（KB-GRAPH-3）
  const [search, setSearch] = useState('');
  const [onlyMatches, setOnlyMatches] = useState(false);
  const [focusId, setFocusId] = useState<string | null>(null);
  const [focusHops, setFocusHops] = useState<1 | 2>(1);
  // KB-GRAPH-P4：局部图（C10）+ 控件面板（B2）
  const [localMode, setLocalMode] = useState(false);
  const [localJumps, setLocalJumps] = useState(1);
  const [forelinks, setForelinks] = useState(true);
  const [backlinks, setBacklinks] = useState(true);
  const [interlinks, setInterlinks] = useState(true);
  const [hideOrphans, setHideOrphans] = useState(false);
  const [forces, setForces] = useState<ForceSliders>(FORCE_SLIDER_DEFAULTS);
  /** KB-MODEL：默认按 category 着色；可切回按 scope（既有次级维度） */
  const [colorScheme, setColorScheme] = useState<'category' | 'scope'>('category');

  const graph = useMemo(() => {
    if (fullGraph === null) return null;
    const filtered = applyEdgeKinds(fullGraph, enabledKinds);
    return showIsolated ? filtered : { ...filtered, nodes: filtered.nodes.filter((n) => n.degree > 0) };
  }, [fullGraph, enabledKinds, showIsolated]);

  const matches = useMemo(() => (graph === null ? new Set<string>() : searchMatches(graph.nodes, search)), [graph, search]);
  const activeOnlyMatches = onlyMatches && search.trim() !== '';
  const viewFilter = useMemo(
    () =>
      graph === null
        ? { graph: null, hiddenNodes: 0, hiddenEdges: 0 }
        : filterGraphForView(graph, { focusId, hops: focusHops, matches, onlyMatches: activeOnlyMatches }),
    [graph, focusId, focusHops, matches, activeOnlyMatches],
  );
  /** 局部图（C10）：中心 = 聚焦节点，逐跳 BFS + 权重，只影响半径 */
  const local = useMemo(
    () =>
      localMode && focusId !== null && graph !== null
        ? localGraphSlice(graph, { centerId: focusId, jumps: localJumps, forelinks, backlinks, interlinks, hideOrphans })
        : null,
    [localMode, focusId, graph, localJumps, forelinks, backlinks, interlinks, hideOrphans],
  );
  /** 实际渲染的图（局部图 > 聚焦/只看命中过滤） */
  const shown = local?.graph ?? viewFilter.graph;
  const stats = shown === null ? null : graphStats(shown);
  // 布局（KB-GRAPH-P3）：首次用既有自研力学出初始坐标，之后走 D6 差量 + 力导向 tick（Worker，收敛即停）
  const [positions, setPositions] = useState<Map<string, { x: number; y: number }>>(() => new Map());
  const layoutClientRef = useRef<ForceLayoutClient | null>(null);
  useEffect(() => {
    if (shown === null || shown.nodes.length === 0) return;
    if (layoutClientRef.current === null) {
      layoutClientRef.current = createForceLayoutClient({
        workerFactory: () =>
          typeof Worker === 'undefined'
            ? null
            : new Worker(new URL('../../lib/forceLayoutWorker.ts', import.meta.url), { type: 'module' }),
        onPositions: (next) => setPositions(new Map(next)),
      });
    }
    const neighbours = buildAdjacency(shown.edges);
    const initial = layoutGraph(shown.nodes, shown.edges, { width: LAYOUT_W, height: LAYOUT_H, iterations: 120 }).positions;
    const result = layoutClientRef.current.apply(
      {
        ids: shown.nodes.map((node) => node.id),
        neighbours,
        links: shown.edges
          .filter((edge) => edge.source !== edge.target)
          .map((edge) => [edge.source, edge.target] as [string, string]),
      },
      initial,
    );
    // 结构变化：已存在节点保持原坐标 + 新节点落点立刻上屏，随后 tick 回传覆盖
    if (result.structural) setPositions(new Map(result.positions));
  }, [shown]);

  useEffect(
    () => () => {
      layoutClientRef.current?.destroy();
      layoutClientRef.current = null;
    },
    [],
  );

  // —— 渲染层：PIXI（KB-GRAPH-P1）。相机状态由渲染层自持，React 只做展示与降级 ——
  // 暗色跟随 html.dark（主题按钮会切 class；用 MutationObserver 触发重读 CSS 语义色）
  const [dark, setDark] = useState(() => typeof document !== 'undefined' && document.documentElement.classList.contains('dark'));
  useEffect(() => {
    const root = document.documentElement;
    const sync = (): void => setDark(root.classList.contains('dark'));
    sync();
    const observer = new MutationObserver(sync);
    observer.observe(root, { attributes: true, attributeFilter: ['class'] });
    return () => observer.disconnect();
  }, []);
  const [hovered, setHovered] = useState<string | null>(null);
  /** C4 右键菜单：节点 id + 触发点（client 坐标） */
  const [menu, setMenu] = useState<{ id: string; x: number; y: number } | null>(null);
  /** 相机倍率（渲染层回调上来，只用于展示与 data-scale） */
  const [scale, setScale] = useState(1);
  const highlight = useMemo(
    () => (shown === null ? { nodes: new Set<string>(), edges: new Set<string>() } : highlightAround(shown, hovered, focusHops)),
    [shown, hovered, focusHops],
  );
  const showStage = !loading && error === null && shown !== null && shown.nodes.length > 0 && shown.edges.length > 0;

  /** 数据映射（A6）：weight = 正向 ∪ 反向邻居数，公式与布局都不在渲染层重算 */
  const renderData = useMemo<PixiGraphData | null>(() => {
    if (!showStage || shown === null) return null;
    // weight = 正向 ∪ 反向邻居数（`nodeWeights`）；局部图模式下改用逐跳权重（文档 C10）
    const weights = nodeWeights(shown.nodes, shown.edges);
    return {
      nodes: shown.nodes.map((node) => ({
        id: node.id,
        title: node.title,
        weight: local?.weights.get(node.id) ?? weights.get(node.id) ?? 0,
        // KB-MODEL：category 固定五色；缺失一律 legacy 灰。scope 方案时退回语义色（不传 tint）
        ...(colorScheme === 'category' ? { tint: tintFromCssColor(categoryColor(node.category, dark)) } : {}),
      })),
      edges: shown.edges.map((edge) => ({
        key: edge.key,
        source: edge.source,
        target: edge.target,
        kind: edge.kind,
        weight: edge.weight,
      })),
      positions,
      highlight,
    };
  }, [showStage, shown, positions, highlight, local, colorScheme, dark]);

  const pick = useCallback(
    (node: GraphNode): void => {
      onSelect({
        id: node.id,
        scope: node.scope,
        workspace_id: node.workspace_id,
        title: node.title,
        revision: node.revision,
        status: 'active',
        expires_at: null,
      });
    },
    [onSelect],
  );
  // 挂载 effect 只跑一次，回调与最新数据走 ref，避免因为 props 引用变化反复重建渲染器
  const pickRef = useRef(pick);
  const shownRef = useRef(shown);
  const renderDataRef = useRef(renderData);
  useEffect(() => {
    pickRef.current = pick;
    shownRef.current = shown;
    renderDataRef.current = renderData;
  }, [pick, shown, renderData]);

  // 挂载：WebGL 前置检测 → 尺寸守卫 → 动态 import PIXI（jsdom 无 WebGL，绝不静态引入）
  // GRAPH-INIT-FAIL：① 先等容器非零尺寸（≤500ms，超时归 no-size，尺寸恢复后自动重试）
  //                   ② 失败分类（import-failed / create-failed）+ 记录真实原因
  //                   ③ 自动重试 1 次（≥300ms，先 destroy 旧 handle），仍失败落兜底并给手动重试
  useEffect(() => {
    if (!showStage) return;
    const host = stageRef.current;
    if (host === null) return;
    if (!hasWebgl(document)) {
      setRenderer('no-webgl');
      setGraphError(null);
      return;
    }
    let cancelled = false;
    let sizeWaitFrame = 0;
    let sizeWaitTimer: ReturnType<typeof setTimeout> | null = null;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;
    let observer: ResizeObserver | null = null;
    setRenderer('pending');

    const cleanupHandle = (): void => {
      handleRef.current?.destroy();
      handleRef.current = null;
      const stage = stageRef.current as (HTMLDivElement & { __kbPixiGraph?: PixiGraphHandle }) | null;
      if (stage !== null && stage !== undefined) delete stage.__kbPixiGraph;
    };

    const fail = (code: 'import-failed' | 'create-failed', error: unknown): void => {
      const info = describeError(code, error);
      setGraphError(info);
      console.error('[graph] init failed', info);
      setRenderer(code);
      // 自动重试一次：仅在还没用掉自动重试额度时
      setAttempts((used) => {
        if (used >= 1) return used;
        retryTimer = setTimeout(() => {
          if (cancelled) return;
          cleanupHandle();
          setRetryToken((token) => token + 1);
        }, 320);
        return used + 1;
      });
    };

    const start = (): void => {
      void import('./pixiGraph')
        .then((module) => {
          if (cancelled || stageRef.current === null) return;
          try {
            cleanupHandle();
            handleRef.current = module.createPixiGraph(host, {
              onSelect: (id) => {
                const node = shownRef.current?.nodes.find((item) => item.id === id);
                if (node !== undefined) pickRef.current(node);
              },
              onHover: setHovered,
              onScaleChange: setScale,
              onContextMenu: (target) => setMenu({ id: target.id, x: target.clientX, y: target.clientY }),
              // 拖拽期间持续 simulate：其它星被力牵动（GRAPH-WEIGHT-DRAG）
              onNodeDrag: (id, position, phase) => {
                const client = layoutClientRef.current;
                if (client === null) return;
                if (phase === 'start') client.dragStart(id, position);
                else if (phase === 'move') client.dragMove(id, position);
                else client.dragEnd(id);
              },
              // 上下文丢失（GPU 重置/资源上限）：销毁后重建一次
              onContextLost: () => {
                if (cancelled) return;
                console.warn('[graph] webgl context lost, rebuilding once');
                cleanupHandle();
                setRetryToken((token) => token + 1);
              },
            });
            // CDP 验收钩子（与 snapshot() 同一入口，只读）
            (host as unknown as { __kbPixiGraph?: PixiGraphHandle }).__kbPixiGraph = handleRef.current;
            const initial = renderDataRef.current;
            if (initial !== null) handleRef.current.update(initial);
            setGraphError(null);
            setRenderer('webgl');
          } catch (error) {
            fail('create-failed', error);
          }
        })
        .catch((error: unknown) => {
          if (!cancelled) fail('import-failed', error);
        });
    };

    // 尺寸守卫：宽高都 ≥1 才初始化；≤500ms 内等不到 → no-size（并监听尺寸，恢复后自动重试一次）
    const sizeOk = (): boolean => host.clientWidth >= 1 && host.clientHeight >= 1;
    if (sizeOk()) {
      start();
    } else {
      const deadline = performance.now() + 500;
      const waitSize = (): void => {
        if (cancelled) return;
        if (sizeOk()) {
          if (sizeWaitTimer !== null) clearTimeout(sizeWaitTimer);
          setGraphError(null);
          start();
          return;
        }
        if (performance.now() >= deadline) {
          setRenderer('no-size');
          setGraphError({ code: 'no-size', message: '容器宽高为 0，暂不初始化星图', stackTop: null });
          const retryWhenSized = (): void => {
            if (cancelled) return;
            if (!sizeOk()) return;
            observer?.disconnect();
            observer = null;
            window.removeEventListener('resize', retryWhenSized);
            setRenderer('pending');
            start();
          };
          if (typeof ResizeObserver === 'function') {
            observer = new ResizeObserver(retryWhenSized);
            observer.observe(host);
          }
          // 没有 RO 的环境（老浏览器/jsdom）与整窗变化也兜一手
          window.addEventListener('resize', retryWhenSized);
          return;
        }
        sizeWaitFrame = requestAnimationFrame(waitSize);
      };
      sizeWaitFrame = requestAnimationFrame(waitSize);
      sizeWaitTimer = setTimeout(() => { if (!cancelled && !sizeOk()) { /* 由 waitSize 收口 */ } }, 520);
    }

    return () => {
      cancelled = true;
      cancelAnimationFrame(sizeWaitFrame);
      if (sizeWaitTimer !== null) clearTimeout(sizeWaitTimer);
      if (retryTimer !== null) clearTimeout(retryTimer);
      observer?.disconnect();
      cleanupHandle();
    };
  }, [showStage, retryToken]);

  // 右键菜单：点空白或 Escape 关闭
  useEffect(() => {
    if (menu === null) return;
    const close = (): void => setMenu(null);
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setMenu(null);
    };
    document.addEventListener('pointerdown', close);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', close);
      document.removeEventListener('keydown', onKey);
    };
  }, [menu]);

  // 数据/布局/高亮变化 → 交给渲染层（不重建 PIXI 实例）
  useEffect(() => {
    if (renderer !== 'webgl' || renderData === null) return;
    handleRef.current?.update(renderData);
  }, [renderer, renderData]);

  // 主题切换 → 重新读 CSS 语义色（颜色只存在于 CSS，JS 不硬编码）
  useEffect(() => {
    if (renderer !== 'webgl') return;
    handleRef.current?.refreshColors();
  }, [renderer, dark]);

  useEffect(() => {
    layoutClientRef.current?.applyForces(forces);
  }, [forces]);

  useEffect(() => {
    handleRef.current?.resetView();
  }, [localMode, localJumps, focusId]);

  const zoomBy = (factor: number): void => {
    handleRef.current?.zoomBy(factor);
  };

  const fitView = (): void => {
    handleRef.current?.resetView();
  };

  const showLabels = textAlpha(scale) > 0.001;

  return (
    <div
      data-testid="knowledge-graph"
      data-scale={scale}
      data-labels-visible={showLabels ? 'true' : 'false'}
      data-hovered={hovered ?? ''}
      data-renderer={renderer}
      data-visible-nodes={shown?.nodes.length ?? 0}
      data-visible-edges={shown?.edges.length ?? 0}
      data-matches={matches.size}
      data-focus-id={focusId ?? ''}
      data-focus-hops={focusHops}
      className="flex min-h-0 flex-col rounded-2xl border border-hairline bg-surface-card"
    >
      <div className="flex flex-wrap items-center gap-3 border-b border-hairline px-3 py-2 text-xs text-ink-2">
        <label className="flex items-center gap-1">
          <input
            type="checkbox"
            data-testid="graph-edge-link"
            checked={kinds.link}
            onChange={(e) => setKinds((prev) => ({ ...prev, link: e.target.checked }))}
            className="size-3.5 accent-accent"
          />
          双链
        </label>
        <label className="flex items-center gap-1">
          <input
            type="checkbox"
            data-testid="graph-edge-source"
            checked={kinds.source}
            onChange={(e) => setKinds((prev) => ({ ...prev, source: e.target.checked }))}
            className="size-3.5 accent-accent"
          />
          来源关联
        </label>
        <label className="flex items-center gap-1">
          <input
            type="checkbox"
            data-testid="graph-edge-keyword"
            checked={kinds.keyword}
            onChange={(e) => setKinds((prev) => ({ ...prev, keyword: e.target.checked }))}
            className="size-3.5 accent-accent"
          />
          关键词关联
        </label>
        <label className="flex items-center gap-1">
          <input
            type="checkbox"
            data-testid="graph-isolated"
            checked={showIsolated}
            onChange={(e) => setShowIsolated(e.target.checked)}
            className="size-3.5 accent-accent"
          />
          显示孤立点
        </label>
        <span className="flex items-center gap-1" data-testid="graph-zoom-controls">
          <button type="button" data-testid="graph-zoom-out" aria-label="缩小星图" title="缩小（0.8 倍以下隐藏标签）" onClick={() => zoomBy(1 / 1.25)} className="rounded border border-hairline px-1.5 text-xs text-ink-2">−</button>
          <button type="button" data-testid="graph-zoom-in" aria-label="放大星图" title="放大" onClick={() => zoomBy(1.25)} className="rounded border border-hairline px-1.5 text-xs text-ink-2">+</button>
          <span data-testid="graph-scale" className="tabular-nums">{scale.toFixed(1)}×</span>
          <button type="button" data-testid="graph-fit" aria-label="适应视图" title="适应视图（全部节点回到视口内）" onClick={fitView} className="rounded border border-hairline px-1.5 text-xs text-ink-2">适应视图</button>
        </span>
        <label className="flex items-center gap-1">
          <span className="sr-only">搜索节点</span>
          <input
            type="search"
            data-testid="graph-search"
            aria-label="搜索星图节点"
            placeholder="搜索节点"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            className="w-28 rounded border border-hairline bg-surface-card px-1.5 py-0.5 text-xs sm:w-36"
          />
        </label>
        <label className="flex items-center gap-1">
          <input
            type="checkbox"
            data-testid="graph-only-matches"
            checked={onlyMatches}
            disabled={search.trim() === ''}
            title={search.trim() === '' ? '先输入搜索词' : '只显示命中节点'}
            onChange={(event) => setOnlyMatches(event.target.checked)}
            className="size-3.5 accent-accent"
          />
          只看命中
        </label>
        <button
          type="button"
          data-testid="graph-preset-unlanded-design"
          title="预设：只看未落地的设计方案（category:design + landed:proposed|partial）"
          onClick={() => {
            setSearch(PRESET_UNLANDED_DESIGN);
            setOnlyMatches(true);
          }}
          className="pointer-events-auto rounded border border-hairline px-1.5 text-[10px] text-ink-2"
        >
          只看未落地设计
        </button>
        {stats !== null && (
          <span data-testid="knowledge-graph-stats" className="ml-auto tabular-nums">
            {stats.nodeCount} 个节点 · {stats.edgeCount} 条关联（双链 {stats.linkEdges} / 来源 {stats.sourceEdges} / 关键词 {stats.keywordEdges}）
          </span>
        )}
      </div>

      {usingFallback && (
        <p data-testid="graph-fallback-notice" className="border-b border-hairline bg-surface-raised px-3 py-1.5 text-xs text-ink-2">
          服务端星图接口未就绪，已按本地规则合成（来源共现 + 关键词共现，最多 {FALLBACK_PAGE_CAP} 页）
        </p>
      )}

      {loading && <p data-testid="knowledge-graph-loading" className="px-3 py-6 text-center text-sm text-ink-3">星图加载中…</p>}

      {error !== null && !loading && (
        <p role="alert" className="px-3 py-6 text-center text-sm text-red-600 dark:text-red-400">{error.message}</p>
      )}

      <div data-testid="graph-legend" aria-label="星图图例" className="flex flex-wrap items-center gap-3 border-b border-hairline px-3 py-1 text-[11px] text-ink-3">
        <button
          type="button"
          data-testid="graph-color-scheme"
          data-scheme={colorScheme}
          aria-label="切换着色维度"
          title={colorScheme === 'category' ? '当前：按内容类型；点击切到按作用域' : '当前：按作用域；点击切到按内容类型'}
          onClick={() => setColorScheme((prev) => (prev === 'category' ? 'scope' : 'category'))}
          className="pointer-events-auto rounded border border-hairline px-1.5 text-[10px] text-ink-2"
        >
          {colorScheme === 'category' ? '内容类型' : '作用域'}
        </button>
        {colorScheme === 'category'
          ? KNOWLEDGE_CATEGORIES.map((category) => (
              <span key={category} data-testid={`graph-legend-${category}`} className="flex items-center gap-1">
                <span aria-hidden className="inline-block size-2.5 rounded-full" style={{ background: categoryColor(category, dark) }} />
                {CATEGORY_STYLES[category].label}
              </span>
            ))
          : [
              <span key="workspace" data-testid="graph-legend-scope-workspace" className="flex items-center gap-1">
                <span aria-hidden className="inline-block size-2.5 rounded-full" style={{ background: 'var(--ab-ink-2)' }} />
                项目知识
              </span>,
              <span key="common" data-testid="graph-legend-scope-common" className="flex items-center gap-1">
                <span aria-hidden className="inline-block size-2.5 rounded-full" style={{ background: 'var(--ab-ink-3)' }} />
                公共经验
              </span>,
            ]}
        <span className="flex items-center gap-1">
          <svg aria-hidden width="22" height="8"><line x1="0" y1="4" x2="22" y2="4" stroke={edgeStyle('source', dark).color} strokeWidth={edgeStyle('source', dark).width} /></svg>
          来源关联（实线）
        </span>
        <span className="flex items-center gap-1">
          <svg aria-hidden width="22" height="8"><line x1="0" y1="4" x2="22" y2="4" stroke={edgeStyle('keyword', dark).color} strokeWidth={edgeStyle('keyword', dark).width} strokeDasharray="4 3" /></svg>
          关键词关联（虚线）
        </span>
        {/* UNSLOP-5：画布真实支持的快捷键（pixiGraph keydown：方向键平移、+/- 缩放、Esc 关右键菜单）用键帽呈现 */}
        <span data-testid="graph-keyboard-hints" className="ml-auto flex items-center gap-1">
          <Kbd>方向键</Kbd>
          <span>平移</span>
          <span aria-hidden>·</span>
          <Kbd>+</Kbd>
          <span aria-hidden>/</span>
          <Kbd>−</Kbd>
          <span>缩放</span>
          <span aria-hidden>·</span>
          <Kbd>Esc</Kbd>
          <span>关菜单</span>
        </span>
      </div>

      {focusId !== null && (
        <div data-testid="graph-focus-bar" className="flex flex-wrap items-center gap-2 border-b border-hairline bg-surface-raised px-3 py-1.5 text-xs text-ink-2">
          <span>
            聚焦中：{shown?.nodes.find((node) => node.id === focusId)?.title ?? focusId} · 可见 {shown?.nodes.length ?? 0} 个节点（原 {graph?.nodes.length ?? 0}）
          </span>
          <span data-testid="graph-focus-hops" role="group" aria-label="聚焦跳数" className="flex items-center gap-1">
            {[1, 2].map((hops) => (
              <button
                key={hops}
                type="button"
                data-testid={`graph-focus-hops-${hops}`}
                aria-pressed={focusHops === hops}
                onClick={() => setFocusHops(hops as 1 | 2)}
                className={`rounded px-1.5 py-0.5 ${focusHops === hops ? 'bg-accent-soft font-medium text-ink' : 'hover:bg-surface-card'}`}
              >
                {hops} 跳
              </button>
            ))}
          </span>
          <button type="button" data-testid="graph-focus-exit" onClick={() => setFocusId(null)} className="rounded px-1.5 py-0.5 hover:bg-surface-card">
            回全图
          </button>
        </div>
      )}

      {!loading && error === null && activeOnlyMatches && matches.size === 0 && graph !== null && graph.nodes.length > 0 && (
        <p data-testid="graph-empty-filter" className="px-3 py-2 text-xs text-ink-3">
          当前筛选没有匹配节点（{search.trim()}）
        </p>
      )}

      {!loading && error === null && shown !== null && shown.nodes.length === 0 && (
        <div data-testid="graph-empty-no-pages" className="px-4 py-10 text-center">
          <p className="text-sm font-medium text-ink">暂无可视化知识</p>
          <p className="mt-1 text-xs text-ink-3">当前范围内还没有知识页，先在左侧新建知识页</p>
        </div>
      )}

      {!loading && error === null && shown !== null && shown.nodes.length > 0 && shown.edges.length === 0 && (
        <div data-testid="graph-empty-no-edges" className="px-4 py-10 text-center">
          <p className="text-sm font-medium text-ink">知识页之间还没有关联</p>
          <p className="mt-1 text-xs text-ink-3">
            共 {shown.nodes.length} 个知识页，但彼此没有共享来源，也没有达到关键词阈值的重合
          </p>
          <p className="mt-2 text-xs text-ink-3">
            建立关联：① 给两页填同一个来源文件或 URL；② 打开上方「关键词关联」（共享实体词 ≥2 或 trigram 重叠 ≥3 才成边）；③ 正文双链后续支持
          </p>
        </div>
      )}

      {showStage && shown !== null && (
        <div className="relative">
          <div
            data-testid="knowledge-graph-stage"
            ref={stageRef}
            role="img"
            tabIndex={0}
            aria-label={`知识星图：${stats?.nodeCount ?? 0} 个节点，${stats?.edgeCount ?? 0} 条关联`}
            className={`w-full max-w-full touch-none outline-none ${
              FALLBACK_RENDERERS.includes(renderer) ? 'hidden' : ''
            }`}
            // CURSOR-WHITE/CURSOR-REUSE：原生 grab 在 Windows 是合成的白手掌位图（无描边），白底看不见；
            // 复用 lib/cursor 的双色光标（白填充 + 深描边）。悬停到节点时保持 pointer 语义不变。
            // KB-GRAPH-H：绘制区高度随视口自适应（扣除顶栏/工具条/搜索行/图例等固定占用），夹在 360–900；
            // 尺寸变化由 pixiGraph 的 ResizeObserver 接住，并按 panCenteredOn 保持内容居中。
            style={{ height: STAGE_HEIGHT, cursor: hovered === null ? GRAB_CURSOR : 'pointer' }}
          />
          <GraphControls
            localMode={localMode}
            localJumps={localJumps}
            forelinks={forelinks}
            backlinks={backlinks}
            interlinks={interlinks}
            hideOrphans={hideOrphans}
            showIsolated={showIsolated}
            forces={forces}
            onLocalMode={setLocalMode}
            onLocalJumps={setLocalJumps}
            onForelinks={setForelinks}
            onBacklinks={setBacklinks}
            onInterlinks={setInterlinks}
            onHideOrphans={setHideOrphans}
            onShowIsolated={setShowIsolated}
            onForces={(patch) => setForces((prev) => ({ ...prev, ...patch }))}
            onReset={() => {
              setForces(FORCE_SLIDER_DEFAULTS);
              setLocalJumps(1);
              setForelinks(true);
              setBacklinks(true);
              setInterlinks(true);
              setHideOrphans(false);
            }}
          />

          {menu !== null && (
            <div
              data-testid="graph-context-menu"
              role="menu"
              aria-label="节点操作"
              style={{ position: 'fixed', left: menu.x, top: menu.y }}
              className="z-50 min-w-40 rounded-lg border border-hairline bg-surface-card py-1 text-xs"
            >
              <button
                type="button"
                role="menuitem"
                data-testid="graph-menu-open"
                className="block w-full px-3 py-1.5 text-left text-ink-2 hover:bg-surface-raised"
                onClick={() => {
                  const node = shown.nodes.find((item) => item.id === menu.id);
                  if (node !== undefined) pick(node);
                  setMenu(null);
                }}
              >
                打开详情
              </button>
              <button
                type="button"
                role="menuitem"
                data-testid="graph-menu-copy"
                className="block w-full px-3 py-1.5 text-left text-ink-2 hover:bg-surface-raised"
                onClick={() => {
                  // 应用无 URL 路由：复制知识页引用（kb/MCP 用得到的 id 形式）
                  void navigator.clipboard?.writeText(`knowledge://${menu.id}`);
                  setMenu(null);
                }}
              >
                复制页链接
              </button>
              <button
                type="button"
                role="menuitem"
                data-testid="graph-menu-focus"
                className="block w-full px-3 py-1.5 text-left text-ink-2 hover:bg-surface-raised"
                onClick={() => {
                  setFocusId(menu.id);
                  setFocusHops(1);
                  setMenu(null);
                }}
              >
                聚焦该节点的邻居
              </button>
            </div>
          )}

          {FALLBACK_RENDERERS.includes(renderer) && (
            <div
              data-graph-fallback={renderer}
              data-graph-error={graphError === null ? '' : `${graphError.code}: ${graphError.message}`}
              className="overflow-auto px-3 py-3"
              style={{ maxHeight: STAGE_HEIGHT }}
            >
              <p className="text-sm font-medium text-ink">
                {FALLBACK_TITLE[renderer as FallbackRenderer]}
              </p>
              {graphError !== null && (
                <p data-testid="graph-error-detail" className="mt-1 text-xs text-ink-3">
                  原因（{graphError.code}）：{graphError.message}
                </p>
              )}
              {/* CHUNK-RECOVER-W：import-failed 多为「旧页面引用已不存在的 chunk」，重试无意义，给刷新入口 */}
              {renderer === 'import-failed' && (
                <button
                  type="button"
                  data-testid="graph-reload"
                  onClick={() => window.location.reload()}
                  className="mt-2 mr-2 rounded-lg border border-hairline bg-surface-card px-2.5 py-1 text-xs text-ink transition-colors duration-150 hover:bg-surface-raised motion-reduce:transition-none"
                >
                  刷新页面
                </button>
              )}
              {(renderer === 'import-failed' || renderer === 'create-failed') && (
                <button
                  type="button"
                  data-testid="graph-retry"
                  disabled={attempts >= 2}
                  title={attempts >= 2 ? '重试次数已达上限（3 次）' : '重新初始化星图渲染器'}
                  onClick={() => {
                    if (attempts >= 2) return;
                    setAttempts((used) => used + 1);
                    setRenderer('pending');
                    setRetryToken((token) => token + 1);
                  }}
                  className="mt-2 rounded-lg border border-hairline bg-surface-card px-2.5 py-1 text-xs text-ink hover:bg-surface-raised disabled:opacity-40"
                >
                  重试（{attempts}/2）
                </button>
              )}
              <ul data-testid="graph-fallback-list" className="mt-2 space-y-1 text-sm">
                {shown.nodes.map((node) => (
                  <li key={node.id}>
                    <button
                      type="button"
                      data-testid={`graph-fallback-${node.id}`}
                      onClick={() => pick(node)}
                      className="text-left text-accent hover:underline"
                    >
                      {node.title}（度 {node.degree}）
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}

      {!loading && error === null && shown !== null && shown.truncated_reason !== null && (
        <p data-testid="graph-truncated" className="border-t border-hairline px-3 py-1.5 text-xs text-ink-3">
          {shown.truncated_reason === 'pages'
            ? `共 ${shown.page_total ?? shown.node_total} 页，已加载 ${shown.pages_loaded ?? shown.node_total} 页，图仅覆盖已加载部分；缩小范围可获得完整关系`
            : shown.truncated_reason === 'nodes'
              ? `已按关联度显示前 ${shown.nodes.length} 个节点，共 ${shown.node_total} 个`
              : `已显示前 ${shown.edges.length} 条关联，共 ${shown.edge_total} 条`}
        </p>
      )}

      {!loading && error === null && shown !== null && shown.nodes.length > 0 && (
        <ul data-testid="knowledge-graph-nodes" className="sr-only">
          {shown.nodes.map((node) => (
            <li key={node.id}>
              <button type="button" data-testid={`graph-node-${node.id}`} data-degree={node.degree} data-radius={nodeRadius(node.degree)} onClick={() => pick(node)}>
                {node.title}（度 {node.degree}）
              </button>
              <button type="button" data-testid={`graph-focus-${node.id}`} onClick={() => setFocusId(node.id)}>
                聚焦 {node.title}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}






