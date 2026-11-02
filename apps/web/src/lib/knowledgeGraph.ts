/**
 * 知识星图数据层（KB-GRAPH）：图契约归一化、边合成（来源共现 / 关键词共现）、
 * 截断与度数计算，以及自研轻量力学布局。
 *
 * 边定义（与 `GET /api/knowledge/graph` 契约一致，服务端就绪后由服务端产出，本文件的
 * `composeGraph` 同时作为「服务端未就绪时的本地兜底」与「阈值语义的参考实现」）：
 * - E1 source：两页共享同一 `sources[].locator`（同一文件/URL）→ weight 3；
 *   若还共享同一 `content_hash`（同一内容快照）→ weight 4。
 * - E2 keyword：**共享实体词 ≥ 2** 或 **trigram 重叠 ≥ 3** → weight 1。
 *   实体词 = 小写化后按非字母数字/非中文切分，长度 ≥2 且不在停用词表中；
 *   trigram = 去掉空白与标点后的连续串取 3 字符滑窗。阈值收紧依据见卡 c62aad74 裁决 2。
 * - E3 正文双链 `[[page]]` 不在本文件范围（独立卡）。
 */

export type GraphEdgeKind = 'source' | 'keyword';

export interface GraphNode {
  id: string;
  title: string;
  scope: 'workspace' | 'common';
  workspace_id: string | null;
  revision: number;
  degree: number;
  updated_at?: number;
}

export interface GraphEdge {
  source: string;
  target: string;
  kind: GraphEdgeKind;
  weight: number;
  key: string;
}

export type GraphTruncatedReason = 'pages' | 'nodes' | 'edges';

export interface GraphPayload {
  nodes: GraphNode[];
  edges: GraphEdge[];
  truncated: boolean;
  node_total: number;
  edge_total: number;
  /** 服务端截断原因：pages（页面集合不全，数据不完整）/ nodes / edges；null 表示未截断 */
  truncated_reason: GraphTruncatedReason | null;
  /** 等价于 truncated_reason === 'pages'；为 true 时 node_total/edge_total 只反映已加载子集 */
  pages_truncated: boolean;
  /** 该 scope/workspace 下的活跃页总数（不受 LIMIT 5000 影响） */
  page_total?: number;
  /** 本次实际加载的页数；pages_truncated=true 时 < page_total */
  pages_loaded?: number;
}

export const GRAPH_LIMITS = {
  defaultNodes: 150,
  defaultEdges: 500,
  maxNodes: 300,
  maxEdges: 900,
} as const;

/** E2 阈值（写成常量便于测试与文档引用） */
export const KEYWORD_THRESHOLDS = {
  sharedEntityTerms: 2,
  trigramOverlap: 3,
} as const;

const STOPWORDS = new Set([
  // 中文高频虚词 / 代词（不含实际业务词）
  '的', '了', '和', '与', '及', '或', '在', '是', '有', '不', '这', '那', '我', '你', '他', '她', '它',
  '我们', '你们', '他们', '它们', '一个', '一下', '一些', '以及', '并且', '但是', '因为', '所以',
  '如果', '已经', '可以', '需要', '进行', '方式', '情况', '问题', '内容', '同时', '通过', '由于',
  // 英文
  'the', 'a', 'an', 'and', 'or', 'of', 'to', 'in', 'on', 'for', 'with', 'is', 'are', 'be', 'as', 'by',
  'at', 'it', 'this', 'that', 'from', 'was', 'were', 'will', 'can', 'not', 'but', 'if', 'then', 'than',
]);

const hasCjk = (s: string) => /[\u3400-\u9fff]/.test(s);

/** 实体词集合：小写、按非字母数字/非中文切分，长度 ≥2 且非停用词 */
export function entityTerms(text: string): Set<string> {
  const out = new Set<string>();
  for (const raw of text.toLowerCase().split(/[^a-z0-9\u3400-\u9fff]+/)) {
    if (raw.length < 2) continue;
    if (STOPWORDS.has(raw)) continue;
    out.add(raw);
  }
  return out;
}

