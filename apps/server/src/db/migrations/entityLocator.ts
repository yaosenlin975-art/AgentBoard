/**
 * STORE-4b（M3）：中心库定位索引 `entity_locator`（薄索引，不是事实来源）。
 *
 * `entity_id` 主键：issue/session/知识页 id 均为随机 UUID，跨 kind 不会碰撞；
 * `workspace_id` NULL = 中心 common（知识页），非空 = 归属工作区（读侧再按 db_mode 解析中心/工作区库）。
 * 行由 repos 维护钩子写入，全表可由 `rebuildEntityLocator` 重建——删表后本迁移幂等重建空表，
 * 读侧回退 fan-out 扫描，不丢数据。
 *
 * 幂等依据：表与索引全部 `IF NOT EXISTS`，`initSchema` 每次启动都调用，重复执行不改结构、不写数据。
 */
import type { Db } from '../connection.js';

export function migrateEntityLocator(db: Db): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS entity_locator (
      entity_id TEXT PRIMARY KEY,
      kind TEXT NOT NULL,
      workspace_id TEXT,
      created_at INTEGER NOT NULL);
    CREATE INDEX IF NOT EXISTS idx_entity_locator_workspace ON entity_locator(workspace_id);
  `);
}
