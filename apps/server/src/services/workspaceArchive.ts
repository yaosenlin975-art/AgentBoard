/**
 * STORE-7（M5）：删除已下沉工作区时的归档（设计 §5.6）。
 *
 * - 未下沉（db_mode≠localized）→ 完全 no-op，删除行为与现状一致；
 * - 已下沉 → 不删库文件：把 `<ws>/.agentboard/agentboard.db`（含 -wal/-shm）与 `attachments/`
 *   移到 `<中心库目录>/archive/<workspaceId>/`，中心库写一条 `workspace_archive` 记录；
 * - 删除事务失败 → `rollbackWorkspaceArchive` 把文件移回原位并删记录，不把半成品留在归档目录。
 *
 * 幂等：文件已移走但注册行未删（上次进程死在文件移动之后）时，检测到源库缺失 + 归档库存在即视为
 * `alreadyArchived`，只补记录并继续删注册行，不会因为「归档目录已存在」永久卡死。
 */
import { cpSync, existsSync, mkdirSync, readdirSync, renameSync, rmSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { Db } from '../db/connection.js';
import { ApiError } from '../errors.js';
import { workspaceDbPath, workspaceStateDir } from '../db/resolver.js';

export interface ArchiveWorkspaceInput {
  workspaceId: string;
  name: string;
  path: string;
  dbMode: string | null | undefined;
}

export interface ArchiveOutcome {
  archived: boolean;
  /** 归档目录（未归档时缺省） */
  dir?: string;
  dbBytes: number;
  attachmentFiles: number;
  alreadyArchived: boolean;
}

export interface ArchiveDeps {
  /** 测试注入：归档根目录（缺省 `<中心库目录>/archive`） */
  archiveRoot?: string;
  now?: () => number;
}

/** 归档根目录：与中心库同级的 `archive/`（默认即 `%APPDATA%\AgentBoard\archive`） */
export function archiveRootDir(centerDbPath: string, override?: string): string {
  return override ?? join(dirname(centerDbPath), 'archive');
}

/** 跨卷 rename 会抛 EXDEV：退化为 copy + rm，语义仍是「移走」 */
function movePath(from: string, to: string): void {
  mkdirSync(dirname(to), { recursive: true });
  try {
    renameSync(from, to);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EXDEV') throw error;
    cpSync(from, to, { recursive: true });
    rmSync(from, { recursive: true, force: true });
  }
}

function fileSize(path: string): number {
  try {
    return statSync(path).size;
  } catch {
    return 0;
  }
}

function countFiles(dir: string): number {
  if (!existsSync(dir)) return 0;
  let count = 0;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    count += entry.isDirectory() ? countFiles(join(dir, entry.name)) : 1;
  }
  return count;
}

/**
 * 归档已下沉工作区的库文件与附件，并在中心库落归档记录。
 * 拒绝场景：中心标记 localized 但工作区库文件与归档库都不存在（唯一副本丢失，不能静默删注册行）；
 * 归档目录已存在且源库仍在（同名冲突，避免覆盖上一次归档）。
 */
export function archiveWorkspaceState(centerDb: Db, input: ArchiveWorkspaceInput, deps: ArchiveDeps = {}): ArchiveOutcome {
  if (input.dbMode !== 'localized') return { archived: false, dbBytes: 0, attachmentFiles: 0, alreadyArchived: false };

  const stateDir = workspaceStateDir(input.path);
  const sourceDb = workspaceDbPath(input.path);
  const dir = join(archiveRootDir(centerDb.name, deps.archiveRoot), input.workspaceId);
  const archiveDb = join(dir, 'agentboard.db');
  const alreadyArchived = !existsSync(sourceDb) && existsSync(archiveDb);
  if (!existsSync(sourceDb) && !alreadyArchived) {
    throw new ApiError(500, 'WORKSPACE_DB_MISSING', `中心库标记该工作区已下沉，但工作区库文件与归档副本都不存在：${sourceDb}`);
  }

  if (!alreadyArchived) {
    if (existsSync(dir)) {
      throw new ApiError(409, 'WORKSPACE_ARCHIVE_EXISTS', `归档目录已存在同名工作区：${dir}`);
    }
    mkdirSync(dir, { recursive: true });
    movePath(sourceDb, archiveDb);
    for (const suffix of ['-wal', '-shm'] as const) {
      const file = `${sourceDb}${suffix}`;
      if (existsSync(file)) movePath(file, `${archiveDb}${suffix}`);
    }
    const attachments = join(stateDir, 'attachments');
    if (existsSync(attachments)) movePath(attachments, join(dir, 'attachments'));
  }

  const dbBytes = fileSize(archiveDb) + fileSize(`${archiveDb}-wal`);
  const attachmentFiles = countFiles(join(dir, 'attachments'));
  centerDb
    .prepare(
      `INSERT OR REPLACE INTO workspace_archive
         (workspace_id, workspace_name, origin_path, archive_dir, archived_at, db_bytes, attachment_files)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(input.workspaceId, input.name, input.path, dir, (deps.now ?? Date.now)(), dbBytes, attachmentFiles);
  return { archived: true, dir, dbBytes, attachmentFiles, alreadyArchived };
}

/** 删除事务失败时的补偿：把归档文件移回工作区并删记录（best-effort，调用方保留原始错误） */
export function rollbackWorkspaceArchive(centerDb: Db, input: Pick<ArchiveWorkspaceInput, 'workspaceId' | 'path'>, deps: ArchiveDeps = {}): void {
  const dir = join(archiveRootDir(centerDb.name, deps.archiveRoot), input.workspaceId);
  const archiveDb = join(dir, 'agentboard.db');
  const stateDir = workspaceStateDir(input.path);
  if (existsSync(archiveDb)) {
    mkdirSync(stateDir, { recursive: true });
    movePath(archiveDb, workspaceDbPath(input.path));
    for (const suffix of ['-wal', '-shm'] as const) {
      const file = `${archiveDb}${suffix}`;
      if (existsSync(file)) movePath(file, `${workspaceDbPath(input.path)}${suffix}`);
    }
    const attachments = join(dir, 'attachments');
    if (existsSync(attachments)) movePath(attachments, join(stateDir, 'attachments'));
  }
  centerDb.prepare('DELETE FROM workspace_archive WHERE workspace_id = ?').run(input.workspaceId);
}
