/**
 * DRAWER-ANCHOR：账号/设置抽屉锚定算法单测。
 * 覆盖：贴左栏右边缘的 left、宽度 clamp 上下限、窄屏回退 legacy。
 */
import { describe, expect, it } from 'vitest';
import {
  DRAWER_ANCHOR_GAP,
  DRAWER_ANCHOR_MIN_VIEWPORT,
  DRAWER_MAX_WIDTH,
  DRAWER_MIN_WIDTH,
  computeDrawerAnchor,
  drawerPanelWidth,
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
