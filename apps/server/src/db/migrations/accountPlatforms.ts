import type { Db } from '../connection.js';

/**
 * ACC-10：把 `managed_account` / `account_operation` 的 `app_id` CHECK 从两个旧值扩到四个值
 * （`workbuddy_desktop` / `codebuddy_desktop` / `minimax` / `trae`）。
 *
 * SQLite 无法就地修改 CHECK，只能按官方推荐的「建新表 → 拷数据 → 删旧表 → 改名」重建；
 * 两张表都有外键（`account_operation.account_id → managed_account(id)`、`checkin_*` 指向两者），
 * 因此按 sqlite.org/lang_altertable.html 的步骤：临时关 `foreign_keys` 与 `legacy_alter_table`、
 * 单事务重建、`foreign_key_check` 校验后恢复原 pragma 值。
 *
 * 幂等依据：读 `sqlite_master` 里 `managed_account` 的建表 SQL，已含 `'minimax'` 就整段跳过。
 *
 * 回滚（降级）——**要求先人工清理非旧值行，不做静默删数据**：
 *   1) 先确认并处理掉新平台的行（二选一，自己决定留档还是丢弃）：
 *        SELECT id, app_id, display_name FROM managed_account WHERE app_id IN ('minimax','trae');
 *        DELETE FROM account_operation WHERE app_id IN ('minimax','trae');
 *        DELETE FROM managed_account   WHERE app_id IN ('minimax','trae');
 *   2) PRAGMA foreign_keys=OFF; BEGIN;
 *   3) 用同样的「建新表 → 拷数据 → 删旧表 → 改名」把两张表的 CHECK 改回
 *        CHECK(app_id IN ('workbuddy_desktop','codebuddy_desktop'))
 *      （列定义与本次新表完全一致，只改 CHECK 列表；`recovers_operation_id` 保持存在）；
 *   4) 重建索引 `account_operation_batch` / `account_operation_instance`；
 *   5) PRAGMA foreign_key_check; COMMIT; PRAGMA foreign_keys=ON;
 * 若未先清理新平台行，第 3 步的 `INSERT ... SELECT` 会被旧 CHECK 拒绝 —— 这是**故意的**：
 * 宁可迁移失败并让人看见，也不静默丢数据。
 */

const LEGACY_APP_IDS = "'workbuddy_desktop','codebuddy_desktop'";
const APP_IDS = "'workbuddy_desktop','codebuddy_desktop','minimax','trae','qoder_cn','zcode'";

const managedAccountDdl = (table: string): string => `CREATE TABLE ${table} (
  id TEXT PRIMARY KEY, app_id TEXT NOT NULL CHECK(app_id IN (${APP_IDS})),
  client_instance_id TEXT NOT NULL, service_region TEXT NOT NULL CHECK(service_region IN ('cn','global','unknown')),
  identity_hash TEXT NOT NULL, display_name TEXT NOT NULL, identity_hint TEXT,
  client_snapshot_ref TEXT, checkin_credential_ref TEXT, client_snapshot_version INTEGER NOT NULL DEFAULT 1,
  checkin_capability TEXT NOT NULL DEFAULT 'unknown' CHECK(checkin_capability IN ('unknown','supported','unsupported')),
  enabled INTEGER NOT NULL DEFAULT 1 CHECK(enabled IN(0,1)), last_checkin_day TEXT, last_checkin_status TEXT, last_checkin_at INTEGER,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, UNIQUE(app_id,client_instance_id,identity_hash));`;

const accountOperationDdl = (table: string): string => `CREATE TABLE ${table} (
  id TEXT PRIMARY KEY, batch_id TEXT, account_id TEXT REFERENCES managed_account(id) ON DELETE SET NULL,
  app_id TEXT NOT NULL CHECK(app_id IN (${APP_IDS})), client_instance_id TEXT NOT NULL,
  operation TEXT NOT NULL CHECK(operation IN ('capture','switch','checkin','restore')),
  state TEXT NOT NULL CHECK(state IN ('queued','running','succeeded','already_done','failed','unknown','recovery_required')),
  stage TEXT NOT NULL CHECK(stage IN ('preflight','stop','snapshot','validate_target','write','start','verify','rollback')),
  safe_error_code TEXT, recovery_ref TEXT, recovers_operation_id TEXT REFERENCES account_operation(id) ON DELETE RESTRICT,
  created_at INTEGER NOT NULL, started_at INTEGER, finished_at INTEGER);`;

/** 该表当前的建表 SQL（不存在返回 undefined） */
function tableSql(db: Db, name: string): string | undefined {
  const row = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name=?").get(name) as { sql: string } | undefined;
  return row?.sql;
}

export function migrateAccountPlatforms(db: Db): void {
  const managedSql = tableSql(db, 'managed_account');
  // 幂等：已扩展过（建表 SQL 里出现 minimax）就跳过
  if (!managedSql || managedSql.includes("'qoder_cn'")) return;

  const previousForeignKeys = db.pragma('foreign_keys', { simple: true }) as number;
  const previousLegacyAlter = db.pragma('legacy_alter_table', { simple: true }) as number;
  db.pragma('foreign_keys = OFF');
  db.pragma('legacy_alter_table = ON');
  try {
    db.transaction(() => {
      db.exec(managedAccountDdl('managed_account_new'));
      db.exec('INSERT INTO managed_account_new SELECT * FROM managed_account');
      db.exec('DROP TABLE managed_account');
      db.exec('ALTER TABLE managed_account_new RENAME TO managed_account');

      db.exec(accountOperationDdl('account_operation_new'));
      db.exec('INSERT INTO account_operation_new SELECT * FROM account_operation');
      db.exec('DROP TABLE account_operation');
      db.exec('ALTER TABLE account_operation_new RENAME TO account_operation');

      db.exec(`CREATE INDEX IF NOT EXISTS account_operation_batch ON account_operation(batch_id,created_at);
        CREATE INDEX IF NOT EXISTS account_operation_instance ON account_operation(app_id,client_instance_id,state);`);
    }).immediate();
    const violations = db.pragma('foreign_key_check') as unknown[];
    if (violations.length > 0) throw new Error(`account 表重建后外键校验失败：${JSON.stringify(violations).slice(0, 500)}`);
  } finally {
    db.pragma(`legacy_alter_table = ${previousLegacyAlter === 1 ? 'ON' : 'OFF'}`);
    db.pragma(`foreign_keys = ${previousForeignKeys === 1 ? 'ON' : 'OFF'}`);
  }
}

/** 供测试/诊断：旧值的合法 app_id 列表（回滚口径文档化用） */
export const LEGACY_APP_ID_CHECK = LEGACY_APP_IDS;
