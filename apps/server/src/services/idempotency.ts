import { createHash } from 'node:crypto';
import type { Request } from 'express';
import type { Db } from '../db/connection.js';
import { getIdempotencyRecord, insertIdempotencyRecord } from '../db/repos/idempotency.js';
import { ApiError, ValidationError } from '../errors.js';

/**
 * BORROW-4.1：幂等键按工作区作用域隔离（workspaceId 缺省 '' = 全局/旧行作用域），
 * effect_state 记录副作用阶段（'pending'=未生效，重放 409 OPERATION_UNKNOWN；'applied'=已生效，重放返回结果）。
 */
export interface IdempotencyInput { key: string; actorId: string; action: string; resource: string; payloadHash: string; workspaceId?: string }
const RETENTION_MS = 24 * 60 * 60 * 1000;
/** 请求作用域：body/query 的 workspace_id 优先，其次路径参数 :workspaceId（changelog/状态字典等嵌套路由），都没有归入全局 '' */
function requestWorkspaceId(req: Request): string {
  const raw = req.body?.workspace_id ?? req.query.workspace_id ?? (req.params as Record<string, string | undefined>).workspaceId;
  return typeof raw === 'string' && raw !== '' ? raw : '';
}
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
    const existing = getIdempotencyRecord(db, input.key, input.workspaceId);
    if (!existing) return null;
    if (existing.actor_id !== input.actorId || existing.action !== input.action || existing.resource !== input.resource || existing.payload_hash !== input.payloadHash) throw new ApiError(409, 'IDEMPOTENCY_KEY_REUSED', '同一请求 ID 不能复用于不同操作');
    if (existing.effect_state !== 'applied') throw new ApiError(409, 'OPERATION_UNKNOWN', '图片投递结果待确认；不会自动再次发送', { result: JSON.parse(existing.response_json) });
    return JSON.parse(existing.response_json) as T;
  }).immediate();
}
export function withIdempotencyResult<T>(db: Db, input: IdempotencyInput, mutate: () => T, effectPending = false): { result: T; replayed: boolean } {
  validateIdempotencyInput(input);
  const workspaceId = input.workspaceId ?? '';
  return db.transaction(() => {
    const now = Date.now();
    db.prepare("DELETE FROM idempotency_record WHERE expires_at<? AND effect_state='applied'").run(now);
    const existing = getIdempotencyRecord(db, input.key, workspaceId);
    if (existing) {
      if (existing.actor_id !== input.actorId || existing.action !== input.action || existing.resource !== input.resource || existing.payload_hash !== input.payloadHash) throw new ApiError(409, 'IDEMPOTENCY_KEY_REUSED', '同一请求 ID 不能复用于不同操作');
      if (existing.effect_state !== 'applied') throw new ApiError(409, 'OPERATION_UNKNOWN', '评论已保存，唤醒结果待确认；不会自动再次唤醒', { result: JSON.parse(existing.response_json) });
      return { result: JSON.parse(existing.response_json) as T, replayed: true };
    }
    const result = mutate();
    if (result === undefined || (result !== null && typeof result === 'object' && 'then' in result)) throw new Error('Idempotency mutation must synchronously return a JSON response');
    insertIdempotencyRecord(db, { workspace_id: workspaceId, request_id: input.key, actor_id: input.actorId, action: input.action, resource: input.resource, payload_hash: input.payloadHash, response_json: JSON.stringify(result), effect_pending: Number(effectPending), effect_state: effectPending ? 'pending' : 'applied', created_at: now, expires_at: now + RETENTION_MS });
    return { result, replayed: false };
  }).immediate();
}
export function withIdempotency<T>(db: Db, input: IdempotencyInput, mutate: () => T): T { return withIdempotencyResult(db, input, mutate).result; }
export function httpMutation<T>(db: Db, req: Request, mutate: () => T, effectPending = false): { result: T; replayed: boolean } {
  const key = req.get('Idempotency-Key');
  if (!key) return { result: mutate(), replayed: false };
  const actor = req.body?.actor ?? req.body?.agent_id ?? 'user';
  if (typeof actor !== 'string') throw new ValidationError('actor 不合法');
  return withIdempotencyResult(db, { key, actorId: actor, action: req.method, resource: `${req.baseUrl}${req.path}`, payloadHash: hashPayload({ body: req.body, query: req.query }), workspaceId: requestWorkspaceId(req) }, mutate, effectPending);
}
export function finishIdempotentEffect(db: Db, key: string, result: unknown): void {
  // 不按工作区过滤：调用方（routes/dispatch）持有同一 key 的 pending 行，key + effect_pending=1 已足够定位
  db.prepare("UPDATE idempotency_record SET response_json=?,effect_pending=0,effect_state='applied' WHERE request_id=? AND effect_pending=1").run(JSON.stringify(result), key);
}
