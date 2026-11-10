import { randomUUID } from 'node:crypto';
import type { Db } from '../connection.js';

/** TRAVEL-REC：WorkBuddy 猫猫旅行轮次（一条记录 = 一次已派出的旅行） */
export interface WorkbuddyTravelRound {
  id: string;
  account_id: string;
  operation_id: string | null;
  state: 'pending' | 'claimed' | 'missed' | 'failed';
  dispatched_at: number;
  due_at: number;
  attempts: number;
  last_attempt_at: number | null;
  safe_error_code: string | null;
  created_at: number;
  updated_at: number;
}

/** 4 小时得分窗口上限：派出后超过这个时间回收不再得分 */
export const TRAVEL_SCORE_WINDOW_MS = 4 * 60 * 60 * 1000;
/** 安全余量：提前 15 分钟回收，吸收请求延迟与时钟误差，避免掉出窗口 */
export const TRAVEL_SAFETY_MARGIN_MS = 15 * 60 * 1000;
/** 回收时刻 = 派出后 3 小时 45 分（225 分钟） */
export const TRAVEL_RECOVERY_DELAY_MS = TRAVEL_SCORE_WINDOW_MS - TRAVEL_SAFETY_MARGIN_MS;

const now = (): number => Date.now();

/**
 * 记录一次「已派出」轮次。
 * 同一账号已有 pending 时保持原行（不重置 due_at）：一轮只回收一次，重复调用是幂等的。
 */
export function createPendingTravelRound(
  db: Db,
  input: { account_id: string; operation_id?: string | null; dispatched_at?: number; due_at?: number },
): WorkbuddyTravelRound {
  const dispatchedAt = input.dispatched_at ?? now();
  const ts = now();
  db.prepare(`INSERT OR IGNORE INTO workbuddy_travel_round
    (id,account_id,operation_id,state,dispatched_at,due_at,attempts,last_attempt_at,safe_error_code,created_at,updated_at)
    VALUES(?,?,?,'pending',?,?,0,NULL,NULL,?,?)`)
    .run(randomUUID(), input.account_id, input.operation_id ?? null, dispatchedAt, input.due_at ?? dispatchedAt + TRAVEL_RECOVERY_DELAY_MS, ts, ts);
  return getPendingTravelRound(db, input.account_id)!;
}

export function getPendingTravelRound(db: Db, accountId: string): WorkbuddyTravelRound | null {
  return (db.prepare("SELECT * FROM workbuddy_travel_round WHERE account_id=? AND state='pending'").get(accountId) as WorkbuddyTravelRound | undefined) ?? null;
}

export function getTravelRound(db: Db, id: string): WorkbuddyTravelRound | null {
  return (db.prepare('SELECT * FROM workbuddy_travel_round WHERE id=?').get(id) as WorkbuddyTravelRound | undefined) ?? null;
}

export function listPendingTravelRounds(db: Db): WorkbuddyTravelRound[] {
  return db.prepare("SELECT * FROM workbuddy_travel_round WHERE state='pending' ORDER BY due_at,created_at").all() as WorkbuddyTravelRound[];
}

export function listTravelRounds(db: Db, options: { state?: WorkbuddyTravelRound['state']; limit?: number } = {}): WorkbuddyTravelRound[] {
  const limit = Math.min(Math.max(options.limit ?? 50, 1), 200);
  if (options.state !== undefined) {
    return db.prepare('SELECT * FROM workbuddy_travel_round WHERE state=? ORDER BY created_at DESC LIMIT ?').all(options.state, limit) as WorkbuddyTravelRound[];
  }
  return db.prepare('SELECT * FROM workbuddy_travel_round ORDER BY created_at DESC LIMIT ?').all(limit) as WorkbuddyTravelRound[];
}

/**
 * 状态 CAS：只有当前状态等于 from 才更新，返回 null 表示状态已变（并发/重复回收按幂等处理）。
 */
export function transitionTravelRound(
  db: Db,
  id: string,
  from: WorkbuddyTravelRound['state'],
  patch: { state: WorkbuddyTravelRound['state']; safe_error_code?: string | null; touch_attempt?: boolean },
): WorkbuddyTravelRound | null {
  const result = db.prepare(`UPDATE workbuddy_travel_round SET state=?,safe_error_code=?,
    attempts=attempts+?,last_attempt_at=?,updated_at=? WHERE id=? AND state=?`)
    .run(
      patch.state,
      patch.safe_error_code ?? null,
      patch.touch_attempt === true ? 1 : 0,
      patch.touch_attempt === true ? now() : null,
      now(),
      id,
      from,
    );
  return result.changes === 1 ? getTravelRound(db, id) : null;
}

/** 回收尝试失败但仍保留 pending（下轮重试）：只累加次数与错误码，不改状态 */
export function recordTravelAttemptFailure(db: Db, id: string, safeErrorCode: string): WorkbuddyTravelRound | null {
  const result = db.prepare(`UPDATE workbuddy_travel_round SET attempts=attempts+1,last_attempt_at=?,safe_error_code=?,updated_at=?
    WHERE id=? AND state='pending'`).run(now(), safeErrorCode, now(), id);
  return result.changes === 1 ? getTravelRound(db, id) : null;
}
