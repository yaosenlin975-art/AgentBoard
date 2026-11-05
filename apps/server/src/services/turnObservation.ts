/**
 * CHAT-TURN1：轮次观测器（`session_turn` 的唯一写入路径之一，仅由 `sessionManager` 调用）。
 *
 * 定位：**只观测，不改执行器语义**。适配器（`packages/adapters`）的事件协议不变、
 * runTurn/kill/排队/合并的行为不变；本模块把已可观测的信号映射成轮次状态与计划：
 * - 一轮 = 一次 `adapter.runTurn`（`seq` 会话内递增）；
 * - 计划步骤 = 一次 `tool` 事件（`step_id` = 轮内稳定的 `s1/s2/…`，只追加不重排）；
 *   CLI 不声明计划，所以无 tool 事件时 `plan_json` 为空数组（前端隐藏计划条）；
 * - 步骤耗时/成败 = 服务端墙钟与 error/退出码观测（不是 CLI 上报的工具结果）；
 * - 用量 = 正文字符量估算（`estimated=true`，见 `messageMeta.ts` 的口径说明）。
 *
 * 生命周期：`beginTurn()` 建行 → 事件回调推进 → `finish()` 收口（幂等）；
 * 任何异常路径都要走到 `finish()` 或 `close()`，否则轮次会停在 `running`。
 */
import type { TurnAwaitingInfo, TurnObservationEvent, TurnPlanStep, TurnUsage } from '@agentboard/shared';
import type { Db } from '../db/connection.js';
import {
  createTurn,
  nextTurnSeq,
  updateTurn,
} from '../db/repos/sessionTurn.js';
import { linkMessagesToTurn, updateMessageMeta } from '../db/repos/message.js';
import { recordStepFinish, recordStepStart } from '../db/repos/stepLedger.js';
import { estimateTokens, estimateTokensFromChars, initialToolMeta } from './messageMeta.js';

/** 契约 #21：usage 合并节流窗口（窗口内的多次更新只推最后一次快照） */
export const TURN_USAGE_THROTTLE_MS = 250;

export type TurnFinishOutcome = {
  state: 'done' | 'failed' | 'stopped';
  /** 验收 6：failed / stopped 必须带机器可判原因（落 `awaiting_json.reason`） */
  reason?: string;
  message?: string | null;
};

export interface TurnTrackerDeps {
  broadcast: (event: TurnObservationEvent) => void;
  /** 节流窗口，默认 `TURN_USAGE_THROTTLE_MS`；测试可缩短 */
  usageThrottleMs?: number;
}

export interface BeginTurnInput {
  session_id: string;
  /** 本轮触发提示（用于 input_tokens 估算） */
  prompt: string;
  /** 发送时先落库、轮次行后建的 user 消息 */
  user_message_ids?: string[];
}

export interface TurnTracker {
  readonly turnId: string;
  readonly seq: number;
  /** 当前打开的步骤 id（无则 null）：本轮消息落库时带 step_id */
  currentStepId(): string | null;
  /** tool 事件：收口上一步（回填观测）→ 追加新步骤 → 推一次 session.plan */
  beginStep(toolName: string): TurnPlanStep;
  /** 步骤的工具消息落库后登记，收口时按它回填 meta_json */
  registerStepMessage(stepId: string, messageId: string): void;
  /** error 事件：当前步骤判 failed（收尾时写回 meta_json 与 plan_json） */
  noteError(): void;
  onTextDelta(text: string): void;
  onThinkingDelta(text: string): void;
  /** 轮次收口（幂等）：plan/usage 落库并推送最终快照 */
  finish(outcome: TurnFinishOutcome): void;
  /** 只停计时器不落库（会话删除 / manager 复位） */
  close(): void;
}

interface OpenStep {
  step: TurnPlanStep;
  index: number;
  startedAt: number;
  messageId: string | null;
  sawError: boolean;
}

