/**
 * VOICE-1/VOICE-5：本地语音模型的下载与管理（服务层）。
 *
 * 口径（Docs/design-2026-11-03-local-voice-input.md §服务端-模型管理；VOICE-5 决策=方案 A）：
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
import { createHash } from 'node:crypto';
import { createWriteStream, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { statfs } from 'node:fs/promises';
import { dirname, join } from 'node:path';
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
  if (!existsSync(path)) return false;
  if (file.sha256 === null) return weakVerify ? weakFileLooksValid(path, file.bytes) : fileSize(path) === file.bytes;
  try {
    const hash = createHash('sha256').update(readFileSync(path)).digest('hex');
    return hash === file.sha256.toLowerCase();
  } catch {
    return false;
  }
}

function statusOf(root: string, entry: VoiceModelCatalogEntry, deps: VoiceModelDeps): VoiceModelStatus {
  const dir = modelDir(root, entry.id);
  const files = requiredFiles(entry);
  const taskId = lastTask.get(entry.id);
  const task = taskId === undefined ? undefined : tasks.get(taskId);
  const meta = readMeta(root, entry.id);
  const weakVerify = deps.weakVerify ?? true;
  const present = files.filter((file) => fileReady(dir, file, weakVerify)).map((file) => file.path);
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

/** 下载单个文件：写 .part → 校验 → 原子改名；失败删掉该文件的半成品并抛出带 code 的错误 */
async function downloadFile(
  dir: string,
  file: VoiceModelFile,
  url: string,
  fetchImpl: typeof fetch,
  onBytes: (delta: number) => void,
  signal: AbortSignal,
): Promise<'sha256' | 'weak'> {
  const finalPath = join(dir, file.path);
  const partPath = `${finalPath}${PART_SUFFIX}`;
  mkdirSync(dirname(finalPath), { recursive: true });
  const response = await fetchImpl(url, { signal });
  if (!response.ok || response.body === null) {
    throw Object.assign(new Error(`下载 ${file.path} 失败：HTTP ${response.status}`), { code: 'VOICE_DOWNLOAD_FAILED' });
  }
  const hash = createHash('sha256');
  const source = Readable.fromWeb(response.body as Parameters<typeof Readable.fromWeb>[0]);
  let bytes = 0;
  source.on('data', (chunk: Buffer) => {
    bytes += chunk.length;
    hash.update(chunk);
    onBytes(chunk.length);
  });
  await pipeline(source, createWriteStream(partPath));
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
}

async function runDownload(db: Db, entry: VoiceModelCatalogEntry, task: DownloadTask, deps: VoiceModelDeps): Promise<void> {
  const root = resolveModelsRoot(db, deps);
  const dir = modelDir(root, entry.id);
  const files = requiredFiles(entry);
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
        const code = (error as { code?: string }).code ?? 'VOICE_DOWNLOAD_FAILED';
        fail(code, errorMessageOf(error), file.path);
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
  lastTask.delete(entry.id);
  if (taskId !== undefined) tasks.delete(taskId);
  return { deleted: true, freed_bytes: freed };
}

/** 测试用：清空内存任务表 */
export function resetVoiceModelTasks(): void {
  tasks.clear();
  lastTask.clear();
}
