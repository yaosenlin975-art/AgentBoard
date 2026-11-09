/**
 * STORE-7（M5）：`GET /api/workspaces` 的只读 `snapshot_lag`。
 *
 * 口径：快照是派生物（设计 §5.8「库为准」），落后条数按行数差近似——
 * `Σ max(0, 当前库该表 scoped 行数 − manifest 登记 rows)`。
 * - `<ws>/.agentboard/snapshot/manifest.json` 不存在 → `null`（从未导出，不谎报 0）；
 * - manifest 损坏 / 库打不开 → `null`（列表接口不能被单个坏快照拖垮）。
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import type { Db } from '../db/connection.js';
import { workspaceStateDir } from '../db/resolver.js';
import { countScopedRowsByTable } from './workspaceScopedQueries.js';

interface ManifestLike {
  files?: Array<{ table?: unknown; rows?: unknown }>;
}

export interface SnapshotLagInput {
  workspaceId: string;
  workspacePath: string;
  /** 解析层判定后实际生效的库路径 */
  effectiveDbPath: string;
  /** 中心库（effectiveDbPath 与它相同时直接复用句柄） */
  centerDb: Db;
}

/**
 * CR2-3（PERF-1 回归）：进程内 TTL 缓存——列表热路径不再每工作区每请求重开 readonly 库 +
 * 14 条 COUNT(*)（改造前 20 区实测 ~22.9ms，与 PERF-1 F2 已修掉的「每请求开库」同模式）。
 * 按 workspace_id 缓存 60s：正值与 null/失败都缓存（坏快照/库打不开也防抖，避免每请求重试拖垮列表）。
 * 失效：manifest 唯一写入点 exportWorkspaceSnapshot 落盘后清对应条目（本地化流程走它）；
 * 库行数变化靠 TTL 收敛。响应契约不变：snapshot_lag 语义不变，仅来源变缓存。
 */
const SNAPSHOT_LAG_TTL_MS = 60_000;

interface SnapshotLagCacheEntry {
  value: number | null;
  computedAt: number;
}

const snapshotLagCache = new Map<string, SnapshotLagCacheEntry>();

/** CR2-3：manifest 落盘后的失效钩子（workspaceSnapshot.exportWorkspaceSnapshot 调用） */
export function invalidateSnapshotLagCache(workspaceId: string): void {
  snapshotLagCache.delete(workspaceId);
}

export function computeSnapshotLag(input: SnapshotLagInput): number | null {
  const cached = snapshotLagCache.get(input.workspaceId);
  if (cached !== undefined && Date.now() - cached.computedAt < SNAPSHOT_LAG_TTL_MS) {
    return cached.value;
  }
  const value = computeSnapshotLagUncached(input);
  snapshotLagCache.set(input.workspaceId, { value, computedAt: Date.now() });
  return value;
}

function computeSnapshotLagUncached(input: SnapshotLagInput): number | null {
  const manifestPath = join(workspaceStateDir(input.workspacePath), 'snapshot', 'manifest.json');
  if (!existsSync(manifestPath)) return null;

  let manifest: ManifestLike;
  try {
    manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as ManifestLike;
  } catch {
    return null;
  }
  if (!Array.isArray(manifest.files)) return null;

  const sameAsCenter = input.centerDb.name === input.effectiveDbPath;
  let db: Db = input.centerDb;
  if (!sameAsCenter) {
    try {
      db = new Database(input.effectiveDbPath, { readonly: true, fileMustExist: true });
    } catch {
      return null;
    }
  }
  try {
    const live = countScopedRowsByTable(db, input.workspaceId);
    let lag = 0;
    for (const entry of manifest.files) {
      if (typeof entry.table !== 'string' || typeof entry.rows !== 'number') continue;
      lag += Math.max(0, (live[entry.table] ?? 0) - entry.rows);
    }
    return lag;
  } catch {
    return null;
  } finally {
    if (!sameAsCenter) {
      try { db.close(); } catch { /* 忽略 */ }
    }
  }
}
