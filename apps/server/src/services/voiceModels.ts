/**
 * VOICE-1：本地语音模型的下载与管理（服务层）。
 *
 * 口径（Docs/design-2026-11-03-local-voice-input.md §服务端-模型管理）：
 * - 目录 `dirname(db)/models/<model-id>/`（与 DOCKER-2 的派生约定一致：容器只挂 /data）；
 * - 下载写 `.part`，完成后**原子改名**；`sha256` 边下边算，不符则保留 `.part` 并报
 *   `VOICE_CHECKSUM_MISMATCH`（可续传/可清理）；
 * - **绝不自动下载**：只有显式 `POST .../download` 才会发起网络请求；
 * - 同 id 重复下载幂等复用进行中的任务（返回同一 `task_id`）；
 * - 下载中的模型删除 → 409 `VOICE_MODEL_BUSY`；
 * - 磁盘空间预检（`statfs`）不足 → `VOICE_NO_SPACE`。
 *
 * 依赖可注入（catalog / fetch / freeBytes / rootDir），单测用小测试文件跑完整流程，不碰真实模型。
 */
import { createHash } from 'node:crypto';
import { createWriteStream, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { statfs } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { Db } from '../db/connection.js';
import { ApiError, NotFoundError } from '../errors.js';
import { VOICE_MODEL_CATALOG, type VoiceModelCatalogEntry } from '@agentboard/shared';

export type VoiceModelState = 'not_downloaded' | 'downloading' | 'downloaded' | 'failed';

export interface VoiceModelStatus {
  id: string;
  name: string;
  languages: readonly string[];
  streaming: boolean;
  note: string;
  /** 目录名（相对 models 根） */
  dir: string;
  /** 预估体积；真实体积看 downloaded_bytes */
  bytes_estimate: number;
  size_estimate: boolean;
  state: VoiceModelState;
  downloaded_bytes: number;
  total_bytes: number;
  /** 落盘实测 sha256（下载完成时写入）；未完成/失败为 null */
  sha256_actual: string | null;
  /** 官方 sha256 是否校验通过；未配置官方值为 null（不算通过） */
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
  /** 候选清单（缺省用 shared 里的常量；测试注入小文件条目） */
  catalog?: readonly VoiceModelCatalogEntry[];
  /** models 根目录（缺省 dirname(db)/models） */
  rootDir?: string;
  /** fetch 实现（测试注入本地 http 服务） */
  fetchImpl?: typeof fetch;
  /** 剩余空间探测（测试注入；null 表示探测不到，不阻塞下载） */
  freeBytes?: (dir: string) => Promise<number | null>;
  /** 单次读取块大小（测试调小便于观察单调递增） */
  chunkSize?: number;
  /** 下载前的空间余量系数，缺省 1.05 */
  spaceMargin?: number;
}

interface DownloadTask {
  taskId: string;
  modelId: string;
  state: VoiceModelState;
  bytes: number;
  total: number;
  error: string | null;
  errorMessage: string | null;
  controller: AbortController;
}

const tasks = new Map<string, DownloadTask>();
/** model_id → 最近一次任务 id（失败/完成后保留，便于 progress 查询） */
const lastTask = new Map<string, string>();

const META_FILE = 'model.meta.json';
const DATA_FILE = 'model.bin';
const PART_SUFFIX = '.part';

const errorMessageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/** models 根目录：`dirname(db)/models`（内存库等无路径场景退回 cwd/.voice-models） */
export function resolveModelsRoot(db: Db, deps: VoiceModelDeps = {}): string {
  if (deps.rootDir !== undefined && deps.rootDir !== '') return deps.rootDir;
  const name = typeof db.name === 'string' ? db.name : '';
  if (name === '' || name === ':memory:') return join(process.cwd(), '.voice-models');
  return join(dirname(name), 'models');
}

const catalogOf = (deps: VoiceModelDeps): readonly VoiceModelCatalogEntry[] => deps.catalog ?? VOICE_MODEL_CATALOG;

function modelDir(root: string, id: string): string {
  return join(root, id);
}

function entryOrThrow(deps: VoiceModelDeps, id: string): VoiceModelCatalogEntry {
  const entry = catalogOf(deps).find((item) => item.id === id);
  if (!entry) throw new NotFoundError(`未知语音模型：${id}`);
  return entry;
}

interface ModelMeta {
  id: string;
  bytes: number;
  sha256_actual: string;
  sha256_verified: boolean | null;
  source_url: string;
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

/** 磁盘剩余空间（字节）；探测失败返回 null（视为不阻塞，交给写入报错） */
async function defaultFreeBytes(dir: string): Promise<number | null> {
  try {
    const stats = await statfs(dir);
    return Number(stats.bavail) * Number(stats.bsize);
  } catch {
    return null;
  }
}

function statusOf(root: string, entry: VoiceModelCatalogEntry): VoiceModelStatus {
  const taskId = lastTask.get(entry.id) ?? null;
  const task = taskId === null ? undefined : tasks.get(taskId);
  const meta = readMeta(root, entry.id);
  const dataPath = join(modelDir(root, entry.id), DATA_FILE);
  const partPath = `${dataPath}${PART_SUFFIX}`;
  const base = {
    id: entry.id,
    name: entry.name,
    languages: entry.languages,
    streaming: entry.streaming,
    note: entry.note,
    dir: entry.id,
    bytes_estimate: entry.bytes,
    size_estimate: entry.size_estimate,
    sha256_actual: meta?.sha256_actual ?? null,
    sha256_verified: meta?.sha256_verified ?? null,
  };
  if (task?.state === 'downloading') {
    return { ...base, state: 'downloading', downloaded_bytes: task.bytes, total_bytes: task.total, error: null, error_message: null };
  }
  if (meta !== null && existsSync(dataPath)) {
    return { ...base, state: 'downloaded', downloaded_bytes: meta.bytes, total_bytes: meta.bytes, error: null, error_message: null };
  }
  if (task?.state === 'failed') {
    return { ...base, state: 'failed', downloaded_bytes: task.bytes, total_bytes: task.total, error: task.error, error_message: task.errorMessage };
  }
  // 有 .part 但没完成：仍算未下载，但把已下字节数暴露出来（可续）
  const partBytes = fileSize(partPath);
  return { ...base, state: partBytes > 0 ? 'failed' : 'not_downloaded', downloaded_bytes: partBytes, total_bytes: entry.bytes, error: null, error_message: null };
}

export function listVoiceModels(db: Db, deps: VoiceModelDeps = {}): VoiceModelStatus[] {
  const root = resolveModelsRoot(db, deps);
  return catalogOf(deps).map((entry) => statusOf(root, entry));
}

export function getVoiceModel(db: Db, id: string, deps: VoiceModelDeps = {}): VoiceModelStatus {
  const entry = entryOrThrow(deps, id);
  return statusOf(resolveModelsRoot(db, deps), entry);
}

export function voiceModelProgress(db: Db, id: string, deps: VoiceModelDeps = {}): VoiceProgressSnapshot {
  const entry = entryOrThrow(deps, id);
  const root = resolveModelsRoot(db, deps);
  const taskId = lastTask.get(entry.id) ?? null;
  const task = taskId === null ? undefined : tasks.get(taskId);
  const status = statusOf(root, entry);
  return {
    model_id: entry.id,
    task_id: task?.taskId ?? null,
    state: status.state,
    bytes: task?.bytes ?? status.downloaded_bytes,
    total: task?.total ?? status.total_bytes,
    error: status.error,
    error_message: status.error_message,
  };
}

async function runDownload(db: Db, entry: VoiceModelCatalogEntry, task: DownloadTask, deps: VoiceModelDeps): Promise<void> {
  const root = resolveModelsRoot(db, deps);
  const dir = modelDir(root, entry.id);
  const dataPath = join(dir, DATA_FILE);
  const partPath = `${dataPath}${PART_SUFFIX}`;
  const fetchImpl = deps.fetchImpl ?? fetch;
  const fail = (code: string, message: string): void => {
    task.state = 'failed';
    task.error = code;
    task.errorMessage = message;
  };
  try {
    mkdirSync(dir, { recursive: true });
    // 空间预检：不足就不开始，避免写出半个文件再失败
    const free = await (deps.freeBytes ?? defaultFreeBytes)(dir);
    const margin = deps.spaceMargin ?? 1.05;
    const need = Math.ceil((entry.bytes || 0) * margin);
    if (free !== null && entry.bytes > 0 && free < need) {
      fail('VOICE_NO_SPACE', `磁盘剩余 ${free} 字节，下载 ${entry.name} 约需 ${need} 字节`);
      return;
    }
    const response = await fetchImpl(entry.url as string);
    if (!response.ok || response.body === null) {
      fail('VOICE_DOWNLOAD_FAILED', `下载失败：HTTP ${response.status}（${entry.url}）`);
      return;
    }
    const total = Number(response.headers.get('content-length') ?? entry.bytes ?? 0);
    task.total = Number.isFinite(total) && total > 0 ? total : entry.bytes;
    const hash = createHash('sha256');
    const source = Readable.fromWeb(response.body as Parameters<typeof Readable.fromWeb>[0]);
    let bytes = 0;
    source.on('data', (chunk: Buffer) => {
      bytes += chunk.length;
      task.bytes = bytes;
      hash.update(chunk);
    });
    await pipeline(source, createWriteStream(partPath));
    const actual = hash.digest('hex');
    task.bytes = bytes;
    if (entry.sha256 !== null && actual !== entry.sha256.toLowerCase()) {
      // 保留 .part：可续传或人工清理，绝不标成已下载
      fail('VOICE_CHECKSUM_MISMATCH', `sha256 校验不符：期望 ${entry.sha256}，实际 ${actual}`);
      return;
    }
    const meta: ModelMeta = {
      id: entry.id,
      bytes,
      sha256_actual: actual,
      sha256_verified: entry.sha256 === null ? null : true,
      source_url: entry.url as string,
      downloaded_at: Date.now(),
    };
    writeFileSync(join(dir, META_FILE), `${JSON.stringify(meta, null, 2)}\n`, 'utf8');
    // 原子改名：先写 meta，再 rename；rename 覆盖旧文件在 POSIX/Windows 上均原子
    renameSync(partPath, dataPath);
    task.state = 'downloaded';
    task.total = bytes;
  } catch (error) {
    if (task.state !== 'failed') fail('VOICE_DOWNLOAD_FAILED', `下载失败：${errorMessageOf(error)}`);
  }
}

/** 开始下载（幂等：进行中的任务直接复用） */
export function startVoiceModelDownload(db: Db, id: string, deps: VoiceModelDeps = {}): VoiceDownloadAccepted {
  const entry = entryOrThrow(deps, id);
  const root = resolveModelsRoot(db, deps);
  const existingId = lastTask.get(entry.id);
  const existing = existingId === undefined ? undefined : tasks.get(existingId);
  if (existing !== undefined && existing.state === 'downloading') {
    return { model_id: entry.id, task_id: existing.taskId, reused: true, state: existing.state };
  }
  if (entry.url === null) {
    throw new ApiError(
      409,
      'VOICE_MODEL_URL_MISSING',
      `模型「${entry.name}」的官方下载地址尚未配置，未发起下载（本版本不预置真实模型）`,
    );
  }
  const current = statusOf(root, entry);
  if (current.state === 'downloaded') {
    return { model_id: entry.id, task_id: existingId ?? '', reused: true, state: 'downloaded' };
  }
  const task: DownloadTask = {
    taskId: `voice-${entry.id}-${Date.now().toString(36)}`,
    modelId: entry.id,
    state: 'downloading',
    bytes: 0,
    total: entry.bytes,
    error: null,
    errorMessage: null,
    controller: new AbortController(),
  };
  tasks.set(task.taskId, task);
  lastTask.set(entry.id, task.taskId);
  void runDownload(db, entry, task, deps);
  return { model_id: entry.id, task_id: task.taskId, reused: false, state: task.state };
}

/** 删除已下载模型；下载中 → 409 */
export function deleteVoiceModel(db: Db, id: string, deps: VoiceModelDeps = {}): { deleted: boolean; freed_bytes: number } {
  const entry = entryOrThrow(deps, id);
  const root = resolveModelsRoot(db, deps);
  const taskId = lastTask.get(entry.id);
  const task = taskId === undefined ? undefined : tasks.get(taskId);
  if (task !== undefined && task.state === 'downloading') {
    throw new ApiError(409, 'VOICE_MODEL_BUSY', `模型「${entry.name}」正在下载，不能删除（先等下载结束或失败）`);
  }
  const dir = modelDir(root, entry.id);
  const freed = fileSize(join(dir, DATA_FILE)) + fileSize(join(dir, `${DATA_FILE}${PART_SUFFIX}`));
  if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
  lastTask.delete(entry.id);
  if (taskId !== undefined) tasks.delete(taskId);
  return { deleted: true, freed_bytes: freed };
}

/** 测试用：清空内存任务表（避免跨用例串味） */
export function resetVoiceModelTasks(): void {
  tasks.clear();
  lastTask.clear();
}
