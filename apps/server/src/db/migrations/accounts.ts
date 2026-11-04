import type { Db } from '../connection.js';
export function migrateAccounts(db: Db): void {
  db.exec(`CREATE TABLE IF NOT EXISTS managed_account (
    id TEXT PRIMARY KEY, app_id TEXT NOT NULL CHECK(app_id IN ('workbuddy_desktop','codebuddy_desktop','minimax','trae','qoder_cn','zcode')),
    client_instance_id TEXT NOT NULL, service_region TEXT NOT NULL CHECK(service_region IN ('cn','global','unknown')),
    identity_hash TEXT NOT NULL, display_name TEXT NOT NULL, identity_hint TEXT,
    client_snapshot_ref TEXT, checkin_credential_ref TEXT, client_snapshot_version INTEGER NOT NULL DEFAULT 1,
    checkin_capability TEXT NOT NULL DEFAULT 'unknown' CHECK(checkin_capability IN ('unknown','supported','unsupported')),
    enabled INTEGER NOT NULL DEFAULT 1 CHECK(enabled IN(0,1)), last_checkin_day TEXT, last_checkin_status TEXT, last_checkin_at INTEGER,
    created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, UNIQUE(app_id,client_instance_id,identity_hash));
    CREATE TABLE IF NOT EXISTS account_operation (
      id TEXT PRIMARY KEY, batch_id TEXT, account_id TEXT REFERENCES managed_account(id) ON DELETE SET NULL,
      app_id TEXT NOT NULL CHECK(app_id IN ('workbuddy_desktop','codebuddy_desktop','minimax','trae','qoder_cn','zcode')), client_instance_id TEXT NOT NULL,
      operation TEXT NOT NULL CHECK(operation IN ('capture','switch','checkin','restore')),
      state TEXT NOT NULL CHECK(state IN ('queued','running','succeeded','already_done','failed','unknown','recovery_required')),
      stage TEXT NOT NULL CHECK(stage IN ('preflight','stop','snapshot','validate_target','write','start','verify','rollback')),
      safe_error_code TEXT,recovery_ref TEXT,recovers_operation_id TEXT REFERENCES account_operation(id) ON DELETE RESTRICT,created_at INTEGER NOT NULL,started_at INTEGER,finished_at INTEGER);
    CREATE INDEX IF NOT EXISTS account_operation_batch ON account_operation(batch_id,created_at);
    CREATE INDEX IF NOT EXISTS account_operation_instance ON account_operation(app_id,client_instance_id,state);`);
  const columns = db.prepare('PRAGMA table_info(account_operation)').all() as Array<{ name: string }>;
  if (!columns.some(c => c.name === 'recovers_operation_id')) db.exec('ALTER TABLE account_operation ADD COLUMN recovers_operation_id TEXT REFERENCES account_operation(id) ON DELETE RESTRICT');
}
