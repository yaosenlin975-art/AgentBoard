/**
 * VOICE-1/VOICE-5：本地语音模型的下载与管理（服务层）。
 *
 * 口径（Docs/designs/ui/2026-11-03-local-voice-input.md §服务端-模型管理；VOICE-5 决策=方案 A）：
 * - 目录 `dirname(db)/models/<model-id>/`（与 DOCKER-2 派生约定一致：容器只挂 /data）；
 * - **按文件下载**（HuggingFace `resolve` 直链），每个文件先写 `<file>.part` 再原子改名；
 * - 每个文件独立校验：有上游 sha256 的按 sha256 校验；`tokens.txt` 这类上游只发 git blob 的文件
 *   做**弱校验**（字节数相等 + 内容非空 + 首行含空格或 `<`），代码与 Docs/api.md 都标明这是弱校验；
 * - 任一文件校验失败 → 删掉该文件的半成品（保留其它已成功文件，重下时只补失败的那个）；
 * - 全部必需文件齐全且校验通过才标 `downloaded`；缺任一 → `VOICE_MODEL_INCOMPLETE`；
 * - 进度按**总字节数聚合**（各文件 size 之和），并给出 `current_file`；
 * - **绝不自动下载**：只有显式 `POST .../download` 才会发起网络请求；同 id 重复调用幂等复用进行中的任务；
 * - 下载中的模型删除 → 409 `VOICE_MODEL_BUSY`；磁盘空间不足 → `VOICE_NO_SPACE`（预检，不发请求）。
 *
 * 不下载 tar.bz2：上游归档 `digest` 为 null（无 sha256），而 HF 每个文件都有 LFS sha256，校验强度更高。
 */
import { ensureProxyEnv, resolveProxyEnv } from '@agentboard/shared';
import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { statfs } from 'node:fs/promises';
import { dirname, join, sep } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { Db } from '../db/connection.js';
import { ApiError, NotFoundError } from '../errors.js';
import { VOICE_MODEL_CATALOG, type VoiceModelCatalogEntry, type VoiceModelFile } from '@agentboard/shared';

export type VoiceModelState = 'not_downloaded' | 'downloading' | 'verifying' | 'downloaded' | 'failed';

export interface VoiceModelStatus {
  id: string;
  name: string;
  languages: readonly string[];
  streaming: boolean;
  note: string;
  dir: string;
  /** 各必需文件字节数之和（真实值，非估算） */
  bytes_total: number;
  state: VoiceModelState;
  downloaded_bytes: number;
  /** 已落盘且校验通过的必需文件 */
  present_files: string[];
  /** 缺少或校验不通过的必需文件 */
  missing_files: string[];
  sha256_verified: boolean | null;
  error: string | null;
  error_message: string | null;
}

export interface VoiceProgressSnapshot {
  model_id: string;
  task_id: string | null;
  state: VoiceModelState;
  bytes: number;
  total: number;
  /** 当前正在下载的文件（相对模型目录） */
  current_file: string | null;
  error: string | null;
  error_message: string | null;
}

export interface VoiceDownloadAccepted {
  model_id: string;
  task_id: string;
  /** true = 复用进行中的任务（幂等） */
  reused: boolean;
  state: VoiceModelState;
}

export interface VoiceModelDeps {
  catalog?: readonly VoiceModelCatalogEntry[];
  rootDir?: string;
  fetchImpl?: typeof fetch;
  freeBytes?: (dir: string) => Promise<number | null>;
  spaceMargin?: number;
  /** 无 sha256 文件的弱校验开关（缺省开；测试可关） */
  weakVerify?: boolean;
  /** 单文件直链解析（缺省 HuggingFace `resolve/<revision>/<path>`；测试注入本地 fixture URL） */
  fileUrl?: (entry: VoiceModelCatalogEntry, file: VoiceModelFile) => string;
}

interface DownloadTask {
  taskId: string;
  modelId: string;
  state: VoiceModelState;
  bytes: number;
  total: number;
  currentFile: string | null;
  error: string | null;
  errorMessage: string | null;
  failedFile: string | null;
  controller: AbortController;
}

const tasks = new Map<string, DownloadTask>();
const lastTask = new Map<string, string>();

const META_FILE = 'model.meta.json';
const PART_SUFFIX = '.part';

const errorMessageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));

