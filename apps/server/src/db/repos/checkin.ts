import { randomUUID } from 'node:crypto';
import type { AccountOperation, CheckinAuthorization, CheckinBatch, CheckinBatchItem, ManagedAccount, ManagedAppId } from '@agentboard/shared';
import type { Db } from '../connection.js';
import { ApiError } from '../../errors.js';

const now = (): number => Date.now();

// ---------- 签到授权 ----------

export function createCheckinAuthorization(
  db: Db,
  input: { account_id: string; app_id: ManagedAppId; remote_state_hash: string; remote_state_ref: string; authorization_url: string | null; expires_at: number },
): CheckinAuthorization {
  const id = randomUUID();
  const ts = now();
  try {
    db.prepare('INSERT INTO checkin_authorization(id,account_id,app_id,status,remote_state_hash,remote_state_ref,authorization_url,created_at,updated_at,expires_at) VALUES(?,?,?,?,?,?,?,?,?,?)')
      .run(id, input.account_id, input.app_id, 'pending', input.remote_state_hash, input.remote_state_ref, input.authorization_url, ts, ts, input.expires_at);
  } catch (error) {
    // 同一账号已有 pending 授权（唯一索引 checkin_authorization_open）
    if (error instanceof Error && /UNIQUE/.test(error.message)) throw new ApiError(409, 'CHECKIN_AUTHORIZATION_EXISTS', '该账号已有进行中的签到授权');
    throw error;
  }
  return getCheckinAuthorization(db, id)!;
}

export function getCheckinAuthorization(db: Db, id: string): CheckinAuthorization | null {
  return (db.prepare('SELECT * FROM checkin_authorization WHERE id=?').get(id) as CheckinAuthorization | undefined) ?? null;
}

/** 对外视图：剥离 remote_state_hash / remote_state_ref，任何响应只走这个函数 */
export function publicCheckinAuthorization(row: CheckinAuthorization): CheckinAuthorization {
  return {
    id: row.id, account_id: row.account_id, app_id: row.app_id, status: row.status,
    authorization_url: row.authorization_url, safe_error_code: row.safe_error_code,
    created_at: row.created_at, updated_at: row.updated_at, expires_at: row.expires_at,
  };
}

/** 内部读取远端 state 的 vault 引用（不对外暴露） */
export function checkinAuthorizationStateRef(db: Db, id: string): { remote_state_ref: string | null; account_id: string } | null {
  return (db.prepare('SELECT remote_state_ref,account_id FROM checkin_authorization WHERE id=?').get(id) as { remote_state_ref: string | null; account_id: string } | undefined) ?? null;
}

/** 状态 CAS：只有当前状态等于 from 才更新，返回 null 表示状态已变（调用方按幂等处理） */
export function transitionCheckinAuthorization(
  db: Db,
  id: string,
  from: CheckinAuthorization['status'],
  patch: { status: CheckinAuthorization['status']; safe_error_code?: string | null },
): CheckinAuthorization | null {
  const result = db.prepare('UPDATE checkin_authorization SET status=?,safe_error_code=?,updated_at=? WHERE id=? AND status=?')
    .run(patch.status, patch.safe_error_code ?? null, now(), id, from);
  return result.changes === 1 ? getCheckinAuthorization(db, id) : null;
}

// ---------- 批次 ----------

export function createCheckinBatch(db: Db, input: { app_id: ManagedAppId; account_ids: string[]; profile_local_day: string }): CheckinBatch {
  const id = randomUUID();
  const ts = now();
  return db.transaction(() => {
    const running = db.prepare("SELECT id FROM checkin_batch WHERE app_id=? AND status IN ('queued','running') LIMIT 1").get(input.app_id) as { id: string } | undefined;
    if (running) throw new ApiError(409, 'CHECKIN_BATCH_IN_PROGRESS', '该产品已有进行中的签到批次', { batch_id: running.id });
    db.prepare('INSERT INTO checkin_batch(id,app_id,status,total,profile_local_day,created_at) VALUES(?,?,?,?,?,?)')
      .run(id, input.app_id, 'queued', input.account_ids.length, input.profile_local_day, ts);
    const insert = db.prepare('INSERT INTO checkin_batch_item(batch_id,account_id,seq,state,updated_at) VALUES(?,?,?,?,?)');
    input.account_ids.forEach((accountId, index) => insert.run(id, accountId, index, 'queued', ts));
    return getCheckinBatch(db, id)!;
  }).immediate();
}

