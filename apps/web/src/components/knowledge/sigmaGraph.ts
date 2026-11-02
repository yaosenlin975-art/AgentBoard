/**
 * sigma 4 渲染层（KB-GRAPH-V2-1）。
 *
 * sigma 4 与 v3 的 API 差异（实测，写在这里避免后人重踩）：
 * - 构造参数是 `{ settings, nodeReducer, edgeReducer, styles, primitives }`；
 *   `renderLabels`/`labelDensity`/`labelRenderedSizeThreshold`/`enableNodeDrag` 属于 `settings`，
 *   **不是**顶层选项 —— 放顶层直接 TS 报错。
 * - `nodeReducer`/`edgeReducer` 只能走构造参数，**没有** `setSetting('nodeReducer', …)`。
 * - reducer 签名是 `(key, data, attrs, state, graphState, graph) => Partial<DisplayData>`，
 *   `data` 含坐标与显示字段，返回的是要覆盖的显示字段子集。
 * - 节点视觉绑定（`x/y/size/color/label`）由内建 styles 声明式读取节点属性，属性名与本文件一致。
 *
 * 本卡不包含 node-border 光晕（需要 `sigma/rendering` 的 `createNodeProgram` 自组图层栈，见 V2-1b）。
 */
import Graph from 'graphology';
import Sigma from 'sigma';
import { edgeStyle, nodeColor, nodeRadius } from '../../lib/knowledgeGraph';
import type { GraphPayload } from '../../lib/knowledgeGraph';

export interface SigmaVisualOptions {
  dark: boolean;
  positions: ReadonlyMap<string, { x: number; y: number }>;
  pinned: ReadonlyMap<string, { x: number; y: number }>;
  highlightedNodes: ReadonlySet<string>;
  highlightedEdges: ReadonlySet<string>;
  hasHighlight: boolean;
}

const DIM_NODE = 'rgba(148,163,184,0.2)';
const DIM_EDGE = 'rgba(148,163,184,0.12)';

/** 自研坐标 → graphology 多重有向图（同一对节点可能同时有 source/keyword 两种边） */
export function buildSigmaGraph(graph: GraphPayload, options: SigmaVisualOptions): Graph {
  const out = new Graph({ multi: true, type: 'directed' });
  for (const node of graph.nodes) {
    const point = options.pinned.get(node.id) ?? options.positions.get(node.id);
    if (point === undefined) continue;
    out.addNode(node.id, {
      x: point.x,
      y: point.y,
      size: nodeRadius(node.degree),
      label: node.title,
      color: nodeColor(node.scope, options.dark),
      scope: node.scope,
      degree: node.degree,
    });
  }
  for (const edge of graph.edges) {
    if (!out.hasNode(edge.source) || !out.hasNode(edge.target)) continue;
    const style = edgeStyle(edge.kind, options.dark);
    out.addEdgeWithKey(edge.key, edge.source, edge.target, {
      size: style.width,
      color: style.color,
      kind: edge.kind,
      weight: edge.weight,
    });
  }
  return out;
}

export interface SigmaHandle {
  renderer: Sigma;
  /** 中心缩放（factor > 1 放大） */
  zoom: (factor: number) => void;
  /** 适应视图 */
  fit: () => void;
  destroy: () => void;
}

export interface MountSigmaOptions {
  container: HTMLElement;
  graph: Graph;
  visual: SigmaVisualOptions;
  onScaleChange: (scale: number) => void;
  onSelectNode: (id: string) => void;
  onReleasePin: (id: string) => void;
}

export function mountSigma({ container, graph, visual, onScaleChange, onSelectNode, onReleasePin }: MountSigmaOptions): SigmaHandle {
  const { highlightedNodes, highlightedEdges, hasHighlight, pinned } = visual;
  const renderer = new Sigma(graph, container, {
    settings: {
      renderLabels: true,
      labelDensity: 1.1,
      labelGridCellSize: 84,
      // 节点在屏幕上的直径低于该值时不画标签（等价于「缩放到阈值以下隐藏标签」）
      labelRenderedSizeThreshold: 7,
      enableNodeDrag: false,
      minCameraRatio: 0.3,
      maxCameraRatio: 3,
    },
    nodeReducer: (node, data) => {
      const lit = !hasHighlight || highlightedNodes.has(node);
      const isPinned = pinned.has(node);
      return {
        color: lit ? data.color : DIM_NODE,
        // 固定态：略放大（描边光晕需要自组 node program，见 V2-1b）
        size: isPinned ? data.size * 1.2 : data.size,
        label: isPinned || (hasHighlight && highlightedNodes.has(node)) ? data.label : undefined,
      };
    },
    edgeReducer: (edge, data) => {
      const lit = !hasHighlight || highlightedEdges.has(edge);
      return { color: lit ? data.color : DIM_EDGE };
    },
  });

  // 调试/测试钩子：容器上留一个只读句柄，便于 CDP 读相机状态（不参与业务逻辑）
  (container as unknown as { __sigma?: Sigma }).__sigma = renderer;

  // sigma 的 ratio 越小越放大；对外沿用「1 = 适配」的 scale 语义
  const syncScale = (): void => onScaleChange(Number((1 / renderer.getCamera().ratio).toFixed(2)));
  const camera = renderer.getCamera();
  camera.on('updated', syncScale);
  renderer.on('afterRender', syncScale);
  syncScale();

  renderer.on('clickNode', ({ node }) => onSelectNode(node));
  renderer.on('doubleClickNode', ({ node }) => onReleasePin(node));

  return {
    renderer,
    zoom: (factor: number) => zoomSigma(renderer, factor),
    fit: () => fitSigma(renderer),
    destroy: () => {
      renderer.getCamera().removeListener('updated', syncScale);
      renderer.removeListener('afterRender', syncScale);
      renderer.kill();
    },
  };
}

/** 适应视图：ratio=1 时 sigma 把整图装进视口 */
export function fitSigma(renderer: Sigma): void {
  renderer.getCamera().setState({ x: 0.5, y: 0.5, ratio: 1, angle: 0 });
}

/** 中心缩放（按钮用）：factor > 1 放大 */
export function zoomSigma(renderer: Sigma, factor: number): void {
  const camera = renderer.getCamera();
  const ratio = Math.min(3, Math.max(0.3, camera.ratio / factor));
  camera.setState({ ...camera.getState(), ratio });
}



