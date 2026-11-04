/** Task 10：kb CLI 的 HTTP 封装（全局 fetch，Node ≥20 内置；基址解析 --server > KB_SERVER > 默认）。 */
import { CLI_VERSION } from './version.js';

export const DEFAULT_BASE = 'http://127.0.0.1:8787';

/** 服务端版本响应头名（Docs/api.md） */
export const SERVER_VERSION_HEADER = 'x-agentboard-version';

/** 服务返回非 2xx（统一体 {error:{code,message}}）时抛出 */
export class CliHttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    /** CLI-04：服务端 error.details（如 resolve 的 candidates），供 --json 错误体透出 */
    readonly details?: unknown,
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

/** 启动指引（单行，仓库根目录执行） */
export const SERVER_START_HINT =
  '启动：pnpm --filter @agentboard/server start（需先 pnpm -r build；或 node apps/server/dist/index.js）';

/** 401 且非默认基址：该端口疑似 DSH web server，非 AgentBoard（默认基址的 401 是真鉴权问题，不加） */
export const DSH_SERVER_HINT =
  '该端口可能是 DSH web server（需 DSH_TASK_BOARD_PROXY_TOKEN），不是 AgentBoard 服务；AgentBoard 默认 http://127.0.0.1:8787';

export function unreachableMessage(base: string): string {
  const head =
    base === DEFAULT_BASE
      ? `看板服务未启动（默认 ${DEFAULT_BASE}，用 --server 指定）`
      : `看板服务未启动（${base}，用 --server 指定）`;
  return `${head}\n${SERVER_START_HINT}`;
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

/** semver 三段解析（允许后缀）；无法解析返回 null */
function parseSemver(raw: string): [number, number, number] | null {
  const m = /^(\d+)\.(\d+)\.(\d+)/.exec(raw.trim());
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

/** 不匹配判定：未上报/无法解析、major 不同、同 major=0 而 minor 不同（0.x 期间 minor 即破坏性变更）；patch 差异不匹配不告警 */
export function versionMismatch(cliVersion: string, serverVersion: string | null): boolean {
  if (serverVersion === null || serverVersion.trim() === '') return true;
  const cli = parseSemver(cliVersion);
  const srv = parseSemver(serverVersion);
  if (!cli || !srv) return true;
  if (cli[0] !== srv[0]) return true;
  if (cli[0] === 0 && cli[1] !== srv[1]) return true;
  return false;
}

/** 版本警告标志（每进程最多一次；测试用 resetVersionWarned 复位） */
let versionWarned = false;

/** 测试复位版本警告标志 */
export function resetVersionWarned(): void {
  versionWarned = false;
}

/** 版本不匹配 → stderr 一行警告，仅警告不阻断（--json 模式不污染 stdout） */
function warnVersionMismatch(serverHeader: string | null): void {
  if (versionWarned || !versionMismatch(CLI_VERSION, serverHeader)) return;
  versionWarned = true;
  const serverText =
    serverHeader === null || serverHeader.trim() === '' ? '服务端未上报版本' : `服务端 ${serverHeader.trim()}`;
  process.stderr.write(`版本不匹配：CLI ${CLI_VERSION} / ${serverText}，可能出现字段不兼容\n`);
}

/** KB-CLI-1：幂等重放标记响应头（服务端命中 idempotency_record 时置 1） */
export const REPLAYED_HEADER = 'x-agentboard-replayed';

/** KB-CLI-1：带元数据的请求——replayed=true 表示该 request-id 命中幂等缓存（服务端原样回放） */
export async function requestWithMeta<T>(
  base: string,
  method: string,
  path: string,
  body?: unknown,
  requestId?: string,
): Promise<{ data: T; replayed: boolean }> {
  const headers = body === undefined && requestId === undefined ? undefined : {
    ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    ...(requestId === undefined ? {} : { 'Idempotency-Key': requestId }),
  };
  const response = await fetchResponse(base, method, path, headers, body === undefined ? undefined : JSON.stringify(body));
  const replayed = response.headers.get(REPLAYED_HEADER) === '1';
  const data = await decodeResponse<T>(base, response);
  return { data, replayed };
}

/** 发请求；2xx 返回解析后的 JSON（204 → undefined），非 2xx 抛 CliHttpError，连接拒绝抛 ServerUnreachableError，其余网络层失败包装为看板服务不可达（含原始 message）。响应带 x-agentboard-version 时与 CLI 版本比对，不匹配 stderr 警告（每进程最多一次） */
async function fetchResponse(base: string, method: string, path: string, headers?: Record<string, string>, body?: BodyInit): Promise<Response> {
  let res: Response;
  try {
    res = await fetch(`${base}${path}`, {
      method,
      headers,
      body,
    });
  } catch (err) {
    if (isConnRefused(err)) throw new ServerUnreachableError(base);
    if (!(err instanceof TypeError)) throw err;
    throw new Error(`看板服务不可达（${base}，用 --server 指定；${rawChainMessages(err)}）`, {
      cause: err,
    });
  }
  warnVersionMismatch(res.headers.get(SERVER_VERSION_HEADER));
  return res;
}

async function decodeResponse<T>(base: string, res: Response): Promise<T> {
  if (res.status === 204) return undefined as T;
  const text = await res.text();
  let data: unknown;
  try {
    data = text === '' ? undefined : JSON.parse(text);
  } catch {
    data = text;
  }
  if (!res.ok) {
    const payload = data as { error?: { code?: unknown; message?: unknown; details?: unknown } } | undefined;
    const code = typeof payload?.error?.code === 'string' ? payload.error.code : 'UNKNOWN';
    const details = payload?.error?.details;
    let message =
      typeof payload?.error?.message === 'string'
        ? payload.error.message
        : typeof data === 'string' && data !== ''
          ? data
          : res.statusText;
    if (res.status === 401 && base !== DEFAULT_BASE) message = `${message}\n${DSH_SERVER_HINT}`;
    throw new CliHttpError(res.status, code, message, details);
  }
  return data as T;
}

export async function request<T>(
  base: string,
  method: string,
  path: string,
  body?: unknown,
  requestId?: string,
): Promise<T> {
  const headers = body === undefined && requestId === undefined ? undefined : {
    ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    ...(requestId === undefined ? {} : { 'Idempotency-Key': requestId }),
  };
  const response = await fetchResponse(base, method, path, headers, body === undefined ? undefined : JSON.stringify(body));
  return decodeResponse<T>(base, response);
}

export async function requestBinary<T>(
  base: string,
  method: string,
  path: string,
  body: Uint8Array,
  mimeType: string,
  fileName: string,
): Promise<T> {
  const bodyBuffer = new ArrayBuffer(body.byteLength);
  new Uint8Array(bodyBuffer).set(body);
  const response = await fetchResponse(base, method, path, {
    'content-type': mimeType,
    'x-file-name': fileName,
  }, bodyBuffer);
  return decodeResponse<T>(base, response);
}
