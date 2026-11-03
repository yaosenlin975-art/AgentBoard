/**
 * 星图视觉公式（KB-GRAPH-P1）——照 `Docs/Obsidian-星图渲染逆向.md` §0/A6 逐条实现，纯函数便于逐值核对。
 *
 * - getSize(weight)      = max(8, min(3*sqrt(weight+1), 30)) * nodeSizeMultiplier
 * - nodeScale(scale)     = sqrt(1/scale)
 * - textAlpha(scale)     = clamp(log2(scale) + 1 - fTextShowMult, 0, 1)
 * - lineWidth(scale)     = fLineSizeMult / scale
 * - fontSize(size)       = 14 + size/4
 *
 * `weight` 取「正向 ∪ 反向邻居数」（双向边只算一次邻居），由调用方用邻接表算好传入。
 */

/** 节点半径下限 / 上限（未乘 nodeSizeMultiplier） */
export const NODE_SIZE_MIN = 8;
export const NODE_SIZE_MAX = 30;

/** 默认可调参数（对应 Obsidian 的 fNodeSizeMult / fTextShowMult / fLineSizeMult） */
export const GRAPH_VISUAL_DEFAULTS: {
  nodeSizeMultiplier: number;
  textShowMult: number;
  lineSizeMult: number;
} = {
  nodeSizeMultiplier: 1,
  /** 文档「文字淡出阈值」默认 0（滑杆 ∈ [-3,3]）；scale 1 → textAlpha 1 */
  textShowMult: 0,
  lineSizeMult: 1,
};

/** weight → 未缩放半径 */
export function getSize(
  weight: number,
  nodeSizeMultiplier = GRAPH_VISUAL_DEFAULTS.nodeSizeMultiplier,
): number {
  const safe = Number.isFinite(weight) && weight > 0 ? weight : 0;
  const base = Math.max(NODE_SIZE_MIN, Math.min(3 * Math.sqrt(safe + 1), NODE_SIZE_MAX));
  return base * nodeSizeMultiplier;
}

/** 相机 scale → 节点缩放（放大时节点反而缩小，照文档 sqrt(1/scale)） */
export function nodeScale(scale: number): number {
  if (!Number.isFinite(scale) || scale <= 0) return 1;
  return Math.sqrt(1 / scale);
}

/** 相机 scale → 标签透明度（逐帧淡出） */
export function textAlpha(
  scale: number,
  textShowMult = GRAPH_VISUAL_DEFAULTS.textShowMult,
): number {
  if (!Number.isFinite(scale) || scale <= 0) return 0;
  const raw = Math.log2(scale) + 1 - textShowMult;
  return Math.max(0, Math.min(1, raw));
}

/** 相机 scale → 连线粗细（线宽与 scale 成反比） */
export function lineWidth(
  scale: number,
  lineSizeMult = GRAPH_VISUAL_DEFAULTS.lineSizeMult,
): number {
  if (!Number.isFinite(scale) || scale <= 0) return lineSizeMult;
  return lineSizeMult / scale;
}

/** 节点半径 → 标签字号 */
export function fontSize(size: number): number {
  const safe = Number.isFinite(size) ? size : NODE_SIZE_MIN;
  return 14 + safe / 4;
}

/** 标签垂直偏移：nodeY + (size + 5) * nodeScale + moveText / scale（moveText 高亮时收敛到 15） */
export function labelOffsetY(size: number, scale: number, moveText: number): number {
  const ns = nodeScale(scale);
  const safeScale = Number.isFinite(scale) && scale > 0 ? scale : 1;
  return (size + 5) * ns + moveText / safeScale;
}

/** 滚轮增量 → 缩放倍率：1.5^(-delta/120)（文档 C 章） */
export function zoomFactorFromWheel(deltaY: number): number {
  const safe = Number.isFinite(deltaY) ? deltaY : 0;
  return Math.pow(1.5, -safe / 120);
}

/** 缩放上下限（文档：上限 8 / 下限 1/128） */
export const ZOOM_MAX = 8;
export const ZOOM_MIN = 1 / 128;

export function clampZoom(scale: number): number {
  if (!Number.isFinite(scale) || scale <= 0) return 1;
  return Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, scale));
}

