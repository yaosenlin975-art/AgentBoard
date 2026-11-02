import type { Db } from '../connection.js';

/**
 * ACC-07 签到授权与批量签到（纯追加表，不改既有 pinned DDL）。
 *
 * 幂等依据：三张表与索引全部 `IF NOT EXISTS`，重复执行只做存在性判断，不写数据、不改列；
 * `initSchema` 每次启动都调用本迁移，因此「新库首次建表后结构」必须等于「重复启动后结构」。
 *
 * 回滚步骤（按依赖顺序执行，均在事务外）：
 *   DROP TABLE IF EXISTS checkin_batch_item;
 *   DROP TABLE IF EXISTS checkin_batch;
 *   DROP TABLE IF EXISTS checkin_authorization;
 * `account_operation` 未被修改，回滚不丢既有操作记录；`managed_account.checkin_credential_ref`
 * 由业务写入，回滚后如需彻底清理由调用方删除对应 vault 文件（本迁移不触碰文件与凭据）。
 */
export function migrateCheckin(db: Db): void {
  db.exec(`CREATE TABLE IF NOT EXISTS checkin_authorization (
    id TEXT PRIMARY KEY,
    account_id TEXT NOT NULL REFERENCES managed_account(id) ON DELETE CASCADE,
    app_id TEXT NOT NULL CHECK(app_id IN ('workbuddy_desktop','codebuddy_desktop')),
    status TEXT NOT NULL CHECK(status IN ('pending','authorized','failed','expired')),
    remote_state_hash TEXT NOT NULL,
    remote_state_ref TEXT,
    authorization_url TEXT,
    safe_error_code TEXT,
    created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, expires_at INTEGER NOT NULL);
    CREATE UNIQUE INDEX IF NOT EXISTS checkin_authorization_open ON checkin_authorization(account_id) WHERE status='pending';

    CREATE TABLE IF NOT EXISTS checkin_batch (
      id TEXT PRIMARY KEY,
      app_id TEXT NOT NULL CHECK(app_id IN ('workbuddy_desktop','codebuddy_desktop')),
      status TEXT NOT NULL CHECK(status IN ('queued','running','succeeded','partial','failed','cancelled')),
      total INTEGER NOT NULL,
      profile_local_day TEXT,
      created_at INTEGER NOT NULL, finished_at INTEGER);
    CREATE INDEX IF NOT EXISTS checkin_batch_app_state ON checkin_batch(app_id,status);

    CREATE TABLE IF NOT EXISTS checkin_batch_item (
      batch_id TEXT NOT NULL REFERENCES checkin_batch(id) ON DELETE CASCADE,
      account_id TEXT NOT NULL,
      seq INTEGER NOT NULL,
      state TEXT NOT NULL CHECK(state IN ('queued','running','succeeded','already_done','failed','unknown','cancelled')),
      operation_id TEXT REFERENCES account_operation(id) ON DELETE SET NULL,
      safe_error_code TEXT,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY(batch_id,account_id));`);
}
