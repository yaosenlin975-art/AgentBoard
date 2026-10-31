/** Task 10：kb CLI 的 HTTP 封装（全局 fetch，Node ≥20 内置；基址解析 --server > KB_SERVER > 默认）。 */

export const DEFAULT_BASE = 'http://127.0.0.1:8787';

/** 服务返回非 2xx（统一体 {error:{code,message}}）时抛出 */
export class CliHttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'CliHttpError';
  }
}

/** 连接拒绝：看板服务未启动 */
export class ServerUnreachableError extends Error {
  constructor(readonly base: string) {
    super(unreachableMessage(base));
    this.name = 'ServerUnreachableError';
  }
}

export function unreachableMessage(base: string): string {
  return base === DEFAULT_BASE
    ? `看板服务未启动（默认 ${DEFAULT_BASE}，用 --server 指定）`
    : `看板服务未启动（${base}，用 --server 指定）`;
}

/** 去尾部斜杠；空值回默认基址 */
export function normalizeBase(raw: string | undefined): string {
  return (raw ?? DEFAULT_BASE).trim().replace(/\/+$/, '');
}

/** fetch failed 的 cause 链上找 ECONNREFUSED（undici 包一层 TypeError） */
function isConnRefused(err: unknown): boolean {
  let cur: unknown = err;
  for (let depth = 0; depth < 5 && cur; depth += 1) {
    const node = cur as { code?: unknown; cause?: unknown };
    if (node.code === 'ECONNREFUSED') return true;
    cur = node.cause;
  }
  return false;
}

/** fetch 抛错的原始信息：cause 链各层 message 去重拼接（undici 外层常为 "fetch failed"，真实原因在 cause） */
function rawChainMessages(err: unknown): string {
  const messages: string[] = [];
  let cur: unknown = err;
  for (let depth = 0; depth < 5 && cur; depth += 1) {
    const node = cur as { message?: unknown; cause?: unknown };
    if (typeof node.message === 'string' && node.message !== '' && !messages.includes(node.message)) {
      messages.push(node.message);
    }
    cur = node.cause;
  }
  return messages.length > 0 ? messages.join(' -> ') : String(err);
}

/** 发请求；2xx 返回解析后的 JSON（204 → undefined），非 2xx 抛 CliHttpError，连接拒绝抛 ServerUnreachableError，其余网络层失败包装为看板服务不可达（含原始 message） */
export async function request<T>(
  base: string,
  method: string,
  path: string,
  body?: unknown,
): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${base}${path}`, {
      method,
      headers: body === undefined ? undefined : { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch (err) {
    if (isConnRefused(err)) throw new ServerUnreachableError(base);
    if (!(err instanceof TypeError)) throw err;
    throw new Error(`看板服务不可达（${base}，用 --server 指定；${rawChainMessages(err)}）`, {
      cause: err,
    });
  }
  if (res.status === 204) return undefined as T;
  const text = await res.text();
  let data: unknown;
  try {
    data = text === '' ? undefined : JSON.parse(text);
  } catch {
    data = text;
  }
  if (!res.ok) {
    const payload = data as { error?: { code?: unknown; message?: unknown } } | undefined;
    const code = typeof payload?.error?.code === 'string' ? payload.error.code : 'UNKNOWN';
    const message =
      typeof payload?.error?.message === 'string'
        ? payload.error.message
        : typeof data === 'string' && data !== ''
          ? data
          : res.statusText;
    throw new CliHttpError(res.status, code, message);
  }
  return data as T;
}
