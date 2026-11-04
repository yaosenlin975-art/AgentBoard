/**
 * CHUNK-RECOVER-W：动态 import 失败（旧页面 + 新 dist，chunk hash 已不存在）的恢复状态。
 *
 * 行为（Vite 官方钩子 `vite:preloadError`）：
 * - 首次失败：写 `sessionStorage['ab:chunk-reload']` 并 `location.reload()` **一次**，让浏览器拿到新 index.html；
 * - 再次失败（标记已在）：**不再刷新**（防刷新循环），只把状态置为 `stale`，由 `ChunkErrorBanner` 提示用户手动刷新；
 * - 局部降级（Markdown 渲染器 / 星图）也调用 `reportChunkError()`：保证「白屏」变成「提示条 + 纯文本兜底」。
 *
 * 纯状态模块（不引 React），入口与组件共用同一份判断；测试可直接调 `handlePreloadError`。
 */

export const CHUNK_RELOAD_KEY = 'ab:chunk-reload';

/** 进程内「已显示提示条」的订阅表（banner 用它重渲染；刷新后自然清空） */
type Listener = () => void;
const listeners = new Set<Listener>();
let stale = false;
/** 测试可注入：不真的 reload，只记录次数 */
let reloadImpl: () => void = () => window.location.reload();

function notify(): void {
  for (const listener of listeners) listener();
}

export function isStale(): boolean {
  return stale;
}

export function subscribeStale(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** 仅供测试：替换 reload 实现并重置内存态 */
export function __setReloadImplForTest(impl: () => void): void {
  reloadImpl = impl;
}

export function __resetChunkRecoveryForTest(): void {
  stale = false;
  listeners.clear();
  reloadImpl = () => window.location.reload();
}

function hasReloadedOnce(): boolean {
  try {
    return sessionStorage.getItem(CHUNK_RELOAD_KEY) === '1';
  } catch {
    return true; // 隐私模式等不可用时不自动刷新，直接提示
  }
}

function markReloaded(): void {
  try {
    sessionStorage.setItem(CHUNK_RELOAD_KEY, '1');
  } catch {
    /* 忽略：不可用时下次仍会尝试，但只在同一会话内，不会无限循环 */
  }
}

/**
 * 全局/局部入口统一调用。
 * @returns `'reloaded'` 表示已自动刷新一次；`'stale'` 表示只提示（不再刷新）
 */
export function handleChunkError(): 'reloaded' | 'stale' {
  if (hasReloadedOnce()) {
    stale = true;
    notify();
    return 'stale';
  }
  markReloaded();
  reloadImpl();
  return 'reloaded';
}

/** `vite:preloadError` 事件的参数（Vite 会在动态 import 失败时派发到 window） */
export interface PreloadErrorEvent {
  preventDefault?: () => void;
  payload?: unknown;
}

/** 全局监听安装（幂等；main.tsx 调用一次） */
export function installChunkErrorRecovery(target: Window = window): () => void {
  const onPreloadError = (event: Event): void => {
    // 阻止 Vite 默认「抛到控制台」的行为：我们自己接管恢复
    (event as PreloadErrorEvent).preventDefault?.();
    handleChunkError();
  };
  target.addEventListener('vite:preloadError', onPreloadError as EventListener);
  return () => target.removeEventListener('vite:preloadError', onPreloadError as EventListener);
}


