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

export function computeSnapshotLag(input: SnapshotLagInput): number | null {
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
