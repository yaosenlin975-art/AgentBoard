/**
 * ACC-KB-B6：设备身份字段成套搬迁（方案 B）。
 *
 * 迁移内容（幂等：每列先查 `PRAGMA table_info` 再加）：
 * - `managed_account.device_identity_ref`：设备身份快照引用（NULL = 还没回填/不适用）
 * - `managed_account.device_identity_status`：`pending`（待回填/回填失败可重试）/ `ok` / `not_applicable`
 * - `managed_account.device_identity_error`：失败时的固定错误码（见 `services/accounts/deviceIdentity.ts`）
 * - `managed_account.device_identity_updated_at`：最后一次尝试回填的时间
 *
 * 老数据：默认 `pending`（方案 B 要求「加字段 + 一次性回填」，不回填就等于没效果）。
 * 回滚：字段可逆（SQLite 3.53.2 支持 `ALTER TABLE DROP COLUMN`）；**数据不可逆** ——
 * 回填只写**新 ref**、绝不覆盖旧 `client_snapshot_ref`，靠这条保证数据级可回滚。
 */
import type { Db } from '../connection.js';

interface ColumnRow { name: string }

function hasColumn(db: Db, table: string, column: string): boolean {
  const rows = db.prepare(`PRAGMA table_info(${table})`).all() as ColumnRow[];
  return rows.some(row => row.name === column);
}

export function migrateDeviceIdentity(db: Db): void {
  const table = 'managed_account';
  const columns: Array<{ name: string; ddl: string }> = [
    { name: 'device_identity_ref', ddl: 'ALTER TABLE managed_account ADD COLUMN device_identity_ref TEXT' },
    {
      name: 'device_identity_status',
      ddl: "ALTER TABLE managed_account ADD COLUMN device_identity_status TEXT NOT NULL DEFAULT 'pending' CHECK(device_identity_status IN ('pending','ok','not_applicable'))",
    },
    { name: 'device_identity_error', ddl: 'ALTER TABLE managed_account ADD COLUMN device_identity_error TEXT' },
    { name: 'device_identity_updated_at', ddl: 'ALTER TABLE managed_account ADD COLUMN device_identity_updated_at INTEGER' },
  ];
  for (const column of columns) {
    if (!hasColumn(db, table, column.name)) db.exec(column.ddl);
  }
}