/** trigram 集合：去掉空白与标点后的 3 字符滑窗 */
export function trigramSet(text: string): Set<string> {
  const compact = text.toLowerCase().replace(/[^a-z0-9\u3400-\u9fff]+/g, '');
  const out = new Set<string>();
  for (let i = 0; i + 3 <= compact.length; i += 1) out.add(compact.slice(i, i + 3));
  return out;
}

function overlap(a: Set<string>, b: Set<string>): number {
  let n = 0;
  for (const v of a) if (b.has(v)) n += 1;
  return n;
}

/** E2 判定：共享实体词 ≥2 或 trigram 重叠 ≥3 → weight 1，否则 0（0 表示不成边） */
export function keywordWeight(titleA: string, bodyA: string, titleB: string, bodyB: string): number {
  const entityOverlap = overlap(entityTerms(`${titleA} ${bodyA}`), entityTerms(`${titleB} ${bodyB}`));
  if (entityOverlap >= KEYWORD_THRESHOLDS.sharedEntityTerms) return 1;
  const trigramOverlap = overlap(trigramSet(`${titleA} ${bodyA}`), trigramSet(`${titleB} ${bodyB}`));
  return trigramOverlap >= KEYWORD_THRESHOLDS.trigramOverlap ? 1 : 0;
}

export interface ComposePageInput {
  id: string;
  title: string;
  scope: 'workspace' | 'common';
  workspace_id: string | null;
  revision: number;
  updated_at?: number;
  body_md?: string;
  sources?: Array<{ source_type?: string; locator: string; content_hash?: string }>;
}

export interface ComposeOptions {
  edgeKinds?: GraphEdgeKind[];
  includeIsolated?: boolean;
  limitNodes?: number;
  limitEdges?: number;
}

export interface ComposeResult extends GraphPayload {
  /** 因节点/边上限被丢弃的数量（用于 UI 说明） */
  droppedNodes: number;
  droppedEdges: number;
}

/**
 * 从知识页（含 sources）合成图：E1 来源共现 + E2 关键词共现。
 * 截断策略：节点按 degree 降序取前 limitNodes（默认 150，硬上限 300）；
 * 边按 weight 降序取前 limitEdges（默认 500，硬上限 900）；任一截断都置 truncated=true。
 */
