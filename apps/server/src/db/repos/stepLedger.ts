import { randomUUID } from 'node:crypto';
import type { SessionStepLedgerEntry, StepLedgerStatus } from '@agentboard/shared';
import type { Db } from '../connection.js';

/**
 * CHAT-RETRY1：`session_step_ledger` 读写。
 *
 * 唯一写入方：观测层（`services/turnObservation.ts` 在步骤开始/结束时登记）与
 * 单步重试服务（`services/turnStepRetry.ts` 在重试时推进状态/次数）。
 * 幂等键由 `buildStepIdempotencyKey` 统一生成：`turn_id + step_id + tool_call_id`。
 */

const LEDGER_STATES: StepLedgerStatus[] = ['running', 'done', 'failed'];

export interface StepLedgerStartInput {
  session_id: string;
  turn_id: string;
  step_id: string;
  tool_name: string;
  tool_call_id?: string | null;
}

interface LedgerRow {
  id: string; session_id: string; turn_id: string; step_id: string; tool_name: string;
  tool_call_id: string | null; idempotency_key: string; status: string; retryable: number;
  writes_json: string; attempt: number; created_at: number; updated_at: number;
}

/** 稳定幂等键：同一轮同一步骤（同一 tool_call_id）永远同一串，不随重试次数变化 */
export function buildStepIdempotencyKey(turnId: string, stepId: string, toolCallId: string | null | undefined): string {
  return `${turnId}:${stepId}:${toolCallId ?? 'no-tool-call'}`;
}

function parseWrites(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const value = JSON.parse(raw);
    return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
  } catch {
    return [];
  }
}

