/**
 * 力导向布局（KB-GRAPH-P3）——照 `Docs/Obsidian-星图渲染逆向.md` A4 与 D6 逐条实现。
 *
 * - 参数：centerStrength .1 / linkStrength 1 / linkDistance 250 / repelStrength -1000（内部存负，UI 值 <1 按 1）
 *   / distanceMin 30 / alphaMin .001 / alphaDecay = 1 - .001^(1/300) ≈ 0.02276277904418933
 *   / alpha 起始 .3 / alphaTarget 0 / velocityDecay .6 / tick 间隔 1000/60 ≈ 16.67ms。
 * - 力：forceX+forceY 共用 strength、forceLink（strength 1、distance 250、iterations 1）、
 *   forceManyBody（-1000、distanceMin 30、theta .9 的精确 O(n²) 等价实现）。
 *   collide 不在卡面 A4 参数表内（文档 JS 回退路径里那段也是死代码），故不实现。
 * - 增量（D6）：已存在节点用 `false` 占位 → 保持原坐标；新节点落点 = 相邻已定位节点质心 + ±√(60·L·60)/2 抖动；
 *   无邻居时沿已有最大半径外沿随机分布；只有结构变化才重新激活 alpha。
 *
 * 纯函数 + 无 DOM 依赖：Worker 与主线程共用同一份实现，jsdom 里可直接单测。
 */

/** 文档 A4 默认参数（逐字） */
export const FORCE_SIM_DEFAULTS = {
  centerStrength: 0.1,
  linkStrength: 1,
  linkDistance: 250,
  /** 内部存负值；消息里传 UI 值（正），<1 时按 1 处理 */
  repelStrength: -1000,
  distanceMin: 30,
  alphaMin: 0.001,
  alphaDecay: 1 - Math.pow(0.001, 1 / 300),
  alphaInitial: 0.3,
  alphaTarget: 0,
  velocityDecay: 0.6,
  /** 文档 sim.js：setTimeout(…, 1000/60)，不是 rAF */
  tickMs: 1000 / 60,
  /** Barnes–Hut 判据，精确实现里只用于文档对照，不影响结果 */
  theta: 0.9,
} as const;

/** 一个 tick 的物理：先积分速度（衰减 .6）再走位置；fx/fy 钉住的节点写回并清零速度 */
export interface ForceSimNode {
  id: string;
  x: number;
  y: number;
  vx: number;
  vy: number;
  fx: number | null;
  fy: number | null;
}

export interface ForceSimLink {
  source: string;
  target: string;
}

export interface SimForcesPatch {
  centerStrength?: number;
  linkStrength?: number;
  linkDistance?: number;
  repelStrength?: number;
}

/** Worker / 主线程共用消息（文档 D6 报文） */
export interface SimMessage {
  /** id → false（保持原坐标）或 [x, y] */
  nodes?: Record<string, false | [number, number]>;
  links?: Array<[string, string]>;
  forces?: SimForcesPatch;
  forceNode?: { id: string; x: number | null; y: number | null };
  alpha?: number;
  alphaTarget?: number;
  run?: boolean;
}

export interface IngestResult {
  /** 节点或边有增删 → 需要重新激活布局 */
  structural: boolean;
  /** 只有颜色/类型/权重变化 → 只重绘 */
  styleOnly: boolean;
  removedNodes: number;
  addedNodes: number;
}

export class ForceSimulation {
  private nodes = new Map<string, ForceSimNode>();
  private order: string[] = [];
  private links: Array<{ source: ForceSimNode; target: ForceSimNode }> = [];
  private forces: { centerStrength: number; linkStrength: number; linkDistance: number; repelStrength: number } = {
    centerStrength: FORCE_SIM_DEFAULTS.centerStrength,
    linkStrength: FORCE_SIM_DEFAULTS.linkStrength,
    linkDistance: FORCE_SIM_DEFAULTS.linkDistance,
    repelStrength: FORCE_SIM_DEFAULTS.repelStrength,
  };
  alpha: number = FORCE_SIM_DEFAULTS.alphaTarget;
  alphaTarget: number = FORCE_SIM_DEFAULTS.alphaTarget;

