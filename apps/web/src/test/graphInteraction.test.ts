/**
 * KB-GRAPH-2：邻接集合、以光标为中心缩放、适应视图、命中测试。
 * 这些纯函数是 canvas 交互与 KB-GRAPH-3（聚焦 N 跳）共用的地基。
 */
import { describe, expect, it } from 'vitest';
import {
  SCALE_MAX,
  SCALE_MIN,
  buildAdjacency,
  clampScale,
  fitTransform,
  hitTestNode,
  highlightAround,
  nodeRadius,
  toGraphPoint,
  zoomAt,
  type GraphEdge,
  type GraphNode,
  type GraphPayload,
} from '../lib/knowledgeGraph';

const edge = (source: string, target: string, kind: GraphEdge['kind'] = 'keyword'): GraphEdge => ({
  source,
  target,
  kind,
  weight: 1,
  key: `${source}->${target}`,
});

const node = (id: string, degree: number): GraphNode => ({
  id,
  scope: 'workspace',
  workspace_id: 'ws-1',
  title: id,
  revision: 1,
  degree,
});

describe('buildAdjacency', () => {
  it('无向邻接：两端都登记；自环跳过；孤立节点不在表里', () => {
    const adjacency = buildAdjacency([edge('a', 'b'), edge('b', 'c'), edge('d', 'd')]);
    expect([...(adjacency.get('a') ?? [])]).toEqual(['b']);
    expect([...(adjacency.get('b') ?? [])].sort()).toEqual(['a', 'c']);
    expect([...(adjacency.get('c') ?? [])]).toEqual(['b']);
    expect(adjacency.get('d')).toBeUndefined();
  });
});

describe('highlightAround（hover 高亮集合）', () => {
  const graph: GraphPayload = {
    nodes: [node('a', 2), node('b', 1), node('c', 1), node('d', 0)],
    edges: [edge('a', 'b'), edge('a', 'c')],
    node_total: 4,
    edge_total: 2,
    truncated: false,
    pages_truncated: false,
    truncated_reason: null,
  };

  it('焦点为 null 时集合为空（走高亮关闭分支）', () => {
    const result = highlightAround(graph, null);
    expect(result.nodes.size).toBe(0);
    expect(result.edges.size).toBe(0);
  });

  it('焦点节点 + 1 跳邻居 + 触及它们的边', () => {
    const result = highlightAround(graph, 'a');
    expect([...result.nodes].sort()).toEqual(['a', 'b', 'c']);
    expect([...result.edges].sort()).toEqual(['a->b', 'a->c']);
    expect(result.nodes.has('d')).toBe(false);
  });

  it('孤立节点只有自己，没有边', () => {
    const result = highlightAround(graph, 'd');
    expect([...result.nodes]).toEqual(['d']);
    expect(result.edges.size).toBe(0);
  });
});

describe('zoomAt（以光标为中心）', () => {
  it('缩放夹在 0.3–3，触界后 pan 不变', () => {
    const maxed = zoomAt({ x: 0, y: 0 }, SCALE_MAX, 1.1, { x: 100, y: 100 });
    expect(maxed.scale).toBe(SCALE_MAX);
    expect(maxed.pan).toEqual({ x: 0, y: 0 });
    const mined = zoomAt({ x: 0, y: 0 }, SCALE_MIN, 1 / 1.1, { x: 100, y: 100 });
    expect(mined.scale).toBe(SCALE_MIN);
    expect(mined.pan).toEqual({ x: 0, y: 0 });
  });

  it('放大后光标下的图坐标保持不变（以光标为中心）', () => {
    const pan = { x: 30, y: -20 };
    const scale = 1;
    const cursor = { x: 200, y: 140 };
    const before = toGraphPoint(cursor, pan, scale);
    const next = zoomAt(pan, scale, 1.5, cursor);
    const after = toGraphPoint(cursor, next.pan, next.scale);
    expect(after.x).toBeCloseTo(before.x, 6);
    expect(after.y).toBeCloseTo(before.y, 6);
    expect(next.scale).toBeGreaterThan(scale);
  });
});

describe('toGraphPoint / clampScale', () => {
  it('屏幕坐标按 pan 与 scale 反算图坐标', () => {
    expect(toGraphPoint({ x: 100, y: 50 }, { x: 20, y: 10 }, 2)).toEqual({ x: 40, y: 20 });
  });

  it('clampScale 兜住非法输入', () => {
    expect(clampScale(Number.NaN)).toBe(1);
    expect(clampScale(0.01)).toBe(SCALE_MIN);
    expect(clampScale(99)).toBe(SCALE_MAX);
  });
});

describe('fitTransform（适应视图）', () => {
  it('把全部节点放进画布并居中；缩放夹在 0.3–3', () => {
    const positions = new Map([
      ['a', { x: 0, y: 0 }],
      ['b', { x: 200, y: 100 }],
    ]);
    const fit = fitTransform(positions, 400, 240, 20);
    expect(fit.scale).toBeGreaterThanOrEqual(SCALE_MIN);
    expect(fit.scale).toBeLessThanOrEqual(SCALE_MAX);
    // 两个点变换后都落在画布内
    for (const point of positions.values()) {
      const x = point.x * fit.scale + fit.pan.x;
      const y = point.y * fit.scale + fit.pan.y;
      expect(x).toBeGreaterThanOrEqual(0);
      expect(x).toBeLessThanOrEqual(400);
      expect(y).toBeGreaterThanOrEqual(0);
      expect(y).toBeLessThanOrEqual(240);
    }
    // 居中：bbox 中心落在画布中心
    const centerX = ((0 + 200) / 2) * fit.scale + fit.pan.x;
    expect(centerX).toBeCloseTo(200, 6);
  });

  it('空集合退回 1 倍且不偏移', () => {
    expect(fitTransform(new Map(), 400, 240)).toEqual({ pan: { x: 0, y: 0 }, scale: 1 });
  });
});

describe('hitTestNode（悬停/拖拽命中）', () => {
  const nodes = [node('a', 0), node('b', 6)];
  const positions = new Map([
    ['a', { x: 10, y: 10 }],
    ['b', { x: 100, y: 100 }],
  ]);

  it('落在半径内才算命中，并优先最近的', () => {
    expect(hitTestNode(nodes, positions, { x: 11, y: 11 })).toBe('a');
    expect(hitTestNode(nodes, positions, { x: 104, y: 100 })).toBe('b');
    expect(hitTestNode(nodes, positions, { x: 60, y: 60 })).toBeNull();
  });

  it('半径随 degree 变化，大节点命中范围更大', () => {
    const far = { x: 100 + nodeRadius(6) + 2, y: 100 };
    expect(nodeRadius(6)).toBeGreaterThan(nodeRadius(0));
    expect(hitTestNode(nodes, positions, far)).toBe('b');
  });
});

