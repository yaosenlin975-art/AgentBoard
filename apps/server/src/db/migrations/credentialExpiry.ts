/**
 * ACC-TOKEN-2：凭据到期/失效四列（纯加法，幂等：每列先查 `PRAGMA table_info` 再加）。
 *
 * 硬约束（设计页 §3）：DPAPI 单次解密 5–9s ⇒ 列表接口绝不逐账号解密，到期时间与失效标记
 * 必须在写入时落库，列表只读列。
 * - `credential_expires_at`：凭据到期时间（epoch ms；NULL=未知）
 * - `credential_status`：落库基准值（读取时按 now 与 expires_at 即时修正 expired/expiring）
 * - `credential_refresh_method`：平台静态表 ⊕ 载荷能力（minimax 无 refresh_token 降 recapture）
 * - `credential_invalid_at`：最近一次凭据被服务端判失效（401 / invalid_grant）且未恢复的时间
 *
 * 老数据不回填（不解密），保持 `unknown`，由下一次写入点自然补齐。
 * 注册位置：schema.ts 的 `migrateDeviceIdentity(db)` 之后——同样必须排在 accountPlatforms /
 * checkinPlatforms 这类 DROP+CREATE 重建 managed_account 的迁移之后，否则加列被重建带走。
 */
import type { Db } from '../connection.js';

interface ColumnRow { name: string }

function hasColumn(db: Db, table: string, column: string): boolean {
  const rows = db.prepare(`PRAGMA table_info(${table})`).all() as ColumnRow[];
  return rows.some(row => row.name === column);
}

export function migrateCredentialExpiry(db: Db): void {
  const columns: Array<{ name: string; ddl: string }> = [
    { name: 'credential_expires_at', ddl: 'ALTER TABLE managed_account ADD COLUMN credential_expires_at INTEGER' },
    {
      name: 'credential_status',
      ddl: "ALTER TABLE managed_account ADD COLUMN credential_status TEXT NOT NULL DEFAULT 'unknown' CHECK(credential_status IN ('valid','expiring','expired','invalid','unknown'))",
    },
    {
      name: 'credential_refresh_method',
      ddl: "ALTER TABLE managed_account ADD COLUMN credential_refresh_method TEXT CHECK(credential_refresh_method IS NULL OR credential_refresh_method IN ('refresh_token','recapture','relogin'))",
    },
    { name: 'credential_invalid_at', ddl: 'ALTER TABLE managed_account ADD COLUMN credential_invalid_at INTEGER' },
  ];
  for (const column of columns) {
    if (!hasColumn(db, 'managed_account', column.name)) db.exec(column.ddl);
  }
}