  /** 吃一条 worker 协议消息（文档 D6 / sim.js onmessage 同构） */
  ingest(message: SimMessage): IngestResult {
    let added = 0;
    let removed = 0;
    let structural = false;
    let styleOnly = false;

    const patch = message.nodes;
    if (patch !== undefined) {
      for (const id of [...this.order]) {
        if (!Object.prototype.hasOwnProperty.call(patch, id)) {
          this.nodes.delete(id);
          removed += 1;
          structural = true;
        }
      }
      this.order = this.order.filter((id) => this.nodes.has(id));
      for (const [id, value] of Object.entries(patch)) {
        const existing = this.nodes.get(id);
        if (existing === undefined) {
          const created: ForceSimNode = {
            id,
            x: value === false ? 0 : value[0],
            y: value === false ? 0 : value[1],
            vx: 0,
            vy: 0,
            fx: null,
            fy: null,
          };
          this.nodes.set(id, created);
          this.order.push(id);
          added += 1;
          structural = true;
        } else if (value !== false) {
          // 只有显式给了坐标才覆盖；false = 保持原位置（加一个节点不会让整张图重排）
          existing.x = value[0];
          existing.y = value[1];
        } else {
          styleOnly = styleOnly || false;
        }
      }
    }

    if (message.links !== undefined) {
      this.links = [];
      for (const [sourceId, targetId] of message.links) {
        const source = this.nodes.get(sourceId);
        const target = this.nodes.get(targetId);
        if (source === undefined || target === undefined || source === target) continue;
        this.links.push({ source, target });
      }
      structural = true;
    }

    if (message.forces !== undefined) {
      const next = message.forces;
      if (next.centerStrength !== undefined) this.forces.centerStrength = next.centerStrength;
      if (next.linkStrength !== undefined) this.forces.linkStrength = next.linkStrength;
      if (next.linkDistance !== undefined) this.forces.linkDistance = next.linkDistance;
      if (next.repelStrength !== undefined) {
        // 文档：UI 值 <1 按 1 处理，内部存负
        this.forces.repelStrength = -Math.max(1, Math.abs(next.repelStrength));
      }
    }

    if (message.forceNode !== undefined) {
      const node = this.nodes.get(message.forceNode.id);
      if (node !== undefined) {
        node.fx = message.forceNode.x;
        node.fy = message.forceNode.y;
      }
    }

    // alpha 只升不降：反复发 0.3 不会重置已衰减的布局
    if (message.alpha !== undefined && this.alpha < message.alpha) this.alpha = message.alpha;
    if (message.alphaTarget !== undefined) this.alphaTarget = message.alphaTarget;

    return { structural, styleOnly, removedNodes: removed, addedNodes: added };
  }

