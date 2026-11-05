/**
 * 任务详情浮窗锚定算法（ANCHOR-DETAIL）：
 * 详情浮窗贴被点卡片所在列出现，按空间自动选边，避免盖住其它列。
 * 纯函数便于单测：入参是列矩形与视口宽度（视口坐标），出参是视口坐标下的面板位置；
 * DOM 层再把视口坐标换算成所在定位容器的相对坐标。
 */

/** 面板与列之间的水平间距 */
export const DETAIL_ANCHOR_GAP = 8;
/** 面板与视口边缘的安全边距 */
export const DETAIL_ANCHOR_MARGIN = 12;
/** 小于该视口宽度保持整宽抽屉，不再左右选边 */
export const DETAIL_ANCHOR_MIN_VIEWPORT = 920;

export interface DetailColumnRect {
  left: number;
  right: number;
  top: number;
  height: number;
}

export type DetailAnchor =
  | { mode: 'drawer' }
  | {
      mode: 'anchored';
      /** right=列右侧；left=列左侧；fallback=两侧都放不下，贴右侧边缘并压住内容 */
      side: 'right' | 'left' | 'fallback';
      left: number;
      top: number;
      width: number;
      height: number;
    };

/** 面板宽度 W = clamp(360, 34vw, 460) */
export function detailPanelWidth(viewportWidth: number): number {
  return Math.min(460, Math.max(360, Math.round(viewportWidth * 0.34)));
}

/**
 * 选边：
 * - 右侧可容（col.right + gap + W + margin <= viewportWidth）→ 放右侧；
 * - 否则左侧可容（col.left - gap - W - margin >= 0）→ 放左侧；
 * - 两侧都不容 → 退化贴右侧边缘（并应由调用方加发丝线/阴影表示压住内容）。
 * 列高即面板高（顶对齐列顶部），窄屏或无列信息回退现有整宽抽屉。
 */
export function computeDetailAnchor(
  column: DetailColumnRect | null,
  viewportWidth: number,
): DetailAnchor {
  if (column === null || viewportWidth < DETAIL_ANCHOR_MIN_VIEWPORT) return { mode: 'drawer' };
  const width = detailPanelWidth(viewportWidth);
  const top = column.top;
  const height = column.height;

  if (column.right + DETAIL_ANCHOR_GAP + width + DETAIL_ANCHOR_MARGIN <= viewportWidth) {
    return {
      mode: 'anchored',
      side: 'right',
      left: column.right + DETAIL_ANCHOR_GAP,
      top,
      width,
      height,
    };
  }

  if (column.left - DETAIL_ANCHOR_GAP - width - DETAIL_ANCHOR_MARGIN >= 0) {
    return {
      mode: 'anchored',
      side: 'left',
      left: column.left - DETAIL_ANCHOR_GAP - width,
      top,
      width,
      height,
    };
  }

  return {
    mode: 'anchored',
    side: 'fallback',
    left: viewportWidth - width - DETAIL_ANCHOR_MARGIN,
    top,
    width,
    height,
  };
}
