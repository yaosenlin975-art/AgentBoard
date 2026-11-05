import type { ServerWsEvent, SessionTurn, TurnAwaitingInfo, TurnPlanStep } from '@agentboard/shared';
import type { Db } from '../db/connection.js';
import { getTurn, updateTurn } from '../db/repos/sessionTurn.js';
import { ConflictError, NotFoundError } from '../errors.js';

/**
 * CHAT-AWAIT1：轮次阻塞态（awaiting_input / awaiting_approval）的状态机。
 *
 * 口径：
 * - 进入阻塞的唯一写入口是 `markTurnAwaiting`（观测层在拿到 ask_user 类信号后调用；本卡不改适配器协议）；
 * - `awaiting_json.at` 是阻塞起点，超时**只用这一个阈值** `TURN_AWAITING_TIMEOUT_MS`；
 * - `awaiting_heartbeat_at` 由 `sweepAwaitingTurns` 周期刷新（幂等：同一行同一列覆盖写，不计数、不追加）；
 * - 超时/回答都走「条件 UPDATE + changes 校验」，重复 tick / 重复请求不会二次落库或二次广播。
 */

/** 阻塞超时阈值（单一常量，15 分钟）：超过它仍无人回答即 failed(awaiting_timeout) */
export const TURN_AWAITING_TIMEOUT_MS = 15 * 60 * 1000;
/** 心跳间隔（对 awaiting 行刷新 awaiting_heartbeat_at） */
export const TURN_AWAITING_HEARTBEAT_MS = 30 * 1000;

export interface AwaitingDeps {
  broadcast: (event: ServerWsEvent) => void;
  /** 测试注入时钟；缺省 Date.now */
  now?: () => number;
}

export interface MarkAwaitingInput {
  /** awaiting_input（问用户）或 awaiting_approval（等审批） */
  state: 'awaiting_input' | 'awaiting_approval';
  /** 机器可判原因，写入 awaiting_json.reason（如 ask_user / approval） */
  reason: string;
  message?: string | null;
  /** 可选：指定阻塞的步骤 id；缺省取 current_index 指向的步骤 */
  stepId?: string;
}

const OPEN_STATES = ['awaiting_input', 'awaiting_approval'] as const;

interface AwaitingRow {
  id: string; session_id: string; state: string; current_index: number;
  plan_json: string | null; awaiting_json: string | null;
  awaiting_heartbeat_at: number | null; started_at: number;
}

function parsePlan(raw: string | null): TurnPlanStep[] {
  if (!raw) return [];
  try {
    const value = JSON.parse(raw);
    return Array.isArray(value) ? value as TurnPlanStep[] : [];
  } catch {
    return [];
  }
}

/** 进入阻塞态：写 state + plan 步骤 awaiting + awaiting_json（at=心跳起点），并落一次心跳 */
export function markTurnAwaiting(db: Db, sessionId: string, turnId: string, input: MarkAwaitingInput): SessionTurn {
  const turn = getTurn(db, turnId);
  if (!turn || turn.session_id !== sessionId) throw new NotFoundError('轮次不存在');
  const plan = (turn.plan_json ?? []).map((step) => ({ ...step }));
  let index = -1;
  if (input.stepId !== undefined) {
    index = plan.findIndex((step) => step.step_id === input.stepId);
    if (index < 0) throw new NotFoundError('步骤不存在');
  } else if (turn.current_index >= 0 && turn.current_index < plan.length) {
    index = turn.current_index;
  }
  if (index >= 0) plan[index] = { ...plan[index]!, state: 'awaiting' };
  const now = Date.now();
  const awaiting: TurnAwaitingInfo = { reason: input.reason, message: input.message ?? null, at: now };
  return updateTurn(db, turnId, {
    state: input.state,
    plan_json: plan,
    awaiting_json: awaiting,
    awaiting_heartbeat_at: now,
  })!;
}

/**
 * 回答（仅在 awaiting_input 可答）：保持同一 turn_id，把阻塞步骤收为 done、下一步转 running；
 * 不在 awaiting_input 的回答一律 409（重复回答因此天然幂等——第二次就是冲突）。
 */
