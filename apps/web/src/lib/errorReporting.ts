/**
 * G5：客户端错误上报接线（把 G3 的环形缓冲接到 G4 的 `POST /api/client-diagnostics`）。
 *
 * 四个必须守住的点：
 * 1. **不在异常路径里发请求**：`pushClientError` 只把条目交给 sink，真正的上报推迟到
 *    `queueMicrotask` —— 渲染期抛错时同一次 tick 里再抛异常的风险最高。
 * 2. **指纹去重**：白屏往往是同一处代码反复抛同一个错，`message + stack` 相同只报一次。
 * 3. **失败静默**：网络错误 / 429 / 5xx 都不重试、不抛、不再入缓冲，更不弹提示。
 * 4. **可关闭**：`localStorage['ab.diagnostics.disabled'] = '1'` 时一个请求都不发（用户排障用）。
 *
 * `navigator.sendBeacon` 用于页面正在卸载的场景（不阻塞卸载），其余走 `fetch keepalive`。
 */
import { pushClientErrorSilently, setClientErrorSink, CLIENT_ERROR_CAPACITY, type ClientErrorEntry } from './errorBuffer';
import { api } from '../api/client';

export const DIAGNOSTICS_DISABLED_KEY = 'ab.diagnostics.disabled';
export const DIAGNOSTICS_ENDPOINT = '/api/client-diagnostics';
/** 单批上限：一次崩溃常带几十条，全发会被服务端限流，且没有额外价值 */
export const REPORT_BATCH_LIMIT = 10;
/** 单条 message / stack 上限，与服务端 zod 契约一致（超出会被 400 丢掉整条） */
const MESSAGE_LIMIT = 2000;
const STACK_LIMIT = 20_000;
const SOURCE_LIMIT = 500;
const URL_LIMIT = 2000;
const UA_LIMIT = 500;

export interface DiagnosticPayload {
  instance_id: string;
  kind: ClientErrorEntry['kind'];
  message: string;
  /** 契约允许缺省；有 stack 才带，避免 .strict() 之外的多余空串 */
  stack?: string;
  source?: string;
  url?: string;
  user_agent?: string;
  client_ts: number;
  app_version?: string;
  context?: Record<string, string>;
}

function clip(value: string, limit: number): string {
  return value.length > limit ? value.slice(0, limit) : value;
}

export function isDiagnosticsDisabled(): boolean {
  if (typeof localStorage === 'undefined') return false;
  try {
    return localStorage.getItem(DIAGNOSTICS_DISABLED_KEY) === '1';
  } catch {
    // 隐私模式读不到 localStorage：按「未关闭」处理，但上报失败也会静默
    return false;
  }
}

/** 指纹：message + stack（同一条错误在不同时间点重复出现时栈通常一致） */
export function errorFingerprint(entry: ClientErrorEntry): string {
  return `${entry.message}\u0000${entry.stack}`;
}

/** 把缓冲条目转成上报体；`instanceId` 必须非空（服务端 `.trim().min(1)`） */
export function toPayload(entry: ClientErrorEntry, instanceId: string, appVersion?: string): DiagnosticPayload {
  const payload: DiagnosticPayload = {
    instance_id: clip(instanceId, 200),
    kind: entry.kind,
    message: clip(entry.message, MESSAGE_LIMIT),
    client_ts: entry.ts,
  };
  if (entry.stack !== '') payload.stack = clip(entry.stack, STACK_LIMIT);
  if (entry.source !== undefined && entry.source !== '') payload.source = clip(entry.source, SOURCE_LIMIT);
  if (entry.url !== '') payload.url = clip(entry.url, URL_LIMIT);
  const ua = typeof navigator === 'undefined' ? '' : navigator.userAgent;
  if (ua !== '') payload.user_agent = clip(ua, UA_LIMIT);
  if (appVersion !== undefined && appVersion !== '') payload.app_version = clip(appVersion, 100);
  return payload;
}

export interface ErrorReporterOptions {
  /** 取服务端 instance_id；返回空串表示拿不到（本次不发） */
  resolveInstanceId: () => Promise<string>;
  /** 覆盖发送实现（测试与 beacon 场景注入） */
  send?: (payload: DiagnosticPayload, unloading: boolean) => Promise<boolean>;
  /** 覆盖「是否已关闭」（测试用） */
  isDisabled?: () => boolean;
  appVersion?: string;
}

export interface ErrorReporter {
  /** 挂到 errorBuffer 的 sink 上 */
  handle: (entry: ClientErrorEntry) => void;
  /** 手动冲刷（测试用；正常流程靠微任务） */
  flush: () => Promise<void>;
  /** 已上报过的指纹数（测试断言去重） */
  reportedCount: () => number;
  /** 卸载/复位 */
  dispose: () => void;
}