export function composeGraph(pages: ComposePageInput[], options: ComposeOptions = {}): ComposeResult {
  const kinds = new Set<GraphEdgeKind>(options.edgeKinds ?? ['source', 'keyword']);
  const limitNodes = Math.min(options.limitNodes ?? GRAPH_LIMITS.defaultNodes, GRAPH_LIMITS.maxNodes);
  const limitEdges = Math.min(options.limitEdges ?? GRAPH_LIMITS.defaultEdges, GRAPH_LIMITS.maxEdges);

  const nodes = new Map<string, GraphNode>();
  for (const page of pages) {
    if (nodes.has(page.id)) continue;
    nodes.set(page.id, {
      id: page.id,
      title: page.title,
      scope: page.scope,
      workspace_id: page.workspace_id,
      revision: page.revision,
      degree: 0,
      ...(page.updated_at !== undefined ? { updated_at: page.updated_at } : {}),
    });
  }

  const edges = new Map<string, GraphEdge>();
  const pairKey = (a: string, b: string, kind: GraphEdgeKind) => (a < b ? `${kind}|${a}|${b}` : `${kind}|${b}|${a}`);
  const addEdge = (a: string, b: string, kind: GraphEdgeKind, weight: number, key: string): void => {
    if (a === b) return;
    const id = pairKey(a, b, kind);
    const existing = edges.get(id);
    if (existing === undefined || weight > existing.weight) edges.set(id, { source: a, target: b, kind, weight, key });
  };

  // E1：共享 locator（weight 3），叠加共享 content_hash（weight 4）
  // 每个页面的 locator / content_hash 集合；边权与服务端一致：3×共享 locator 数 + 4×共享 hash 数
  const locatorsOf = new Map<string, Set<string>>();
  const hashesOf = new Map<string, Set<string>>();
  for (const page of pages) {
    const locators = locatorsOf.get(page.id) ?? new Set<string>();
    const hashes = hashesOf.get(page.id) ?? new Set<string>();
    for (const src of page.sources ?? []) {
      locators.add(`${src.source_type ?? 'file'}:${src.locator}`);
      if (src.content_hash) hashes.add(src.content_hash);
    }
    locatorsOf.set(page.id, locators);
    hashesOf.set(page.id, hashes);
  }
  if (kinds.has('source')) {
    const ids = [...nodes.keys()];
    for (let i = 0; i < ids.length; i += 1) {
      for (let j = i + 1; j < ids.length; j += 1) {
        const a = ids[i]!;
        const b = ids[j]!;
        let sharedLocators = 0;
        for (const locator of locatorsOf.get(a) ?? []) if (locatorsOf.get(b)?.has(locator) === true) sharedLocators += 1;
        let sharedHashes = 0;
        for (const hash of hashesOf.get(a) ?? []) if (hashesOf.get(b)?.has(hash) === true) sharedHashes += 1;
        if (sharedLocators === 0 && sharedHashes === 0) continue;
        addEdge(a, b, 'source', 3 * sharedLocators + 4 * sharedHashes, `source:${a}->${b}`);
      }
    }
  }
  // E2：关键词共现（不与 E1 重复成边）
  if (kinds.has('keyword')) {
    const candidates = pages.filter((p) => nodes.has(p.id));
    for (let i = 0; i < candidates.length; i += 1) {
      for (let j = i + 1; j < candidates.length; j += 1) {
        const a = candidates[i]!;
        const b = candidates[j]!;
        if (edges.has(pairKey(a.id, b.id, 'source'))) continue;
        const weight = keywordWeight(a.title, a.body_md ?? '', b.title, b.body_md ?? '');
        if (weight > 0) addEdge(a.id, b.id, 'keyword', weight, 'keyword');
      }
    }
  }

  // 度数
  for (const edge of edges.values()) {
    const a = nodes.get(edge.source);
    const b = nodes.get(edge.target);
    if (a) a.degree += 1;
    if (b) b.degree += 1;
  }

  // 截断：节点按 degree 降序取前 limitNodes
  const allNodes = [...nodes.values()];
  let nodeList = allNodes;
  let droppedNodes = 0;
  if (allNodes.length > limitNodes) {
    nodeList = [...allNodes].sort((x, y) => y.degree - x.degree || x.title.localeCompare(y.title)).slice(0, limitNodes);
    droppedNodes = allNodes.length - limitNodes;
  }
  const kept = new Set(nodeList.map((n) => n.id));
  let edgeList = [...edges.values()].filter((e) => kept.has(e.source) && kept.has(e.target));
  let droppedEdges = edges.size - edgeList.length;
  if (edgeList.length > limitEdges) {
    edgeList = [...edgeList].sort((x, y) => y.weight - x.weight || x.key.localeCompare(y.key)).slice(0, limitEdges);
    droppedEdges = edges.size - edgeList.length;
  }
  // 度数只统计实际保留的边
  const degree = new Map<string, number>();
  for (const edge of edgeList) {
    degree.set(edge.source, (degree.get(edge.source) ?? 0) + 1);
    degree.set(edge.target, (degree.get(edge.target) ?? 0) + 1);
  }
  nodeList = nodeList.map((n) => ({ ...n, degree: degree.get(n.id) ?? 0 }));

  const finalNodes = options.includeIsolated === false ? nodeList.filter((n) => n.degree > 0) : nodeList;
  const nodeIds = new Set(finalNodes.map((n) => n.id));
  const finalEdges = edgeList.filter((e) => nodeIds.has(e.source) && nodeIds.has(e.target));

  return {
    nodes: finalNodes,
    edges: finalEdges,
    truncated: droppedNodes > 0 || droppedEdges > 0,
    truncated_reason: droppedNodes > 0 ? 'nodes' : droppedEdges > 0 ? 'edges' : null,
    pages_truncated: false,
    page_total: nodes.size,
    pages_loaded: nodes.size,
    node_total: nodes.size,
    edge_total: edges.size,
    droppedNodes,
    droppedEdges,
  };
}

