/**
 * STORE-1（M1）：中心库 `workspace` 行加「分布式存储」三列（幂等）。
 *
 * 只加列、不改行数据：`db_mode` 缺省 `center`（= 未下沉，行为与现状一致），
 * `localized_at` / `last_migration_id` 缺省 NULL（等 STORE-2 的状态机写入）。
 *
 * 注意：本迁移必须注册在**所有会重建 `workspace` 表的迁移之后**（与 `migrateDeviceIdentity` 同一约束），
 * 否则重建会把这几个后加列丢掉。
 */
import type { Db } from '../connection.js';

const COLUMNS: Array<{ name: string; ddl: string }> = [
  /** 期望状态：center | localizing | localized | failed */
  { name: 'db_mode', ddl: "ALTER TABLE workspace ADD COLUMN db_mode TEXT NOT NULL DEFAULT 'center'" },
  /** 最近一次完成下沉的时间（epoch ms） */
  { name: 'localized_at', ddl: 'ALTER TABLE workspace ADD COLUMN localized_at INTEGER' },
  /** 最近一次迁移 id（STORE-2 状态机用，便于排障与幂等重放） */
  { name: 'last_migration_id', ddl: 'ALTER TABLE workspace ADD COLUMN last_migration_id TEXT' },
];

export function migrateWorkspaceDbMode(db: Db): void {
  const existing = new Set(
    (db.prepare('PRAGMA table_info(workspace)').all() as Array<{ name: string }>).map((column) => column.name),
  );
  for (const column of COLUMNS) {
    if (existing.has(column.name)) continue;
    db.exec(column.ddl);
  }
  // 只做「合法值兜底」，不改任何业务数据（老行全是缺省 center）
  db.exec(`CREATE INDEX IF NOT EXISTS idx_workspace_db_mode ON workspace(db_mode)`);
}