export function resolveModelsRoot(db: Db, deps: VoiceModelDeps = {}): string {
  if (deps.rootDir !== undefined && deps.rootDir !== '') return deps.rootDir;
  const name = typeof db.name === 'string' ? db.name : '';
  if (name === '' || name === ':memory:') return join(process.cwd(), '.voice-models');
  return join(dirname(name), 'models');
}

const catalogOf = (deps: VoiceModelDeps): readonly VoiceModelCatalogEntry[] => deps.catalog ?? VOICE_MODEL_CATALOG;

const modelDir = (root: string, id: string): string => join(root, id);
const requiredFiles = (entry: VoiceModelCatalogEntry): readonly VoiceModelFile[] => entry.files ?? [];

function entryOrThrow(deps: VoiceModelDeps, id: string): VoiceModelCatalogEntry {
  const entry = catalogOf(deps).find((item) => item.id === id);
  if (!entry) throw new NotFoundError(`未知语音模型：${id}`);
  return entry;
}

interface ModelMeta {
  id: string;
  bytes: number;
  files: Array<{ path: string; bytes: number; sha256: string | null; verified: 'sha256' | 'weak' }>;
  downloaded_at: number;
}

function readMeta(root: string, id: string): ModelMeta | null {
  const path = join(modelDir(root, id), META_FILE);
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as ModelMeta;
  } catch {
    return null;
  }
}

function fileSize(path: string): number {
  try {
    return statSync(path).size;
  } catch {
    return 0;
  }
}

/**
 * CR2-02：就绪判定的进程内缓存，键为绝对路径。
 * SSE 每 250ms 调一次 statusOf，若每次都 readFileSync 整文件算 sha256，
 * 200MB 模型会被反复读进内存（主线程）。这里用 (size, mtimeMs) 判失效：
 * 只有文件真被改写（下载完成改名）时才重算一次。
 */
interface ReadyCacheEntry {
  size: number;
  mtimeMs: number;
  ok: boolean;
}

const readyCache = new Map<string, ReadyCacheEntry>();
const READY_CACHE_LIMIT = 256;

function rememberReady(path: string, entry: ReadyCacheEntry): void {
  if (readyCache.size >= READY_CACHE_LIMIT && !readyCache.has(path)) {
    const oldest = readyCache.keys().next().value;
    if (oldest !== undefined) readyCache.delete(oldest);
  }
  readyCache.set(path, entry);
}

function forgetModelCache(dir: string): void {
  const prefix = `${dir}${sep}`;
  for (const key of [...readyCache.keys()]) {
    if (key.startsWith(prefix)) readyCache.delete(key);
  }
}

async function defaultFreeBytes(dir: string): Promise<number | null> {
  try {
    const stats = await statfs(dir);
    return Number(stats.bavail) * Number(stats.bsize);
  } catch {
    return null;
  }
}

/**
 * 弱校验（上游未发布 sha256 的文件，如 tokens.txt）：
 * 字节数相等 + 内容非空 + 首行含空格或 `<`。**不是密码学校验**，只挡明显损坏/占位文件。
 */
export function weakFileLooksValid(path: string, expectedBytes: number): boolean {
  if (fileSize(path) !== expectedBytes) return false;
  try {
    const head = readFileSync(path).subarray(0, 512).toString('utf8');
    const firstLine = head.split('\n')[0] ?? '';
    return head.trim() !== '' && (firstLine.includes(' ') || firstLine.includes('<'));
  } catch {
    return false;
  }
}

/** 单文件是否已就绪：有 sha256 的必须哈希一致；没有的走弱校验 */
function fileReady(dir: string, file: VoiceModelFile, weakVerify: boolean): boolean {
  const path = join(dir, file.path);
  let stat;
  try {
    stat = statSync(path);
  } catch {
    readyCache.delete(path);
    return false;
  }
  // 字节数不符必然不通过，省掉整文件读取
  if (stat.size !== file.bytes) return false;
  const cached = readyCache.get(path);
  if (cached !== undefined && cached.size === stat.size && cached.mtimeMs === stat.mtimeMs) return cached.ok;
  let ok: boolean;
  if (file.sha256 === null) {
    ok = weakVerify ? weakFileLooksValid(path, file.bytes) : true;
  } else {
    try {
      const hash = createHash('sha256').update(readFileSync(path)).digest('hex');
      ok = hash === file.sha256.toLowerCase();
    } catch {
      ok = false;
    }
  }
  rememberReady(path, { size: stat.size, mtimeMs: stat.mtimeMs, ok });
  return ok;
}

