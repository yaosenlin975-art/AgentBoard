/**
 * 局部图（KB-GRAPH-P4）——照 `Docs/Obsidian-星图渲染逆向.md` C10 的 `PQ()` 逐条实现。
 *
 * - 中心权重固定 30；第 k 跳权重 = 30 - 30/jumps * k（`localJumps=1` 时第 1 跳为 0，最后一跳恒为 0）。
 * - 权重只影响节点半径（`getSize(weight)`），所以离中心越远节点越小。
 * - 四个开关：正向扩展（forelinks）/ 反向扩展（backlinks）/ 相邻链接（interlinks，还原结构）/ 隐藏孤立。
 * - 标签节点不参与扩展（AgentBoard 的图里没有 tag 节点，保留判断以便对齐文档语义）。
 * - 无向 BFS（fore 与 back 同时开）复用 `lib/knowledgeGraph` 的 `buildAdjacency` 口径，
 *   与 hover/聚焦高亮共用同一份邻接与跳数实现，不留第二套。
 */
import { bfsDepths, buildAdjacency, type GraphEdge, type GraphNode, type GraphPayload } from './knowledgeGraph';

export const LOCAL_JUMPS_MIN = 1;
export const LOCAL_JUMPS_MAX = 5;
/** 文档：中心文件固定权重 30 */
export const LOCAL_CENTER_WEIGHT = 30;

/** 第 k 跳（1 基）权重：30 - 30/jumps * k */
export function localHopWeight(jumps: number, hop: number): number {
  const safeJumps = Math.min(LOCAL_JUMPS_MAX, Math.max(LOCAL_JUMPS_MIN, Math.round(jumps)));
  return LOCAL_CENTER_WEIGHT - (LOCAL_CENTER_WEIGHT / safeJumps) * hop;
}

export interface LocalGraphOptions {
  centerId: string;
  /** 1–5，超出夹紧 */
  jumps: number;
  forelinks?: boolean;
  backlinks?: boolean;
  /** 相邻链接：把命中集合之间的边全部还原（关闭时只留遍历用到的边） */
  interlinks?: boolean;
  /** 隐藏孤立：丢掉在局部图里没有任何边的节点 */
  hideOrphans?: boolean;
}

export interface LocalGraphResult {
  graph: GraphPayload;
  /** 节点 id → 局部图权重（中心 30，逐跳递减到 0） */
  weights: Map<string, number>;
  /** 命中集合的跳数（诊断用：CDP 逐值核对跳与权重） */
  hopOf: Map<string, number>;
}

/** 有向邻接：正向（source→target）与反向（target→source）分开建，供 four-switch BFS 用 */
export function buildDirectedAdjacency(edges: readonly GraphEdge[]): {
  forward: Map<string, Set<string>>;
  backward: Map<string, Set<string>>;
} {
  const forward = new Map<string, Set<string>>();
  const backward = new Map<string, Set<string>>();
  const push = (map: Map<string, Set<string>>, from: string, to: string): void => {
    const set = map.get(from) ?? new Set<string>();
    set.add(to);
    map.set(from, set);
  };
  for (const edge of edges) {
    if (edge.source === edge.target) continue;
    push(forward, edge.source, edge.target);
    push(backward, edge.target, edge.source);
  }
  return { forward, backward };
}

/**
 * 逐跳 BFS。`fore && back` 时退化为无向 BFS（与 hover/聚焦高亮同一口径）；
 * 只开一侧时按文档的「正向：集合内节点拉进它的邻居 / 反向：邻居指向集合内则拉进邻居」。
 * 返回 id → 跳数（中心是 0）。
 */
export function bfsHops(
  nodes: readonly GraphNode[],
  edges: readonly GraphEdge[],
  options: { centerId: string; jumps: number; forelinks: boolean; backlinks: boolean },
): Map<string, number> {
  const hops = new Map<string, number>();
  const known = new Set(nodes.map((node) => node.id));
  if (!known.has(options.centerId)) return hops;
  hops.set(options.centerId, 0);
  const maxHops = Math.min(LOCAL_JUMPS_MAX, Math.max(LOCAL_JUMPS_MIN, Math.round(options.jumps)));

  if (options.forelinks && options.backlinks) {
    // 无向：直接复用 `bfsDepths`（与 hover/聚焦高亮同一份实现，不另写一套）
    for (const [id, depth] of bfsDepths(buildAdjacency(edges), options.centerId, maxHops)) {
      if (known.has(id)) hops.set(id, depth);
    }
    return hops;
  }

  const { forward, backward } = buildDirectedAdjacency(edges);
  for (let hop = 1; hop <= maxHops; hop += 1) {
    const added: string[] = [];
    if (options.forelinks) {
      for (const [id, depth] of [...hops]) {
        if (depth !== hop - 1) continue;
        for (const target of forward.get(id) ?? []) {
          if (hops.has(target) || !known.has(target)) continue;
          hops.set(target, hop);
          added.push(target);
        }
      }
    }
    if (options.backlinks) {
      for (const [id] of [...hops]) {
        for (const source of backward.get(id) ?? []) {
          if (hops.has(source) || !known.has(source)) continue;
          hops.set(source, hop);
          added.push(source);
        }
      }
    }
    if (added.length === 0) break;
  }
  return hops;
}

/** 文档 `PQ()`：截取局部图 + 权重表 */
export function localGraphSlice(graph: GraphPayload, options: LocalGraphOptions): LocalGraphResult {
  const jumps = Math.min(LOCAL_JUMPS_MAX, Math.max(LOCAL_JUMPS_MIN, Math.round(options.jumps)));
  const forelinks = options.forelinks ?? true;
  const backlinks = options.backlinks ?? true;
  const interlinks = options.interlinks ?? true;
  const hideOrphans = options.hideOrphans ?? false;

  const hopOf = bfsHops(graph.nodes, graph.edges, { centerId: options.centerId, jumps, forelinks, backlinks });
  const weights = new Map<string, number>();
  for (const [id, hop] of hopOf) {
    weights.set(id, hop === 0 ? LOCAL_CENTER_WEIGHT : localHopWeight(jumps, hop));
  }

  const included = new Set(hopOf.keys());
  let nodes = graph.nodes.filter((node) => included.has(node.id));
  let edges = graph.edges.filter(
    (edge) =>
      included.has(edge.source) &&
      included.has(edge.target) &&
      // 相邻链接关闭时只留遍历用到的边（两端跳数相差 1），否则把集合内的边全部还原
      (interlinks || Math.abs((hopOf.get(edge.source) ?? 0) - (hopOf.get(edge.target) ?? 0)) === 1),
  );

  if (hideOrphans) {
    const degree = new Map<string, number>();
    for (const edge of edges) {
      degree.set(edge.source, (degree.get(edge.source) ?? 0) + 1);
      degree.set(edge.target, (degree.get(edge.target) ?? 0) + 1);
    }
    const kept = new Set(nodes.filter((node) => (degree.get(node.id) ?? 0) > 0).map((node) => node.id));
    nodes = nodes.filter((node) => kept.has(node.id));
    edges = edges.filter((edge) => kept.has(edge.source) && kept.has(edge.target));
    for (const id of [...weights.keys()]) if (!kept.has(id)) weights.delete(id);
  }

  return {
    graph: {
      ...graph,
      nodes,
      edges,
      node_total: nodes.length,
      edge_total: edges.length,
      truncated: false,
      truncated_reason: null,
    },
    weights,
    hopOf,
  };
}
