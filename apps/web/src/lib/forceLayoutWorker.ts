/**
 * 布局 Worker（KB-GRAPH-P3）：照文档 sim.js 的消息协议与 tick 节奏跑 `ForceSimulation`。
 * - tick 用 setTimeout(…, 1000/60)，不是 rAF；
 * - alpha 衰减到 alphaMin 后不再排 tick（worker 空闲）；
 * - 回传 { positions, alpha, idle }，主线程只更新坐标，不重建对象。
 */
import { FORCE_SIM_DEFAULTS, ForceSimulation, type SimMessage } from './forceLayout';

export interface WorkerTickPayload {
  positions: Array<[string, number, number]>;
  alpha: number;
  idle: boolean;
  ticks: number;
}

const sim = new ForceSimulation();
let timer: ReturnType<typeof setTimeout> | null = null;
let ticks = 0;

function post(): void {
  const payload: WorkerTickPayload = {
    positions: [...sim.positions()].map(([id, point]) => [id, point.x, point.y]),
    alpha: sim.alpha,
    idle: sim.idle,
    ticks,
  };
  (self as unknown as { postMessage: (value: WorkerTickPayload) => void }).postMessage(payload);
}

function schedule(): void {
  if (timer !== null || sim.idle) return;
  timer = setTimeout(runTick, FORCE_SIM_DEFAULTS.tickMs);
}

function runTick(): void {
  timer = null;
  if (sim.idle) {
    post();
    return;
  }
  sim.tick();
  ticks += 1;
  post();
  schedule();
}

self.onmessage = (event: MessageEvent<SimMessage>): void => {
  const message = event.data ?? {};
  const result = sim.ingest(message);
  if (result.structural || message.run === true) {
    ticks = 0;
    schedule();
  }
  post();
};
