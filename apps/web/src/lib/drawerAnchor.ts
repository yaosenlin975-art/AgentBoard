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
/** SETTINGS-LAYOUT：设置抽屉收窄比例（相对 accounts 抽屉的基准宽度） */
export const SETTINGS_WIDTH_RATIO = 0.75;
/** SETTINGS-LAYOUT：设置抽屉宽度下限（再窄正文会换行爆炸） */
export const SETTINGS_MIN_WIDTH = 420;
/** SETTINGS-LAYOUT：并排面板可用的最小剩余空间；不足即降级为覆盖式抽屉 */
export const SIDE_PANEL_MIN_AVAILABLE = 360;
/** SETTINGS-LAYOUT：并排面板宽度上下限 */
export const SIDE_PANEL_MIN_WIDTH = 360;
export const SIDE_PANEL_MAX_WIDTH = 480;
/** SETTINGS-LAYOUT：并排面板与视口右边缘的安全边距 */
export const SIDE_PANEL_MARGIN = 24;
/** SETTINGS-LAYOUT：窄于此视口一律降级为覆盖式抽屉 */
export const SIDE_PANEL_MIN_VIEWPORT = 768;

export type DrawerKind = 'accounts' | 'settings';

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

/** 设置抽屉宽度：accounts 基准宽度的 3/4，下限 420（窄屏正文不被挤碎） */
export function settingsPanelWidth(contentWidth: number): number {
  return Math.max(SETTINGS_MIN_WIDTH, Math.round(drawerPanelWidth(contentWidth) * SETTINGS_WIDTH_RATIO));
}

/**
 * 锚定到左栏右边缘：
 * - <920px：`legacy`，由调用方沿用挤压 / 整宽覆盖两态；
 * - ≥920px：`left = sidebarRight + 8`，宽度按内容区（视口 - 左栏右边缘）自适应，上限 720、下限 400；
 *   `kind='settings'` 时宽度再收窄为基准的 3/4（下限 420）。
 */
export function computeDrawerAnchor(sidebarRight: number, viewportWidth: number, kind: DrawerKind = 'accounts'): DrawerAnchor {
  if (viewportWidth < DRAWER_ANCHOR_MIN_VIEWPORT) return { mode: 'legacy' };
  const contentWidth = viewportWidth - sidebarRight;
  return {
    mode: 'anchored',
    left: sidebarRight + DRAWER_ANCHOR_GAP,
    width: kind === 'settings' ? settingsPanelWidth(contentWidth) : drawerPanelWidth(contentWidth),
  };
}

export type SidePanelLayout =
  | { mode: 'side'; /** 视口坐标下的面板左边缘 = 锚定面板右边缘 */ left: number; width: number }
  | { mode: 'overlay' };

/** 并排面板宽度：clamp(360, 480, 剩余可用空间) */
export function sidePanelWidth(available: number): number {
  return Math.min(SIDE_PANEL_MAX_WIDTH, Math.max(SIDE_PANEL_MIN_WIDTH, available));
}

/**
 * 并排面板落位：贴在 `anchorRight`（设置抽屉右边缘）右侧、无间隙（hairline 分隔）。
 * 剩余空间（视口 - 锚定右边缘 - 右安全边距）不足 360px 时降级为覆盖式抽屉。
 */
export function computeSidePanel(anchorRight: number, viewportWidth: number): SidePanelLayout {
  if (viewportWidth < SIDE_PANEL_MIN_VIEWPORT) return { mode: 'overlay' };
  const available = viewportWidth - anchorRight - SIDE_PANEL_MARGIN;
  if (available < SIDE_PANEL_MIN_AVAILABLE) return { mode: 'overlay' };
  return { mode: 'side', left: anchorRight, width: sidePanelWidth(available) };
}