export function beginTurn(db: Db, input: BeginTurnInput, deps: TurnTrackerDeps): TurnTracker {
  const throttleMs = deps.usageThrottleMs ?? TURN_USAGE_THROTTLE_MS;
  const startedAt = Date.now();
  const turn = createTurn(db, {
    session_id: input.session_id,
    seq: nextTurnSeq(db, input.session_id),
    state: 'running',
    started_at: startedAt,
    current_index: -1,
    plan_json: [],
  });
  if (input.user_message_ids?.length) linkMessagesToTurn(db, input.user_message_ids, turn.id);

  const plan: TurnPlanStep[] = [];
  const inputTokens = estimateTokens(input.prompt);
  let outputChars = 0;
  let open: OpenStep | null = null;
  let currentIndex = -1;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let finished = false;
  let closed = false;

  /** 计划变更即推（同一批变更合并成一次推送）；载荷是快照副本，不暴露内部可变数组 */
  const pushPlan = (): void => {
    if (closed) return;
    deps.broadcast({
      type: 'session.plan',
      session_id: input.session_id,
      turn_id: turn.id,
      plan: plan.map((step) => ({ ...step })),
      current_index: currentIndex,
    });
  };

  const usageSnapshot = (): TurnUsage => {
    const outputTokens = estimateTokensFromChars(outputChars);
    return {
      input_tokens: inputTokens,
      output_tokens: outputTokens,
      cost_usd: null, // 无汇率来源：不编造金额（设计 §3.3 的「估算」标注由 UI 承担）
      context_used_tokens: inputTokens + outputTokens,
      context_limit_tokens: null, // 无模型上下文窗口来源
      estimated: true,
    };
  };

  const flushUsage = (): void => {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    if (closed) return;
    const usage = usageSnapshot();
    deps.broadcast({ type: 'session.usage', session_id: input.session_id, turn_id: turn.id, usage });
    // 推送之后的落库失败不能炸会话链路：观测列坏了不影响执行语义
    try {
      updateTurn(db, turn.id, { usage_json: usage });
    } catch {
      // 库已关闭（测试隔离 / 会话删除）或写入异常，忽略
    }
  };

  /** 节流：窗口内多次 delta 只在窗口末尾推一次 */
  const scheduleUsage = (): void => {
    if (closed || timer) return;
    timer = setTimeout(() => {
      timer = null;
      try {
        flushUsage();
      } catch {
        // 计时器回调里的异常没人接，必须自己吞掉（否则整个进程被 uncaughtException 带走）
      }
    }, throttleMs);
    // Node 的计时器不该拖住进程退出（测试结束后仍挂着会卡 vitest）
    timer.unref?.();
  };

  const closeStep = (failed: boolean): void => {
    if (!open) return;
    const durationMs = Math.max(0, Date.now() - open.startedAt);
    const stepFailed = failed || open.sawError;
    plan[open.index] = { ...open.step, state: stepFailed ? 'failed' : 'done' };
    if (open.messageId) {
      try {
        updateMessageMeta(db, open.messageId, { ...initialToolMeta(open.step.step_id), status: stepFailed ? 'failed' : 'ok', duration_ms: durationMs });
      } catch {
        // 回填失败只丢观测，不影响执行
      }
    }
    // CHAT-RETRY1：步骤台账同步收口；台账写入失败同样不影响执行（重试时缺台账会被 409 拒绝）
    try {
      recordStepFinish(db, { turn_id: turn.id, step_id: open.step.step_id, failed: stepFailed });
    } catch {
      // 观测失败不炸会话链路
    }
    open = null;
  };

  const tracker: TurnTracker = {
    turnId: turn.id,
    seq: turn.seq,
    currentStepId: () => open?.step.step_id ?? null,
    beginStep: (toolName) => {
      closeStep(false);
      const step: TurnPlanStep = { step_id: `s${plan.length + 1}`, title: toolName, state: 'running' };
      plan.push(step);
      open = { step, index: plan.length - 1, startedAt: Date.now(), messageId: null, sawError: false };
      currentIndex = plan.length - 1;
      // CHAT-RETRY1：步骤开始即登记台账（幂等键 turn+step+tool_call_id；事件暂无 call id）
      try {
        recordStepStart(db, {
          session_id: input.session_id,
          turn_id: turn.id,
          step_id: step.step_id,
          tool_name: toolName,
        });
      } catch {
        // 台账写入失败不影响执行（重试时会被 409 拒绝）
      }
      pushPlan();
      return step;
    },
    registerStepMessage: (stepId, messageId) => {
      if (open && open.step.step_id === stepId) open.messageId = messageId;
    },
    noteError: () => {
      if (open) open.sawError = true;
    },
    onTextDelta: (text) => {
      outputChars += Array.from(text).length;
      scheduleUsage();
    },
    onThinkingDelta: (text) => {
      outputChars += Array.from(text).length;
      scheduleUsage();
    },
    finish: (outcome) => {
      if (finished) return;
      finished = true;
      closeStep(outcome.state !== 'done');
      currentIndex = plan.length;
      const awaiting: TurnAwaitingInfo | null = outcome.reason
        ? { reason: outcome.reason, message: outcome.message ?? null, at: Date.now() }
        : null;
      try {
        updateTurn(db, turn.id, {
          state: outcome.state,
          current_index: currentIndex,
          plan_json: plan,
          awaiting_json: awaiting,
          usage_json: usageSnapshot(),
          ended_at: Date.now(),
        });
      } catch {
        // 同上：收口写库失败不炸执行链路
      }
      pushPlan();
      flushUsage();
      closed = true;
    },
    close: () => {
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      closed = true;
    },
  };
  return tracker;
}