/** 页面是否正在卸载（此状态下改走 sendBeacon） */
let unloading = false;

function defaultSend(payload: DiagnosticPayload, unloadingNow: boolean): Promise<boolean> {
  const body = JSON.stringify(payload);
  // 页面卸载途中：sendBeacon 不阻塞卸载，且不受 keepalive 配额限制
  if (unloadingNow && typeof navigator !== 'undefined' && typeof navigator.sendBeacon === 'function') {
    try {
      const queued = navigator.sendBeacon(DIAGNOSTICS_ENDPOINT, new Blob([body], { type: 'application/json' }));
      return Promise.resolve(queued);
    } catch {
      return Promise.resolve(false);
    }
  }
  try {
    return fetch(DIAGNOSTICS_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
      keepalive: true,
    }).then((response) => response.ok, () => false);
  } catch {
    return Promise.resolve(false);
  }
}

export function createErrorReporter(options: ErrorReporterOptions): ErrorReporter {
  const send = options.send ?? defaultSend;
  const isDisabled = options.isDisabled ?? isDiagnosticsDisabled;
  const appVersion = options.appVersion;
  let instancePromise: Promise<string> | null = null;
  /** 已上报过的指纹（每个 reporter 一份；`installErrorReporting` 每个进程只调一次） */
  const reportedFingerprints = new Set<string>();
  /** 待发队列：微任务里统一冲刷，避免一次崩溃触发 N 个请求 */
  let pending: ClientErrorEntry[] = [];
  let scheduled = false;

  const resolveInstance = (): Promise<string> => {
    if (instancePromise === null) {
      instancePromise = options.resolveInstanceId().catch(() => '');
    }
    return instancePromise;
  };

  const flush = async (): Promise<void> => {
    scheduled = false;
    const batch = pending;
    pending = [];
    if (batch.length === 0) return;
    if (isDisabled()) return;
    // 同批内按指纹再去一次（同一条错误在微任务入队前可能来两次）
    const unique: ClientErrorEntry[] = [];
    for (const entry of batch) {
      const fingerprint = errorFingerprint(entry);
      if (reportedFingerprints.has(fingerprint)) continue;
      reportedFingerprints.add(fingerprint);
      unique.push(entry);
    }
    if (unique.length === 0) return;
    const instanceId = await resolveInstance();
    if (instanceId === '') {
      // 拿不到 instance_id：不重试、不记缓冲（服务端必然 400）
      return;
    }
    const accepted = unique.slice(0, REPORT_BATCH_LIMIT);
    const dropped = unique.length - accepted.length;
    for (const entry of accepted) {
      try {
        await send(toPayload(entry, instanceId, appVersion), unloading);
      } catch {
        /* 上报失败静默丢弃：不重试、不抛、不回流缓冲 */
      }
    }
    if (dropped > 0) {
      // 只写本地缓冲、不再通知上报器（否则「丢弃记录」自己又会被上报，形成自激）
      pushClientErrorSilently({
        kind: 'error',
        message: `${dropped} 条客户端错误因超出单批上限 ${REPORT_BATCH_LIMIT} 未上报`,
        stack: '',
        source: 'diagnostics-reporter',
      });
    }
  };

  const schedule = (): void => {
    if (scheduled) return;
    scheduled = true;
    // 延后到微任务：不在抛异常的调用栈里做 IO
    if (typeof queueMicrotask === 'function') queueMicrotask(() => void flush());
    else setTimeout(() => void flush(), 0);
  };

  const handle = (entry: ClientErrorEntry): void => {
    pending.push(entry);
    schedule();
  };

  return {
    handle,
    flush,
    reportedCount: () => reportedFingerprints.size,
    dispose: () => {
      pending = [];
      scheduled = false;
      reportedFingerprints.clear();
      instancePromise = null;
    },
  };
}

export function installErrorReporting(options: ErrorReporterOptions): ErrorReporter {
  const reporter = createErrorReporter(options);
  setClientErrorSink(reporter.handle);

  // 页面卸载途中改用 sendBeacon：此时 fetch 可能被取消
  const markUnloading = (): void => {
    unloading = true;
  };
  window.addEventListener('pagehide', markUnloading);
  window.addEventListener('beforeunload', markUnloading);

  return reporter;
}

/** instance_id 来源：`GET /api/version`（进程生命周期内不变，缓存一次） */
export async function fetchInstanceId(): Promise<string> {
  try {
    const version = await api.get<{ instance_id?: string }>('/api/version');
    return typeof version.instance_id === 'string' ? version.instance_id : '';
  } catch {
    return '';
  }
}

/** 测试与排障用：可读的容量常量导出（避免测试另算一份） */
export const DIAGNOSTICS_LIMITS = {
  capacity: CLIENT_ERROR_CAPACITY,
  batch: REPORT_BATCH_LIMIT,
} as const;
