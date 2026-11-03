/**
 * KB-GRAPH-P4 局部图（文档 C10）：逐跳权重、四个开关、与聚焦高亮共用 BFS。
 */
import { describe, expect, it } from 'vitest';
import { LOCAL_CENTER_WEIGHT, localHopWeight, localGraphSlice, bfsHops } from '../lib/localGraph';
import { neighborsWithin, type GraphEdge, type GraphPayload } from '../lib/knowledgeGraph';

const edge = (source: string, target: string, key = `${source}->${target}`): GraphEdge => ({
  key,
  source,
  target,
  kind: 'source',
  weight: 3,
});

const node = (id: string): GraphPayload['nodes'][number] => ({
  id,
  title: id,
  scope: 'workspace',
  workspace_id: 'A',
  revision: 1,
  degree: 0,
});

/** A→B、A→C、B→D、C→D、D→E，另有一条 C→F 与 B–F 的「相邻」边，用来验 interlinks */
const payload: GraphPayload = {
  nodes: ['A', 'B', 'C', 'D', 'E', 'F'].map(node),
  edges: [edge('A', 'B'), edge('A', 'C'), edge('B', 'D'), edge('C', 'D'), edge('D', 'E'), edge('C', 'F'), edge('B', 'F')],
  truncated: false,
  truncated_reason: null,
  pages_truncated: false,
  node_total: 6,
  edge_total: 7,
};

describe('逐跳权重（文档：30 - 30/jumps*k，中心 30，最后一跳 0）', () => {
  it('jumps=1 第 1 跳为 0；jumps=5 逐跳 24/18/12/6/0', () => {
    expect(LOCAL_CENTER_WEIGHT).toBe(30);
    expect(localHopWeight(1, 1)).toBe(0);
    expect([1, 2, 3, 4, 5].map((hop) => localHopWeight(5, hop))).toEqual([24, 18, 12, 6, 0]);
    expect([1, 2].map((hop) => localHopWeight(2, hop))).toEqual([15, 0]);
    // 超出 1–5 夹紧
    expect(localHopWeight(9, 5)).toBe(0);
    expect(localHopWeight(0, 1)).toBe(0);
  });

  it('中心固定 30，逐跳递减', () => {
    const slice = localGraphSlice(payload, { centerId: 'A', jumps: 5 });
    expect(slice.weights.get('A')).toBe(30);
    expect(slice.weights.get('B')).toBe(24);
    expect(slice.weights.get('D')).toBe(18);
    expect(slice.weights.get('E')).toBe(12);
  });
});

describe('节点集合：1 跳 / 2 跳', () => {
  it('jumps=1 → 中心 + 直接邻居', () => {
    const slice = localGraphSlice(payload, { centerId: 'A', jumps: 1 });
    expect([...slice.graph.nodes.map((n) => n.id)].sort()).toEqual(['A', 'B', 'C']);
    expect(slice.graph.edges.every((e) => e.source !== 'D' && e.target !== 'D')).toBe(true);
  });

  it('jumps=2 → 再进一层（D/F），远跳节点半径更小', () => {
    const one = localGraphSlice(payload, { centerId: 'A', jumps: 1 });
    const two = localGraphSlice(payload, { centerId: 'A', jumps: 2 });
    expect([...two.graph.nodes.map((n) => n.id)].sort()).toEqual(['A', 'B', 'C', 'D', 'F']);
    expect(two.graph.nodes.length).toBeGreaterThan(one.graph.nodes.length);
    expect(two.weights.get('A')!).toBeGreaterThan(two.weights.get('B')!);
    expect(two.weights.get('B')!).toBeGreaterThan(two.weights.get('D')!);
  });
});

describe('四个开关', () => {
  it('正向扩展关闭 → 只留反向进集合的节点', () => {
    const graph: GraphPayload = {
      ...payload,
      nodes: ['A', 'B', 'C'].map(node),
      edges: [edge('A', 'B'), edge('C', 'A')],
    };
    const fore = localGraphSlice(graph, { centerId: 'A', jumps: 1, forelinks: true, backlinks: false });
    expect([...fore.graph.nodes.map((n) => n.id)].sort()).toEqual(['A', 'B']);
    const back = localGraphSlice(graph, { centerId: 'A', jumps: 1, forelinks: false, backlinks: true });
    expect([...back.graph.nodes.map((n) => n.id)].sort()).toEqual(['A', 'C']);
  });

  it('相邻链接关闭 → 只保留遍历到的边（去掉集合内其它边）', () => {
    const graph: GraphPayload = {
      ...payload,
      nodes: ['A', 'B', 'C'].map(node),
      edges: [edge('A', 'B'), edge('A', 'C'), edge('B', 'C')],
    };
    const withInter = localGraphSlice(graph, { centerId: 'A', jumps: 1, interlinks: true });
    const withoutInter = localGraphSlice(graph, { centerId: 'A', jumps: 1, interlinks: false });
    expect(withInter.graph.edges.some((e) => e.key === 'B->C')).toBe(true);
    expect(withoutInter.graph.edges.length).toBeLessThan(withInter.graph.edges.length);
  });

  it('隐藏孤立：没有边的节点被丢掉（中心也没边时整图为空）', () => {
    const isolated: GraphPayload = { ...payload, nodes: [node('A'), node('Z')], edges: [] };
    const kept = localGraphSlice(isolated, { centerId: 'A', jumps: 1, hideOrphans: true });
    expect(kept.graph.nodes).toHaveLength(0);
    const notHidden = localGraphSlice(isolated, { centerId: 'A', jumps: 1, hideOrphans: false });
    expect(notHidden.graph.nodes).toHaveLength(1);
  });
});

describe('与聚焦/悬停高亮共用 BFS（不留第二套实现）', () => {
  it('fore+back 同时开时节点集合与 neighborsWithin 一致', () => {
    for (const hops of [1, 2]) {
      const slice = localGraphSlice(payload, { centerId: 'A', jumps: hops });
      const shared = neighborsWithin(payload, 'A', hops);
      expect([...slice.graph.nodes.map((n) => n.id)].sort()).toEqual([...shared].sort());
    }
  });

  it('bfsHops 返回跳数：中心 0、邻居 1、二跳 2', () => {
    const hops = bfsHops(payload.nodes, payload.edges, { centerId: 'A', jumps: 3, forelinks: true, backlinks: true });
    expect(hops.get('A')).toBe(0);
    expect(hops.get('B')).toBe(1);
    expect(hops.get('D')).toBe(2);
    expect(hops.get('E')).toBe(3);
  });
});
