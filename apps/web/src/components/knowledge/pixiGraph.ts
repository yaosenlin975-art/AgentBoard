/**
 * PIXI 星图渲染骨架（KB-GRAPH-P1）——照 `Docs/Obsidian-星图渲染逆向.md` A1–A6 逐条实现。
 *
 * 这个文件必须**动态 import**：jsdom 没有 WebGL，静态引入会让整个测试套件报
 * `WebGL2RenderingContext is not defined`。入口是 `createPixiGraph()`，调用方负责 WebGL 前置检测。
 *
 * 与 Obsidian 的差异（都是有意的）：
 * - 布局不在渲染层：节点坐标由 `lib/knowledgeGraph.layoutGraph` 在 React 侧算好后传入（A5 ① 的 worker 结果）；
 * - 事件不走 PIXI 的 event system，而是 DOM 监听 + 距离命中（与 A5 ⑧ 的 hover 距离校验同一套数学校验）；
 * - 相机参数（scale/targetScale/pan）由本模块自持并回调 `onScaleChange`，React 只做展示。
 */
import { Texture } from '@pixi/core';
import { Application } from '@pixi/app';
import { Container } from '@pixi/display';
import { Graphics } from '@pixi/graphics';
import { Sprite } from '@pixi/sprite';
import { Text, TextStyle } from '@pixi/text';
import '@pixi/events';
import {
  GRAPH_VISUAL_DEFAULTS,
  clampZoom,
  dampen,
  duplicateEdgeKeys,
  fontSize,
  getSize,
  CLICK_DISTANCE_SQ,
  isClickGesture,
  labelOffsetY,
  lineWidth,
  nodeScale,
  readSemanticColors,
  shouldKeepPanInertia,
  textAlpha,
  tintFromCssColor,
  wheelDeltaPixels,
  zoomAnchor,
  zoomFactorFromWheel,
  type SemanticColorKey,
} from '../../lib/graphVisualFormulas';
import { buildAdjacency, panCenteredOn, positionsCenter, type GraphEdgeKind } from '../../lib/knowledgeGraph';

/** 文档 app.js#SQ：圆固定画在 (100,100) 半径 100，靠 scale 缩放（不重建 geometry） */
const SQ = 100;
/** 背景靶尺寸（文档：drawRect(0, 0, 1e4, 1e4)） */
const BG_SIZE = 10000;
/** 文档 app.js#fQ：唯一的去强调系数（无关节点/连线 0.2） */
const FQ = 0.2;
/** 文档 A5：idleFrames > 60 停帧 */
const IDLE_FRAME_LIMIT = 60;
/** 文档 A5 ⑤：每帧按「离屏幕中心最近」补建最多 50 个节点 */
const MAX_CREATE_PER_FRAME = 50;
/** 文档 app.js#fQ 的每帧收敛比例：mQ(cur,target,.9) = 每帧 10% */
const FADE_RATIO = 0.9;
/** 文档 A6 文字高亮下移量 */
const HIGHLIGHT_TEXT_OFFSET = 15;
/** 文档 C1：mQ(scale, target, .85) = 每帧收敛 15% */
const ZOOM_LERP = 0.85;
/** 文档：平移动量与透明度都是每帧 10% 收敛 */
const FONT_FAMILY =
  'ui-sans-serif, -apple-system, BlinkMacSystemFont, system-ui, "Segoe UI", Roboto, "Inter", sans-serif';

export interface PixiGraphNode {
  id: string;
  title: string;
  /** KB-MODEL：按 category 算好的 tint（0xRRGGBB）；缺省时用语义色 color-fill */
  tint?: number;
  /** 文档 getSize 的 weight = 正向 ∪ 反向邻居数（由调用方用邻接表算好） */
  weight: number;
}

export interface PixiGraphEdge {
  key: string;
  source: string;
  target: string;
  kind: GraphEdgeKind;
  weight: number;
}

export interface PixiGraphData {
  nodes: ReadonlyArray<PixiGraphNode>;
  edges: ReadonlyArray<PixiGraphEdge>;
  /** 布局坐标（图坐标，非屏幕坐标） */
  positions: ReadonlyMap<string, { x: number; y: number }>;
  /** 聚焦高亮集合（KB-GRAPH-3 的 focus/matches）；null 表示不高亮 */
  highlight?: { nodes: ReadonlySet<string>; edges: ReadonlySet<string> } | null;
}

export interface PixiGraphCallbacks {
  onSelect?: (id: string) => void;
  onHover?: (id: string | null) => void;
  onScaleChange?: (scale: number) => void;
  /** C4 右键菜单：节点上右键 → 交给 React 弹菜单 */
  onContextMenu?: (target: { id: string; clientX: number; clientY: number }) => void;
  /**
   * C6 拖拽节点（GRAPH-WEIGHT-DRAG）：start/move/end 交给布局层，
   * 由布局层写 fx/fy 并**持续 simulate**，其它节点才会被力牵动（与 Obsidian 行为对齐）。
   */
  onNodeDrag?: (id: string, position: { x: number; y: number }, phase: 'start' | 'move' | 'end') => void;
  /** GRAPH-INIT-FAIL：WebGL 上下文丢失（驱动/资源上限/GPU 重置）时通知调用方重建一次 */
  onContextLost?: () => void;
}

export type PixiGraphOptions = PixiGraphCallbacks;

interface SemanticColor {
  tint: number;
  alpha: number;
}

type ColorMap = Record<SemanticColorKey, SemanticColor>;

interface NodeView {
  id: string;
  /** PIXI 对象身份序号：增量更新应复用同一个序号 */
  objId: number;
  title: string;
  /** 按 category 的固定色（undefined → 语义色） */
  tint?: number;
  weight: number;
  size: number;
  x: number;
  y: number;
  circle: Graphics;
  label: Text;
  alpha: number;
  textMove: number;
}

interface EdgeView {
  key: string;
  source: string;
  target: string;
  line: Sprite;
  arrow: Graphics;
  alpha: number;
  arrowAlpha: number;
}

