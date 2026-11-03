/**
 * KB-GRAPH-P1 公式逐值核对 + 双向边去重 + 语义色读取。
 * 期望值来自 `Docs/Obsidian-星图渲染逆向.md` 的实测表：weight 8→9、7→8.4853、6→8；size 9→fontSize 16.25；scale 0.5→textAlpha 0。
 */
import { describe, expect, it, vi } from 'vitest';
import {
  GRAPH_SEMANTIC_CLASSES,
  NODE_SIZE_MAX,
  NODE_SIZE_MIN,
  ZOOM_MAX,
  ZOOM_MIN,
  clampZoom,
  duplicateEdgeKeys,
  fontSize,
  getSize,
  labelOffsetY,
  lineWidth,
  nodeScale,
  readSemanticColors,
  textAlpha,
  tintFromCssColor,
  zoomFactorFromWheel,
} from '../lib/graphVisualFormulas';

describe('getSize（weight → 半径）', () => {
  it('文档实测逐值：weight 8→9、7→8.4853、6→8', () => {
    expect(getSize(8)).toBeCloseTo(9, 4);
    expect(getSize(7)).toBeCloseTo(8.4853, 3);
    expect(getSize(6)).toBeCloseTo(8, 4);
  });

  it('下限 8 / 上限 30：weight 0 → 8，大权重触顶 30', () => {
    expect(getSize(0)).toBe(NODE_SIZE_MIN);
    expect(getSize(1)).toBe(NODE_SIZE_MIN);
    expect(getSize(200)).toBe(NODE_SIZE_MAX);
  });

  it('乘 nodeSizeMultiplier 线性缩放；非法权重按下限', () => {
    expect(getSize(8, 2)).toBeCloseTo(18, 4);
    expect(getSize(Number.NaN)).toBe(NODE_SIZE_MIN);
    expect(getSize(-5)).toBe(NODE_SIZE_MIN);
  });
});

describe('nodeScale / lineWidth（与 scale 反比）', () => {
  it('scale 1 → 1；放大到 4 → 0.5（放大时节点反而缩小）', () => {
    expect(nodeScale(1)).toBe(1);
    expect(nodeScale(4)).toBe(0.5);
    expect(nodeScale(4)).toBeLessThan(nodeScale(1));
  });

  it('线宽 = fLineSizeMult / scale', () => {
    expect(lineWidth(1)).toBe(1);
    expect(lineWidth(2)).toBe(0.5);
    expect(lineWidth(2, 2)).toBe(1);
  });
});

describe('textAlpha / fontSize / labelOffsetY', () => {
  it('scale 0.5 → textAlpha 0（文档实测）；scale 1 → 1；scale 2 → 1', () => {
    expect(textAlpha(0.5)).toBe(0);
    expect(textAlpha(1)).toBe(1);
    expect(textAlpha(2)).toBe(1);
    expect(textAlpha(64)).toBe(1);
  });

  it('文字淡出阈值向左（fTextShowMult=-3）低倍率也显示文字（文档第二张实测表）', () => {
    expect(textAlpha(0.125, -3)).toBe(1);
    expect(textAlpha(0.0625, -3)).toBe(0);
  });

  it('size 9 → fontSize 16.25（文档实测）', () => {
    expect(fontSize(9)).toBe(16.25);
  });

  it('标签偏移随 scale 收敛：scale 越大偏移越小', () => {
    const small = labelOffsetY(9, 0.5, 15);
    const large = labelOffsetY(9, 2, 15);
    expect(small).toBeGreaterThan(large);
  });
});

describe('滚轮缩放与上下限', () => {
  it('1.5^(-Δ/120)：向下滚（正 delta）缩小，向上滚放大', () => {
    expect(zoomFactorFromWheel(-120)).toBeCloseTo(1.5, 5);
    expect(zoomFactorFromWheel(120)).toBeCloseTo(1 / 1.5, 5);
    expect(zoomFactorFromWheel(0)).toBe(1);
  });

  it('夹在 1/128–8', () => {
    expect(clampZoom(100)).toBe(ZOOM_MAX);
    expect(clampZoom(0.0001)).toBe(ZOOM_MIN);
    expect(clampZoom(1)).toBe(1);
  });
});

