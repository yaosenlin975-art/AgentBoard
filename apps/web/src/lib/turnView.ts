/**
 * CHAT-VIS1：轮次观测的**只读投影**口径（纯函数，不触 DOM，便于单测）。
 *
 * 数据来源只有 CHAT-TURN1 已落地的两样：
 * - WS `session.plan`（`{ turn_id, plan, current_index }`，变更即推）；
 * - WS `session.usage`（`{ turn_id, usage }`，250ms 合并节流）；
 * 外加前端已有的 `session.status`（`运行中 | 已结束 | 失败`）。
 *
 * 关键约束（本卡是只读投影，不与执行器双写）：
 * - `session_turn.state` **没有** HTTP/WS 出口，所以计划条的状态 chip 只按上面三样推导，
 *   且明确记「推导」而不是「读取」；`awaiting_input` / `awaiting_approval` 的权威恢复通道归 CHAT-AWAIT2；
 * - 不提供改计划、改步骤、重跑步骤的任何入口（CHAT-RETRY2 / CHAT-AWAIT2 的地盘）。
 */
import type { SessionStatus, TurnPlanStep, TurnUsage } from '@agentboard/shared';

/**
 * 计划条状态 chip：`SessionTurnState` 的前端可推导子集。
 * 推导优先级（`deriveTurnChip`）：awaiting 步骤 → 失败 → 收口（完成）→ 运行中。
 */
export type TurnChipState = 'running' | 'awaiting' | 'failed' | 'done' | 'stopped';

export interface TurnChip {
  state: TurnChipState;
  /** chip 文案（三态可辨，机器可判） */
  label: string;
  /** 配色语义：accent=进行中/等待、danger=失败、neutral=收口；组件按 tone 取既有 token，不写死色值 */
  tone: 'accent' | 'danger' | 'neutral';
}

const CHIP_LABELS: Record<TurnChipState, string> = {
  running: '运行中',
  awaiting: '等待回答',
  failed: '已失败',
  done: '已完成',
  stopped: '已停止',
};

const CHIP_TONES: Record<TurnChipState, TurnChip['tone']> = {
  running: 'accent',
  awaiting: 'accent',
  failed: 'danger',
  done: 'neutral',
  stopped: 'neutral',
};

/** 轮次是否已收口：`current_index` 由服务端在 finish() 时置为 `plan.length`（契约 #18） */
export function isTurnClosed(plan: TurnPlanStep[], currentIndex: number): boolean {
  return plan.length > 0 && currentIndex >= plan.length;
}

/** 已完成的步骤数（计划条 `3/5` 的分子：只数 `state==='done'`，失败步不计入已完成） */
export function doneStepCount(plan: TurnPlanStep[]): number {
  return plan.filter((s) => s.state === 'done').length;
}

/** 当前打开的步骤（收口或下标越界时为 null） */
export function currentStep(plan: TurnPlanStep[], currentIndex: number): TurnPlanStep | null {
  if (currentIndex < 0 || currentIndex >= plan.length) return null;
  return plan[currentIndex] ?? null;
}

/**
 * 状态 chip 的前端推导（**只读**，不是读 `session_turn.state`）：
 * 1. 有 `awaiting` 步骤 → 等待回答（CHAT-AWAIT1 写步骤态，本卡已能观测；恢复通道仍归 CHAT-AWAIT2）；
 * 2. 有失败步骤或会话已失败 → 已失败；
 * 3. 轮次收口 → 已完成（会话已结束但没有失败步骤时，`done` 与 `stopped` 在前端不可区分，
 *    故 `运行中` 收尾记 `done`、`已结束` 收尾记 `stopped` 之外统一按「已完成」显示，见本页顶部约束）；
 * 4. 其余 → 运行中。
 */
export function deriveTurnChip(
  plan: TurnPlanStep[],
  currentIndex: number,
  sessionStatus: SessionStatus | null | undefined,
): TurnChip {
  let state: TurnChipState;
  if (plan.some((s) => s.state === 'awaiting')) state = 'awaiting';
  else if (plan.some((s) => s.state === 'failed') || sessionStatus === '失败') state = 'failed';
  else if (isTurnClosed(plan, currentIndex))
    state = sessionStatus === '已结束' && hasOpenEnd(plan) ? 'stopped' : 'done';
  else state = 'running';
  return { state, label: CHIP_LABELS[state], tone: CHIP_TONES[state] };
}

/**
 * 「已停止」的唯一可观测特征：收口快照里最后一步仍是 `running`
 * （正常收口会把打开的步骤落成 done/failed；`stopSession` 走的是同一路径，
 * 所以这里只作为「会话已结束 + 末步未落定」的弱信号，不宣称权威）。
 */
function hasOpenEnd(plan: TurnPlanStep[]): boolean {
  return plan.at(-1)?.state === 'running';
}

/** 计划条一行文案：`计划 3/5 · 正在执行：Read`（chip 与 ▾ 由组件渲染，不进文案，避免重复播报） */
export function planHeadline(plan: TurnPlanStep[], currentIndex: number, chip: TurnChip): string {
  const count = `${doneStepCount(plan)}/${plan.length}`;
  const step = currentStep(plan, currentIndex);
  let what: string;
  if (chip.state === 'awaiting') what = `等待你的回答${step === null ? '' : `：${step.title}`}`;
  else if (chip.state === 'failed') what = `失败于${step === null ? '本轮' : `第 ${currentIndex + 1} 步：${step.title}`}`;
  else if (chip.state === 'done') what = '全部步骤已完成';
  else if (chip.state === 'stopped') what = '已停止，已完成步骤保留';
  else what = `正在执行：${step?.title ?? '准备中'}`;
  return `计划 ${count} · ${what}`;
}

