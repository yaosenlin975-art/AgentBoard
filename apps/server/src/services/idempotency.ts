import { createHash } from 'node:crypto';
import type { Request } from 'express';
import type { Db } from '../db/connection.js';
import { getIdempotencyRecord, insertIdempotencyRecord } from '../db/repos/idempotency.js';
import { ApiError, ValidationError } from '../errors.js';

export interface IdempotencyInput { key: string; actorId: string; action: string; resource: string; payloadHash: string }
const RETENTION_MS = 24 * 60 * 60 * 1000;
function validateIdempotencyInput(input: IdempotencyInput): void {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(input.key) || !input.actorId.trim() || input.actorId.length > 100) throw new ValidationError('Idempotency-Key 必须为 UUID，actor 不能为空');
}
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value !== null && typeof value === 'object') return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([k, v]) => [k, canonical(v)]));
  return value;
}
export function hashPayload(value: unknown): string { return createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex'); }
export function replayIdempotentResult<T>(db: Db, input: IdempotencyInput): T | null {
  validateIdempotencyInput(input);
  return db.transaction(() => {
    const existing = getIdempotencyRecord(db, input.key);
    if (!existing) return null;
    if (existing.actor_id !== input.actorId || existing.action !== input.action || existing.resource !== input.resource || existing.payload_hash !== input.payloadHash) throw new ApiError(409, 'IDEMPOTENCY_KEY_REUSED', '同一请求 ID 不能复用于不同操作');
    if (existing.effect_pending) throw new ApiError(409, 'OPERATION_UNKNOWN', '图片投递结果待确认；不会自动再次发送', { result: JSON.parse(existing.response_json) });
    return JSON.parse(existing.response_json) as T;
  }).immediate();
}
export function withIdempotencyResult<T>(db: Db, input: IdempotencyInput, mutate: () => T, effectPending = false): { result: T; replayed: boolean } {
  validateIdempotencyInput(input);
  return db.transaction(() => {
    const now = Date.now();
    db.prepare('DELETE FROM idempotency_record WHERE expires_at<? AND effect_pending=0').run(now);
    const existing = getIdempotencyRecord(db, input.key);
    if (existing) {
      if (existing.actor_id !== input.actorId || existing.action !== input.action || existing.resource !== input.resource || existing.payload_hash !== input.payloadHash) throw new ApiError(409, 'IDEMPOTENCY_KEY_REUSED', '同一请求 ID 不能复用于不同操作');
      if (existing.effect_pending) throw new ApiError(409, 'OPERATION_UNKNOWN', '评论已保存，唤醒结果待确认；不会自动再次唤醒', { result: JSON.parse(existing.response_json) });
      return { result: JSON.parse(existing.response_json) as T, replayed: true };
    }
    const result = mutate();
    if (result === undefined || (result !== null && typeof result === 'object' && 'then' in result)) throw new Error('Idempotency mutation must synchronously return a JSON response');
    insertIdempotencyRecord(db, { request_id: input.key, actor_id: input.actorId, action: input.action, resource: input.resource, payload_hash: input.payloadHash, response_json: JSON.stringify(result), effect_pending: Number(effectPending), created_at: now, expires_at: now + RETENTION_MS });
    return { result, replayed: false };
  }).immediate();
}
export function withIdempotency<T>(db: Db, input: IdempotencyInput, mutate: () => T): T { return withIdempotencyResult(db, input, mutate).result; }
export function httpMutation<T>(db: Db, req: Request, mutate: () => T, effectPending = false): { result: T; replayed: boolean } {
  const key = req.get('Idempotency-Key');
  if (!key) return { result: mutate(), replayed: false };
  const actor = req.body?.actor ?? req.body?.agent_id ?? 'user';
  if (typeof actor !== 'string') throw new ValidationError('actor 不合法');
  return withIdempotencyResult(db, { key, actorId: actor, action: req.method, resource: `${req.baseUrl}${req.path}`, payloadHash: hashPayload({ body: req.body, query: req.query }) }, mutate, effectPending);
}
export function finishIdempotentEffect(db: Db, key: string, result: unknown): void {
  db.prepare('UPDATE idempotency_record SET response_json=?,effect_pending=0 WHERE request_id=? AND effect_pending=1').run(JSON.stringify(result), key);
}