function toEntry(row: LedgerRow): SessionStepLedgerEntry {
  return {
    id: row.id,
    session_id: row.session_id,
    turn_id: row.turn_id,
    step_id: row.step_id,
    tool_name: row.tool_name,
    tool_call_id: row.tool_call_id,
    idempotency_key: row.idempotency_key,
    status: (LEDGER_STATES as string[]).includes(row.status) ? row.status as StepLedgerStatus : 'failed',
    retryable: row.retryable === 1,
    writes: parseWrites(row.writes_json),
    attempt: row.attempt,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

/**
 * 步骤开始：登记 running 行。
 * 同键重复开始只刷新状态，不增加 attempt（`attempt` 是执行次数：首次 1，每次重试 +1）。
 */
export function recordStepStart(db: Db, input: StepLedgerStartInput): SessionStepLedgerEntry {
  const now = Date.now();
  const key = buildStepIdempotencyKey(input.turn_id, input.step_id, input.tool_call_id);
  const existing = db
    .prepare('SELECT * FROM session_step_ledger WHERE idempotency_key = ?')
    .get(key) as LedgerRow | undefined;
  if (existing) {
    db.prepare(
      `UPDATE session_step_ledger SET status = 'running', tool_name = ?, tool_call_id = ?, updated_at = ?
       WHERE idempotency_key = ?`,
    ).run(input.tool_name, input.tool_call_id ?? null, now, key);
    return getStepLedger(db, input.turn_id, input.step_id)!;
  }
  db.prepare(
    `INSERT INTO session_step_ledger
     (id, session_id, turn_id, step_id, tool_name, tool_call_id, idempotency_key,
      status, retryable, writes_json, attempt, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'running', 0, '[]', 1, ?, ?)`,
  ).run(
    randomUUID(), input.session_id, input.turn_id, input.step_id, input.tool_name,
    input.tool_call_id ?? null, key, now, now,
  );
  return getStepLedger(db, input.turn_id, input.step_id)!;
}

/**
 * 步骤结束：写终态并按写入记录计算 retryable。
 *
 * 取舍（卡面要求二选一并写进注释）：**任何已成功写入都判不可重试**——
 * 「部分成功但报失败」时，重试可能重复写已落盘文件，因此直接 409，而不是尝试跳过。
 */
export function recordStepFinish(
  db: Db,
  input: { turn_id: string; step_id: string; failed: boolean; writes?: string[] },
): SessionStepLedgerEntry | null {
  const row = db
    .prepare('SELECT * FROM session_step_ledger WHERE turn_id = ? AND step_id = ? ORDER BY created_at, id LIMIT 1')
    .get(input.turn_id, input.step_id) as LedgerRow | undefined;
  if (!row) return null;
  const writes = input.writes ?? parseWrites(row.writes_json);
  const retryable = input.failed && writes.length === 0 ? 1 : 0;
  db.prepare(
    `UPDATE session_step_ledger SET status = ?, retryable = ?, writes_json = ?, updated_at = ?
     WHERE id = ?`,
  ).run(input.failed ? 'failed' : 'done', retryable, JSON.stringify(writes), Date.now(), row.id);
  return getStepLedger(db, input.turn_id, input.step_id);
}

/**
 * 登记该步已成功写入（供执行器/测试填入真实写入集）。
 * 已存在写入即视为部分成功，后续失败一律不可重试。
 */
export function recordStepWrites(db: Db, turnId: string, stepId: string, writes: string[]): SessionStepLedgerEntry | null {
  const row = db
    .prepare('SELECT * FROM session_step_ledger WHERE turn_id = ? AND step_id = ? ORDER BY created_at, id LIMIT 1')
    .get(turnId, stepId) as LedgerRow | undefined;
  if (!row) return null;
  const merged = Array.from(new Set([...parseWrites(row.writes_json), ...writes]));
  db.prepare(
    `UPDATE session_step_ledger SET writes_json = ?, retryable = 0, updated_at = ? WHERE id = ?`,
  ).run(JSON.stringify(merged), Date.now(), row.id);
  return getStepLedger(db, turnId, stepId);
}

/** 重试开始：状态 running + attempt+1；返回 null 表示台账缺失 */
export function beginStepRetry(db: Db, turnId: string, stepId: string): SessionStepLedgerEntry | null {
  const row = db
    .prepare('SELECT * FROM session_step_ledger WHERE turn_id = ? AND step_id = ? ORDER BY created_at, id LIMIT 1')
    .get(turnId, stepId) as LedgerRow | undefined;
  if (!row) return null;
  db.prepare(
    `UPDATE session_step_ledger SET status = 'running', attempt = attempt + 1, updated_at = ? WHERE id = ?`,
  ).run(Date.now(), row.id);
  return getStepLedger(db, turnId, stepId);
}

/** 重试结束：done/failed；失败且无写入时重新标记可重试（允许用户再次点重试） */
export function finishStepRetry(
  db: Db,
  turnId: string,
  stepId: string,
  failed: boolean,
): SessionStepLedgerEntry | null {
  const row = db
    .prepare('SELECT * FROM session_step_ledger WHERE turn_id = ? AND step_id = ? ORDER BY created_at, id LIMIT 1')
    .get(turnId, stepId) as LedgerRow | undefined;
  if (!row) return null;
  const retryable = failed && parseWrites(row.writes_json).length === 0 ? 1 : 0;
  db.prepare(
    `UPDATE session_step_ledger SET status = ?, retryable = ?, updated_at = ? WHERE id = ?`,
  ).run(failed ? 'failed' : 'done', retryable, Date.now(), row.id);
  return getStepLedger(db, turnId, stepId);
}

export function getStepLedger(db: Db, turnId: string, stepId: string): SessionStepLedgerEntry | null {
  const row = db
    .prepare('SELECT * FROM session_step_ledger WHERE turn_id = ? AND step_id = ? ORDER BY created_at, id LIMIT 1')
    .get(turnId, stepId) as LedgerRow | undefined;
  return row ? toEntry(row) : null;
}

/** 某轮全部步骤台账（seq 不可用，按创建顺序） */
export function listStepLedgerByTurn(db: Db, turnId: string): SessionStepLedgerEntry[] {
  const rows = db
    .prepare('SELECT * FROM session_step_ledger WHERE turn_id = ? ORDER BY created_at, id')
    .all(turnId) as LedgerRow[];
  return rows.map(toEntry);
}