/**
 * 契约归一化（对齐服务端 `GET /api/knowledge/graph`）：
 * - 丢非法项、同类边去重（服务端已按 pair 合并，这里幂等）；
 * - `degree` 保留服务端「截断前真实度数」，仅当服务端未给时按可见边重算；
 * - 不在前端二次裁剪到比服务端更小的上限（服务端硬上限 150 节点 / 500 边）。
 */
export function normalizeGraph(raw: unknown, options: ComposeOptions = {}): ComposeResult & { malformed: number } {
  const limitNodes = Math.min(options.limitNodes ?? GRAPH_LIMITS.maxNodes, GRAPH_LIMITS.maxNodes);
  const limitEdges = Math.min(options.limitEdges ?? GRAPH_LIMITS.maxEdges, GRAPH_LIMITS.maxEdges);
  let malformed = 0;
  const obj = (raw ?? {}) as Record<string, unknown>;
  const rawNodes = Array.isArray(obj.nodes) ? obj.nodes : [];
  const rawEdges = Array.isArray(obj.edges) ? obj.edges : [];

  const nodes = new Map<string, GraphNode>();
  const degreeProvided = new Set<string>();
  for (const item of rawNodes) {
    const n = (item ?? {}) as Record<string, unknown>;
    if (typeof n.id !== 'string' || n.id === '' || typeof n.title !== 'string') { malformed += 1; continue; }
    const scope = n.scope === 'common' ? 'common' : 'workspace';
    const hasDegree = typeof n.degree === 'number' && Number.isFinite(n.degree);
    if (hasDegree) degreeProvided.add(n.id);
    nodes.set(n.id, {
      id: n.id,
      title: n.title,
      scope,
      workspace_id: typeof n.workspace_id === 'string' ? n.workspace_id : null,
      revision: typeof n.revision === 'number' ? n.revision : 1,
      degree: hasDegree ? (n.degree as number) : 0,
      ...(typeof n.source_count === 'number' ? { source_count: n.source_count } : {}),
      ...(typeof n.updated_at === 'number' ? { updated_at: n.updated_at } : {}),
    });
  }

  const edges = new Map<string, GraphEdge>();
  for (const item of rawEdges) {
    const e = (item ?? {}) as Record<string, unknown>;
    const kind = e.kind === 'keyword' ? 'keyword' : e.kind === 'source' ? 'source' : null;
    if (kind === null || typeof e.source !== 'string' || typeof e.target !== 'string') { malformed += 1; continue; }
    if (!nodes.has(e.source) || !nodes.has(e.target) || e.source === e.target) { malformed += 1; continue; }
    const weight = typeof e.weight === 'number' && Number.isFinite(e.weight) && e.weight > 0 ? e.weight : 1;
    const key = typeof e.key === 'string' ? e.key : `${kind}:${e.source}->${e.target}`;
    const dedupeKey = [kind, e.source, e.target].sort().join('|');
    const existing = edges.get(dedupeKey);
    if (existing === undefined || weight > existing.weight) {
      edges.set(dedupeKey, { source: e.source, target: e.target, kind, weight, key });
    }
  }

  const recomputed = new Map<string, number>();
  for (const edge of edges.values()) {
    recomputed.set(edge.source, (recomputed.get(edge.source) ?? 0) + 1);
    recomputed.set(edge.target, (recomputed.get(edge.target) ?? 0) + 1);
  }

  let nodeList = [...nodes.values()].map((n) =>
    degreeProvided.has(n.id) ? n : { ...n, degree: recomputed.get(n.id) ?? 0 },
  );
  let droppedNodes = 0;
  if (nodeList.length > limitNodes) {
    nodeList.sort((x, y) => y.degree - x.degree || x.title.localeCompare(y.title));
    droppedNodes = nodeList.length - limitNodes;
    nodeList = nodeList.slice(0, limitNodes);
  }
  const kept = new Set(nodeList.map((n) => n.id));
  let edgeList = [...edges.values()].filter((e) => kept.has(e.source) && kept.has(e.target));
  let droppedEdges = edges.size - edgeList.length;
  if (edgeList.length > limitEdges) {
    edgeList.sort((x, y) => y.weight - x.weight || x.key.localeCompare(y.key));
    droppedEdges += edgeList.length - limitEdges;
    edgeList = edgeList.slice(0, limitEdges);
  }
  const serverTruncated = obj.truncated === true;
  const serverReason =
    obj.truncated_reason === 'pages' || obj.truncated_reason === 'nodes' || obj.truncated_reason === 'edges'
      ? obj.truncated_reason
      : null;
  const pagesTruncated = obj.pages_truncated === true || serverReason === 'pages';
  const nodeTotal = typeof obj.node_total === 'number' ? obj.node_total : nodes.size;
  const edgeTotal = typeof obj.edge_total === 'number' ? obj.edge_total : edges.size;
  return {
    nodes: nodeList,
    edges: edgeList,
    truncated: serverTruncated || droppedNodes > 0 || droppedEdges > 0,
    truncated_reason: serverReason ?? (droppedNodes > 0 ? 'nodes' : droppedEdges > 0 ? 'edges' : null),
    pages_truncated: pagesTruncated,
    page_total: typeof obj.page_total === 'number' ? obj.page_total : nodes.size,
    pages_loaded: typeof obj.pages_loaded === 'number' ? obj.pages_loaded : nodes.size,
    node_total: Math.max(nodeTotal, nodes.size),
    edge_total: Math.max(edgeTotal, edges.size),
    droppedNodes,
    droppedEdges,
    malformed,
  };
}
/** 按边类型过滤（本地开关切换不重新请求）；节点保留，度数按可见边重算 */
export function applyEdgeKinds(graph: GraphPayload, kinds: GraphEdgeKind[]): GraphPayload {
  const enabled = new Set(kinds);
  const edges = graph.edges.filter((e) => enabled.has(e.kind));
  const degree = new Map<string, number>();
  for (const e of edges) {
    degree.set(e.source, (degree.get(e.source) ?? 0) + 1);
    degree.set(e.target, (degree.get(e.target) ?? 0) + 1);
  }
  return {
    ...graph,
    edges,
    nodes: graph.nodes.map((n) => ({ ...n, degree: degree.get(n.id) ?? 0 })),
  };
}