function statusOf(root: string, entry: VoiceModelCatalogEntry, deps: VoiceModelDeps): VoiceModelStatus {
  const dir = modelDir(root, entry.id);
  const files = requiredFiles(entry);
  const taskId = lastTask.get(entry.id);
  const task = taskId === undefined ? undefined : tasks.get(taskId);
  const meta = readMeta(root, entry.id);
  const weakVerify = deps.weakVerify ?? true;
  // meta 只在校验全通过后才写；清单内每个文件字节数与落盘一致时直接信任，
  // 避免重启后首次 list/SSE 又对整模型做一遍 sha256（CR2-02）
  const metaTrusted = meta !== null && files.every((file) => {
    const record = meta.files.find((item) => item.path === file.path);
    return record !== undefined && record.bytes === file.bytes && fileSize(join(dir, file.path)) === file.bytes;
  });
  const present = metaTrusted
    ? files.map((file) => file.path)
    : files.filter((file) => fileReady(dir, file, weakVerify)).map((file) => file.path);
  const missing = files.filter((file) => !present.includes(file.path)).map((file) => file.path);
  const bytesTotal = files.reduce((sum, file) => sum + file.bytes, 0);
  const base = {
    id: entry.id,
    name: entry.name,
    languages: entry.languages,
    streaming: entry.streaming,
    note: entry.note,
    dir: entry.id,
    bytes_total: bytesTotal,
    present_files: present,
    missing_files: missing,
    sha256_verified: meta === null ? null : missing.length === 0,
  };
  if (task !== undefined && (task.state === 'downloading' || task.state === 'verifying')) {
    return { ...base, state: task.state, downloaded_bytes: task.bytes, error: null, error_message: null };
  }
  if (files.length === 0) {
    // 兼容：未声明必需文件清单的候选，按旧口径（meta + model.bin）判定
    const legacy = join(dir, 'model.bin');
    const legacyBytes = fileSize(legacy);
    if (meta !== null && legacyBytes > 0) {
      return { ...base, state: 'downloaded', downloaded_bytes: legacyBytes, error: null, error_message: null };
    }
    return { ...base, state: 'not_downloaded', downloaded_bytes: 0, error: null, error_message: null };
  }
  if (meta !== null && missing.length === 0) {
    return { ...base, state: 'downloaded', downloaded_bytes: bytesTotal, error: null, error_message: null };
  }
  if (task !== undefined && task.state === 'failed') {
    return { ...base, state: 'failed', downloaded_bytes: task.bytes, error: task.error, error_message: task.errorMessage };
  }
  return {
    ...base,
    state: missing.length === files.length ? 'not_downloaded' : 'failed',
    downloaded_bytes: present.reduce((sum, path) => sum + (files.find((file) => file.path === path)?.bytes ?? 0), 0),
    error: null,
    error_message: null,
  };
}

export function listVoiceModels(db: Db, deps: VoiceModelDeps = {}): VoiceModelStatus[] {
  const root = resolveModelsRoot(db, deps);
  return catalogOf(deps).map((entry) => statusOf(root, entry, deps));
}

export function getVoiceModel(db: Db, id: string, deps: VoiceModelDeps = {}): VoiceModelStatus {
  const entry = entryOrThrow(deps, id);
  return statusOf(resolveModelsRoot(db, deps), entry, deps);
}

export function voiceModelProgress(db: Db, id: string, deps: VoiceModelDeps = {}): VoiceProgressSnapshot {
  const entry = entryOrThrow(deps, id);
  const root = resolveModelsRoot(db, deps);
  const taskId = lastTask.get(entry.id);
  const task = taskId === undefined ? undefined : tasks.get(taskId);
  const status = statusOf(root, entry, deps);
  return {
    model_id: entry.id,
    task_id: task?.taskId ?? null,
    state: status.state,
    bytes: task?.bytes ?? status.downloaded_bytes,
    total: task?.total ?? status.bytes_total,
    current_file: task?.currentFile ?? null,
    error: status.error,
    error_message: status.error_message,
  };
}

/**
 * VOICE-DL-FAIL：代理探测（只读）。
 * 只报「有没有代理、代理主机」，**不打印凭据**（userinfo 一律丢弃）。
 */
