import { randomUUID } from 'node:crypto';
import type {
  SessionTurn,
  SessionTurnState,
  TurnAwaitingInfo,
  TurnPlanStep,
  TurnUsage,
} from '@agentboard/shared';
import type { Db } from '../connection.js';

/**
 * CHAT-TURN1：`session_turn` 行读写。
 *
 * 唯一写入方是服务端会话链路（`sessionManager` → `services/turnObservation.ts`）；
 * 前端与 CLI 只读。JSON 列（plan/awaiting/usage）在读取端统一解析，解析失败按 null 降级，
 * 坏数据不炸列表（老库或人工写入的非法 JSON 走同一兜底）。
 */

const TURN_STATES: SessionTurnState[] = [
  'running', 'awaiting_input', 'awaiting_approval', 'failed', 'done', 'stopped',
];

/** 未结束的轮次状态（服务重启恢复与「有无在途轮次」判定用） */
const OPEN_STATES: SessionTurnState[] = ['running', 'awaiting_input', 'awaiting_approval'];

export interface CreateTurnInput {
  session_id: string;
  seq: number;
  state: SessionTurnState;
  started_at: number;
  current_index?: number;
  plan_json?: TurnPlanStep[] | null;
}

export type TurnPatch = Partial<{
  state: SessionTurnState;
  current_index: number;
  plan_json: TurnPlanStep[] | null;
  awaiting_json: TurnAwaitingInfo | null;
  usage_json: TurnUsage | null;
  ended_at: number | null;
}>;

function parseJson<T>(raw: unknown): T | null {
  if (typeof raw !== 'string' || raw === '') return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

interface TurnRow {
  id: string; session_id: string; seq: number; state: string; current_index: number;
  plan_json: string | null; awaiting_json: string | null; usage_json: string | null;
  started_at: number; ended_at: number | null;
}

function toTurn(row: TurnRow): SessionTurn {
  const state = (TURN_STATES as string[]).includes(row.state) ? (row.state as SessionTurnState) : 'running';
  return {
    id: row.id,
    session_id: row.session_id,
    seq: row.seq,
    state,
    current_index: row.current_index,
    plan_json: parseJson<TurnPlanStep[]>(row.plan_json),
    awaiting_json: parseJson<TurnAwaitingInfo>(row.awaiting_json),
    usage_json: parseJson<TurnUsage>(row.usage_json),
    started_at: row.started_at,
    ended_at: row.ended_at,
  };
}

/** 会话内下一轮次序号（1 起，MAX+1）；无历史轮次返回 1 */
export function nextTurnSeq(db: Db, sessionId: string): number {
  const row = db
    .prepare('SELECT COALESCE(MAX(seq), 0) + 1 AS seq FROM session_turn WHERE session_id = ?')
    .get(sessionId) as { seq: number };
  return row.seq;
}

export function createTurn(db: Db, input: CreateTurnInput): SessionTurn {
  const id = randomUUID();
  db.prepare(
    `INSERT INTO session_turn (id, session_id, seq, state, current_index, plan_json, awaiting_json, usage_json, started_at, ended_at)
     VALUES (?, ?, ?, ?, ?, ?, NULL, NULL, ?, NULL)`,
  ).run(
    id,
    input.session_id,
    input.seq,
    input.state,
    input.current_index ?? -1,
    input.plan_json === undefined || input.plan_json === null ? null : JSON.stringify(input.plan_json),
    input.started_at,
  );
  return getTurn(db, id)!;
}

export function getTurn(db: Db, id: string): SessionTurn | null {
  const row = db.prepare('SELECT * FROM session_turn WHERE id = ?').get(id) as TurnRow | undefined;
  return row ? toTurn(row) : null;
}

/** 某会话的全部轮次（seq 升序）；历史会话没有 turn 行时返回空数组（旧路径回退） */
export function listTurnsBySession(db: Db, sessionId: string): SessionTurn[] {
  const rows = db
    .prepare('SELECT * FROM session_turn WHERE session_id = ? ORDER BY seq, id')
    .all(sessionId) as TurnRow[];
  return rows.map(toTurn);
}

/** 某会话未结束的轮次（重启恢复用；正常结束时都已被收口） */
export function listOpenTurnsBySession(db: Db, sessionId: string): SessionTurn[] {
  const rows = db
    .prepare(`SELECT * FROM session_turn WHERE session_id = ? AND state IN (${OPEN_STATES.map(() => '?').join(',')}) ORDER BY seq, id`)
    .all(sessionId, ...OPEN_STATES) as TurnRow[];
  return rows.map(toTurn);
}

export function updateTurn(db: Db, id: string, patch: TurnPatch): SessionTurn | null {
  const sets: string[] = [];
  const params: unknown[] = [];
  if (patch.state !== undefined) {
    sets.push('state = ?');
    params.push(patch.state);
  }
  if (patch.current_index !== undefined) {
    sets.push('current_index = ?');
    params.push(patch.current_index);
  }
  if (patch.plan_json !== undefined) {
    sets.push('plan_json = ?');
    params.push(patch.plan_json === null ? null : JSON.stringify(patch.plan_json));
  }
  if (patch.awaiting_json !== undefined) {
    sets.push('awaiting_json = ?');
    params.push(patch.awaiting_json === null ? null : JSON.stringify(patch.awaiting_json));
  }
  if (patch.usage_json !== undefined) {
    sets.push('usage_json = ?');
    params.push(patch.usage_json === null ? null : JSON.stringify(patch.usage_json));
  }
  if (patch.ended_at !== undefined) {
    sets.push('ended_at = ?');
    params.push(patch.ended_at);
  }
  if (sets.length === 0) return getTurn(db, id);
  params.push(id);
  db.prepare(`UPDATE session_turn SET ${sets.join(', ')} WHERE id = ?`).run(...params);
  return getTurn(db, id);
}

/**
 * 服务重启恢复：把该会话未结束的轮次置 `failed`，原因写在 `awaiting_json.reason`
 * （验收 6：failed 必须携带机器可判原因）。返回被收口的轮次数。
 */
export function failOpenTurns(db: Db, sessionId: string, awaiting: TurnAwaitingInfo): number {
  const result = db
    .prepare(
      `UPDATE session_turn SET state = 'failed', ended_at = ?, awaiting_json = ?
       WHERE session_id = ? AND state IN (${OPEN_STATES.map(() => '?').join(',')})`,
    )
    .run(Date.now(), JSON.stringify(awaiting), sessionId, ...OPEN_STATES);
  return result.changes;
}

/** 删某会话的轮次行（与会话删除同事务的显式清理；FK CASCADE 已覆盖，这里保留显式入口） */
export function deleteTurnsBySession(db: Db, sessionId: string): void {
  db.prepare('DELETE FROM session_turn WHERE session_id = ?').run(sessionId);
}
