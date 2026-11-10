/**
 * ACC-SW-TRAE：Trae CN 登录态的**目录级多文件快照**（KB knowledge:cc06032d-59de-480a-a5af-6e627ed12ff2 Trae 段，范式 A）。
 *
 * 为什么不是单文件：Trae 登录态散在 `%APPDATA%\Trae CN\` 下多文件/多目录——
 * `storage.json` 只是 IDE 侧信封；`state.vscdb`（+wal/shm）有按 userId 隔离的键；
 * `Local Storage/leveldb`、`Session Storage`、`Partitions/*` 是 webview 侧登录态；
 * `machineid`、`aha/`、`Local State`、`Network/` 与 storage.json 里的 telemetry 字段是设备身份，
 * 必须与令牌**成套同代搬**，否则被判新设备或「看起来成功、实际串号」。
 *
 * 快照形态（vault.protect 只收单 Buffer 的解法）：
 * - 备份目录 `<数据根>/trae-snapshots/<ref>/` 原样镜像各条目（相对路径不变）；
 * - manifest（逐文件 sha256 + 条目状态）整体走 `vault.protect` 加密为单条 ref——备份目录名 = 同一 ref；
 * - 还原按 manifest 逐文件拷回并**按哈希值校验**，不比路径 mtime。
 *
 * 实测（2026-11-07 本机）：`Partitions/trae-webview` 505MB、`icube-web-crawler*` 309MB，
 * 其中 Cache/Code Cache/GPUCache 等 HTTP 缓存占 ~98%（零账号身份）——快照在分区内**跳过缓存子目录**，
 * 只取身份子路径（IndexedDB/Local Storage/Session Storage/Network/WebStorage/Service Worker 等），
 * 单份快照 ~15MB / ~300 文件。缓存不搬不影响换号（客户端自建）。
 *
 * 必清（KB：清单外凭据残留）：切换写入时删 `logs/`（completion.log 有明文 JWT，不清则串号）、
 * `code.lock`（Electron 单实例锁）、live 的 `state.vscdb-wal/-shm/-journal`（SQLite 回放旧事务）。
 *
 * 安全边界：快照文件含凭据——只落数据根下的 `trae-snapshots/`（与 vault 同级信任域），不进日志、不进响应。
 */
import { createHash } from 'node:crypto';
import { promises as nodeFs } from 'node:fs';
import { join } from 'node:path';
import { ApiError } from '../../errors.js';

/** 快照内的文件记录（相对 dataDir 的 posix 风格路径 + 哈希） */
export interface TraeSnapshotFileRecord {
  path: string;
  bytes: number;
  sha256: string;
}

/** 快照条目：status=ok 有 files；absent = 本机当时就没有；failed = 拷贝失败（还原时**不碰** live 对应路径） */
export interface TraeSnapshotEntry {
  path: string;
  kind: 'file' | 'dir';
  status: 'ok' | 'absent' | 'failed';
  files?: TraeSnapshotFileRecord[];
  message?: string;
}

export interface TraeSnapshotManifest {
  version: 1;
  created_at: number;
  /** 还原前必清的固定残留（dataDir 相对路径；kind 由 cleanTraeResiduals 内置决定） */
  residual_dirs: string[];
  residual_files: string[];
  entries: TraeSnapshotEntry[];
}

/** 可注入文件系统（测试用内存实现）；remove 对文件与目录都生效（递归） */
export interface TraeFileSystem {
  exists(path: string): Promise<boolean>;
  readFile(path: string): Promise<Buffer>;
  writeFile(path: string, data: Buffer): Promise<void>;
  mkdir(path: string): Promise<void>;
  listDir(path: string): Promise<Array<{ name: string; isDirectory: boolean }>>;
  copyFile(from: string, to: string): Promise<void>;
  remove(path: string): Promise<void>;
  /** 同卷改名（快照暂存目录 → manifest ref 定名；同卷 rename 原子） */
  rename(from: string, to: string): Promise<void>;
}

