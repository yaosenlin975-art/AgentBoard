/**
 * DRAWER-ANCHOR：账号/设置抽屉锚定算法单测。
 * 覆盖：贴左栏右边缘的 left、宽度 clamp 上下限、窄屏回退 legacy；
 * SETTINGS-LAYOUT：设置抽屉收窄 3/4（下限 420）、并排面板落位与降级阈值。
 */
import { describe, expect, it } from 'vitest';
import {
  DRAWER_ANCHOR_GAP,
  DRAWER_ANCHOR_MIN_VIEWPORT,
  DRAWER_MAX_WIDTH,
  DRAWER_MIN_WIDTH,
  SIDE_PANEL_MAX_WIDTH,
  SIDE_PANEL_MIN_WIDTH,
  SETTINGS_MIN_WIDTH,
  computeDrawerAnchor,
  computeSidePanel,
  drawerPanelWidth,
  settingsPanelWidth,
  sidePanelWidth,
} from '../lib/drawerAnchor';

describe('computeDrawerAnchor', () => {
  it('≥920 贴左栏右边缘：left = sidebarRight + 8', () => {
    expect(computeDrawerAnchor(176, 1440)).toEqual({
      mode: 'anchored',
      left: 176 + DRAWER_ANCHOR_GAP,
      width: DRAWER_MAX_WIDTH,
    });
  });

  it('920 边界仍锚定：左边 184，宽度 720，右侧保留 16px 边距', () => {
    const anchor = computeDrawerAnchor(176, DRAWER_ANCHOR_MIN_VIEWPORT);
    expect(anchor.mode).toBe('anchored');
    if (anchor.mode !== 'anchored') return;
    expect(anchor.left).toBe(184);
    expect(anchor.width).toBe(720);
    expect(anchor.left + anchor.width).toBeLessThanOrEqual(DRAWER_ANCHOR_MIN_VIEWPORT);
  });

  it('内容区不够 720 时按 内容区宽度 - 24 收窄', () => {
    // 内容区 = 1000 - 400 = 600 → 600 - 24 = 576
    expect(drawerPanelWidth(1000 - 400)).toBe(576);
    expect(computeDrawerAnchor(400, 1000)).toEqual({ mode: 'anchored', left: 408, width: 576 });
  });

  it('内容区过窄时不小于 400（宽度下限）', () => {
    // 内容区 = 320 → 296，被下限 400 兜住
    expect(drawerPanelWidth(320)).toBe(DRAWER_MIN_WIDTH);
    expect(computeDrawerAnchor(600, 920)).toEqual({ mode: 'anchored', left: 608, width: DRAWER_MIN_WIDTH });
  });

  it('<920 回退既有抽屉行为', () => {
    expect(computeDrawerAnchor(176, 919)).toEqual({ mode: 'legacy' });
    expect(computeDrawerAnchor(0, 375)).toEqual({ mode: 'legacy' });
  });

  it('宽度上限恒为 720', () => {
    expect(drawerPanelWidth(2000)).toBe(DRAWER_MAX_WIDTH);
  });
});

describe('设置抽屉宽度（SETTINGS-LAYOUT）', () => {
  it('1440 视口（sidebarRight=240）：基准 720 的 3/4 = 540', () => {
    expect(settingsPanelWidth(1440 - 240)).toBe(540);
    expect(computeDrawerAnchor(240, 1440, 'settings')).toEqual({ mode: 'anchored', left: 248, width: 540 });
  });

  it('accounts 宽度不受影响', () => {
    expect(computeDrawerAnchor(240, 1440)).toEqual({ mode: 'anchored', left: 248, width: DRAWER_MAX_WIDTH });
  });

  it('内容区过窄时保底 420，不随 3/4 无限缩小', () => {
    // 内容区 320 → 基准被下限 400 兜住 → 400*0.75=300 → 保底 420
    expect(settingsPanelWidth(320)).toBe(SETTINGS_MIN_WIDTH);
  });

  it('<920 仍回退 legacy（squeeze / overlay 不缩放）', () => {
    expect(computeDrawerAnchor(176, 919, 'settings')).toEqual({ mode: 'legacy' });
  });
});

describe('并排面板落位（SETTINGS-LAYOUT）', () => {
  it('1440：贴设置右缘，宽度上限 480', () => {
    expect(computeSidePanel(788, 1440)).toEqual({ mode: 'side', left: 788, width: SIDE_PANEL_MAX_WIDTH });
  });

  it('1280 仍可并排：按剩余空间收窄', () => {
    // 1280 - 788 - 24 = 468
    expect(computeSidePanel(788, 1280)).toEqual({ mode: 'side', left: 788, width: 468 });
  });

  it('1024 剩余空间不足 360 → 降级覆盖式', () => {
    // 1024 - 788 - 24 = 212
    expect(computeSidePanel(788, 1024)).toEqual({ mode: 'overlay' });
  });

  it('<768 视口一律降级覆盖式', () => {
    expect(computeSidePanel(100, 767)).toEqual({ mode: 'overlay' });
  });

  it('宽度恒不小于下限 360', () => {
    expect(sidePanelWidth(100)).toBe(SIDE_PANEL_MIN_WIDTH);
  });
});
