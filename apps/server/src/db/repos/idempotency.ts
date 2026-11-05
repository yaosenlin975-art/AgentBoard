import type { Db } from '../connection.js';

/**
 * BORROW-4.1：幂等记录带工作区作用域（'' = 升级前旧行的全局作用域）与副作用阶段 effect_state
 * （'pending'=未生效，'applied'=已生效）。effect_pending 为兼容派生列（1↔'pending'，0↔'applied'）。
 */
export interface IdempotencyRecord {
  workspace_id: string; request_id: string; actor_id: string; action: string; resource: string; payload_hash: string;
  response_json: string; effect_pending: number; effect_state: string; created_at: number; expires_at: number;
}

/** 按 (workspace_id, key) 精确查；查不到且带了工作区时回退旧行（workspace_id=''），保证升级前的 key 重放仍命中 */
export function getIdempotencyRecord(db: Db, key: string, workspaceId = ''): IdempotencyRecord | null {
  const exact = db.prepare('SELECT * FROM idempotency_record WHERE request_id=? AND workspace_id=?')
    .get(key, workspaceId) as IdempotencyRecord | undefined;
  if (exact || workspaceId === '') return exact ?? null;
  return (db.prepare('SELECT * FROM idempotency_record WHERE request_id=? AND workspace_id=?')
    .get(key, '') as IdempotencyRecord | undefined) ?? null;
}

export function insertIdempotencyRecord(db: Db, row: IdempotencyRecord): void {
  db.prepare(`INSERT INTO idempotency_record
    (workspace_id, request_id, actor_id, action, resource, payload_hash, response_json, effect_pending, effect_state, created_at, expires_at)
    VALUES(@workspace_id, @request_id, @actor_id, @action, @resource, @payload_hash, @response_json, @effect_pending, @effect_state, @created_at, @expires_at)`).run(row);
}
