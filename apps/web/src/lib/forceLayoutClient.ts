/**
 * 布局客户端（KB-GRAPH-P3）：主线程侧负责 D6 差量 + 与 Worker 收发协议。
 * - 有 Worker 就走 Worker（真浏览器）；jsdom / 不支持时退回同线程 tick（结果一致，只是阻塞）。
 * - 结构变化才发 `alpha: .3, run: true`；仅样式变化直接回调，不重新激活布局。
 */
import {
  FORCE_SIM_DEFAULTS,
  ForceSimulation,
  diffGraphData,
  type SimMessage,
} from './forceLayout';

export interface LayoutGraph {
  ids: readonly string[];
  /** 邻接表（`buildAdjacency` 返回的 Set 集合） */
  neighbours: ReadonlyMap<string, ReadonlySet<string>>;
  links: ReadonlyArray<[string, string]>;
}

export interface ApplyResult {
  structural: boolean;
  added: string[];
  removed: string[];
  seeded: Map<string, { x: number; y: number }>;
  /** 立刻可上屏的位置：已存在节点保持原坐标 + 新节点落点（等 tick 回传再覆盖） */
  positions: Map<string, { x: number; y: number }>;
}

export interface ForceLayoutClientOptions {
  /** 返回 null 表示用同线程实现（jsdom / 无 Worker 环境） */
  workerFactory?: () => Worker | null;
  onPositions: (positions: Map<string, { x: number; y: number }>) => void;
  onIdle?: () => void;
  /** 同线程实现每个 tick 之间的让出点（测试里注入空实现即可同步跑） */
  scheduler?: (run: () => void) => void;
}

export interface ForceLayoutClient {
  apply(graph: LayoutGraph, initialPositions: ReadonlyMap<string, { x: number; y: number }>): ApplyResult;
  /** 当前是否还有 tick 在跑 */
  running(): boolean;
  stop(): void;
  destroy(): void;
  /** 测试/诊断用：累计 tick 数（Worker 与同线程都用它） */
  ticks(): number;
}

/** 默认让出点：macrotask，避免卡住主线程 */
const defaultScheduler = (run: () => void): void => {
  setTimeout(run, FORCE_SIM_DEFAULTS.tickMs);
};

export function createForceLayoutClient(options: ForceLayoutClientOptions): ForceLayoutClient {
  const worker = options.workerFactory?.() ?? null;
  const sim = new ForceSimulation();
  const scheduler = options.scheduler ?? defaultScheduler;
  let previous: {
    ids: readonly string[];
    positions: ReadonlyMap<string, { x: number; y: number }>;
    links: ReadonlyArray<[string, string]>;
  } = { ids: [], positions: new Map(), links: [] };
  let running = false;
  let tickCount = 0;
  let destroyed = false;

  // 每 N 个 tick 才推一次位置（248 tick 全推会给 React 造成 248 次渲染）；收敛时强制推一次
  const EMIT_EVERY = 4;
  const emit = (positions: Map<string, { x: number; y: number }>, force = false): void => {
    if (destroyed) return;
    if (!force && tickCount % EMIT_EVERY !== 0) return;
    options.onPositions(positions);
  };

  const runInlineTick = (): void => {
    if (destroyed) return;
    if (sim.idle) {
      running = false;
      options.onIdle?.();
      return;
    }
    sim.tick();
    tickCount += 1;
    emit(sim.positions());
    if (sim.idle) {
      running = false;
      emit(sim.positions(), true);
      options.onIdle?.();
      return;
    }
    scheduler(runInlineTick);
  };

  if (worker !== null) {
    worker.onmessage = (event: MessageEvent<{ positions: Array<[string, number, number]>; alpha: number; idle: boolean; ticks: number }>) => {
      const data = event.data;
      if (data === undefined || data === null) return;
      const positions = new Map<string, { x: number; y: number }>();
      for (const [id, x, y] of data.positions) positions.set(id, { x, y });
      tickCount = data.ticks;
      emit(positions, data.idle);
      if (data.idle) {
        running = false;
        options.onIdle?.();
      }
    };
  }

  return {
    apply(graph, initialPositions) {
      // 第一次拿到数据：没有历史位置，用调用方给的初始布局（复用既有自研力学成果）
      const isFirst = previous.ids.length === 0;
      const base = isFirst ? initialPositions : previous.positions;
      const result = isFirst
        ? {
            payload: Object.fromEntries([...initialPositions].map(([id, point]) => [id, [point.x, point.y] as [number, number]])),
            structural: true,
            addedIds: [...graph.ids],
            removedIds: [] as string[],
            seeded: new Map(initialPositions),
          }
        : diffGraphData(previous, graph);

      const message: SimMessage = {
        nodes: result.payload,
        links: [...graph.links].map(([source, target]) => [source, target] as [string, string]),
        // 只有结构变化才重新激活布局
        ...(result.structural ? { alpha: FORCE_SIM_DEFAULTS.alphaInitial, run: true } : {}),
      };

      if (result.structural) {
        tickCount = 0;
        running = true;
      }

      if (worker !== null) {
        worker.postMessage(message);
      } else {
        sim.ingest(message);
        if (result.structural) scheduler(runInlineTick);
      }

      // 记录基线：结构变化后位置以「保持原坐标 + 新节点落点」为准，等 tick 回传再覆盖
      const merged = new Map(base);
      for (const [id, point] of result.seeded) merged.set(id, point);
      for (const id of [...merged.keys()]) if (!graph.ids.includes(id)) merged.delete(id);
      previous = { ids: [...graph.ids], positions: merged, links: [...graph.links] };

      return {
        structural: result.structural,
        added: [...result.addedIds],
        removed: [...result.removedIds],
        seeded: result.seeded,
        positions: merged,
      };
    },
    running: () => running,
    ticks: () => tickCount,
    stop() {
      running = false;
      if (worker !== null) worker.postMessage({ alphaTarget: 0, alpha: 0 });
    },
    destroy() {
      destroyed = true;
      running = false;
      worker?.terminate();
    },
  };
}