describe('双向边去重', () => {
  it('A↔B 只保留一条：字典序小的那条被隐藏', () => {
    const hidden = duplicateEdgeKeys([
      { key: 'a-b', source: 'a', target: 'b' },
      { key: 'b-a', source: 'b', target: 'a' },
      { key: 'b-c', source: 'b', target: 'c' },
    ]);
    expect([...hidden]).toEqual(['a-b']);
  });

  it('单向边与自环不受影响', () => {
    const hidden = duplicateEdgeKeys([
      { key: 'x-y', source: 'x', target: 'y' },
      { key: 'self', source: 'z', target: 'z' },
    ]);
    expect(hidden.size).toBe(0);
  });
});

describe('11 语义色从 CSS 变量读（不硬编码）', () => {
  it('逐个插 div 读 getComputedStyle：改 CSS 变量后颜色跟着变', () => {
    const style = document.createElement('style');
    style.textContent = `
      .graph-view.color-fill { color: rgb(1, 2, 3); }
      .graph-view.color-line-highlight { color: rgb(9, 8, 7); opacity: 0.5; }
    `;
    document.head.appendChild(style);
    const colors = readSemanticColors();
    expect(colors.fill?.color).toBe('rgb(1, 2, 3)');
    expect(colors.lineHighlight?.color).toBe('rgb(9, 8, 7)');
    expect(colors.lineHighlight?.opacity).toBe(0.5);

    // 改 CSS 变量/规则 → 再读一次必须跟着变（证明不是硬编码）
    style.textContent = `.graph-view.color-fill { color: rgb(200, 100, 50); }`;
    const again = readSemanticColors();
    expect(again.fill?.color).toBe('rgb(200, 100, 50)');
    style.remove();
  });

  it('11 个 key 全覆盖，且读取后不残留探测节点', () => {
    const before = document.body.children.length;
    const colors = readSemanticColors();
    expect(Object.keys(colors).length).toBe(11);
    expect(Object.keys(GRAPH_SEMANTIC_CLASSES).length).toBe(11);
    expect(document.body.children.length).toBe(before);
  });

  it('无 document 时返回空对象（服务端/非浏览器）', () => {
    expect(readSemanticColors(null)).toEqual({});
  });
});

describe('公式与文档一致性守卫（防回归成自研近似值）', () => {
  it('getSize 不是线性、textAlpha 是 log2 而非线性', () => {
    const g = getSize as unknown as ReturnType<typeof vi.fn>;
    void g;
    // 若有人把公式改成线性，这两条会立刻红
    expect(getSize(3) - getSize(0)).not.toBeCloseTo((getSize(30) - getSize(0)) * (3 / 30), 3);
    // textAlpha 在 2 以上已被 clamp 到 1，改用未触界的 0.5 / 1 验证 log2 步长
    expect(textAlpha(1) - textAlpha(0.5)).toBeCloseTo(1, 5);
  });
});

describe('tintFromCssColor（CSS 颜色 → PIXI tint）', () => {
  it('rgb/rgba/#hex 都转成 0xRRGGBB；rgba 忽略 alpha', () => {
    expect(tintFromCssColor('rgb(1, 2, 3)')).toBe(0x010203);
    expect(tintFromCssColor('rgba(90, 90, 90, 0.5)')).toBe(0x5a5a5a);
    expect(tintFromCssColor('#5c5c5c')).toBe(0x5c5c5c);
    expect(tintFromCssColor('#abc')).toBe(0xaabbcc);
    expect(tintFromCssColor('rgb(1 2 3)')).toBe(0x010203);
  });

  it('解析失败/非法输入退回 0x888888（文档 testCSS 同一处兜底）', () => {
    expect(tintFromCssColor('')).toBe(0x888888);
    expect(tintFromCssColor('var(--x)')).toBe(0x888888);
    expect(tintFromCssColor('rgb(a, b, c)')).toBe(0x888888);
    expect(tintFromCssColor('#12345')).toBe(0x888888);
    expect(tintFromCssColor(undefined as unknown as string)).toBe(0x888888);
  });
});