  /** 一个 tick：alpha 衰减 → 三个力 → 速度衰减 → 位置 → fx/fy 钉住 */
  tick(): void {
    this.alpha += (this.alphaTarget - this.alpha) * FORCE_SIM_DEFAULTS.alphaDecay;
    const alpha = this.alpha;
    const nodes = this.order.map((id) => this.nodes.get(id) as ForceSimNode);

    // forceX / forceY（两轴共用一个 strength）
    for (const node of nodes) {
      node.vx += -node.x * this.forces.centerStrength * alpha;
      node.vy += -node.y * this.forces.centerStrength * alpha;
    }

    // forceLink（strength 1、distance 250、iterations 1）；bias 按两端度数分配（d3 同式）：
    // bias = deg(source) / (deg(source) + deg(target))，度数高的节点位移更小
    const degree = new Map<ForceSimNode, number>();
    for (const link of this.links) {
      degree.set(link.source, (degree.get(link.source) ?? 0) + 1);
      degree.set(link.target, (degree.get(link.target) ?? 0) + 1);
    }
    for (const link of this.links) {
      const dx = link.target.x - link.source.x;
      const dy = link.target.y - link.source.y;
      const distance = Math.sqrt(dx * dx + dy * dy) || 1e-6;
      const delta = ((distance - this.forces.linkDistance) / distance) * alpha * this.forces.linkStrength;
      const sourceDegree = degree.get(link.source) ?? 1;
      const targetDegree = degree.get(link.target) ?? 1;
      const bias = sourceDegree / (sourceDegree + targetDegree);
      link.target.vx -= dx * delta * bias;
      link.target.vy -= dy * delta * bias;
      link.source.vx += dx * delta * (1 - bias);
      link.source.vy += dy * delta * (1 - bias);
    }

    // forceManyBody（strength 负、distanceMin 30）：精确 O(n²)，与 d3 的 Barnes–Hut 在 n≈百级等价
    const distanceMin2 = FORCE_SIM_DEFAULTS.distanceMin * FORCE_SIM_DEFAULTS.distanceMin;
    for (let i = 0; i < nodes.length; i += 1) {
      const node = nodes[i] as ForceSimNode;
      for (let j = 0; j < nodes.length; j += 1) {
        if (i === j) continue;
        const other = nodes[j] as ForceSimNode;
        // 方向取「自己→对方」：strength 为负，故把节点推离对方（与 d3 的 `x = quad.x - node.x` 同向）
        const dx = other.x - node.x;
        const dy = other.y - node.y;
        let lengthSquared = dx * dx + dy * dy;
        if (lengthSquared === 0) continue;
        // distanceMin：平方距离低于阈值时按 sqrt(distanceMin²·r²) 钳（d3 同式）
        const length = lengthSquared < distanceMin2 ? Math.sqrt(distanceMin2 * lengthSquared) : lengthSquared;
        const strength = this.forces.repelStrength * alpha / length;
        node.vx += dx * strength;
        node.vy += dy * strength;
      }
    }

    for (const node of nodes) {
      node.vx *= FORCE_SIM_DEFAULTS.velocityDecay;
      node.vy *= FORCE_SIM_DEFAULTS.velocityDecay;
      node.x += node.vx;
      node.y += node.vy;
      // 拖拽钉住：写回 fx/fy 并清零速度（文档 complete() 之后的搬运）
      if (node.fx !== null) {
        node.x = node.fx;
        node.vx = 0;
      }
      if (node.fy !== null) {
        node.y = node.fy;
        node.vy = 0;
      }
    }
  }

  /** alpha 已衰减到 alphaMin 以下 → 布局收敛、worker 可以停 */
  get idle(): boolean {
    return this.alpha <= FORCE_SIM_DEFAULTS.alphaMin;
  }

  /** 连续跑到收敛，返回用掉的 tick 数（文档：0.3 → ≤0.001 约 248 tick） */
  runToIdle(maxTicks = 1000): number {
    let ticks = 0;
    while (!this.idle && ticks < maxTicks) {
      this.tick();
      ticks += 1;
    }
    return ticks;
  }

  positions(): Map<string, { x: number; y: number }> {
    const out = new Map<string, { x: number; y: number }>();
    for (const id of this.order) {
      const node = this.nodes.get(id) as ForceSimNode;
      out.set(id, { x: node.x, y: node.y });
    }
    return out;
  }

  has(id: string): boolean {
    return this.nodes.has(id);
  }

  node(id: string): ForceSimNode | undefined {
    return this.nodes.get(id);
  }
}

/** 布局指标：平均边长与最大半径（文档实测表口径） */
export function layoutMetrics(
  positions: ReadonlyMap<string, { x: number; y: number }>,
  links: ReadonlyArray<[string, string]>,
): { avgEdgeLength: number; maxRadius: number; overlaps: number } {
  let total = 0;
  let counted = 0;
  for (const [sourceId, targetId] of links) {
    const a = positions.get(sourceId);
    const b = positions.get(targetId);
    if (a === undefined || b === undefined) continue;
    total += Math.hypot(a.x - b.x, a.y - b.y);
    counted += 1;
  }
  let maxRadius = 0;
  const points = [...positions.values()];
  for (const point of points) maxRadius = Math.max(maxRadius, Math.hypot(point.x, point.y));
  let overlaps = 0;
  for (let i = 0; i < points.length; i += 1) {
    for (let j = i + 1; j < points.length; j += 1) {
      const a = points[i] as { x: number; y: number };
      const b = points[j] as { x: number; y: number };
      if (Math.hypot(a.x - b.x, a.y - b.y) < 2) overlaps += 1;
    }
  }
  return { avgEdgeLength: counted === 0 ? 0 : total / counted, maxRadius, overlaps };
}

