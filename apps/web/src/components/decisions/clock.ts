/**
 * DEC-6：秒级时钟（待决策倒计时 / 卡面宽限倒计时共用）。
 *
 * 模块级单例 interval：只有存在订阅者时才启动，最后一个订阅者退订即停止。
 * 用 `useSyncExternalStore` 保证同一帧内所有订阅组件拿到同一个 now。
 */
import { useSyncExternalStore } from 'react';

const listeners = new Set<() => void>();
let timer: ReturnType<typeof setInterval> | null = null;
let nowValue = Date.now();

function tick(): void {
  nowValue = Date.now();
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  if (timer === null) {
    nowValue = Date.now();
    timer = setInterval(tick, 1000);
  }
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0 && timer !== null) {
      clearInterval(timer);
      timer = null;
    }
  };
}

function snapshot(): number {
  return nowValue;
}

/** 订阅秒级时钟；仅在有倒计时需求的组件里调用，避免整页每秒重渲染 */
export function useDecisionClock(): number {
  return useSyncExternalStore(subscribe, snapshot, snapshot);
}
