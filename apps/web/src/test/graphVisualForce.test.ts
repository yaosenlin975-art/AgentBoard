/**
 * KB-GRAPH-4：scope/kind 配色与线型、图例数据、力学默认参数（20–50 节点稳定不重叠）。
 */
import { describe, expect, it } from 'vitest';
import {
  FORCE_DEFAULTS,
  GRAPH_PALETTE,
  NODE_RADIUS_MAX,
  countOverlaps,
  edgeStyle,
  layoutGraph,
  nodeColor,
  type GraphEdge,
  type GraphNode,
} from '../lib/knowledgeGraph';

const buildGraph = (count: number, spacing: 'hub' | 'chain' = 'hub'): { nodes: GraphNode[]; edges: GraphEdge[] } => {
  const nodes: GraphNode[] = [];
  const edges: GraphEdge[] = [];
  for (let i = 0; i < count; i += 1) {
    nodes.push({ id: `n${i}`, scope: i % 3 === 0 ? 'common' : 'workspace', workspace_id: 'ws-1', title: `页 ${i}`, revision: 1, degree: 0 });
  }
  if (spacing === 'hub') {
    for (let i = 1; i < count; i += 1) edges.push({ key: `e${i}`, source: 'n0', target: `n${i}`, kind: 'keyword', weight: 1 });
  } else {
    for (let i = 1; i < count; i += 1) edges.push({ key: `e${i}`, source: `n${i - 1}`, target: `n${i}`, kind: 'source', weight: 1 });
  }
  // degree 由调用方按边数补齐（layoutGraph 只看坐标，countOverlaps 用 nodeRadius(degree)）
  const degree = new Map<string, number>();
  for (const edge of edges) {
    degree.set(edge.source, (degree.get(edge.source) ?? 0) + 1);
    degree.set(edge.target, (degree.get(edge.target) ?? 0) + 1);
  }
  for (const node of nodes) node.degree = degree.get(node.id) ?? 0;
  return { nodes, edges };
};

describe('配色与线型（KB-GRAPH-4）', () => {
  it('scope 着色：workspace / common 各有亮暗两套，且亮暗不同', () => {
    expect(nodeColor('workspace', false)).toBe(GRAPH_PALETTE.node.workspace.light);
    expect(nodeColor('workspace', true)).toBe(GRAPH_PALETTE.node.workspace.dark);
    expect(nodeColor('common', false)).toBe(GRAPH_PALETTE.node.common.light);
    expect(nodeColor('common', true)).not.toBe(nodeColor('common', false));
    expect(nodeColor('workspace', false)).not.toBe(nodeColor('common', false));
  });

  it('edge kind 线型：source 实线、keyword 虚线，且颜色不同', () => {
    const source = edgeStyle('source', false);
    const keyword = edgeStyle('keyword', false);
    expect(source.dash).toEqual([]);
    expect(keyword.dash.length).toBeGreaterThan(0);
    expect(source.color).not.toBe(keyword.color);
    expect(source.width).toBeGreaterThan(keyword.width);
    // 暗色各自不同
    expect(edgeStyle('source', true).color).not.toBe(source.color);
  });

  it('未知 kind/scope 落到默认分支而不是 undefined', () => {
    expect(nodeColor('weird', false)).toBe(GRAPH_PALETTE.node.workspace.light);
    expect(edgeStyle('weird', false).color).toBe(GRAPH_PALETTE.edge.keyword.light);
  });
});

describe('力学默认参数（20–50 节点）', () => {
  it('FORCE_DEFAULTS 有明确默认值与收敛阈值', () => {
    expect(FORCE_DEFAULTS.iterations).toBeGreaterThanOrEqual(200);
    expect(FORCE_DEFAULTS.settleSpeed).toBeGreaterThan(0);
    expect(FORCE_DEFAULTS.repulsion).toBeGreaterThan(1000);
    expect(FORCE_DEFAULTS.damping).toBeLessThan(0.8);
    expect(FORCE_DEFAULTS.maxStep).toBeLessThanOrEqual(12);
  });

  it('20 / 35 / 50 节点：迭代加倍后坐标几乎不动（已收敛、不抖动）', () => {
    for (const count of [20, 35, 50]) {
      const { nodes, edges } = buildGraph(count);
      const base = layoutGraph(nodes, edges, { width: 1200, height: 720 });
      const doubled = layoutGraph(nodes, edges, { width: 1200, height: 720, iterations: base.iterations * 2 });
      let maxDelta = 0;
      for (const node of nodes) {
        const a = base.positions.get(node.id)!;
        const b = doubled.positions.get(node.id)!;
        maxDelta = Math.max(maxDelta, Math.hypot(a.x - b.x, a.y - b.y));
      }
      // 收敛判据：再跑一倍 tick，位移不超过 1px（等价于视觉静止）
      expect(maxDelta).toBeLessThan(1);
      // 末帧速度也应当在同一量级（< 1.5 px/tick）
      expect(doubled.finalMaxSpeed).toBeLessThan(1.5);
    }
  });

  it('20 / 50 节点：节点互不重叠（中心距 ≥ 半径和）', () => {
    for (const count of [20, 50]) {
      const { nodes, edges } = buildGraph(count);
      const result = layoutGraph(nodes, edges, { width: 1200, height: 720 });
      expect(countOverlaps(result.positions, nodes)).toBe(0);
    }
  });

  it('链式 30 节点也不重叠（长条拓扑不塌成一条线）', () => {
    const { nodes, edges } = buildGraph(30, 'chain');
    const result = layoutGraph(nodes, edges, { width: 1200, height: 720 });
    expect(countOverlaps(result.positions, nodes)).toBe(0);
  });

  it('半径上限参与重叠判定（小图大半径也不会被判成重叠）', () => {
    const nodes: GraphNode[] = [
      { id: 'a', scope: 'workspace', workspace_id: 'ws-1', title: 'a', revision: 1, degree: 0 },
      { id: 'b', scope: 'workspace', workspace_id: 'ws-1', title: 'b', revision: 1, degree: 0 },
    ];
    const positions = new Map([
      ['a', { x: 100, y: 100 }],
      ['b', { x: 100 + NODE_RADIUS_MAX * 2 + 1, y: 100 }],
    ]);
    expect(countOverlaps(positions, nodes)).toBe(0);
    const crowded = new Map([
      ['a', { x: 100, y: 100 }],
      ['b', { x: 103, y: 100 }],
    ]);
    expect(countOverlaps(crowded, nodes)).toBe(1);
  });
});


