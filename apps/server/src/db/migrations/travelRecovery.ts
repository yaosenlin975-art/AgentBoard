import type { Db } from '../connection.js';

/**
 * TRAVEL-REC：WorkBuddy 猫猫旅行「派出 → 回收」轮次持久化（纯追加表，不改既有 pinned DDL）。
 *
 * 背景：签到成功后的旅行 `afterCheckin` 会把结果只写进 `account_operation.recovery_ref` 文本，
 * 没有轮次 id / 派出时间 / 到期时间，进程重启后无法续回收。本表记录每条已派出的轮次：
 * - `due_at` = 派出时间 + 3 小时 45 分（4 小时得分窗口留 15 分钟安全余量的回收时刻）；
 * - 唯一索引保证同一账号至多一条 `pending`，重复记录不重置到期时间；
 * - 状态只前进：pending → claimed / missed / failed。
 *
 * 幂等依据：表与索引全部 `IF NOT EXISTS`；`initSchema` 每次启动都调用本迁移，
 * 「新库首次建表后结构」必须等于「重复启动后结构」。
 *
 * 回滚步骤（事务外执行）：
 *   DROP TABLE IF EXISTS workbuddy_travel_round;
 * 本迁移不触碰 managed_account / account_operation / vault，回滚不丢既有签到与凭据数据。
 */
export function migrateTravelRecovery(db: Db): void {
  db.exec(`CREATE TABLE IF NOT EXISTS workbuddy_travel_round (
    id TEXT PRIMARY KEY,
    account_id TEXT NOT NULL,
    operation_id TEXT,
    state TEXT NOT NULL CHECK(state IN ('pending','claimed','missed','failed')),
    dispatched_at INTEGER NOT NULL,
    due_at INTEGER NOT NULL,
    attempts INTEGER NOT NULL DEFAULT 0,
    last_attempt_at INTEGER,
    safe_error_code TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL);
    CREATE UNIQUE INDEX IF NOT EXISTS workbuddy_travel_round_open ON workbuddy_travel_round(account_id) WHERE state='pending';
    CREATE INDEX IF NOT EXISTS workbuddy_travel_round_due ON workbuddy_travel_round(state,due_at);
    CREATE INDEX IF NOT EXISTS workbuddy_travel_round_account ON workbuddy_travel_round(account_id,created_at);`);
}