export function getCheckinBatch(db: Db, id: string, withItems = true): CheckinBatch | null {
  const batch = (db.prepare('SELECT id,app_id,status,total,profile_local_day,created_at,finished_at FROM checkin_batch WHERE id=?').get(id) as CheckinBatch | undefined) ?? null;
  if (!batch) return null;
  return withItems ? { ...batch, items: listCheckinBatchItems(db, id) } : batch;
}

export function listCheckinBatchItems(db: Db, batchId: string): CheckinBatchItem[] {
  return db.prepare('SELECT * FROM checkin_batch_item WHERE batch_id=? ORDER BY seq').all(batchId) as CheckinBatchItem[];
}

export function getCheckinBatchItem(db: Db, batchId: string, accountId: string): CheckinBatchItem | null {
  return (db.prepare('SELECT * FROM checkin_batch_item WHERE batch_id=? AND account_id=?').get(batchId, accountId) as CheckinBatchItem | undefined) ?? null;
}

export function updateCheckinBatchItem(
  db: Db,
  batchId: string,
  accountId: string,
  patch: { state: CheckinBatchItem['state']; operation_id?: string | null; safe_error_code?: string | null },
): CheckinBatchItem {
  db.prepare('UPDATE checkin_batch_item SET state=?,operation_id=COALESCE(?,operation_id),safe_error_code=?,updated_at=? WHERE batch_id=? AND account_id=?')
    .run(patch.state, patch.operation_id ?? null, patch.safe_error_code ?? null, now(), batchId, accountId);
  return getCheckinBatchItem(db, batchId, accountId)!;
}

export function updateCheckinBatch(db: Db, id: string, patch: { status: CheckinBatch['status']; finished_at?: number | null }): CheckinBatch {
  db.prepare('UPDATE checkin_batch SET status=?,finished_at=? WHERE id=?').run(patch.status, patch.finished_at ?? null, id);
  return getCheckinBatch(db, id)!;
}

/** 取消尚未开始的项；返回被取消的账号 id（幂等：重复调用返回空数组） */
export function cancelQueuedCheckinItems(db: Db, batchId: string): string[] {
  return db.transaction(() => {
    const rows = db.prepare("SELECT account_id FROM checkin_batch_item WHERE batch_id=? AND state='queued' ORDER BY seq").all(batchId) as Array<{ account_id: string }>;
    const cancelled: string[] = [];
    const update = db.prepare("UPDATE checkin_batch_item SET state='cancelled',updated_at=? WHERE batch_id=? AND account_id=? AND state='queued'");
    for (const row of rows) if (update.run(now(), batchId, row.account_id).changes === 1) cancelled.push(row.account_id);
    return cancelled;
  }).immediate();
}

export function operationsForBatch(db: Db, batchId: string): AccountOperation[] {
  return db.prepare('SELECT * FROM account_operation WHERE batch_id=? ORDER BY created_at,id').all(batchId) as AccountOperation[];
}

// ---------- 账号签到字段 ----------

export function attachCheckinCredential(db: Db, accountId: string, ref: string): ManagedAccount {
  db.prepare("UPDATE managed_account SET checkin_credential_ref=?,checkin_capability='supported',updated_at=MAX(?,updated_at+1) WHERE id=?").run(ref, now(), accountId);
  return db.prepare('SELECT * FROM managed_account WHERE id=?').get(accountId) as ManagedAccount;
}

export function recordAccountCheckin(db: Db, accountId: string, result: { day: string; status: string }): void {
  db.prepare('UPDATE managed_account SET last_checkin_day=?,last_checkin_status=?,last_checkin_at=?,updated_at=MAX(?,updated_at+1) WHERE id=?')
    .run(result.day, result.status, now(), now(), accountId);
}
