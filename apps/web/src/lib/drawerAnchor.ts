/**
 * 账号/设置抽屉锚定算法（DRAWER-ANCHOR）：
 * 抽屉不再钉在视口最右边，改为紧贴左侧导航栏右边缘出现，宽度随内容区放宽。
 * 纯函数便于单测：入参是左栏右边缘（视口坐标）与视口宽度，出参是视口坐标下的左偏移与宽度；
 * DOM 层再把视口坐标换算成定位容器（App 里的 relative 布局壳）的相对坐标。
 */

/** 抽屉与左栏之间的水平间距（与详情浮窗同口径） */
export const DRAWER_ANCHOR_GAP = 8;
/** 抽屉与视口右边缘的安全边距（宽度上限按内容区宽度 - 该值） */
export const DRAWER_ANCHOR_MARGIN = 24;
/** 宽度下限：不小于改动前的抽屉宽度，保证账号卡可读 */
export const DRAWER_MIN_WIDTH = 400;
/** 宽度上限：不要顶到右边缘 */
export const DRAWER_MAX_WIDTH = 720;
/** 小于该视口宽度退回既有抽屉行为（挤压 / 整宽覆盖） */
export const DRAWER_ANCHOR_MIN_VIEWPORT = 920;

export type DrawerAnchor =
  | { mode: 'legacy' }
  | {
      mode: 'anchored';
      /** 视口坐标下的面板左边缘 = sidebarRight + gap */
      left: number;
      width: number;
    };

/** 按内容区宽度算面板宽度：clamp(400, min(720, 内容区宽度 - 24)) */
export function drawerPanelWidth(contentWidth: number): number {
  return Math.min(DRAWER_MAX_WIDTH, Math.max(DRAWER_MIN_WIDTH, contentWidth - DRAWER_ANCHOR_MARGIN));
}

/**
 * 锚定到左栏右边缘：
 * - <920px：`legacy`，由调用方沿用挤压 / 整宽覆盖两态；
 * - ≥920px：`left = sidebarRight + 8`，宽度按内容区（视口 - 左栏右边缘）自适应，上限 720、下限 400。
 */
export function computeDrawerAnchor(sidebarRight: number, viewportWidth: number): DrawerAnchor {
  if (viewportWidth < DRAWER_ANCHOR_MIN_VIEWPORT) return { mode: 'legacy' };
  return {
    mode: 'anchored',
    left: sidebarRight + DRAWER_ANCHOR_GAP,
    width: drawerPanelWidth(viewportWidth - sidebarRight),
  };
}