export function answerAwaitingTurn(
  db: Db,
  sessionId: string,
  turnId: string,
  _answer: { optionId?: string; text?: string },
): SessionTurn {
  const turn = getTurn(db, turnId);
  if (!turn || turn.session_id !== sessionId) throw new NotFoundError('轮次不存在');
  if (turn.state !== 'awaiting_input') throw new ConflictError('轮次当前不在等待输入状态');
  const plan = (turn.plan_json ?? []).map((step) => ({ ...step }));
  let index = plan.findIndex((step) => step.state === 'awaiting');
  if (index < 0 && turn.current_index >= 0 && turn.current_index < plan.length) index = turn.current_index;
  if (index >= 0 && plan[index]) plan[index] = { ...plan[index]!, state: 'done' };
  const next = index + 1;
  if (plan[next]) plan[next] = { ...plan[next]!, state: 'running' };
  const current_index = next < plan.length ? next : plan.length;
  return updateTurn(db, turnId, {
    state: 'running',
    current_index,
    plan_json: plan,
    awaiting_json: null,
    awaiting_heartbeat_at: null,
  })!;
}

export interface SweepResult {
  /** 本轮刷新了心跳的 awaiting 行数 */
  heartbeated: number;
  /** 本轮判定超时并收口的轮次（每行最多一次；重复 tick 返回空） */
  timedOut: SessionTurn[];
}

/**
 * 心跳 + 超时兜底（可重复调用，幂等）：
 * - 未到期的 awaiting 行刷新 `awaiting_heartbeat_at`；
 * - 距 `awaiting_json.at` 超过 `TURN_AWAITING_TIMEOUT_MS` 的行置 `failed`，原因 `awaiting_timeout`，
 *   并用一次 `session.turn` 广播（条件 UPDATE 命中 1 行才推，避免重复推送）。
 */
export function sweepAwaitingTurns(db: Db, deps: AwaitingDeps): SweepResult {
  const now = deps.now ? deps.now() : Date.now();
  const rows = db
    .prepare(
      `SELECT id, session_id, state, current_index, plan_json, awaiting_json, awaiting_heartbeat_at, started_at
       FROM session_turn WHERE state IN (${OPEN_STATES.map(() => '?').join(',')})`,
    )
    .all(...OPEN_STATES) as AwaitingRow[];
  const result: SweepResult = { heartbeated: 0, timedOut: [] };
  for (const row of rows) {
    const info = (() => {
      if (!row.awaiting_json) return null;
      try {
        return JSON.parse(row.awaiting_json) as TurnAwaitingInfo;
      } catch {
        return null;
      }
    })();
    const since = typeof info?.at === 'number' ? info.at : row.started_at;
    if (now - since >= TURN_AWAITING_TIMEOUT_MS) {
      const info: TurnAwaitingInfo = { reason: 'awaiting_timeout', message: '等待回答超时', at: now };
      const updated = db
        .prepare(
          `UPDATE session_turn SET state = 'failed', ended_at = ?, awaiting_json = ?, awaiting_heartbeat_at = NULL
           WHERE id = ? AND state IN (${OPEN_STATES.map(() => '?').join(',')})`,
        )
        .run(now, JSON.stringify(info), row.id, ...OPEN_STATES);
      if (updated.changes === 1) {
        const turn = getTurn(db, row.id);
        if (turn) {
          result.timedOut.push(turn);
          deps.broadcast({
            type: 'session.turn',
            session_id: turn.session_id,
            turn_id: turn.id,
            state: 'failed',
            awaiting: info,
          });
        }
      }
    } else {
      db.prepare(
        `UPDATE session_turn SET awaiting_heartbeat_at = ?
         WHERE id = ? AND state IN (${OPEN_STATES.map(() => '?').join(',')})`,
      ).run(now, row.id, ...OPEN_STATES);
      result.heartbeated += 1;
    }
  }
  return result;
}

/** 启动周期任务；返回 disposer（测试/优雅退出可停） */
export function startAwaitingSweeper(
  db: Db,
  broadcast: (event: ServerWsEvent) => void,
  intervalMs = TURN_AWAITING_HEARTBEAT_MS,
): () => void {
  const timer = setInterval(() => {
    try {
      sweepAwaitingTurns(db, { broadcast });
    } catch (error) {
      // 定时任务不外抛：一轮失败不能让心跳链整体停摆
      console.error('[session.turn] 阻塞态心跳/超时扫描失败', error);
    }
  }, intervalMs);
  timer.unref?.();
  return () => clearInterval(timer);
}
