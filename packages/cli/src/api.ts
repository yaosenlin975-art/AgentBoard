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

/** CLI-RETRY：连接层错误码（undici 把真实原因包在 cause 链上，外层常是 `TypeError: fetch failed`） */
type ConnErrorCode = 'ECONNREFUSED' | 'ECONNRESET';

function connErrorCode(err: unknown): ConnErrorCode | null {
  let cur: unknown = err;
  for (let depth = 0; depth < 5 && cur; depth += 1) {
    const node = cur as { code?: unknown; cause?: unknown };
    if (node.code === 'ECONNREFUSED' || node.code === 'ECONNRESET') return node.code;
    cur = node.cause;
  }
  return null;
}

/**
 * CR-3：请求统一超时（服务进程存活但卡死：同步 SQLite 长事务、事件循环阻塞等，此前任意命令会无限挂起）。
 * 每次尝试独立计时（signal 在 fetch 调用点创建）；超时不参与 GET 重试，避免总耗时翻倍。
 */
export const REQUEST_TIMEOUT_MS = 15_000;

/** CR-3：识别超时中断——AbortSignal.timeout 的原因是 TimeoutError；旧版 undici 包装为 AbortError；均在 cause 链上 */
function isTimeoutError(err: unknown): boolean {
  let cur: unknown = err;
  for (let depth = 0; depth < 5 && cur; depth += 1) {
    const node = cur as { name?: unknown; cause?: unknown };
    if (node.name === 'TimeoutError' || node.name === 'AbortError') return true;
    cur = node.cause;
  }
  return false;
}

/** CR-3：超时报错文案（含服务地址与「服务无响应」；写请求带幂等重试指引） */
function timeoutError(base: string, method: string, path: string, err: unknown): Error {
  const writeHint = method.toUpperCase() === 'GET' ? '' : `；${WRITE_RETRY_HINT}`;
  return new Error(
    `服务无响应：${method} ${path} 超过 ${REQUEST_TIMEOUT_MS / 1000}s 未完成（${base}），看板服务可能卡死；确认服务状态或用 --server 指定其它地址${writeHint}`,
    { cause: err },
  );
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
  const data = await decodeWithTimeout<T>(base, method, path, response);
  return { data, replayed };
}

/**
 * CLI-RETRY：网络抖动重试与错误分类。
 * 只重试 GET：一次抖动（服务端重启、连接被重置）不该让只读命令直接失败；
 * POST/PATCH/DELETE 一律不自动重试，重试可能重复写（幂等键只兜住带 --request-id 的那部分）。
 * HTTP 4xx/5xx 不在此列——那是服务端明确答复，重试没有意义，原样透出。
 */
export const GET_RETRY_DELAY_MS = 200;

/** 写请求断连后的下一步指引：同一个 request-id 重放才安全 */
export const WRITE_RETRY_HINT = '网络中断；重试请复用 --request-id';

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** 网络层失败 → 四类文案：① ECONNREFUSED=服务端未启动；② 超时中断=服务无响应；③ ECONNRESET=连接被重置；④ 其余按 cause 链透出 */
function networkFailureError(base: string, method: string, path: string, err: unknown): Error {
  const code = connErrorCode(err);
  if (code === 'ECONNREFUSED') return new ServerUnreachableError(base);
  if (isTimeoutError(err)) return timeoutError(base, method, path, err);
  const writeHint = method.toUpperCase() === 'GET' ? '' : `；${WRITE_RETRY_HINT}`;
  if (code === 'ECONNRESET') {
    return new Error(`连接被重置（ECONNRESET，${base}）：服务端可能未启动/网络抖动${writeHint}`, { cause: err });
  }
  if (err instanceof TypeError) {
    return new Error(`看板服务不可达（${base}，用 --server 指定；${rawChainMessages(err)}）${writeHint}`, { cause: err });
  }
  return err instanceof Error ? err : new Error(String(err));
}