/**
 * D6 ④ 新节点落点：相邻已定位节点质心 + ±√(60·L·60)/2 抖动；无邻居时沿已有最大半径外沿分布。
 * `random` 可注入，便于测试确定性。
 */
export function seedPositions(
  newNodeIds: readonly string[],
  neighbours: ReadonlyMap<string, Iterable<string>>,
  positions: ReadonlyMap<string, { x: number; y: number }>,
  random: () => number = Math.random,
): Map<string, { x: number; y: number }> {
  const seeded = new Map<string, { x: number; y: number }>();
  if (newNodeIds.length === 0) return seeded;
  let squaredMax = 0;
  for (const point of positions.values()) squaredMax = Math.max(squaredMax, point.x * point.x + point.y * point.y);
  const maxRadius = Math.sqrt(squaredMax);
  const L = newNodeIds.length;
  const I = 60 * L * 60;
  const outerBand = Math.sqrt(I / Math.PI + maxRadius * maxRadius) - maxRadius;
  const jitter = Math.sqrt(I);
  for (const id of newNodeIds) {
    const neighboursOfNew = neighbours.get(id) ?? [];
    let sumX = 0;
    let sumY = 0;
    let count = 0;
    for (const other of neighboursOfNew) {
      const point = positions.get(other);
      if (point === undefined) continue;
      sumX += point.x;
      sumY += point.y;
      count += 1;
    }
    if (count > 0) {
      seeded.set(id, {
        x: sumX / count + (random() - 0.5) * jitter,
        y: sumY / count + (random() - 0.5) * jitter,
      });
    } else {
      const angle = 2 * random() * Math.PI;
      const radius = maxRadius + Math.sqrt(random()) * outerBand;
      seeded.set(id, { x: radius * Math.cos(angle), y: radius * Math.sin(angle) });
    }
  }
  return seeded;
}

export interface IncrementalLayout {
  /** 可直接喂给 worker 的 nodes 报文：已存在节点 false，新节点 [x, y] */
  payload: Record<string, false | [number, number]>;
  structural: boolean;
  addedIds: string[];
  removedIds: string[];
  /** 新节点的落点（已写进 payload，单测直接断言用） */
  seeded: Map<string, { x: number; y: number }>;
}

/**
 * D6 setData 差量：已存在节点保持原坐标（候选报文里传 `false`），只给新节点算落点。
 * 只要结构没变（无增删、无新边），`structural=false` → 调用方只重绘，不重新激活布局。
 */
export function diffGraphData(
  previous: {
    ids: readonly string[];
    positions: ReadonlyMap<string, { x: number; y: number }>;
    links: ReadonlyArray<[string, string]>;
  },
  next: {
    ids: readonly string[];
    neighbours: ReadonlyMap<string, Iterable<string>>;
    links: ReadonlyArray<[string, string]>;
  },
  random: () => number = Math.random,
): IncrementalLayout {
  const previousIds = new Set(previous.ids);
  const nextIds = new Set(next.ids);
  const removedIds = previous.ids.filter((id) => !nextIds.has(id));
  const addedIds = next.ids.filter((id) => !previousIds.has(id));

  const seeded = seedPositions(addedIds, next.neighbours, previous.positions, random);

  const payload: Record<string, false | [number, number]> = {};
  for (const id of next.ids) {
    if (previousIds.has(id) && previous.positions.has(id)) payload[id] = false;
  }
  for (const [id, point] of seeded) payload[id] = [point.x, point.y];

  const linkKey = (link: [string, string]): string => `${link[0]}\u0000${link[1]}`;
  const previousLinks = new Set(previous.links.map(linkKey));
  const linksChanged =
    previous.links.length !== next.links.length || next.links.some((link) => !previousLinks.has(linkKey(link)));

  return {
    payload,
    structural: addedIds.length > 0 || removedIds.length > 0 || linksChanged,
    addedIds,
    removedIds,
    seeded,
  };
}
