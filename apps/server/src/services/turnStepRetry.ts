import type { ServerWsEvent, SessionStepRetryResult, SessionTurn, TurnAwaitingInfo, TurnPlanStep } from '@agentboard/shared';
import type { Db } from '../db/connection.js';
import { getTurn, updateTurn } from '../db/repos/sessionTurn.js';
import { beginStepRetry, finishStepRetry, getStepLedger } from '../db/repos/stepLedger.js';
import { ApiError, NotFoundError } from '../errors.js';

/**
 * CHAT-RETRY1（契约 #15）：`POST /api/sessions/:id/turns/:turnId/steps/:stepId/retry` 的服务层。
 *
 * 三条缺一不可的护栏：
 * 1. **台账存在**：没有 `session_step_ledger` 行的失败步骤一律 409（无台账的单步重试比整轮重试更危险）；
 * 2. **显式 retryable**：台账 `retryable=false`（如已记录写入的部分成功）一律 409；
 * 3. **稳定幂等键**：台账键 = `turn + step + tool_call_id`，同一重试请求重复提交时，
 *    第一次已把步骤置 `running`/`done`，后续请求在状态校验处 409，工具不会执行第二次。
 *
 * 只推进状态与台账，不新建 `session_turn`、不落 message；执行通道由 `sessionManager.runRetriedStep` 注入。
 */
export interface RetryStepDeps {
  broadcast: (event: ServerWsEvent) => void;
  execute: (input: { session_id: string; turn_id: string; step_id: string; tool_name: string }) => Promise<{
    ok: boolean;
    message: string | null;
  }>;
}

const OPEN_STATES = ['running', 'awaiting_input', 'awaiting_approval'] as const;

export async function retryFailedStep(
  db: Db,
  sessionId: string,
  turnId: string,
  stepId: string,
  deps: RetryStepDeps,
): Promise<SessionStepRetryResult> {
  const turn = getTurn(db, turnId);
  if (!turn || turn.session_id !== sessionId) throw new NotFoundError('轮次不存在');

  const plan = (turn.plan_json ?? []).map((step) => ({ ...step }));
  const index = plan.findIndex((step) => step.step_id === stepId);
  if (index < 0) throw new NotFoundError('步骤不存在');

  // awaiting_* 属于阻塞态，明确拒绝（卡面：本卡不得在 awaiting 状态下触发重试）
  if ((OPEN_STATES as readonly string[]).includes(turn.state)) {
    throw new ApiError(409, 'TURN_NOT_RETRYABLE', '当前轮次不可重试：轮次仍在执行或处于阻塞态');
  }
  if (plan[index]!.state !== 'failed') {
    throw new ApiError(409, 'STEP_NOT_FAILED', '仅失败步骤可重试');
  }

  const ledger = getStepLedger(db, turnId, stepId);
  if (!ledger) {
    throw new ApiError(409, 'STEP_NOT_RETRYABLE', '该步骤缺少执行台账，不允许单步重试');
  }
  if (!ledger.retryable) {
    throw new ApiError(409, 'STEP_NOT_RETRYABLE', '该步骤不可重试：已有写入记录，重试可能重复写入');
  }

  // 条件 UPDATE + changes 校验：并发重复请求只有一个能把 failed 改成 running
  const startedPlan: TurnPlanStep[] = plan.map((step, i) => (i === index ? { ...step, state: 'running' } : step));
  const started = db
    .prepare(
      `UPDATE session_turn
       SET state = 'running', ended_at = NULL, awaiting_json = NULL, awaiting_heartbeat_at = NULL,
           plan_json = ?, current_index = ?
       WHERE id = ? AND state = 'failed'`,
    )
    .run(JSON.stringify(startedPlan), index, turnId);
  if (started.changes !== 1) {
    throw new ApiError(409, 'STEP_RETRY_IN_FLIGHT', '重试已在处理中或轮次状态已变化');
  }
  beginStepRetry(db, turnId, stepId);

  let outcome: { ok: boolean; message: string | null };
  try {
    outcome = await deps.execute({ session_id: sessionId, turn_id: turnId, step_id: stepId, tool_name: ledger.tool_name });
  } catch (err) {
    outcome = { ok: false, message: err instanceof Error ? err.message : String(err) };
  }

  const current = getTurn(db, turnId);
  const finalPlan = (current?.plan_json ?? startedPlan).map((step) => ({ ...step }));
  finalPlan[index] = { ...finalPlan[index]!, state: outcome.ok ? 'done' : 'failed' };
  // 其余步骤未执行时不能谎报轮次 done：只有全部步骤 done 才收口为 done
  const allDone = finalPlan.every((step) => step.state === 'done');
  const state = outcome.ok && allDone ? 'done' : 'failed';
  const awaiting: TurnAwaitingInfo | null = state === 'done'
    ? null
    : {
      reason: outcome.ok ? 'step_retry_incomplete' : 'step_retry_failed',
      message: outcome.message ?? (outcome.ok ? '该步已重试成功，但其余步骤未执行' : '步骤重试失败'),
      at: Date.now(),
    };
  const finalTurn: SessionTurn = updateTurn(db, turnId, {
    state,
    current_index: index,
    plan_json: finalPlan,
    awaiting_json: awaiting,
    awaiting_heartbeat_at: null,
    ended_at: Date.now(),
  })!;
  finishStepRetry(db, turnId, stepId, !outcome.ok);
  const finalLedger = getStepLedger(db, turnId, stepId)!;

  // 只在终态推一次；重复请求走 409，不会二次广播
  deps.broadcast({
    type: 'session.turn',
    session_id: sessionId,
    turn_id: turnId,
    state,
    awaiting,
  });

  return { turn: finalTurn, step_id: stepId, ledger: finalLedger, executed: true };
}