export interface GraphStats {
  nodeCount: number;
  edgeCount: number;
  isolatedCount: number;
  sourceEdges: number;
  keywordEdges: number;
}

export function graphStats(graph: GraphPayload): GraphStats {
  return {
    nodeCount: graph.nodes.length,
    edgeCount: graph.edges.length,
    isolatedCount: graph.nodes.filter((n) => n.degree === 0).length,
    sourceEdges: graph.edges.filter((e) => e.kind === 'source').length,
    keywordEdges: graph.edges.filter((e) => e.kind === 'keyword').length,
  };
}

export interface LayoutPosition { x: number; y: number }

export interface LayoutOptions {
  width?: number;
  height?: number;
  iterations?: number;
  measure?: boolean;
}

export interface LayoutResult {
  positions: Map<string, LayoutPosition>;
  iterations: number;
  totalMs: number;
  maxTickMs: number;
  /** 计时 tick 的逐帧耗时（仅 measure 模式有值，已排除 5 个预热 tick） */
  tickMs: number[];
}

const CELL = 120;
const REPULSION_RADIUS = 170;
const NEIGHBOR_SAMPLE = 20;

/**
 * 自研轻量力学（不引 d3-force）：网格桶近似斥力 + 弹簧 + 中心重力 + 速度阻尼。
 * - 初始化：按节点序号均布在圆周上（确定性，便于测试与快照复现）；
 * - 斥力：只与相邻 3×3 网格桶内节点计算，距离 > REPULSION_RADIUS 忽略 → 近似 O(n)；
 * - 弹簧：理想长度按边权重（source 3/4 → 100，keyword 1 → 130）；
 * - 预跑 iterations（默认 120）后返回坐标；每 tick 目标 ≤ 2ms（300 节点 / 900 边实测见测试）。
 */
