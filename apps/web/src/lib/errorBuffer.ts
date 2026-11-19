/**
 * G3：客户端错误环形缓冲。
 *
 * 白屏（render 期未捕获异常）时整棵树会被 React 卸载，用户无法从界面拿到任何线索。
 * 这里把「界面级异常 / 全局 error / unhandledrejection」记到模块内环形缓冲，
 * 兜底 UI 的「复制错误信息」直接读它 —— 即使网络上报（G4/G5）没做也有完整上下文。
 *
 * 只记录，不联网。容量固定 20 条，满了丢最旧的。
 */

export type ClientErrorKind = 'error' | 'rejection' | 'react';

export interface ClientErrorEntry {
  /** 采集时刻 epoch 毫秒 */
  ts: number;
  kind: ClientErrorKind;
  message: string;
  stack: string;
  source?: string;
  /** 触发页面的 URL（Navigation Timing 之外的最省事来源） */
  url: string;
}

export const CLIENT_ERROR_CAPACITY = 20;

const entries: ClientErrorEntry[] = [];

/**
 * G5：上报接收方。由 `lib/errorReporting.ts` 在启动时注入，
 * 缓冲本身不联网——这样异常路径里不会因为 import 循环或网络逻辑再抛一次。
 */
export type ClientErrorSink = (entry: ClientErrorEntry) => void;
let sink: ClientErrorSink | null = null;

export function setClientErrorSink(next: ClientErrorSink | null): void {
  sink = next;
}

function currentUrl(): string {
  try {
    return typeof window === 'undefined' ? '' : window.location.href;
  } catch {
    return '';
  }
}

function toText(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value instanceof Error) return value.message;
  if (value === undefined || value === null) return '';
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

export interface PushClientErrorInput {
  kind: ClientErrorKind;
  message: unknown;
  stack?: unknown;
  source?: string;
}

/** 写入一条；返回写入的条目（调用方只读用，不要改它） */
export function pushClientError(input: PushClientErrorInput): ClientErrorEntry {
  const entry = appendClientError(input);
  // G5：交给上报器（延后到微任务，不在这里发请求）；上报器自身的异常不影响记录
  try {
    sink?.(entry);
  } catch {
    /* 上报器不该抛，真抛了也不能污染缓冲 */
  }
  return entry;
}

/**
 * 只写缓冲、**不通知上报器**。
 * 上报器自己产生的记录（如「丢弃 N 条」）必须走这里，否则会自激上报。
 */
export function pushClientErrorSilently(input: PushClientErrorInput): ClientErrorEntry {
  return appendClientError(input);
}

function appendClientError(input: PushClientErrorInput): ClientErrorEntry {
  const entry: ClientErrorEntry = {
    ts: Date.now(),
    kind: input.kind,
    message: toText(input.message),
    stack: toText(input.stack),
    url: currentUrl(),
    ...(input.source === undefined ? {} : { source: input.source }),
  };
  entries.push(entry);
  if (entries.length > CLIENT_ERROR_CAPACITY) entries.splice(0, entries.length - CLIENT_ERROR_CAPACITY);
  return entry;
}

/** 按时间升序的快照副本（调用方可安全排序/序列化） */
export function getClientErrors(): ClientErrorEntry[] {
  return entries.map((entry) => ({ ...entry }));
}

export function clearClientErrors(): void {
  entries.length = 0;
}

/** 「复制错误信息」用：单条错误的可读文本 */
export function formatClientError(entry: ClientErrorEntry): string {
  const head = `[${new Date(entry.ts).toISOString()}] ${entry.kind}${entry.source ? ` (${entry.source})` : ''}: ${entry.message}`;
  return entry.stack === '' ? `${head}\n${entry.url}` : `${head}\n${entry.stack}\n${entry.url}`;
}

/** 「复制错误信息」用：整段缓冲 + 环境（用户贴给开发者就够定位） */
export function formatClientErrorReport(primary?: ClientErrorEntry | null): string {
  const lines: string[] = [];
  if (primary !== undefined && primary !== null) {
    lines.push('== 本次错误 ==', formatClientError(primary), '');
  }
  const all = getClientErrors();
  lines.push(`== 最近 ${all.length} 条客户端错误（容量 ${CLIENT_ERROR_CAPACITY}）==`);
  if (all.length === 0) lines.push('（无）');
  for (const entry of all) lines.push(formatClientError(entry), '');
  lines.push(`url: ${currentUrl()}`);
  try {
    lines.push(`ua: ${typeof navigator === 'undefined' ? '' : navigator.userAgent}`);
  } catch {
    /* navigator 不可用时略过 */
  }
  try {
    lines.push(`viewport: ${window.innerWidth}x${window.innerHeight}`);
  } catch {
    /* 同上 */
  }
  return lines.join('\n');
}

/**
 * 挂全局钩子（`error` + `unhandledrejection`），只记录到环形缓冲。
 *
 * 刻意不联网：网络上报是 G4/G5 的事，异常路径里发请求有再抛一次的风险。
 * 返回卸载函数，便于测试与热更新时复位。
 */
export function installClientErrorHooks(target: Window = window): () => void {
  const onError = (event: ErrorEvent): void => {
    const element = event.target;
    pushClientError({
      kind: 'error',
      message: event.error instanceof Error ? event.error.message : event.message || '资源加载失败',
      stack: event.error instanceof Error ? (event.error.stack ?? '') : '',
      source:
        element instanceof HTMLElement
          ? `${element.tagName.toLowerCase()}:${(element as HTMLImageElement).src ?? ''}`
          : 'window.error',
    });
  };
  const onRejection = (event: PromiseRejectionEvent): void => {
    const reason: unknown = event.reason;
    pushClientError({
      kind: 'rejection',
      message: reason instanceof Error ? reason.message : toText(reason),
      stack: reason instanceof Error ? (reason.stack ?? '') : '',
      source: 'window.unhandledrejection',
    });
  };
  target.addEventListener('error', onError);
  target.addEventListener('unhandledrejection', onRejection);
  return () => {
    target.removeEventListener('error', onError);
    target.removeEventListener('unhandledrejection', onRejection);
  };
}