/** 屏幕阅读器播报的一句（aria-live=polite）：步骤变化必须能读出来，但不铺时间线 */
export function planAnnouncement(plan: TurnPlanStep[], currentIndex: number, chip: TurnChip): string {
  const done = doneStepCount(plan);
  const step = currentStep(plan, currentIndex);
  if (chip.state === 'done') return `计划已完成，共 ${plan.length} 步`;
  if (chip.state === 'failed') return `计划第 ${currentIndex + 1} 步失败，共 ${plan.length} 步`;
  if (chip.state === 'awaiting') return `计划第 ${currentIndex + 1} 步等待回答，共 ${plan.length} 步`;
  return step === null
    ? `计划进行中，已完成 ${done} 步，共 ${plan.length} 步`
    : `计划第 ${currentIndex + 1} 步，共 ${plan.length} 步：${step.title}`;
}

/** 步骤状态标记（仅视觉，aria-hidden；文字标签走 stepLabel） */
export function stepMark(state: TurnPlanStep['state']): string {
  return { done: '✓', running: '●', failed: '✕', awaiting: '‖', pending: '○' }[state] ?? '○';
}

/** 步骤状态中文标签（展开清单与无障碍用，不靠颜色/符号单独承载信息） */
export function stepLabel(state: TurnPlanStep['state']): string {
  return (
    {
      done: '已完成',
      running: '执行中',
      failed: '失败',
      awaiting: '等待回答',
      pending: '待执行',
    } as Record<TurnPlanStep['state'], string>
  )[state];
}

/** token 数可读化：`12400 → 12.4k`、`0 → 0` */
export function formatTokens(count: number): string {
  if (!Number.isFinite(count) || count <= 0) return '0';
  if (count < 1000) return String(Math.round(count));
  return `${(count / 1000).toFixed(1)}k`;
}

/** 金额可读化：`0.02 → ¥0.020`（三位小数，避免小金额显示成 ¥0.00） */
export function formatUsd(amount: number): string {
  return `¥${amount.toFixed(3)}`;
}

/** 耗时可读化：`null` → `—`（观测缺来源时不显示假数字） */
export function formatDuration(ms: number | null | undefined): string {
  if (ms === null || ms === undefined || !Number.isFinite(ms)) return '—';
  if (ms < 1000) return `${Math.round(ms)}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

/** 轮次 token 总量（input+output，缺列为 0） */
export function turnTokenTotal(usage: TurnUsage | null): number {
  if (usage === null) return 0;
  return (usage.input_tokens ?? 0) + (usage.output_tokens ?? 0);
}

/** 上下文占用百分比：`context_limit_tokens` 无来源（null/0）→ null（不编造分母） */
export function contextPercent(usage: TurnUsage | null): number | null {
  if (usage === null) return null;
  const used = usage.context_used_tokens;
  const limit = usage.context_limit_tokens;
  if (typeof used !== 'number' || typeof limit !== 'number' || limit <= 0) return null;
  return Math.min(100, Math.max(0, Math.round((used / limit) * 100)));
}

/**
 * 成本脚注一行：`本轮 12.4k tokens（估算） · 估算 ¥0.020 · 上下文 34%`。
 * `cost_usd` / `context_limit_tokens` 为 null 时分别显示「成本 待接入」「上下文 未知」，
 * 不用 0 冒充（服务端契约 #21 明确「不编造金额与上限」）。
 */
export function usageFootnote(usage: TurnUsage | null): string {
  const tokens = `${formatTokens(turnTokenTotal(usage))} tokens`;
  const tokenSeg = usage?.estimated === true ? `${tokens}（估算）` : tokens;
  const cost = usage?.cost_usd;
  const costSeg =
    typeof cost === 'number' && Number.isFinite(cost)
      ? usage?.estimated === false
        ? formatUsd(cost)
        : `估算 ${formatUsd(cost)}`
      : '成本 待接入';
  const pct = contextPercent(usage);
  const ctxSeg = pct === null ? '上下文 未知' : `上下文 ${pct}%`;
  return `本轮 ${tokenSeg} · ${costSeg} · ${ctxSeg}`;
}

/** `git diff -- <path>` 退化提示（无 diff 视图时给可复制的命令，不调用不存在的端点） */
export function gitDiffCommand(path: string | null | undefined): string {
  return `git diff -- ${path ?? '.'}`;
}

/** unified diff 单行分类（行级底色只按首字符判定，正文原样展示、不改写） */
export type DiffLineKind = 'add' | 'del' | 'hunk' | 'meta' | 'ctx';

export function classifyDiffLine(line: string): DiffLineKind {
  if (line.startsWith('+++') || line.startsWith('---')) return 'meta';
  if (line.startsWith('@@')) return 'hunk';
  if (line.startsWith('+')) return 'add';
  if (line.startsWith('-')) return 'del';
  return 'ctx';
}

/** 单行截断（头部摘要用；完整内容留在 title 悬浮层） */
export function singleLine(text: string, max = 90): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  if (flat === '') return '';
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}