export function layoutGraph(nodes: GraphNode[], edges: GraphEdge[], options: LayoutOptions = {}): LayoutResult {
  const width = options.width ?? 800;
  const height = options.height ?? 600;
  const iterations = options.iterations ?? 120;
  const measure = options.measure === true;
  const n = nodes.length;
  const positions = new Map<string, LayoutPosition>();
  if (n === 0) return { positions, iterations: 0, totalMs: 0, maxTickMs: 0, tickMs: [] };

  const xs = new Float64Array(n);
  const ys = new Float64Array(n);
  const vx = new Float64Array(n);
  const vy = new Float64Array(n);
  const index = new Map<string, number>();
  const cx = width / 2;
  const cy = height / 2;
  const radius = Math.min(width, height) * 0.35;

  nodes.forEach((node, i) => {
    index.set(node.id, i);
    const angle = (i / n) * Math.PI * 2;
    xs[i] = cx + Math.cos(angle) * radius + ((i * 37) % 11) - 5;
    ys[i] = cy + Math.sin(angle) * radius + ((i * 53) % 13) - 6;
  });

  const springs: Array<[number, number, number]> = [];
  for (const edge of edges) {
    const a = index.get(edge.source);
    const b = index.get(edge.target);
    if (a === undefined || b === undefined || a === b) continue;
    springs.push([a, b, edge.kind === 'source' ? 100 : 130]);
  }

  const cells = new Map<number, number[]>();
  let totalMs = 0;
  let maxTickMs = 0;
  const tickMs: number[] = [];
  // measure 模式先跑 WARMUP_TICKS 个预热 tick（JIT/分配热身）不计入统计，再计时 iterations 个 tick
  const warmup = measure ? 5 : 0;
  const totalTicks = iterations + warmup;

  for (let tick = 0; tick < totalTicks; tick += 1) {
    const counted = measure && tick >= warmup;
    const started = counted ? performance.now() : 0;
    cells.clear();
    for (let i = 0; i < n; i += 1) {
      const key = Math.floor(xs[i]! / CELL) * 10000 + Math.floor(ys[i]! / CELL);
      const bucket = cells.get(key);
      if (bucket === undefined) cells.set(key, [i]);
      else bucket.push(i);
    }
    for (let i = 0; i < n; i += 1) {
      const gx = Math.floor(xs[i]! / CELL);
      const gy = Math.floor(ys[i]! / CELL);
      let considered = 0;
      for (let dx = -1; dx <= 1 && considered < NEIGHBOR_SAMPLE; dx += 1) {
        for (let dy = -1; dy <= 1 && considered < NEIGHBOR_SAMPLE; dy += 1) {
          const bucket = cells.get((gx + dx) * 10000 + (gy + dy));
          if (bucket === undefined) continue;
          for (const j of bucket) {
            if (j <= i) continue;
            if (considered >= NEIGHBOR_SAMPLE) break;
            considered += 1;
            const ddx = xs[i]! - xs[j]!;
            const ddy = ys[i]! - ys[j]!;
            const dist2 = ddx * ddx + ddy * ddy;
            if (dist2 > REPULSION_RADIUS * REPULSION_RADIUS) continue;
            const dist = Math.sqrt(dist2) || 0.01;
            const force = (3200 / dist) * 0.02;
            const fx = (ddx / dist) * force;
            const fy = (ddy / dist) * force;
            vx[i]! += fx; vy[i]! += fy;
            vx[j]! -= fx; vy[j]! -= fy;
          }
        }
      }
    }
    for (const [a, b, ideal] of springs) {
      const ddx = xs[b]! - xs[a]!;
      const ddy = ys[b]! - ys[a]!;
      const dist = Math.sqrt(ddx * ddx + ddy * ddy) || 0.01;
      const force = ((dist - ideal) / dist) * 0.08;
      const fx = ddx * force;
      const fy = ddy * force;
      vx[a]! += fx; vy[a]! += fy;
      vx[b]! -= fx; vy[b]! -= fy;
    }
    for (let i = 0; i < n; i += 1) {
      vx[i]! += (cx - xs[i]!) * 0.002;
      vy[i]! += (cy - ys[i]!) * 0.002;
      vx[i]! *= 0.85;
      vy[i]! *= 0.85;
      const stepX = Math.max(-24, Math.min(24, vx[i]!));
      const stepY = Math.max(-24, Math.min(24, vy[i]!));
      xs[i]! = Math.max(20, Math.min(width - 20, xs[i]! + stepX));
      ys[i]! = Math.max(20, Math.min(height - 20, ys[i]! + stepY));
    }
    if (counted) {
      const spent = performance.now() - started;
      totalMs += spent;
      tickMs.push(spent);
      if (spent > maxTickMs) maxTickMs = spent;
    }
  }

  nodes.forEach((node, i) => positions.set(node.id, { x: xs[i]!, y: ys[i]! }));
  return { positions, iterations, totalMs, maxTickMs, tickMs };
}