export interface PixiNodeSnapshot {
  id: string;
  /** PIXI 对象身份序号：同一 id 在增量更新前后必须相同 */
  objId: number;
  weight: number;
  size: number;
  /** 节点当前图坐标（拖拽后即 pinned 坐标，CDP 换算屏幕点要用它） */
  x: number;
  y: number;
  /** circle.scale.x = size/100 * nodeScale */
  circleScale: number;
  fontSize: number;
  /** label.style.fontSize */
  labelFontSize: number;
  labelAlpha: number;
  labelY: number;
  circleAlpha: number;
  fadeAlpha: number;
  circleVisible: boolean;
  labelVisible: boolean;
  tint: number;
}

export interface PixiEdgeSnapshot {
  key: string;
  visible: boolean;
  width: number;
  height: number;
  rotation: number;
  alpha: number;
  arrowVisible: boolean;
  arrowScale: number;
  alphaNow: number;
  arrowAlphaNow: number;
  tint: number;
}

/** CDP 校验用快照：直接读 PIXI 对象当前值，不从公式反推 */
export interface PixiGraphSnapshot {
  rendererType: number;
  resolution: number;
  dpr: number;
  cssWidth: number;
  cssHeight: number;
  backingWidth: number;
  backingHeight: number;
  scale: number;
  targetScale: number;
  nodeScale: number;
  textAlpha: number;
  lineWidth: number;
  pan: { x: number; y: number };
  idleFrames: number;
  /** 累计 renderCallback 执行次数（用来核对一次 changed() 约 62 帧） */
  frames: number;
  hangerChildren: number;
  nodeCount: number;
  edgeCount: number;
  hiddenDuplicateEdges: number;
  createdNodes: number;
  createdEdges: number;
  hoverId: string | null;
  dragId: string | null;
  pinnedCount: number;
  /** 增量更新证据：PIXI 对象创建/复用/回收计数与序号上界 */
  objects: { created: number; reused: number; destroyed: number; seq: number };
  panVelocity: { x: number; y: number };
  zoomCenter: { x: number; y: number };
  clickDistanceSq: number;
  colors: Record<string, SemanticColor>;
  nodes: PixiNodeSnapshot[];
  edges: PixiEdgeSnapshot[];
}

export interface PixiGraphHandle {
  host: HTMLElement;
  /** 换数据/换布局：重建节点与连线（颜色缓存保留） */
  update(data: PixiGraphData): void;
  /** 键盘/按钮缩放：乘一个倍率（走 1.5^(-Δ/120) 同一套 clamp） */
  zoomBy(factor: number): void;
  /** 适应视图：scale 回 1、pan 居中 */
  resetView(): void;
  /** 主题/参数变化后重读 CSS 语义色 */
  refreshColors(): void;
  /** 主动触发一轮重绘（≈62 帧后自动停） */
  changed(): void;
  snapshot(): PixiGraphSnapshot;
  destroy(): void;
}



function cssColorToTint(color: { color: string; opacity: number } | undefined, fallback: number, fallbackAlpha: number): SemanticColor {
  if (color === undefined) return { tint: fallback, alpha: fallbackAlpha };
  return {
    tint: tintFromCssColor(color.color),
    alpha: Number.isFinite(color.opacity) ? color.opacity : fallbackAlpha,
  };
}

/** 读 11 个语义色（CSS 变量 → tint/alpha），不带 DOM 时给文档兜底色 */
function readColorMap(): ColorMap {
  const raw = readSemanticColors();
  return {
    fill: cssColorToTint(raw.fill, 0x5c5c5c, 1),
    fillFocused: cssColorToTint(raw.fillFocused, 0x8a5cf5, 1),
    fillTag: cssColorToTint(raw.fillTag, 0x08b94e, 1),
    fillUnresolved: cssColorToTint(raw.fillUnresolved, 0xababab, 0.5),
    fillAttachment: cssColorToTint(raw.fillAttachment, 0xe0ac00, 1),
    arrow: cssColorToTint(raw.arrow, 0x222222, 0.5),
    circle: cssColorToTint(raw.circle, 0x8a5cf5, 1),
    line: cssColorToTint(raw.line, 0xd4d4d4, 1),
    text: cssColorToTint(raw.text, 0x222222, 1),
    fillHighlight: cssColorToTint(raw.fillHighlight, 0x9873f7, 1),
    lineHighlight: cssColorToTint(raw.lineHighlight, 0x9873f7, 1),
  };
}

/**
 * 创建 PIXI 星图并挂到 host。host 必须有非零尺寸（调用方保证已布局）。
 * 创建失败（拿不到 WebGL context 等）会抛错，由调用方降级。
 */
