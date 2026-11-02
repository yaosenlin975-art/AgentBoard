import type { Db } from '../connection.js';
export function migrateIdempotency(db: Db): void {
  db.exec(`CREATE TABLE IF NOT EXISTS idempotency_record (
    request_id TEXT PRIMARY KEY, actor_id TEXT NOT NULL, action TEXT NOT NULL, resource TEXT NOT NULL,
    payload_hash TEXT NOT NULL, response_json TEXT NOT NULL, effect_pending INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL);
    CREATE INDEX IF NOT EXISTS idempotency_expiry ON idempotency_record(expires_at);`);
}