export interface VoiceDownloadEnv {
  proxy_detected: boolean;
  proxy_var: string | null;
  proxy_host: string | null;
  node_env_proxy: boolean;
  no_proxy: string | null;
}

export function voiceDownloadEnv(env: NodeJS.ProcessEnv = process.env): VoiceDownloadEnv {
  // PROXY-ENV：解析/脱敏只有一份实现（`@agentboard/shared` 的 resolveProxyEnv）
  const info = resolveProxyEnv(env);
  return {
    proxy_detected: info.proxy_var !== null,
    proxy_var: info.proxy_var,
    proxy_host: info.proxy_host,
    node_env_proxy: info.node_env_proxy !== null,
    no_proxy: env.NO_PROXY ?? env.no_proxy ?? null,
  };
}

/**
 * VOICE-DL-FAIL：让 Node 内置 fetch 认 `HTTPS_PROXY`。
 * Node 24 只在 `NODE_USE_ENV_PROXY=1` 时按环境代理走（直连多数网络到 HuggingFace 会 10000ms 连接超时，
 * 对外只看到裸 `fetch failed`）。这里在首次请求前开启：已显式设为 `0` 时尊重用户不改。
 * 返回是否最终处于开启状态。
 */
export function ensureVoiceProxySupport(env: NodeJS.ProcessEnv = process.env): boolean {
  // PROXY-ENV：启动器（`pnpm server:ensure`）已在子进程环境注入过，这里只是**兜底**
  // （手工 `node dist/index.js` 也能用）；实现唯一一份在 shared。
  const info = ensureProxyEnv(env);
  return info.node_env_proxy !== '0' && info.proxy_var !== null;
}

/** undici 外层错误的原因码 → 可读中文（不再让用户只看到 fetch failed） */
const DOWNLOAD_CAUSE_TEXT: Record<string, string> = {
  ECONNRESET: '连接被重置',
  ECONNREFUSED: '连接被拒绝（代理或目标端口不通）',
  ENOTFOUND: '域名解析失败',
  EAI_AGAIN: '域名解析暂时失败',
  ETIMEDOUT: '连接超时',
  EPIPE: '连接被对端关闭',
  UND_ERR_CONNECT_TIMEOUT: '连接超时（常见原因：没有走代理，或代理不可用）',
  UND_ERR_HEADERS_TIMEOUT: '等待响应超时',
  UND_ERR_BODY_TIMEOUT: '接收数据超时',
  UND_ERR_SOCKET: '连接被中断',
  CERT_HAS_EXPIRED: 'TLS 证书已过期',
  DEPTH_ZERO_SELF_SIGNED_CERT: 'TLS 证书不受信任（可能被代理替换）',
  UNABLE_TO_VERIFY_LEAF_SIGNATURE: 'TLS 证书校验失败（可能被代理替换）',
  ERR_TLS_CERT_ALTNAME_INVALID: 'TLS 证书域名不匹配（可能被代理替换）',
};

export const VOICE_DOWNLOAD_IDLE_MS = 60_000;
export const VOICE_DOWNLOAD_RETRIES = 2;

