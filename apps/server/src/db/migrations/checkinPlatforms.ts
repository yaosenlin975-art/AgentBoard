import type { Db } from '../connection.js';

/**
 * ACC-12：`checkin_authorization` / `checkin_batch` 的 `app_id` CHECK 也扩到四值。
 *
 * 为什么需要：ACC-10 只重建了 `managed_account` / `account_operation`，而签到两表各自也有
 * `CHECK(app_id IN ('workbuddy_desktop','codebuddy_desktop'))`，导致 minimax / trae 无法建批次
 * （`createCheckinBatch` 直接 SQLITE_CONSTRAINT_CHECK）。本迁移补齐。
 *
 * 幂等依据：读 `sqlite_master` 里 `checkin_batch` 的建表 SQL，已含 `'minimax'` 就整段跳过。
 * 外键：`checkin_authorization.account_id → managed_account(id)`、`checkin_batch_item.batch_id → checkin_batch(id)`，
 * 因此按官方 12 步做法：临时关 `foreign_keys` 与 `legacy_alter_table`、单事务重建、`foreign_key_check` 校验、
 * `finally` 恢复原 pragma。
 *
 * 回滚（降级）——**同样要求先人工清理新平台行**，不静默丢数据：
 *   DELETE FROM checkin_batch_item WHERE batch_id IN (SELECT id FROM checkin_batch WHERE app_id IN ('minimax','trae'));
 *   DELETE FROM checkin_batch WHERE app_id IN ('minimax','trae');
 *   DELETE FROM checkin_authorization WHERE app_id IN ('minimax','trae');
 *   然后按同样「建新表 → 拷数据 → 删旧表 → 改名」把两表 CHECK 改回两值，并重建
 *   `checkin_authorization_open`（唯一部分索引）与 `checkin_batch_app_state`。
 */
const APP_IDS = "'workbuddy_desktop','codebuddy_desktop','minimax','trae','qoder_cn','zcode'";

const authorizationDdl = (table: string): string => `CREATE TABLE ${table} (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES managed_account(id) ON DELETE CASCADE,
  app_id TEXT NOT NULL CHECK(app_id IN (${APP_IDS})),
  status TEXT NOT NULL CHECK(status IN ('pending','authorized','failed','expired')),
  remote_state_hash TEXT NOT NULL,
  remote_state_ref TEXT,
  authorization_url TEXT,
  safe_error_code TEXT,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, expires_at INTEGER NOT NULL);`;

const batchDdl = (table: string): string => `CREATE TABLE ${table} (
  id TEXT PRIMARY KEY,
  app_id TEXT NOT NULL CHECK(app_id IN (${APP_IDS})),
  status TEXT NOT NULL CHECK(status IN ('queued','running','succeeded','partial','failed','cancelled')),
  total INTEGER NOT NULL,
  profile_local_day TEXT,
  created_at INTEGER NOT NULL, finished_at INTEGER);`;

const tableSql = (db: Db, name: string): string | undefined =>
  (db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name=?").get(name) as { sql: string } | undefined)?.sql;

export function migrateCheckinPlatforms(db: Db): void {
  const batchSql = tableSql(db, 'checkin_batch');
  if (!batchSql || batchSql.includes("'qoder_cn'")) return;

  const previousForeignKeys = db.pragma('foreign_keys', { simple: true }) as number;
  const previousLegacyAlter = db.pragma('legacy_alter_table', { simple: true }) as number;
  db.pragma('foreign_keys = OFF');
  db.pragma('legacy_alter_table = ON');
  try {
    db.transaction(() => {
      db.exec(authorizationDdl('checkin_authorization_new'));
      db.exec('INSERT INTO checkin_authorization_new SELECT * FROM checkin_authorization');
      db.exec('DROP TABLE checkin_authorization');
      db.exec('ALTER TABLE checkin_authorization_new RENAME TO checkin_authorization');

      db.exec(batchDdl('checkin_batch_new'));
      db.exec('INSERT INTO checkin_batch_new SELECT * FROM checkin_batch');
      db.exec('DROP TABLE checkin_batch');
      db.exec('ALTER TABLE checkin_batch_new RENAME TO checkin_batch');

      db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS checkin_authorization_open ON checkin_authorization(account_id) WHERE status='pending';
        CREATE INDEX IF NOT EXISTS checkin_batch_app_state ON checkin_batch(app_id,status);`);
    }).immediate();
    const violations = db.pragma('foreign_key_check') as unknown[];
    if (violations.length > 0) throw new Error(`checkin 表重建后外键校验失败：${JSON.stringify(violations).slice(0, 500)}`);
  } finally {
    db.pragma(`legacy_alter_table = ${previousLegacyAlter === 1 ? 'ON' : 'OFF'}`);
    db.pragma(`foreign_keys = ${previousForeignKeys === 1 ? 'ON' : 'OFF'}`);
  }
}