/** 发请求；2xx 返回解析后的 JSON（204 → undefined），非 2xx 抛 CliHttpError；GET 遇连接层抖动自动重试一次，写请求不重试。响应带 x-agentboard-version 时与 CLI 版本比对，不匹配 stderr 警告（每进程最多一次）。CR-3：每次尝试统一 15s 超时（REQUEST_TIMEOUT_MS） */
async function fetchResponse(base: string, method: string, path: string, headers?: Record<string, string>, body?: BodyInit): Promise<Response> {
  const retryable = method.toUpperCase() === 'GET';
  for (let attempt = 0; ; attempt += 1) {
    let res: Response;
    try {
      res = await fetch(`${base}${path}`, {
        method,
        headers,
        body,
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (err) {
      if (retryable && attempt === 0 && connErrorCode(err) !== null) {
        await delay(GET_RETRY_DELAY_MS);
        continue;
      }
      throw networkFailureError(base, method, path, err);
    }
    if (attempt > 0) process.stderr.write(`网络抖动：${method} ${path} 连接中断，已重试 1 次后成功\n`);
    warnVersionMismatch(res.headers.get(SERVER_VERSION_HEADER));
    return res;
  }
}

/** CR-3：响应体读取阶段被同一超时 signal 中断（响应头已到、body 卡住）→ 补映射为同一可读文案 */
async function decodeWithTimeout<T>(base: string, method: string, path: string, res: Response): Promise<T> {
  try {
    return await decodeResponse<T>(base, res);
  } catch (err) {
    if (isTimeoutError(err)) throw timeoutError(base, method, path, err);
    throw err;
  }
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
  return decodeWithTimeout<T>(base, method, path, response);
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
  return decodeWithTimeout<T>(base, method, path, response);
}

/**
 * MOJI-GUARD：写入后回读校验。
 * POST/PATCH 返回 2xx 不等于内容按提交原文落库（历史事故：卡面 description 存成 `????` 串），
 * 所以三条文本写入路径（create / update / comment）写成功后必须 GET 读回实际落库文本逐字比对。
 * 失败口径：明确报错 + 回显已写入 id，不自动重试、不自动删除。
 */

interface StoredIssueText {
  title?: string;
  description?: string | null;
}

interface StoredCommentWindow {
  content?: string;
  truncated?: boolean;
}

interface StoredTextCheck {
  /** 字段显示名（标题 / 描述 / 评论内容） */
  field: string;
  /** 本次提交文本 */
  sent: string;
  /** 回读到的落库文本 */
  stored: string;
}

/**
 * 提交文本与落库文本的漂移描述：`''` 表示一致。
 * 字符位置按码位（Array.from）计，与 emoji/中文代理对友好，也和服务端 textWindow 口径一致。
 */
export function describeStoredTextDrift(sent: string, stored: string): string {
  if (sent === stored) return '';
  const mangledRun = (stored.match(/\?{3,}/g) ?? []).find((run) => !sent.includes(run));
  if (mangledRun !== undefined) {
    const at = Array.from(stored.slice(0, stored.indexOf(mangledRun))).length;
    return `落库内容出现连续 ${Array.from(mangledRun).length} 个 ?（第 ${at + 1} 字符起），提交内容无此片段，疑似中文被替换字符吞掉`;
  }
  const sentChars = Array.from(sent);
  const storedChars = Array.from(stored);
  let index = 0;
  while (index < sentChars.length && index < storedChars.length && sentChars[index] === storedChars[index]) index += 1;
  return `落库内容与提交内容不一致（第 ${index + 1} 字符起）`;
}

function assertStoredTexts(target: string, checks: StoredTextCheck[]): void {
  const problems = checks
    .map(({ field, sent, stored }) => {
      const drift = describeStoredTextDrift(sent, stored);
      return drift === '' ? null : `${field}：${drift}`;
    })
    .filter((line): line is string => line !== null);
  if (problems.length === 0) return;
  throw new Error(`写入校验失败：${problems.join('；')}。${target} 已写入但落库内容未确认，未自动重试、未删除，请人工核对`);
}

/** 回读请求本身失败（服务重启、路由缺失等）也要如实报「未确认」，不能静默通过 */
function readbackFailure(err: unknown, target: string): Error {
  const reason = err instanceof Error ? err.message : String(err);
  return new Error(`写入校验失败：回读 ${target} 未成功（${reason}）。内容已写入但未确认，未自动重试、未删除，请人工核对`);
}

/**
 * create / update 写入后回读卡面文本：只比对本次提交过的字段。
 * 标题按服务端 schema 的 `.trim()` 口径先归一，否则尾部空格会被误判成漂移；描述服务端原样存储。
 */
export async function verifyIssueStoredText(
  base: string,
  issueId: string,
  sent: { title?: string; description?: string },
): Promise<void> {
  if (sent.title === undefined && sent.description === undefined) return;
  let stored: StoredIssueText;
  try {
    stored = await request<StoredIssueText>(base, 'GET', `/api/issues/${encodeURIComponent(issueId)}`);
  } catch (err) {
    throw readbackFailure(err, `任务 ${issueId}`);
  }
  assertStoredTexts(`任务 ${issueId}`, [
    ...(sent.title === undefined ? [] : [{ field: '标题', sent: sent.title.trim(), stored: stored.title ?? '' }]),
    ...(sent.description === undefined ? [] : [{ field: '描述', sent: sent.description, stored: stored.description ?? '' }]),
  ]);
}

/** comment 写入后回读该条评论正文（长正文按服务端窗口分页读全） */
export async function verifyCommentStoredText(base: string, issueId: string, commentId: string, sent: string): Promise<void> {
  const pieces: string[] = [];
  const path = `/api/issues/${encodeURIComponent(issueId)}/comments/${encodeURIComponent(commentId)}`;
  let offset = 0;
  try {
    for (;;) {
      // 首窗用服务端默认窗口，只有它报 truncated 才继续翻页
      const window = await request<StoredCommentWindow>(base, 'GET', offset === 0 ? path : `${path}?content_offset_chars=${offset}`);
      const chunk = window.content ?? '';
      pieces.push(chunk);
      // truncated 为真但窗口为空说明服务端口径异常，停住而不是死循环
      if (window.truncated !== true || chunk === '') break;
      offset += Array.from(chunk).length;
    }
  } catch (err) {
    throw readbackFailure(err, `评论 ${commentId}`);
  }
  assertStoredTexts(`评论 ${commentId}`, [{ field: '评论内容', sent, stored: pieces.join('') }]);
}
