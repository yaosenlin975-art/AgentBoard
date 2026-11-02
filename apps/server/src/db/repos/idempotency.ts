import type { Db } from '../connection.js';
export interface IdempotencyRecord {
  request_id: string; actor_id: string; action: string; resource: string; payload_hash: string;
  response_json: string; effect_pending: number; created_at: number; expires_at: number;
}
export function getIdempotencyRecord(db: Db, key: string): IdempotencyRecord | null {
  return db.prepare('SELECT * FROM idempotency_record WHERE request_id=?').get(key) as IdempotencyRecord | undefined ?? null;
}
export function insertIdempotencyRecord(db: Db, row: IdempotencyRecord): void {
  db.prepare('INSERT INTO idempotency_record(request_id,actor_id,action,resource,payload_hash,response_json,effect_pending,created_at,expires_at) VALUES(@request_id,@actor_id,@action,@resource,@payload_hash,@response_json,@effect_pending,@created_at,@expires_at)').run(row);
}