function formatBytesText(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)}MB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${bytes}B`;
}

/**
 * 把下载错误翻译成「哪个文件、什么原因、已经下了多少」。
 * `cause.code` 是 undici 的真实原因（外层只是 `fetch failed`）。
 */
export function describeVoiceDownloadError(
  error: unknown,
  ctx: { file: string; downloadedBytes: number; fileBytes: number; env?: NodeJS.ProcessEnv },
): { code: string; message: string } {
  const err = error as { code?: string; message?: string; name?: string; cause?: { code?: string; message?: string; name?: string } } | undefined;
  const code = err?.code ?? 'VOICE_DOWNLOAD_FAILED';
  // 已带业务码的错误保持原码（校验不符/主动中止不该被翻成通用下载失败）
  if (code === 'VOICE_CHECKSUM_MISMATCH') return { code, message: err?.message ?? `下载 ${ctx.file} 后 sha256 校验不符` };
  if (code === 'VOICE_DOWNLOAD_ABORTED') return { code, message: `下载 ${ctx.file} 被中断（用户取消）` };
  if (code === 'VOICE_DOWNLOAD_IDLE_TIMEOUT') {
    return { code, message: `下载 ${ctx.file} 时 ${Math.round(VOICE_DOWNLOAD_IDLE_MS / 1000)} 秒没有收到数据，已中断；已下载 ${formatBytesText(ctx.downloadedBytes)}/${formatBytesText(ctx.fileBytes)}，重试会从这里续传` };
  }
  const causeCode = err?.cause?.code ?? '';
  const reason = DOWNLOAD_CAUSE_TEXT[causeCode]
    ?? (err?.cause?.message ?? err?.message ?? err?.name ?? '未知错误');
  const env = voiceDownloadEnv(ctx.env ?? process.env);
  const proxyHint = env.proxy_detected
    ? `当前检测到代理（${env.proxy_var}=${env.proxy_host ?? ''}），若代理已关闭请同步取消该环境变量`
    : '当前未检测到 HTTP(S)_PROXY：访问 HuggingFace 通常需要代理，配置后重试';
  const causeText = causeCode === '' ? '' : `（${causeCode}）`;
  return {
    code: 'VOICE_DOWNLOAD_FAILED',
    message: `下载 ${ctx.file} 失败：${reason}${causeText}，已下载 ${formatBytesText(ctx.downloadedBytes)}/${formatBytesText(ctx.fileBytes)}；${proxyHint}`,
  };
}

/**
 * 下载单个文件（VOICE-DL-FAIL）：
 * - **断点续传**：`.part` 已存在就带 `Range: bytes=<size>-`，206 才续传，200 说明服务端不支持就从头重下；
 * - **空闲超时**：`idleMs` 内没有新数据就中断（`VOICE_DOWNLOAD_IDLE_TIMEOUT`）；
 * - **失败保留 .part**（下次续传），只有 sha256 不符才删；
 * - 完成后校验 sha256 再原子改名。
 */
async function downloadFileOnce(
  dir: string,
  file: VoiceModelFile,
  url: string,
  fetchImpl: typeof fetch,
  onBytes: (delta: number) => void,
  signal: AbortSignal,
  idleMs: number,
): Promise<'sha256' | 'weak'> {
  const finalPath = join(dir, file.path);
  const partPath = `${finalPath}${PART_SUFFIX}`;
  mkdirSync(dirname(finalPath), { recursive: true });
  let resumed = existsSync(partPath) ? fileSize(partPath) : 0;
  if (resumed >= file.bytes) resumed = 0; // 半成品反而比目标大：视为脏文件，从头下
  const hash = createHash('sha256');
  if (resumed > 0) {
    // 续传前先把已有字节喂进哈希（保持最终 sha256 校验的是整份文件）
    await new Promise<void>((resolve, reject) => {
      const reader = createReadStream(partPath);
      reader.on('data', (chunk: Buffer | string) => hash.update(chunk));
      reader.on('end', () => resolve());
      reader.on('error', (error: Error) => reject(error));
    });
  }
  const controller = new AbortController();
  const onOuterAbort = (): void => controller.abort();
  signal.addEventListener('abort', onOuterAbort, { once: true });
  let idleTimer: NodeJS.Timeout | undefined;
  const armIdle = (): void => {
    if (idleTimer !== undefined) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => controller.abort(Object.assign(new Error('idle'), { code: 'VOICE_DOWNLOAD_IDLE_TIMEOUT' })), idleMs);
  };
  let bytes = resumed;
  try {
    armIdle();
    const response = await fetchImpl(url, {
      signal: controller.signal,
      ...(resumed > 0 ? { headers: { range: `bytes=${resumed}-` } } : {}),
    });
    if (!response.ok || response.body === null) {
      throw Object.assign(new Error(`HTTP ${response.status}`), { code: 'VOICE_DOWNLOAD_FAILED' });
    }
    const append = resumed > 0 && response.status === 206;
    if (resumed > 0 && !append) {
      // 服务端没按 Range 返回 → 从头写
      resumed = 0;
      bytes = 0;
    }
    const source = Readable.fromWeb(response.body as Parameters<typeof Readable.fromWeb>[0]);
    source.on('data', (chunk: Buffer) => {
      armIdle();
      bytes += chunk.length;
      hash.update(chunk);
      onBytes(chunk.length);
    });
    await pipeline(source, createWriteStream(partPath, { flags: append ? 'a' : 'w' }));
    if (idleTimer !== undefined) clearTimeout(idleTimer);
    if (file.sha256 !== null) {
      const actual = hash.digest('hex');
      if (actual !== file.sha256.toLowerCase()) {
        try { unlinkSync(partPath); } catch { /* 忽略 */ }
        throw Object.assign(
          new Error(`sha256 校验不符（${file.path}）：期望 ${file.sha256}，实际 ${actual}`),
          { code: 'VOICE_CHECKSUM_MISMATCH' },
        );
      }
      renameSync(partPath, finalPath);
      return 'sha256';
    }
    renameSync(partPath, finalPath);
    return 'weak';
  } catch (error) {
    // 失败保留 .part（下次续传）；只有中断/网络类错误保留
    const code = (error as { code?: string }).code;
    if (code === undefined && (error as { name?: string }).name === 'AbortError') {
      throw Object.assign(new Error('下载被中断'), { code: 'VOICE_DOWNLOAD_ABORTED' });
    }
    throw error;
  } finally {
    if (idleTimer !== undefined) clearTimeout(idleTimer);
    signal.removeEventListener('abort', onOuterAbort);
  }
}

/** 单文件下载 + 退避重试（`VOICE_DOWNLOAD_RETRIES` 次）；每次重试都从 `.part` 续传 */
async function downloadFile(
  dir: string,
  file: VoiceModelFile,
  url: string,
  fetchImpl: typeof fetch,
  onBytes: (delta: number) => void,
  signal: AbortSignal,
  options: { idleMs?: number; retries?: number; retryDelayMs?: (attempt: number) => number } = {},
): Promise<'sha256' | 'weak'> {
  const idleMs = options.idleMs ?? VOICE_DOWNLOAD_IDLE_MS;
  const retries = options.retries ?? VOICE_DOWNLOAD_RETRIES;
  const delay = options.retryDelayMs ?? ((attempt: number) => 1000 * (attempt + 1));
  let lastError: unknown;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      return await downloadFileOnce(dir, file, url, fetchImpl, onBytes, signal, idleMs);
    } catch (error) {
      lastError = error;
      const code = (error as { code?: string }).code;
      if (code === 'VOICE_CHECKSUM_MISMATCH' || code === 'VOICE_DOWNLOAD_ABORTED' || signal.aborted) break;
      if (attempt === retries) break;
      await new Promise((resolve) => setTimeout(resolve, delay(attempt)));
    }
  }
  throw lastError;
}

async function runDownload(db: Db, entry: VoiceModelCatalogEntry, task: DownloadTask, deps: VoiceModelDeps): Promise<void> {
  const root = resolveModelsRoot(db, deps);
  const dir = modelDir(root, entry.id);
  const files = requiredFiles(entry);
  // VOICE-DL-FAIL：首次请求前开启环境代理支持（未设代理时无副作用）
  if (deps.fetchImpl === undefined) ensureVoiceProxySupport();
  const fetchImpl = deps.fetchImpl ?? fetch;
  const weakVerify = deps.weakVerify ?? true;
  const fail = (code: string, message: string, failedFile: string | null = null): void => {
    task.state = 'failed';
    task.error = code;
    task.errorMessage = message;
    task.failedFile = failedFile;
    task.currentFile = failedFile;
  };
  try {
    mkdirSync(dir, { recursive: true });
    const total = files.reduce((sum, file) => sum + file.bytes, 0);
    task.total = total;
    const free = await (deps.freeBytes ?? defaultFreeBytes)(dir);
    const margin = deps.spaceMargin ?? 1.05;
    if (free !== null && total > 0 && free < Math.ceil(total * margin)) {
      fail('VOICE_NO_SPACE', `磁盘剩余 ${free} 字节，下载 ${entry.name} 约需 ${Math.ceil(total * margin)} 字节`);
      return;
    }
    // 已就绪的文件跳过（支持只补失败/缺失的那个文件）
    const pending = files.filter((file) => !fileReady(dir, file, weakVerify));
    task.bytes = total - pending.reduce((sum, file) => sum + file.bytes, 0);
    for (const file of pending) {
      task.currentFile = file.path;
      const url = deps.fileUrl !== undefined
        ? deps.fileUrl(entry, file)
        : `https://huggingface.co/${entry.repo ?? ''}/resolve/${entry.revision ?? 'main'}/${encodeURIComponent(file.path)}`;
      try {
        await downloadFile(dir, file, url, fetchImpl, (delta) => { task.bytes += delta; }, task.controller.signal);
      } catch (error) {
        // 已下载字节 = 目标文件字节 - .part 剩余待下字节（续传后仍准确）
        const partBytes = fileSize(`${join(dir, file.path)}${PART_SUFFIX}`);
        const described = describeVoiceDownloadError(error, {
          file: file.path,
          downloadedBytes: partBytes,
          fileBytes: file.bytes,
        });
        fail(described.code, described.message, file.path);
        return;
      }
    }
    task.state = 'verifying';
    const missing = files.filter((file) => !fileReady(dir, file, weakVerify));
    if (missing.length > 0) {
      fail('VOICE_MODEL_INCOMPLETE', `必需文件缺失或校验不通过：${missing.map((file) => file.path).join(', ')}`, missing[0]?.path ?? null);
      return;
    }
    const meta: ModelMeta = {
      id: entry.id,
      bytes: total,
      files: files.map((file) => ({
        path: file.path,
        bytes: file.bytes,
        sha256: file.sha256,
        verified: file.sha256 === null ? 'weak' : 'sha256',
      })),
      downloaded_at: Date.now(),
    };
    writeFileSync(join(dir, META_FILE), `${JSON.stringify(meta, null, 2)}\n`, 'utf8');
    task.state = 'downloaded';
    task.bytes = total;
    task.currentFile = null;
  } catch (error) {
    if (task.state !== 'failed') fail('VOICE_DOWNLOAD_FAILED', `下载失败：${errorMessageOf(error)}`);
  }
}

