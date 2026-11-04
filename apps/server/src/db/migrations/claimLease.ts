import type { Db } from '../connection.js';
import { ensureColumn } from './column.js';

/**
 * BORROW-0.2：占用租约（claim lease）。
 *
 * - `claim_lease_until`：占用到期时刻（ms）；claim 写入 now+CLAIM_LEASE_MS，heartbeat 续租，done/fail/release 清空。
 *   NULL = 无租约语义（存量占用 / 老版本写入）→ **不可抢占**，避免把无法判断新旧的老占用误清。
 * - `claim_fence`：占用代次，每次 claim（含抢占）+1；本卡只落列与自增，校验属 B03。
 * - `last_heartbeat_at`：最后一次续租时刻，观测用。
 *
 * 部分索引只覆盖「未过期占用」的查询面（sweep / 抢占判定都按 claimed_by IS NOT NULL AND claim_lease_until IS NOT NULL 过滤）。
 *
 * 幂等依据：ensureColumn 先查 PRAGMA 再 ALTER，索引 IF NOT EXISTS，可重复执行。
 * 回滚（列仅本功能写入，NULL/0 不影响其它路径；索引可独立删）：
 *   DROP INDEX IF EXISTS idx_issue_claim_lease;
 *   ALTER TABLE issue DROP COLUMN claim_lease_until; （+ claim_fence / last_heartbeat_at）
 */
export function migrateClaimLease(db: Db): void {
  ensureColumn(db, 'issue', 'claim_lease_until', 'claim_lease_until INTEGER');
  ensureColumn(db, 'issue', 'claim_fence', 'claim_fence INTEGER NOT NULL DEFAULT 0');
  ensureColumn(db, 'issue', 'last_heartbeat_at', 'last_heartbeat_at INTEGER');
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_issue_claim_lease
      ON issue(claim_lease_until)
      WHERE claimed_by IS NOT NULL AND claim_lease_until IS NOT NULL
  `);
}