/**
 * 双向边去重：A、B 互链时只保留 id 字典序大的那条（等价「source.reverse 含 target 且
 * source.id.localeCompare(target.id) < 0 时不画」）。
 * 返回应隐藏的边键集合。
 */
export function duplicateEdgeKeys(
  edges: ReadonlyArray<{ key: string; source: string; target: string }>,
): Set<string> {
  const set = new Set<string>();
  for (const edge of edges) {
    if (edge.source === edge.target) continue;
    const reverse = edges.find((other) => other.source === edge.target && other.target === edge.source);
    if (reverse === undefined) continue;
    // 只保留字典序大的那条
    if (edge.source.localeCompare(edge.target) < 0) set.add(edge.key);
  }
  return set;
}

/** 11 个语义色的 CSS 变量类名（取值靠临时插 div + getComputedStyle，不硬编码） */
export const GRAPH_SEMANTIC_CLASSES = {
  fill: 'color-fill',
  fillFocused: 'color-fill-focused',
  fillTag: 'color-fill-tag',
  fillUnresolved: 'color-fill-unresolved',
  fillAttachment: 'color-fill-attachment',
  arrow: 'color-arrow',
  circle: 'color-circle',
  line: 'color-line',
  text: 'color-text',
  fillHighlight: 'color-fill-highlight',
  lineHighlight: 'color-line-highlight',
} as const;

export type SemanticColorKey = keyof typeof GRAPH_SEMANTIC_CLASSES;

/**
 * 读 11 个语义色：临时往 document.body 插 `<div class="graph-view color-xxx">`，
 * 取 `getComputedStyle` 的 color 与 opacity（照文档 A/B 章的做法）。
 * 非浏览器环境返回空对象（单测在 jsdom 下用可注入的 scope）。
 */
/**
 * CSS 颜色串 → PIXI 的 tint（0xRRGGBB）。照文档 `testCSS` 的 `o.r << 16 | o.g << 8 | o.b`，
 * 解析失败退回 0x888888（文档同一处兜底值）。
 */
export function tintFromCssColor(cssColor: string, fallback = 0x888888): number {
  if (typeof cssColor !== 'string') return fallback;
  const text = cssColor.trim().toLowerCase();
  let channels: number[] | null = null;
  const rgbMatch = /^rgba?\(([^)]+)\)$/.exec(text);
  if (rgbMatch !== null) {
    channels = rgbMatch[1]!
      .split(/[\s,/]+/)
      .filter((part) => part !== '')
      .slice(0, 3)
      .map((part) => Number.parseFloat(part));
  } else {
    const hexMatch = /^#([0-9a-f]{3}|[0-9a-f]{6})$/.exec(text);
    if (hexMatch !== null) {
      const hex = hexMatch[1]!;
      const full = hex.length === 3 ? hex.split('').map((c) => c + c).join('') : hex;
      channels = [0, 2, 4].map((i) => Number.parseInt(full.slice(i, i + 2), 16));
    }
  }
  if (channels === null || channels.length < 3) return fallback;
  if (channels.some((c) => !Number.isFinite(c))) return fallback;
  const [r, g, b] = channels.map((c) => Math.min(255, Math.max(0, Math.round(c))));
  return ((r ?? 0) << 16) | ((g ?? 0) << 8) | (b ?? 0);
}

export function readSemanticColors(
  scope: Pick<Document, 'createElement' | 'body'> | null = typeof document === 'undefined' ? null : { createElement: document.createElement.bind(document), body: document.body },
): Partial<Record<SemanticColorKey, { color: string; opacity: number }>> {
  if (scope === null) return {};
  const out: Partial<Record<SemanticColorKey, { color: string; opacity: number }>> = {};
  for (const [key, className] of Object.entries(GRAPH_SEMANTIC_CLASSES) as Array<[SemanticColorKey, string]>) {
    const probe = scope.createElement('div');
    probe.className = `graph-view ${className}`;
    probe.style.display = 'none';
    scope.body.appendChild(probe);
    const style = window.getComputedStyle(probe);
    out[key] = { color: style.color, opacity: Number(style.opacity) };
    probe.remove();
  }
  return out;
}