export function createPixiGraph(host: HTMLElement, options: PixiGraphOptions = {}): PixiGraphHandle {
  const doc = host.ownerDocument;
  const view = doc.defaultView;
  const raf = (callback: FrameRequestCallback): number =>
    view?.requestAnimationFrame(callback) ?? 0;
  const cancelRaf = (handle: number): void => view?.cancelAnimationFrame(handle);

  const colors = readColorMap();
  const nodeSizeMultiplier = GRAPH_VISUAL_DEFAULTS.nodeSizeMultiplier;
  const lineSizeMult = GRAPH_VISUAL_DEFAULTS.lineSizeMult;
  const textShowMult = GRAPH_VISUAL_DEFAULTS.textShowMult;

  const app = new Application<HTMLCanvasElement>({
    backgroundAlpha: 0,
    antialias: true,
    autoStart: false,
    resolution: 1,
    width: Math.max(1, Math.round(host.clientWidth || 1)),
    height: Math.max(1, Math.round(host.clientHeight || 1)),
  });
  const canvas = app.view;
  canvas.style.display = 'block';
  canvas.style.width = '100%';
  canvas.style.height = '100%';
  host.appendChild(canvas);

  // GRAPH-INIT-FAIL：上下文丢失（GPU 重置/驱动/资源上限）→ 交回调用方重建一次。
  // 只通知、不在这里自我重建，避免与 React 侧的挂载/卸载竞态。
  const onContextLost = (event: Event): void => {
    event.preventDefault();
    options.onContextLost?.();
  };
  canvas.addEventListener('webglcontextlost', onContextLost, false);

  // 三层容器（文档 A2）
  const background = new Graphics();
  background.beginFill(0x000000, 0);
  background.drawRect(0, 0, BG_SIZE, BG_SIZE);
  background.endFill();
  background.alpha = 0;
  background.eventMode = 'static';
  app.stage.addChild(background);

  const hanger = new Container();
  hanger.eventMode = 'static';
  app.stage.addChild(hanger);

  const watermarkStyle = new TextStyle({ fontSize: 12, fill: colors.text.tint, fontFamily: FONT_FAMILY });
  const watermark = new Text('Powered by AgentBoard', watermarkStyle);
  watermark.anchor.set(1, 1);
  watermark.alpha = 0.5;
  watermark.zIndex = 3;
  watermark.resolution = 2;
  app.stage.addChild(watermark);

  let data: PixiGraphData = { nodes: [], edges: [], positions: new Map(), highlight: null };
  let adjacency = new Map<string, Set<string>>();
  let hiddenEdges = new Set<string>();
  const nodeViews = new Map<string, NodeView>();
  const edgeViews = new Map<string, EdgeView>();
  const destroyedRef = { value: false };

  // 相机：pan 单位是设备像素（文档 A3）
  let scale = 1;
  let targetScale = 1;
  let panX = 0;
  let panY = 0;
  let panvX = 0;
  let panvY = 0;
  let zoomCenterX = 0;
  let zoomCenterY = 0;
  let idleFrames = 0;
  let frames = 0;
  let timer: number | null = null;
  let hoverId: string | null = null;
  let cssWidth = Math.max(1, Math.round(host.clientWidth || 1));
  let cssHeight = Math.max(1, Math.round(host.clientHeight || 1));
  const keys = { zoomIn: false, zoomOut: false, up: false, down: false, left: false, right: false, fast: false };
  const pointer = {
    x: null as number | null,
    y: null as number | null,
    down: false,
    dragging: false,
    clickCancelled: false,
    startX: 0,
    startY: 0,
    panStartX: 0,
    panStartY: 0,
    downAtMs: 0,
    lastMoveMs: 0,
    velocityX: 0,
    velocityY: 0,
    nodeId: null as string | null,
  };
  /** C6 拖拽后的固定坐标（图坐标）：本实现无 sim，等价为「停在松手处、不回弹」 */
  const pinned = new Map<string, { x: number; y: number }>();
  /** 当前正在拖的节点（文档 getHighlightNode = dragNode || highlightNode） */
  let dragId: string | null = null;
  /** 增量更新证据：PIXI 对象身份与复用/回收计数（CDP 与单测都读它） */
  let objectSeq = 0;
  const objectStats = { created: 0, reused: 0, destroyed: 0 };
  let viewport = { left: -Infinity, right: Infinity, top: -Infinity, bottom: Infinity };
  /** KB-PANEL-POLISH：用户还没手动平移/缩放时，坐标更新一律跟随内容居中（力导向 tick 会挪质心） */
  let userAdjusted = false;
  const markUserAdjusted = (): void => {
    userAdjusted = true;
  };

  const dpr = (): number => view?.devicePixelRatio ?? 1;

  function resize(): void {
    const width = host.clientWidth;
    const height = host.clientHeight;
    if (width <= 0 || height <= 0) return;
    // KB-PANEL-POLISH：尺寸变化时保持「视口中心的图坐标点」不动（首帧/居中后都不跳）
    const before = dpr();
    const centerWorld = {
      x: ((cssWidth / 2) * before - panX) / scale,
      y: ((cssHeight / 2) * before - panY) / scale,
    };
    cssWidth = width;
    cssHeight = height;
    // A3：backing store = CSS × DPR，PIXI resolution 保持 1
    app.renderer.resize(Math.round(width * dpr()), Math.round(height * dpr()));
    canvas.style.width = `${width}px`;
    canvas.style.height = `${height}px`;
    const after = panCenteredOn(centerWorld, cssWidth * dpr(), cssHeight * dpr(), scale);
    panX = after.x;
    panY = after.y;
    applyScale();
    layoutWatermark();
  }

  /** 把内容包围盒中心放到视口中心（不改缩放）；无坐标时不动 */
  function centerOnContent(): void {
    const center = positionsCenter(data.positions);
    if (center === null) return;
    const next = panCenteredOn(center, cssWidth * dpr(), cssHeight * dpr(), scale);
    panX = next.x;
    panY = next.y;
    panvX = 0;
    panvY = 0;
    applyScale();
    changed();
  }

  function layoutWatermark(): void {
    watermark.position.set(cssWidth * dpr() - 8, cssHeight * dpr() - 6);
  }

  function changed(): void {
    idleFrames = 0;
    queueRender();
  }

  function queueRender(): void {
    if (destroyedRef.value) return;
    if (timer === null) timer = raf(renderCallback);
  }

  function applyScale(): void {
    hanger.scale.set(scale);
    hanger.position.set(panX, panY);
  }

  /** ④ 缩放插值（文档 C1 updateZoom）：target 夹 [1/128,8]，每帧走 15%，相对差 <1% 停；锚点 world 坐标保持屏幕位置不动 */
  function updateZoom(): void {
    targetScale = clampZoom(targetScale);
    const ratio = scale > targetScale ? scale / targetScale : targetScale / scale;
    // 相对差 >=1% 才继续插值（文档 C1）；差值收敛后直接落到 target，但仍然按锚点重算 pan
    const nextScale = ratio - 1 >= 0.01 ? dampen(scale, targetScale, ZOOM_LERP) : targetScale;
    if (nextScale !== scale) {
      // zoomCenter 为 (0,0) 时用画布中心（文档 C1：缩小时锚点归零 → 以画布中心为锚点）
      const centerX = zoomCenterX === 0 && zoomCenterY === 0 ? (cssWidth / 2) * dpr() : zoomCenterX;
      const centerY = zoomCenterX === 0 && zoomCenterY === 0 ? (cssHeight / 2) * dpr() : zoomCenterY;
      const anchorWorldX = (centerX - panX) / scale;
      const anchorWorldY = (centerY - panY) / scale;
      scale = nextScale;
      panX = centerX - anchorWorldX * scale;
      panY = centerY - anchorWorldY * scale;
      applyScale();
      options.onScaleChange?.(scale);
    }
    const widthPx = cssWidth * dpr();
    const heightPx = cssHeight * dpr();
    viewport = {
      left: -panX / scale,
      right: (-panX + widthPx) / scale,
      top: -panY / scale,
      bottom: (-panY + heightPx) / scale,
    };
  }

  /** 文档 getHighlightNode：拖拽中的节点优先于 hover 节点 */
  function highlightId(): string | null {
    return dragId ?? hoverId;
  }

  /** 文档 A6 屏幕空间剔除：圆用节点包围盒、文字用 600x200 矩形 */
  function intersectsViewport(left: number, right: number, top: number, bottom: number): boolean {
    return !(right < viewport.left || left > viewport.right || bottom < viewport.top || top > viewport.bottom);
  }

  function highlightActive(): boolean {
    if (highlightId() !== null) return true;
    return (data.highlight?.nodes.size ?? 0) > 0;
  }

  function isNodeLit(id: string): boolean {
    const focus = highlightId();
    if (focus !== null) return id === focus || adjacency.get(focus)?.has(id) === true;
    const highlight = data.highlight;
    if (highlight === undefined || highlight === null || highlight.nodes.size === 0) return true;
    return highlight.nodes.has(id);
  }

  function isEdgeLit(edge: EdgeView): boolean {
    const focus = highlightId();
    if (focus !== null) return edge.source === focus || edge.target === focus;
    const highlight = data.highlight;
    if (highlight === undefined || highlight === null || highlight.nodes.size === 0) return true;
    return highlight.edges.has(edge.key);
  }

  /** ⑤ 补建节点：按离视口中心最近的顺序，每帧最多 50 个 */
  function createPendingNodes(): void {
    const pending = data.nodes.filter((node) => !nodeViews.has(node.id) && data.positions.has(node.id));
    if (pending.length === 0) return;
    const centerX = (viewport.left + viewport.right) / 2;
    const centerY = (viewport.top + viewport.bottom) / 2;
    const ranked = pending
      .map((node) => {
        const point = pinned.get(node.id) ?? (data.positions.get(node.id) as { x: number; y: number });
        const dx = point.x - centerX;
        const dy = point.y - centerY;
        return { node, point, dist: dx * dx + dy * dy };
      })
      .sort((a, b) => a.dist - b.dist)
      .slice(0, MAX_CREATE_PER_FRAME);
    for (const { node, point } of ranked) createNode(node, point);
  }

  function createNode(node: PixiGraphNode, point: { x: number; y: number }): void {
    const size = getSize(node.weight, nodeSizeMultiplier);
    // 文档 A6：固定 drawCircle(100,100,100) + pivot(100,100)，用 scale 缩放
    const circle = new Graphics();
    circle.beginFill(0xffffff);
    circle.drawCircle(SQ, SQ, SQ);
    circle.endFill();
    circle.pivot.set(SQ, SQ);
    circle.zIndex = 1;
    circle.eventMode = 'static';
    circle.cursor = 'pointer';
    circle.tint = node.tint ?? colors.fill.tint;
    circle.alpha = colors.fill.alpha;
    hanger.addChild(circle);

    const style = new TextStyle({
      fontSize: fontSize(size),
      fill: colors.text.tint,
      fontFamily: FONT_FAMILY,
      wordWrap: true,
      wordWrapWidth: 300,
      align: 'center',
    });
    const label = new Text(node.title, style);
    label.eventMode = 'none';
    label.resolution = 2;
    label.anchor.set(0.5, 0);
    label.zIndex = 2;
    hanger.addChild(label);

    objectSeq += 1;
    objectStats.created += 1;
    nodeViews.set(node.id, {
      id: node.id,
      objId: objectSeq,
      title: node.title,
      tint: node.tint,
      weight: node.weight,
      size,
      x: point.x,
      y: point.y,
      circle,
      label,
      alpha: colors.fill.alpha,
      textMove: 0,
    });
  }

  /** ⑥ 补建连线：两端都已建好才建（双向边先去重） */
  function createPendingEdges(): void {
    for (const edge of data.edges) {
      if (hiddenEdges.has(edge.key) || edgeViews.has(edge.key)) continue;
      const from = nodeViews.get(edge.source);
      const to = nodeViews.get(edge.target);
      if (from === undefined || to === undefined) continue;
      const line = new Sprite(Texture.WHITE);
      line.eventMode = 'none';
      line.alpha = FQ * colors.line.alpha;
      line.tint = colors.line.tint;
      hanger.addChild(line);

      const arrow = new Graphics();
      arrow.eventMode = 'none';
      arrow.alpha = FQ * colors.arrow.alpha;
      arrow.tint = colors.arrow.tint;
      arrow.beginFill(0xffffff);
      arrow.moveTo(0, 0);
      arrow.lineTo(-4, -2);
      arrow.lineTo(-3, 0);
      arrow.lineTo(-4, 2);
      arrow.lineTo(0, 0);
      arrow.endFill();
      arrow.zIndex = 1;
      hanger.addChild(arrow);

      objectStats.created += 2;
      edgeViews.set(edge.key, {
        key: edge.key,
        source: edge.source,
        target: edge.target,
        line,
        arrow,
        alpha: FQ * colors.line.alpha,
        arrowAlpha: FQ * colors.arrow.alpha,
      });
    }
  }

  /** ⑦ 逐节点 render（含视口剔除） */
  function renderNodes(): void {
    const ns = nodeScale(scale);
    const active = highlightActive();
    for (const node of nodeViews.values()) {
      const lit = !active || isNodeLit(node.id);
      const fadeTarget = lit ? 1 : FQ;
      node.alpha = dampen(node.alpha, fadeTarget, FADE_RATIO);
      node.textMove = dampen(node.textMove, lit && active ? HIGHLIGHT_TEXT_OFFSET : 0, FADE_RATIO);
      const radius = node.size * ns;
      node.circle.visible = intersectsViewport(node.x - radius, node.x + radius, node.y - radius, node.y + radius);
      node.circle.position.set(node.x, node.y);
      // 文档 A6：scale = getSize()/100 * nodeScale
      node.circle.scale.set((node.size / 100) * ns);
      node.circle.alpha = node.alpha * colors.fill.alpha;
      node.circle.tint = lit && active ? colors.fillHighlight.tint : node.tint ?? colors.fill.tint;

      let alpha = textAlpha(scale, textShowMult) * node.alpha;
      if (lit && active) alpha = 1;
      alpha *= colors.text.alpha;
      const labelY = node.y + labelOffsetY(node.size, scale, node.textMove);
      node.label.position.set(node.x, labelY);
      const labelScale = lit && active && scale < 1 ? 1 / scale : ns;
      node.label.scale.set(labelScale);
      node.label.alpha = alpha;
      node.label.visible = alpha > 0.001 && intersectsViewport(node.x - 300, node.x + 300, labelY, labelY + 200);
      node.label.tint = colors.text.tint;
    }
  }

  /** ⑦ 逐连线 render（文档 A6 连线段逐行搬） */
  function renderEdges(): void {
    const active = highlightActive();
    const thickness = lineWidth(scale, lineSizeMult);
    const ns = nodeScale(scale);
    for (const edge of edgeViews.values()) {
      const from = nodeViews.get(edge.source);
      const to = nodeViews.get(edge.target);
      if (from === undefined || to === undefined) continue;
      const lit = !active || isEdgeLit(edge);
      const targetAlpha = (lit ? 1 : FQ) * colors.line.alpha;
      const targetArrow = (lit ? 1 : FQ) * Math.max(0, Math.min(1, 2 * (scale - 0.3))) * colors.arrow.alpha;
      edge.alpha = dampen(edge.alpha, targetAlpha, FADE_RATIO);
      edge.arrowAlpha = dampen(edge.arrowAlpha, targetArrow, FADE_RATIO);

      const dx = to.x - from.x;
      const dy = to.y - from.y;
      const distance = Math.sqrt(dx * dx + dy * dy);
      const rFrom = from.size * ns;
      const rTo = to.size * ns;
      const boundsLeft = Math.min(from.x, to.x);
      const boundsRight = Math.max(from.x, to.x);
      const boundsTop = Math.min(from.y, to.y);
      const boundsBottom = Math.max(from.y, to.y);
      const inView = intersectsViewport(boundsLeft, boundsRight, boundsTop, boundsBottom);
      const visible = distance > thickness && inView;
      edge.line.visible = visible;
      edge.line.alpha = edge.alpha;
      edge.arrow.visible = visible && edge.arrowAlpha > 0.001;
      edge.arrow.alpha = edge.arrowAlpha;
      if (!visible) continue;
      // 线：Sprite 从 A 边缘出发拉伸到 B 边缘（文档：width = |AB| - rA - rB、height = fLineSizeMult/scale）
      edge.line.position.set(from.x + (dx * rFrom) / distance, from.y + (dy * rFrom) / distance - thickness / 2);
      edge.line.pivot.set(0, 0);
      edge.line.rotation = Math.atan2(dy, dx);
      edge.line.width = Math.max(0, distance - rFrom - rTo);
      edge.line.height = thickness;
      edge.line.tint = lit && active ? colors.lineHighlight.tint : colors.line.tint;
      // 箭头：目标边缘外 1px
      const offset = rTo + 1;
      edge.arrow.position.set(to.x - (dx * offset) / distance, to.y - (dy * offset) / distance);
      edge.arrow.pivot.set(0, 0);
      edge.arrow.rotation = Math.atan2(dy, dx);
      edge.arrow.scale.set((2 * Math.sqrt(lineSizeMult)) / scale);
      edge.arrow.tint = colors.arrow.tint;
    }
  }

  /** A5 主循环（顺序与文档一致） */
  function renderCallback(): void {
    timer = null;
    if (destroyedRef.value || idleFrames > IDLE_FRAME_LIMIT) return;
    frames += 1;

    // ① 布局结果已在 data.positions 里（Obsidian 用 worker + SharedArrayBuffer 的版本号判重）

    // ② 平移惯性：panX += 1000*panv/60；方向键持续平移时重置空闲
    let dx = 0;
    let dy = 0;
    if (keys.up) dy += 1;
    if (keys.down) dy -= 1;
    if (keys.left) dx += 1;
    if (keys.right) dx -= 1;
    if (dx !== 0 || dy !== 0) {
      const boost = keys.fast ? 3 : 1;
      panvX = dx * boost;
      panvY = dy * boost;
      idleFrames = 0;
    }
    if (Math.abs(panvX) > 1e-4 || Math.abs(panvY) > 1e-4) {
      panX += (1000 * panvX) / 60;
      panY += (1000 * panvY) / 60;
      panvX *= 0.9;
      panvY *= 0.9;
      if (Math.abs(panvX) < 1e-4) panvX = 0;
      if (Math.abs(panvY) < 1e-4) panvY = 0;
      applyScale();
      idleFrames = 0;
    }

    // ③ 键盘缩放（每帧 ×1.03，Shift 时 ×1.1）
    const zoomStep = 1 + (keys.fast ? 0.1 : 0.03);
    if (keys.zoomIn || keys.zoomOut) {
      markUserAdjusted();
      targetScale = clampZoom(keys.zoomIn ? targetScale * zoomStep : targetScale / zoomStep);
      zoomCenterX = (cssWidth / 2) * dpr();
      zoomCenterY = (cssHeight / 2) * dpr();
      idleFrames = 0;
    }

    // ④ 缩放插值 + 视口矩形
    const beforeScale = scale;
    updateZoom();
    if (beforeScale !== scale) idleFrames = 0;

    // ⑤ 补建未渲染节点（≤50/帧） ⑥ 补建连线
    const nodeCountBefore = nodeViews.size;
    createPendingNodes();
    if (nodeViews.size !== nodeCountBefore) idleFrames = 0;
    createPendingEdges();

    // ⑦ 逐节点 → 逐连线 → 水印 → 排序 → WebGL 绘制
    renderNodes();
    renderEdges();
    watermark.alpha = 0.5;
    hanger.sortChildren();
    app.renderer.render(app.stage);
    idleFrames += 1;

    // ⑧ hover 距离校验：鼠标离开节点超过 半径+2 就撤掉高亮
    if (hoverId !== null && pointer.x !== null && pointer.y !== null) {
      const node = nodeViews.get(hoverId);
      if (node === undefined) {
        hoverId = null;
        options.onHover?.(null);
      } else {
        const worldX = ((pointer.x * dpr()) - panX) / scale;
        const worldY = ((pointer.y * dpr()) - panY) / scale;
        const ddx = node.x - worldX;
        const ddy = node.y - worldY;
        const limit = node.size * nodeScale(scale) + 2;
        if (ddx * ddx + ddy * ddy > limit * limit) {
          hoverId = null;
          options.onHover?.(null);
        }
      }
    }

    queueRender();
  }

  function worldPoint(clientX: number, clientY: number): { x: number; y: number } {
    const rect = host.getBoundingClientRect();
    const x = (clientX - rect.left) * dpr();
    const y = (clientY - rect.top) * dpr();
    return { x: (x - panX) / scale, y: (y - panY) / scale };
  }

  function hitTest(clientX: number, clientY: number): string | null {
    if (scale <= 0) return null;
    const point = worldPoint(clientX, clientY);
    const ns = nodeScale(scale);
    let best: { id: string; area: number } | null = null;
    for (const node of nodeViews.values()) {
      const dx = node.x - point.x;
      const dy = node.y - point.y;
      const radius = node.size * ns;
      if (dx * dx + dy * dy > radius * radius) continue;
      const area = node.size;
      if (best === null || area > best.area) best = { id: node.id, area };
    }
    return best?.id ?? null;
  }

  /** C1 滚轮缩放：deltaMode 归一 → ×1.5^(−Δ/120)；放大锚点=鼠标，缩小锚点归零（画布中心） */
  function onWheel(event: WheelEvent): void {
    event.preventDefault();
    const rect = host.getBoundingClientRect();
    const delta = wheelDeltaPixels(event.deltaY, event.deltaMode);
    const previous = targetScale;
    targetScale = clampZoom(previous * zoomFactorFromWheel(delta));
    const anchor = zoomAnchor(previous, targetScale, {
      x: (event.clientX - rect.left) * dpr(),
      y: (event.clientY - rect.top) * dpr(),
    }, { x: 0, y: 0 });
    zoomCenterX = anchor.x;
    zoomCenterY = anchor.y;
    markUserAdjusted();
    changed();
  }

  /** C2/C6 pointerdown：先判是否落在节点上（拖节点），否则拖画布 */
  function onPointerDown(event: PointerEvent): void {
    if (event.button === 2) return; // 右键交给 contextmenu
    pointer.down = true;
    pointer.dragging = false;
    pointer.startX = event.clientX;
    pointer.startY = event.clientY;
    pointer.panStartX = panX;
    pointer.panStartY = panY;
    pointer.lastMoveMs = performance.now();
    pointer.downAtMs = pointer.lastMoveMs;
    pointer.velocityX = 0;
    pointer.velocityY = 0;
    pointer.nodeId = hitTest(event.clientX, event.clientY);
    if (pointer.nodeId !== null) {
      const point = worldPoint(event.clientX, event.clientY);
      options.onNodeDrag?.(pointer.nodeId, point, 'start');
    }
    try {
      host.setPointerCapture?.(event.pointerId);
    } catch {
      // 合成事件/无效 pointerId 时 setPointerCapture 会抛，捕获失败不影响后续交互
    }
  }

  function onPointerMove(event: PointerEvent): void {
    const rect = host.getBoundingClientRect();
    pointer.x = event.clientX - rect.left;
    pointer.y = event.clientY - rect.top;

    if (pointer.down && pointer.nodeId !== null) {
      // C6 拖拽节点：hanger 局部坐标写 fx/fy（本实现无 sim，等价效果=停在松手处不回弹）
      if (!isClickGesture(event.clientX - pointer.startX, event.clientY - pointer.startY)) {
        pointer.dragging = true;
        pointer.clickCancelled = true;
      }
      const point = worldPoint(event.clientX, event.clientY);
      const node = nodeViews.get(pointer.nodeId);
      if (node !== undefined) {
        node.x = point.x;
        node.y = point.y;
        pinned.set(node.id, { x: point.x, y: point.y });
        dragId = node.id;
        // 持续把 fx/fy 发给布局层：其它节点被力牵动（文档 C6）
        options.onNodeDrag?.(node.id, point, 'move');
      }
      idleFrames = 0;
      changed();
      return;
    }

    if (pointer.down) {
      // C2 拖拽平移：采样速度（mQ 平滑），超过 5px 取消点击判定
      if (!isClickGesture(event.clientX - pointer.startX, event.clientY - pointer.startY)) pointer.clickCancelled = true;
      const nextPanX = pointer.panStartX + (event.clientX - pointer.startX) * dpr();
      const nextPanY = pointer.panStartY + (event.clientY - pointer.startY) * dpr();
      const now = performance.now();
      const deltaMs = Math.max(1, now - pointer.lastMoveMs);
      pointer.velocityX = dampen(pointer.velocityX, (nextPanX - panX) / deltaMs, 0.8);
      pointer.velocityY = dampen(pointer.velocityY, (nextPanY - panY) / deltaMs, 0.8);
      pointer.lastMoveMs = now;
      panX = nextPanX;
      panY = nextPanY;
      markUserAdjusted();
      applyScale();
      idleFrames = 0;
      changed();
      return;
    }

    // C5 hover：命中节点 → 高亮，自身与直接邻居 1、其余 0.2
    const hit = hitTest(event.clientX, event.clientY);
    if (hit !== hoverId) {
      hoverId = hit;
      options.onHover?.(hit);
      changed();
    }
  }

  /** C2 松手：>100ms 视为停住（惯性清零），否则保留速度交给主循环衰减 */
  function onPointerUp(event: PointerEvent): void {
    const wasDown = pointer.down;
    const draggedNode = pointer.nodeId;
    const clickCancelled = pointer.clickCancelled;
    pointer.down = false;
    pointer.nodeId = null;
    try {
      host.releasePointerCapture?.(event.pointerId);
    } catch {
      // 同上：释放失败（从未捕获）不应中断点击判定
    }

    if (draggedNode !== null) {
      // 节点上松手：位移 ≤5px 仍是点击（文档 C3 的 onNodeClick），超过阈值才是拖拽
      dragId = null;
      // 松手：清 pin（位置由布局层 tick 回传接管；文档：fx/fy 置 undefined）并通知布局层
      const released = pinned.get(draggedNode);
      pinned.delete(draggedNode);
      options.onNodeDrag?.(draggedNode, released ?? { x: 0, y: 0 }, 'end');
      if (wasDown && !clickCancelled) options.onSelect?.(draggedNode);
      changed();
    } else if (wasDown && !clickCancelled) {
      // C3 点击判定：位移 ≤5px 才算点击
      const hit = hitTest(event.clientX, event.clientY);
      if (hit !== null) options.onSelect?.(hit);
    }

    if (wasDown && draggedNode === null) {
      const elapsed = performance.now() - pointer.lastMoveMs;
      if (shouldKeepPanInertia(elapsed)) {
        panvX = pointer.velocityX * (1000 / 1000);
        panvY = pointer.velocityY * (1000 / 1000);
      } else {
        panvX = 0;
        panvY = 0;
      }
      if (Math.abs(panvX) > 1e-4 || Math.abs(panvY) > 1e-4) {
        idleFrames = 0;
        changed();
      }
    }
    pointer.dragging = false;
    pointer.clickCancelled = false;
  }

  function onPointerLeave(): void {
    pointer.x = null;
    pointer.y = null;
    pointer.down = false;
    pointer.nodeId = null;
    if (hoverId !== null) {
      hoverId = null;
      options.onHover?.(null);
      changed();
    }
  }

  /** C4 右键：节点上右键 → 交给 React 弹「打开详情 / 复制页链接 / 聚焦邻居」 */
  function onContextMenu(event: MouseEvent): void {
    const hit = hitTest(event.clientX, event.clientY);
    if (hit === null) return;
    event.preventDefault();
    options.onContextMenu?.({
      id: hit,
      clientX: event.clientX,
      clientY: event.clientY,
    });
  }

  /** C9 键盘：仅焦点在 body 时响应；187/189 放大缩小，方向键平移，Shift 加速 */
  function keyboardEnabled(): boolean {
    const active = doc.activeElement;
    if (active === null || active === doc.body) return true;
    const tag = active.tagName.toLowerCase();
    return tag !== 'input' && tag !== 'textarea' && tag !== 'select' && !(active as HTMLElement).isContentEditable;
  }

  function onKeyDown(event: KeyboardEvent): void {
    if (!keyboardEnabled()) return;
    const code = event.keyCode || event.which;
    const key = event.key;
    if (code === 187 || key === '+' || key === '=' || key === 'Add') keys.zoomIn = true;
    else if (code === 189 || key === '-' || key === '_' || key === 'Subtract') keys.zoomOut = true;
    else if (key === 'ArrowUp') keys.up = true;
    else if (key === 'ArrowDown') keys.down = true;
    else if (key === 'ArrowLeft') keys.left = true;
    else if (key === 'ArrowRight') keys.right = true;
    else return;
    event.preventDefault();
    keys.fast = event.shiftKey;
    changed();
  }

  function onKeyUp(event: KeyboardEvent): void {
    const code = event.keyCode || event.which;
    const key = event.key;
    if (code === 187 || key === '+' || key === '=' || key === 'Add') keys.zoomIn = false;
    else if (code === 189 || key === '-' || key === '_' || key === 'Subtract') keys.zoomOut = false;
    else if (key === 'ArrowUp') keys.up = false;
    else if (key === 'ArrowDown') keys.down = false;
    else if (key === 'ArrowLeft') keys.left = false;
    else if (key === 'ArrowRight') keys.right = false;
    else return;
    keys.fast = event.shiftKey;
  }

  host.addEventListener('wheel', onWheel, { passive: false });
  host.addEventListener('pointerdown', onPointerDown);
  host.addEventListener('pointermove', onPointerMove);
  host.addEventListener('pointerup', onPointerUp);
  host.addEventListener('pointercancel', onPointerUp);
  host.addEventListener('pointerleave', onPointerLeave);
  host.addEventListener('contextmenu', onContextMenu);
  host.addEventListener('keydown', onKeyDown);
  host.addEventListener('keyup', onKeyUp);
  const observer = typeof ResizeObserver === 'function' ? new ResizeObserver(() => { resize(); changed(); }) : null;
  observer?.observe(host);

  resize();
  applyScale();
  layoutWatermark();

  function update(next: PixiGraphData): void {
    data = next;
    // 双向边去重（文档 A6：A↔B 只画字典序大的那条）
    hiddenEdges = duplicateEdgeKeys(
      next.edges.map((edge) => ({ key: edge.key, source: edge.source, target: edge.target })),
    );
    adjacency = buildAdjacency(next.edges);
    // 清掉已消失的节点/连线
    const keepNodes = new Set(next.nodes.map((node) => node.id));
    for (const [id, node] of [...nodeViews]) {
      if (keepNodes.has(id) && next.positions.has(id)) {
        objectStats.reused += 1;
        const point = pinned.get(id) ?? (next.positions.get(id) as { x: number; y: number });
        node.x = point.x;
        node.y = point.y;
        node.size = getSize(node.weight, nodeSizeMultiplier);
        continue;
      }
      node.circle.destroy();
      node.label.destroy();
      objectStats.destroyed += 1;
      nodeViews.delete(id);
    }
    for (const [key, edge] of [...edgeViews]) {
      if (next.edges.some((item) => item.key === key) && keepNodes.has(edge.source) && keepNodes.has(edge.target)) continue;
      edge.line.destroy();
      edge.arrow.destroy();
      objectStats.destroyed += 2;
      edgeViews.delete(key);
    }
    // weight 可能变了（度数随边过滤变化）→ 重算
    const byId = new Map(next.nodes.map((node) => [node.id, node]));
    for (const node of nodeViews.values()) {
      const source = byId.get(node.id);
      if (source === undefined) continue;
      node.tint = source.tint;
      node.weight = source.weight;
      node.size = getSize(node.weight, nodeSizeMultiplier);
      node.label.style.fontSize = fontSize(node.size);
    }
    // 不要无条件清 hover：React 侧 onHover → setHovered → 数据更新会再次调用 update()，
    // 清掉会让「悬停 → 重渲染 → 高亮消失」自相矛盾。只在节点已不存在时清。
    if (hoverId !== null && !keepNodes.has(hoverId)) hoverId = null;
    // KB-PANEL-POLISH：未被用户平移/缩放前，坐标变化（含力导向 tick 挪动质心）都保持内容居中
    if (!userAdjusted) {
      centerOnContent();
      return;
    }
    changed();
  }

  function zoomBy(factor: number): void {
    const previous = targetScale;
    markUserAdjusted();
    targetScale = clampZoom(previous * factor);
    const anchor = zoomAnchor(previous, targetScale, { x: 0, y: 0 }, { x: 0, y: 0 });
    zoomCenterX = anchor.x;
    zoomCenterY = anchor.y;
    changed();
  }

  function resetView(): void {
    userAdjusted = false;
    scale = 1;
    targetScale = 1;
    panvX = 0;
    panvY = 0;
    zoomCenterX = (cssWidth / 2) * dpr();
    zoomCenterY = (cssHeight / 2) * dpr();
    // KB-PANEL-POLISH：复位回「内容居中」，不是图坐标原点（pan=0 会把图推到左上角）
    const center = positionsCenter(data.positions);
    const next = center === null
      ? { x: 0, y: 0 }
      : panCenteredOn(center, cssWidth * dpr(), cssHeight * dpr(), scale);
    panX = next.x;
    panY = next.y;
    applyScale();
    options.onScaleChange?.(scale);
    changed();
  }

  function refreshColors(): void {
    const next = readColorMap();
    for (const key of Object.keys(colors) as SemanticColorKey[]) colors[key] = next[key];
    watermark.style.fill = colors.text.tint;
    // UNSLOP-4：主题切换只换中性色，不能把按内容类型算好的 tint 抹成统一底灰
    const tints = new Map(data.nodes.map((node) => [node.id, node.tint]));
    for (const node of nodeViews.values()) {
      node.tint = tints.get(node.id);
      node.circle.tint = node.tint ?? colors.fill.tint;
      node.label.style.fill = colors.text.tint;
    }
    for (const edge of edgeViews.values()) {
      edge.line.tint = colors.line.tint;
      edge.arrow.tint = colors.arrow.tint;
    }
    changed();
  }

  function snapshot(): PixiGraphSnapshot {
    const ns = nodeScale(scale);
    return {
      rendererType: app.renderer.type,
      resolution: app.renderer.resolution,
      dpr: dpr(),
      cssWidth,
      cssHeight,
      backingWidth: app.renderer.width,
      backingHeight: app.renderer.height,
      scale,
      targetScale,
      nodeScale: ns,
      textAlpha: textAlpha(scale, textShowMult),
      lineWidth: lineWidth(scale, lineSizeMult),
      pan: { x: panX, y: panY },
      idleFrames,
      frames,
      hangerChildren: hanger.children.length,
      nodeCount: data.nodes.length,
      edgeCount: data.edges.length,
      hiddenDuplicateEdges: hiddenEdges.size,
      createdNodes: nodeViews.size,
      createdEdges: edgeViews.size,
      hoverId,
      dragId,
      pinnedCount: pinned.size,
      objects: { ...objectStats, seq: objectSeq },
      panVelocity: { x: panvX, y: panvY },
      zoomCenter: { x: zoomCenterX, y: zoomCenterY },
      clickDistanceSq: CLICK_DISTANCE_SQ,
      colors: { ...colors },
      nodes: [...nodeViews.values()].map((node) => ({
        id: node.id,
        objId: node.objId,
        weight: node.weight,
        size: node.size,
        x: node.x,
        y: node.y,
        circleScale: node.circle.scale.x,
        fontSize: fontSize(node.size),
        labelFontSize: Number(node.label.style.fontSize),
        labelAlpha: node.label.alpha,
        labelY: node.label.position.y,
        circleAlpha: node.circle.alpha,
        fadeAlpha: node.alpha,
        circleVisible: node.circle.visible,
        labelVisible: node.label.visible,
        tint: node.circle.tint,
      })),
      edges: [...edgeViews.values()].map((edge) => ({
        key: edge.key,
        visible: edge.line.visible,
        width: edge.line.width,
        height: edge.line.height,
        rotation: edge.line.rotation,
        alpha: edge.line.alpha,
        arrowVisible: edge.arrow.visible,
        arrowScale: edge.arrow.scale.x,
        alphaNow: edge.alpha,
        arrowAlphaNow: edge.arrowAlpha,
        tint: edge.line.tint,
      })),
    };
  }

  function destroy(): void {
    if (destroyedRef.value) return;
    destroyedRef.value = true;
    if (timer !== null) cancelRaf(timer);
    timer = null;
    observer?.disconnect();
    host.removeEventListener('wheel', onWheel);
    host.removeEventListener('pointerdown', onPointerDown);
    host.removeEventListener('pointermove', onPointerMove);
    host.removeEventListener('pointerup', onPointerUp);
    host.removeEventListener('pointercancel', onPointerUp);
    host.removeEventListener('pointerleave', onPointerLeave);
    host.removeEventListener('contextmenu', onContextMenu);
    host.removeEventListener('keydown', onKeyDown);
    host.removeEventListener('keyup', onKeyUp);
    canvas.removeEventListener('webglcontextlost', onContextLost);
    nodeViews.clear();
    edgeViews.clear();
    // GRAPH-INIT-FAIL：显式释放 WebGL 上下文。只 destroy 不释放时浏览器要等 GC，
    // 反复进出知识库会累积到每页上下文上限（实测 10 次切换创建 25 个、仅 8 个 lost），
    // 后续 createPixiGraph 就会失败 → render-failed。
    // 两条路都试：PIXI 自带 forceContextLoss（版本差异可能没有）+ WEBGL_lose_context 扩展（标准做法）。
    const renderer = app.renderer as unknown as { gl?: WebGLRenderingContext; forceContextLoss?: () => void };
    try {
      renderer.forceContextLoss?.();
    } catch {
      /* 已丢失/已销毁时个别实现会抛，忽略 */
    }
    try {
      const gl = renderer.gl ?? (canvas.getContext('webgl2') as WebGL2RenderingContext | null) ?? (canvas.getContext('webgl') as WebGLRenderingContext | null);
      gl?.getExtension('WEBGL_lose_context')?.loseContext();
    } catch {
      /* 上下文已丢失 */
    }
    app.destroy(true, { children: true });
  }

  changed();

  return { host, update, zoomBy, resetView, refreshColors, changed, snapshot, destroy };
}
