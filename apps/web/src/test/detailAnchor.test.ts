import { describe, expect, it } from 'vitest';
import {
  computeDetailAnchor,
  detailPanelWidth,
  DETAIL_ANCHOR_GAP,
  DETAIL_ANCHOR_MARGIN,
  DETAIL_ANCHOR_MIN_VIEWPORT,
} from '../lib/detailAnchor';

describe('ANCHOR-DETAIL 选边算法', () => {
  it('右侧可容：面板贴列右缘，且与列无水平重叠', () => {
    const anchor = computeDetailAnchor({ left: 0, right: 300, top: 80, height: 700 }, 1440);
    expect(anchor).toEqual({
      mode: 'anchored',
      side: 'right',
      left: 300 + DETAIL_ANCHOR_GAP,
      top: 80,
      width: 460,
      height: 700,
    });
    if (anchor.mode !== 'anchored') throw new Error('expected anchored');
    // 不遮列：整体落在列右侧，且留出 gap + 安全边距
    expect(anchor.left).toBeGreaterThanOrEqual(300);
    expect(anchor.left + anchor.width).toBeLessThanOrEqual(1440 - DETAIL_ANCHOR_MARGIN);
  });

  it('右侧不容但左侧可容：翻到列左侧', () => {
    const anchor = computeDetailAnchor({ left: 900, right: 1100, top: 60, height: 600 }, 1440);
    expect(anchor.mode).toBe('anchored');
    if (anchor.mode !== 'anchored') throw new Error('expected anchored');
    expect(anchor.side).toBe('left');
    expect(anchor.left).toBe(900 - DETAIL_ANCHOR_GAP - 460);
    expect(anchor.left + anchor.width).toBeLessThanOrEqual(900);
  });

  it('两侧都不容：退化贴右侧边缘（压住内容，由调用方加发丝线/阴影）', () => {
    const anchor = computeDetailAnchor({ left: 300, right: 700, top: 50, height: 500 }, 1000);
    expect(anchor.mode).toBe('anchored');
    if (anchor.mode !== 'anchored') throw new Error('expected anchored');
    expect(anchor.side).toBe('fallback');
    expect(anchor.left).toBe(1000 - 360 - DETAIL_ANCHOR_MARGIN);
    expect(anchor.top).toBe(50);
    expect(anchor.height).toBe(500);
  });

  it('窄屏 < 920 回退整宽抽屉（不左右选边）', () => {
    expect(computeDetailAnchor({ left: 0, right: 300, top: 0, height: 600 }, DETAIL_ANCHOR_MIN_VIEWPORT - 1)).toEqual({ mode: 'drawer' });
    // 边界值 920 仍允许贴列
    expect(computeDetailAnchor({ left: 0, right: 300, top: 0, height: 600 }, DETAIL_ANCHOR_MIN_VIEWPORT).mode).toBe('anchored');
  });

  it('无列信息（任务树等）回退抽屉', () => {
    expect(computeDetailAnchor(null, 1440)).toEqual({ mode: 'drawer' });
  });

  it('D4 回归：锚定高度=列高（吸底条贴面板底边，而不是视口底边）', () => {
    const anchor = computeDetailAnchor({ left: 0, right: 300, top: 120, height: 480 }, 1440);
    if (anchor.mode !== 'anchored') throw new Error('expected anchored');
    expect(anchor.height).toBe(480);
    expect(anchor.top).toBe(120);
  });

  it('面板宽度 clamp(360, 34vw, 460)', () => {
    expect(detailPanelWidth(900)).toBe(360);
    expect(detailPanelWidth(1000)).toBe(360);
    expect(detailPanelWidth(1200)).toBe(408);
    expect(detailPanelWidth(1440)).toBe(460);
    expect(detailPanelWidth(1920)).toBe(460);
  });
});