export const defaultTraeFs: TraeFileSystem = {
  exists: async path => nodeFs.access(path).then(() => true, () => false),
  readFile: path => nodeFs.readFile(path),
  writeFile: async (path, data) => { await nodeFs.writeFile(path, data); },
  mkdir: async path => { await nodeFs.mkdir(path, { recursive: true }); },
  listDir: async path => {
    const items = await nodeFs.readdir(path, { withFileTypes: true });
    return items.map(item => ({ name: item.name, isDirectory: item.isDirectory() }));
  },
  copyFile: (from, to) => nodeFs.copyFile(from, to),
  remove: path => nodeFs.rm(path, { recursive: true, force: true }),
  rename: (from, to) => nodeFs.rename(from, to),
};

/** dataDir 相对路径 → 绝对路径（manifest 统一存 posix 分隔符） */
export function traeAbsPath(dataDir: string, relPath: string): string {
  assertSafeSnapshotPath(relPath);
  return join(dataDir, ...relPath.split('/'));
}

/**
 * CR3-05：manifest 内的相对路径必须留在 dataDir 内。
 * 清单来自加密 vault、由本机生成，正常不可注入；但清单损坏/被改写时
 * `../` 会让 restore 的删除动作逃出 dataDir，这里解析阶段就整份判无效。
 */
export function assertSafeSnapshotPath(relPath: string): void {
  const unsafe = typeof relPath !== 'string'
    || relPath.length === 0
    || relPath.includes('\0')
    || relPath.startsWith('/')
    || relPath.startsWith('\\')
    || /^[a-zA-Z]:/.test(relPath)
    || relPath.split('/').includes('..')
    || relPath.split('\\').includes('..');
  if (unsafe) throw new ApiError(409, 'TARGET_SNAPSHOT_INVALID', `快照清单含非法路径：${relPath}`);
}

/** 快照条目清单（KB 15 条按本机实测路径落定；Partitions 两条用前缀匹配实际分区名） */
export const TRAE_SNAPSHOT_FILE_ENTRIES = [
  'User/globalStorage/storage.json',
  'User/globalStorage/state.vscdb',
  'User/globalStorage/state.vscdb.backup',
  'User/globalStorage/state.vscdb-wal',
  'User/globalStorage/state.vscdb-shm',
  'User/globalStorage/state.vscdb-journal',
  'machineid',
  'Preferences',
  'Local State',
  'Local Storage/config.db',
] as const;

export const TRAE_SNAPSHOT_DIR_ENTRIES = [
  'aha',
  'Local Storage',
  'Session Storage',
  'Network',
] as const;

/** 换号必须成套搬的设备字段最小集（KB：漏了会被判新设备或串号） */
export const TRAE_SNAPSHOT_REQUIRED = [
  'User/globalStorage/storage.json',
  'User/globalStorage/state.vscdb',
  'machineid',
] as const;

export const TRAE_PARTITION_DIR = 'Partitions';
/** 分区名前缀：trae 主 webview + icube 爬虫共享会话（实测后缀 -shared-session-v1.0） */
export const TRAE_PARTITION_INCLUDE_PREFIXES = ['trae-webview', 'icube-web-crawler'] as const;
/** 分区内跳过的缓存/瞬态子目录（HTTP 缓存与 GPU 着色器，零账号身份；实测占分区体积 ~98%） */
export const TRAE_PARTITION_SKIP_SUBDIRS = [
  'Cache', 'Code Cache', 'GPUCache', 'DawnGraphiteCache', 'DawnWebGPUCache',
  'VideoDecodeStats', 'blob_storage', 'Shared Dictionary',
] as const;

/** 必清残留（KB：logs/ 有明文 JWT 不清则串号；code.lock 是 Electron 单实例锁） */
export const TRAE_SWITCH_RESIDUAL_DIRS = ['logs'] as const;
export const TRAE_SWITCH_RESIDUAL_FILES = ['code.lock'] as const;

const sha256File = (data: Buffer): string => createHash('sha256').update(data).digest('hex');

const joinRel = (base: string, name: string): string => `${base}/${name}`;