/* ----------------------------------------------------------------------------
 * 视觉尺寸（KB-GRAPH-1）：节点半径按 degree 缩放、标签在低缩放下隐藏。
 * 纯函数，供 canvas 绘制与单测共用；不涉及布局与数据。
 * -------------------------------------------------------------------------- */

/** 半径下限 / 上限（px，未缩放坐标系） */
export const NODE_RADIUS_MIN = 5;
export const NODE_RADIUS_MAX = 14;
/** 标签在缩放低于该值时整体隐藏（避免糊成一团） */
export const LABEL_SCALE_THRESHOLD = 0.8;

/**
 * 节点半径：degree 0 → 下限；随 sqrt(degree) 增长并夹在上限内。
 * 单调不减、有下界，孤立节点不会变成针尖。
 */
export function nodeRadius(degree: number): number {
  const safe = Number.isFinite(degree) && degree > 0 ? degree : 0;
  return NODE_RADIUS_MIN; // mutation: 不随 degree 增长
}

/** 当前缩放是否显示标签 */
export function labelsVisible(scale: number, threshold = LABEL_SCALE_THRESHOLD): boolean {
  return Number.isFinite(scale) && scale >= threshold;
}

/** 缩放夹紧（0.3–3 倍，KB-GRAPH-2 的滚轮缩放共用） */
export const SCALE_MIN = 0.3;
export const SCALE_MAX = 3;

export function clampScale(scale: number): number {
  if (!Number.isFinite(scale)) return 1;
  return Math.min(SCALE_MAX, Math.max(SCALE_MIN, scale));
}

/** 标签文字截断（画布上不换行，超长用省略号） */
export function labelText(title: string, max = 12): string {
  const text = title.trim();
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

