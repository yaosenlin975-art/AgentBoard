/**
 * STORE-4b（M3）：中心库定位索引 `entity_locator` 的维护与重建。
 *
 * 薄索引、**不是事实来源**：只回答「这个 id 归哪个工作区（`workspace_id` NULL = 中心 common）」，
 * 不存库路径、不做一致性约束——行缺失或过期时读侧回退 fan-out 扫描（`resolver.locateDbByScan`），
 * 全表可由 `rebuildEntityLocator` 随时重建。因此本文件所有维护写入一律吞错：
 * 索引失败只降级为「兜底扫描」，绝不反过来打断业务写。
 *
 * 表结构由 `migrations/entityLocator.ts` 建立（中心库与工作区库同构；只有中心库这张被读写）。
 */
import type { Db } from '../connection.js';

export type EntityLocatorKind = 'issue' | 'session' | 'knowledge_page';

/**
 * 业务库句柄 → 中心库句柄（repos 层维护索引用）。
 * routes.ts 装配时绑定（中心句柄自绑 + 每个工作区句柄绑中心）；未绑定的句柄按「自身即中心」处理
 * ——直接以中心库调用 repo 的既有路径（含单测）行为不变。
 */
const centerBindings = new WeakMap<Db, Db>();

export function bindEntityLocatorCenter(db: Db, centerDb: Db): void {
  centerBindings.set(db, centerDb);
}

/** 业务句柄对应的中心库句柄（未绑定按「自身即中心」——中心库直连路径与既有单测行为不变） */
export function centerLocatorDb(db: Db): Db {
  return centerBindings.get(db) ?? db;
}

/** 创建（或工作区归属变化时）写索引行；索引表被删等情况静默降级 */
export function upsertEntityLocator(centerDb: Db, kind: EntityLocatorKind, entityId: string, workspaceId: string | null): void {
  try {
    centerDb.prepare(
      'INSERT INTO entity_locator (entity_id, kind, workspace_id, created_at) VALUES (?,?,?,?) '
      + 'ON CONFLICT(entity_id) DO UPDATE SET kind=excluded.kind, workspace_id=excluded.workspace_id',
    ).run(entityId, kind, workspaceId, Date.now());
  } catch {
    /* 索引不是事实来源：写失败降级为读侧 fan-out 兜底 */
  }
}

/** 删除（硬删/软删均视为「不再可按 id 寻址」）时清索引行 */
export function removeEntityLocator(centerDb: Db, kind: EntityLocatorKind, entityId: string): void {
  try {
    centerDb.prepare('DELETE FROM entity_locator WHERE entity_id=? AND kind=?').run(entityId, kind);
  } catch {
    /* 同上 */
  }
}

/** 删除工作区（级联清 issue/session/知识页）时清该区全部索引行；common 页（workspace_id NULL）不受影响 */
export function removeEntityLocatorByWorkspace(centerDb: Db, workspaceId: string): void {
  try {
    centerDb.prepare('DELETE FROM entity_locator WHERE workspace_id=?').run(workspaceId);
  } catch {
    /* 同上 */
  }
}

/**
 * 读索引：`undefined` = 无索引行（读侧回退扫描）；`workspace_id: null` = 中心 common。
 * 表被删（删表重建路径的中间态）返回 undefined，调用方自然走兜底。
 */
export function findEntityLocator(centerDb: Db, kind: EntityLocatorKind, entityId: string): { workspace_id: string | null } | undefined {
  try {
    return centerDb.prepare('SELECT workspace_id FROM entity_locator WHERE entity_id=? AND kind=?').get(entityId, kind) as
      | { workspace_id: string | null }
      | undefined;
  } catch {
    return undefined;
  }
}

/** 重建数据源：逐库直读三张实体表（工作区库缺表时跳过该表，不影响其它来源） */
const SOURCE_QUERIES: ReadonlyArray<readonly [EntityLocatorKind, string]> = [
  ['issue', 'SELECT id, workspace_id FROM issue'],
  ['session', 'SELECT id, workspace_id FROM session'],
  ['knowledge_page', "SELECT id, workspace_id FROM knowledge_page WHERE status<>'deleted'"],
];

/**
 * 全量重建（可重入）：清空后按给定库逐个回填，单事务完成。
 * 重复执行结果一致；`sources` 通常为 `[centerDb, ...已下沉工作区库]`——调用方决定开哪些库，
 * 本函数不开库、不取锁。
 */
export function rebuildEntityLocator(centerDb: Db, sources: readonly Db[]): void {
  const now = Date.now();
  centerDb.transaction(() => {
    centerDb.prepare('DELETE FROM entity_locator').run();
    const insert = centerDb.prepare(
      'INSERT OR REPLACE INTO entity_locator (entity_id, kind, workspace_id, created_at) VALUES (?,?,?,?)',
    );
    for (const source of sources) {
      for (const [kind, sql] of SOURCE_QUERIES) {
        let rows: Array<{ id: string; workspace_id: string | null }>;
        try {
          rows = source.prepare(sql).all() as Array<{ id: string; workspace_id: string | null }>;
        } catch {
          continue; // 源库缺该表（空工作区库/最小替身）：跳过，索引可再重建
        }
        for (const row of rows) insert.run(row.id, kind, row.workspace_id, now);
      }
    }
  })();
}

/**
 * 启动回填判定：索引表为空且中心库已有实体（含本功能上线前的存量数据）时需要回填。
 * 只探中心库（不开工作区库——已下沉区实体缺行由读侧 fan-out 兜底）；表缺失/查询失败按不需要处理。
 */
export function entityLocatorNeedsBackfill(centerDb: Db): boolean {
  try {
    const count = (centerDb.prepare('SELECT COUNT(*) AS n FROM entity_locator').get() as { n: number }).n;
    if (count > 0) return false;
    const has = centerDb.prepare(
      "SELECT (EXISTS(SELECT 1 FROM issue) OR EXISTS(SELECT 1 FROM session) OR EXISTS(SELECT 1 FROM knowledge_page WHERE status<>'deleted')) AS has",
    ).get() as { has: number };
    return has.has === 1;
  } catch {
    return false;
  }
}