/** 目录递归展开（分区内按 TRAE_PARTITION_SKIP_SUBDIRS 过滤缓存）；任一文件读失败抛错 → 整条目记 failed */
async function walkDir(input: { dataDir: string; absDir: string; relBase: string; fs: TraeFileSystem }): Promise<TraeSnapshotFileRecord[]> {
  const { dataDir, absDir, relBase, fs } = input;
  const files: TraeSnapshotFileRecord[] = [];
  const items = await fs.listDir(absDir);
  for (const item of items) {
    const childAbs = join(absDir, item.name);
    const childRel = joinRel(relBase, item.name);
    if (item.isDirectory) {
      // 分区内（relBase 已是 Partitions/<name>）的缓存子目录整段跳过：身份子路径之外全是 HTTP 缓存
      const insidePartition = relBase.startsWith(`${TRAE_PARTITION_DIR}/`);
      if (insidePartition && (TRAE_PARTITION_SKIP_SUBDIRS as readonly string[]).includes(item.name)) continue;
      files.push(...await walkDir({ dataDir, absDir: childAbs, relBase: childRel, fs }));
    } else {
      const data = await fs.readFile(childAbs);
      files.push({ path: childRel, bytes: data.length, sha256: sha256File(data) });
    }
  }
  return files;
}

/** 把单条目拷进备份目录（镜像相对路径）；返回逐文件记录 */
async function copyEntryToBackup(input: { dataDir: string; backupDir: string; files: TraeSnapshotFileRecord[]; fs: TraeFileSystem }): Promise<void> {
  const { dataDir, backupDir, files, fs } = input;
  for (const file of files) {
    const target = traeAbsPath(backupDir, file.path);
    await fs.mkdir(traeAbsPath(backupDir, file.path.split('/').slice(0, -1).join('/') || '.'));
    await fs.copyFile(traeAbsPath(dataDir, file.path), target);
  }
}

/** Partitions 下本机实际存在的、名字命中 INCLUDE 前缀的分区目录 */
async function partitionEntries(input: { dataDir: string; fs: TraeFileSystem }): Promise<string[]> {
  const { dataDir, fs } = input;
  const absRoot = traeAbsPath(dataDir, TRAE_PARTITION_DIR);
  if (!(await fs.exists(absRoot))) return [];
  const items = await fs.listDir(absRoot);
  return items
    .filter(item => item.isDirectory && (TRAE_PARTITION_INCLUDE_PREFIXES as readonly string[]).some(prefix => item.name.startsWith(prefix)))
    .map(item => joinRel(TRAE_PARTITION_DIR, item.name))
    .sort();
}

/**
 * 生成快照：把清单内条目拷进 backupDir（镜像相对路径），返回 manifest（调用方负责 vault.protect + 写 manifest.json）。
 * 单文件读失败 → 该条目记 failed（不中断整份快照）；目录条目内任一文件失败 → 整条目 failed。
 */
export async function createTraeSnapshot(input: { dataDir: string; backupDir: string; now: () => number; fs?: TraeFileSystem }): Promise<TraeSnapshotManifest> {
  const fs = input.fs ?? defaultTraeFs;
  const entries: TraeSnapshotEntry[] = [];

  for (const rel of TRAE_SNAPSHOT_FILE_ENTRIES) {
    const abs = traeAbsPath(input.dataDir, rel);
    if (!(await fs.exists(abs))) { entries.push({ path: rel, kind: 'file', status: 'absent' }); continue; }
    try {
      const data = await fs.readFile(abs);
      await fs.mkdir(traeAbsPath(input.backupDir, rel.split('/').slice(0, -1).join('/') || '.'));
      await fs.copyFile(abs, traeAbsPath(input.backupDir, rel));
      entries.push({ path: rel, kind: 'file', status: 'ok', files: [{ path: rel, bytes: data.length, sha256: sha256File(data) }] });
    } catch (error) {
      entries.push({ path: rel, kind: 'file', status: 'failed', message: error instanceof Error ? error.name : 'READ_FAILED' });
    }
  }

  const dirs = [...TRAE_SNAPSHOT_DIR_ENTRIES, ...await partitionEntries({ dataDir: input.dataDir, fs })];
  for (const rel of dirs) {
    const abs = traeAbsPath(input.dataDir, rel);
    if (!(await fs.exists(abs))) { entries.push({ path: rel, kind: 'dir', status: 'absent' }); continue; }
    try {
      const files = await walkDir({ dataDir: input.dataDir, absDir: abs, relBase: rel, fs });
      if (files.length === 0) { entries.push({ path: rel, kind: 'dir', status: 'absent' }); continue; }
      await copyEntryToBackup({ dataDir: input.dataDir, backupDir: input.backupDir, files, fs });
      entries.push({ path: rel, kind: 'dir', status: 'ok', files });
    } catch (error) {
      entries.push({ path: rel, kind: 'dir', status: 'failed', message: error instanceof Error ? error.name : 'READ_FAILED' });
    }
  }

  return {
    version: 1,
    created_at: input.now(),
    residual_dirs: [...TRAE_SWITCH_RESIDUAL_DIRS],
    residual_files: [...TRAE_SWITCH_RESIDUAL_FILES],
    entries,
  };
}