export function startVoiceModelDownload(db: Db, id: string, deps: VoiceModelDeps = {}): VoiceDownloadAccepted {
  const entry = entryOrThrow(deps, id);
  const root = resolveModelsRoot(db, deps);
  if (requiredFiles(entry).length === 0) {
    throw new ApiError(409, 'VOICE_MODEL_INCOMPLETE', `模型「${entry.name}」的必需文件清单为空，无法下载`);
  }
  if (entry.repo === undefined || entry.repo === '') {
    throw new ApiError(409, 'VOICE_MODEL_URL_MISSING', `模型「${entry.name}」的下载地址尚未配置，未发起下载`);
  }
  const existingId = lastTask.get(entry.id);
  const existing = existingId === undefined ? undefined : tasks.get(existingId);
  if (existing !== undefined && (existing.state === 'downloading' || existing.state === 'verifying')) {
    return { model_id: entry.id, task_id: existing.taskId, reused: true, state: existing.state };
  }
  const current = statusOf(root, entry, deps);
  if (current.state === 'downloaded') {
    return { model_id: entry.id, task_id: existingId ?? '', reused: true, state: 'downloaded' };
  }
  const task: DownloadTask = {
    taskId: `voice-${entry.id}-${Date.now().toString(36)}`,
    modelId: entry.id,
    state: 'downloading',
    bytes: 0,
    total: requiredFiles(entry).reduce((sum, file) => sum + file.bytes, 0),
    currentFile: null,
    error: null,
    errorMessage: null,
    failedFile: null,
    controller: new AbortController(),
  };
  tasks.set(task.taskId, task);
  lastTask.set(entry.id, task.taskId);
  void runDownload(db, entry, task, deps);
  return { model_id: entry.id, task_id: task.taskId, reused: false, state: task.state };
}

export function deleteVoiceModel(db: Db, id: string, deps: VoiceModelDeps = {}): { deleted: boolean; freed_bytes: number } {
  const entry = entryOrThrow(deps, id);
  const root = resolveModelsRoot(db, deps);
  const taskId = lastTask.get(entry.id);
  const task = taskId === undefined ? undefined : tasks.get(taskId);
  if (task !== undefined && (task.state === 'downloading' || task.state === 'verifying')) {
    throw new ApiError(409, 'VOICE_MODEL_BUSY', `模型「${entry.name}」正在下载，不能删除（先等下载结束或失败）`);
  }
  const dir = modelDir(root, entry.id);
  let freed = 0;
  for (const file of requiredFiles(entry)) {
    freed += fileSize(join(dir, file.path)) + fileSize(join(dir, `${file.path}${PART_SUFFIX}`));
  }
  if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
  forgetModelCache(dir);
  lastTask.delete(entry.id);
  if (taskId !== undefined) tasks.delete(taskId);
  return { deleted: true, freed_bytes: freed };
}

/** 测试用：清空内存任务表 */
export function resetVoiceModelTasks(): void {
  tasks.clear();
  lastTask.clear();
  readyCache.clear();
}
