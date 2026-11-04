/**
 * DB-3B-S：存储位置只读汇总（`GET /api/settings/storage`）。
 *
 * 口径（父卡 DB-3B）：
 * - **只读**：不改配置、不触发迁移、不动库；纯统计。
 * - **数字全由服务端给**，前端只格式化，避免前后端各算一套：
 *   `usage` 是当前磁盘占用，`migration_estimate.estimated_bytes` 与迁移前置检查
 *   （`measureMigrationSource`）**同一个总量口径**（db + `-wal` + `-shm` + 附件字节），
 *   `required_bytes` 用同一个 `DB_MIGRATION_SPACE_MARGIN`（×1.2）算空间门槛。
 * - **大目录保护**：附件遍历超过 `STORAGE_SCAN_MAX_FILES` 就停，返回 `null` + `truncated: true`，
 *   不让一次请求卡在几十万文件的目录上。
 * - 附件目录不存在不是错误：按 0 计。
 */
import { existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { DbPathSource } from '../config.js';
import { DB_MIGRATION_SPACE_MARGIN, DB_SIDECAR_SUFFIXES } from './dbMigration.js';

/** 单次统计最多遍历的附件文件数（超过即截断） */
export const STORAGE_SCAN_MAX_FILES = 50_000;

export interface StorageUsage {
  db_bytes: number;
  wal_bytes: number;
  shm_bytes: number;
  /** 截断时为 null（没数完，不假装知道） */
  attachments_bytes: number | null;
  attachments_files: number | null;
  /** 截断时为 null */
  total_bytes: number | null;
}

export interface StorageMigrationEstimate {
  issue_count: number;
  /** 截断时为 null */
  attachment_count: number | null;
  /** 迁移源总量：与 `preflightMigration` 的 `plan.totalBytes` 同值；截断时为 null */
  estimated_bytes: number | null;
  /** 空间门槛：`ceil(estimated_bytes × DB_MIGRATION_SPACE_MARGIN)`；截断时为 null */
  required_bytes: number | null;
}

export interface StorageInfo {
  db_path: string;
  db_path_source: DbPathSource;
  attachments_dir: string;
  usage: StorageUsage;
  migration_estimate: StorageMigrationEstimate;
  /** 附件遍历被截断（文件数超过上限） */
  truncated: boolean;
}

/** 单文件字节数；不存在或不可读按 0（统计端点不因缺文件失败） */
export function fileBytesOrZero(path: string): number {
  try {
    return statSync(path).size;
  } catch {
    return 0;
  }
}

/**
 * 递归统计目录里的文件数与总字节，最多数 `maxFiles` 个文件。
 * 目录不存在 → 0 个 / 0 字节；超过上限 → `truncated: true`（字节与文件数都不完整）。
 */
export function scanDirectoryCapped(root: string, maxFiles: number = STORAGE_SCAN_MAX_FILES): { files: number; bytes: number; truncated: boolean } {
  if (!existsSync(root)) return { files: 0, bytes: 0, truncated: false };
  let files = 0;
  let bytes = 0;
  const stack: string[] = [root];
  while (stack.length > 0) {
    const dir = stack.pop() as string;
    let entries: Array<{ name: string; isDirectory: () => boolean }>;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      continue; // 单个子目录不可读：跳过，不整体失败
    }
    for (const entry of entries) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        stack.push(path);
        continue;
      }
      files += 1;
      bytes += fileBytesOrZero(path);
      if (files >= maxFiles) {
        // 数到上限就停：宁可报「未知」也不长时间占着请求
        return { files, bytes, truncated: files >= maxFiles };
      }
    }
  }
  return { files, bytes, truncated: false };
}

export interface CollectStorageInfoOptions {
  dbPath: string;
  attachmentsDir: string;
  dbPathSource: DbPathSource;
  /** 卡数（由调用方查库；service 不持有连接） */
  countIssues: () => number;
  maxFiles?: number;
}

export function collectStorageInfo(options: CollectStorageInfoOptions): StorageInfo {
  const dbBytes = fileBytesOrZero(options.dbPath);
  const walBytes = fileBytesOrZero(`${options.dbPath}${DB_SIDECAR_SUFFIXES[0]}`);
  const shmBytes = fileBytesOrZero(`${options.dbPath}${DB_SIDECAR_SUFFIXES[1]}`);
  const scan = scanDirectoryCapped(options.attachmentsDir, options.maxFiles ?? STORAGE_SCAN_MAX_FILES);
  const baseBytes = dbBytes + walBytes + shmBytes;
  const estimatedBytes = scan.truncated ? null : baseBytes + scan.bytes;
  const issueCount = options.countIssues();
  return {
    db_path: options.dbPath,
    db_path_source: options.dbPathSource,
    attachments_dir: options.attachmentsDir,
    usage: {
      db_bytes: dbBytes,
      wal_bytes: walBytes,
      shm_bytes: shmBytes,
      attachments_bytes: scan.truncated ? null : scan.bytes,
      attachments_files: scan.truncated ? null : scan.files,
      total_bytes: scan.truncated ? null : baseBytes + scan.bytes,
    },
    migration_estimate: {
      issue_count: issueCount,
      attachment_count: scan.truncated ? null : scan.files,
      estimated_bytes: estimatedBytes,
      required_bytes: estimatedBytes === null ? null : Math.ceil(estimatedBytes * DB_MIGRATION_SPACE_MARGIN),
    },
    truncated: scan.truncated,
  };
}