/** manifest 合法性（还原目标校验用）：三件套必须 ok */
export function traeSnapshotReady(manifest: TraeSnapshotManifest): { ok: boolean; missing: string[] } {
  const okPaths = new Set(manifest.entries.filter(entry => entry.status === 'ok').map(entry => entry.path));
  const missing = TRAE_SNAPSHOT_REQUIRED.filter(required => !okPaths.has(required));
  return { ok: missing.length === 0, missing: [...missing] };
}

export function parseTraeSnapshotManifest(raw: Buffer): TraeSnapshotManifest {
  let parsed: unknown;
  try { parsed = JSON.parse(raw.toString('utf8')); } catch { throw new ApiError(409, 'TARGET_SNAPSHOT_INVALID', '快照 manifest 不是合法 JSON'); }
  const manifest = parsed as TraeSnapshotManifest;
  if (!manifest || manifest.version !== 1 || !Array.isArray(manifest.entries)) {
    throw new ApiError(409, 'TARGET_SNAPSHOT_INVALID', '快照 manifest 版本或结构不符合预期');
  }
  for (const rel of manifest.residual_dirs ?? []) assertSafeSnapshotPath(rel);
  for (const rel of manifest.residual_files ?? []) assertSafeSnapshotPath(rel);
  for (const entry of manifest.entries) {
    assertSafeSnapshotPath(entry.path);
    for (const file of entry.files ?? []) assertSafeSnapshotPath(file.path);
  }
  return manifest;
}

/** 必清残留（切换写入/回滚恢复前执行）：logs/ 整目录 + code.lock */
export async function cleanTraeResiduals(input: { dataDir: string; fs?: TraeFileSystem }): Promise<void> {
  const fs = input.fs ?? defaultTraeFs;
  for (const rel of TRAE_SWITCH_RESIDUAL_DIRS) await fs.remove(traeAbsPath(input.dataDir, rel));
  for (const rel of TRAE_SWITCH_RESIDUAL_FILES) await fs.remove(traeAbsPath(input.dataDir, rel));
}

/**
 * 把快照还原到 dataDir：
 * - status=ok → 先删 live 对应路径（文件/目录）再逐文件拷回，**逐文件 sha256 校验**（KB：写后按值校验）；
 * - status=absent → 只删 live 对应路径（清掉上一账号的残留，目标本来就没有）；
 * - status=failed → 不碰 live（快照没能备份的东西不能瞎删）。
 * 哈希不匹配/写失败抛 `SNAPSHOT_WRITE_FAILED`（SAFE 错误码，operationRunner 可落库）。
 */
export async function restoreTraeSnapshot(input: { dataDir: string; backupDir: string; manifest: TraeSnapshotManifest; fs?: TraeFileSystem }): Promise<void> {
  const fs = input.fs ?? defaultTraeFs;
  for (const entry of input.manifest.entries) {
    const absLive = traeAbsPath(input.dataDir, entry.path);
    if (entry.status === 'failed') continue;
    await fs.remove(absLive);
    if (entry.status !== 'ok' || !entry.files) continue;
    for (const file of entry.files) {
      const source = traeAbsPath(input.backupDir, file.path);
      if (!(await fs.exists(source))) throw new ApiError(409, 'SNAPSHOT_WRITE_FAILED', `快照缺文件，还原中止：${file.path}`);
      const data = await fs.readFile(source);
      if (sha256File(data) !== file.sha256 || data.length !== file.bytes) {
        throw new ApiError(409, 'SNAPSHOT_WRITE_FAILED', '快照文件哈希与 manifest 不符，还原中止');
      }
      await fs.mkdir(traeAbsPath(input.dataDir, file.path.split('/').slice(0, -1).join('/') || '.'));
      await fs.writeFile(traeAbsPath(input.dataDir, file.path), data);
    }
  }
}
