/**
 * CHAT-VIS1：计划条（一轮一条、常驻、贴顶 sticky）。
 *
 * 定位：**`session_turn` 观测快照的只读投影**。
 * - 不做计划编辑、不做步骤增删、不放「重试此步」按钮、不提供整轮重发
 *   （改计划会与执行器双写；重试端点尚未存在，归 CHAT-RETRY2 / CHAT-AWAIT2）；
 * - 一行摘要 + 展开式紧凑步骤清单（不铺时间线）；
 * - 无障碍：整条是 `button` + `aria-expanded`，步骤变化写进隐藏 `aria-live="polite"`；
 * - 动效只用 `motion-safe:` / `motion-reduce:` 变体，`prefers-reduced-motion: reduce` 下无过渡、无动画。
 */
import { useState } from 'react';
import type { SessionStatus, TurnPlanStep } from '@agentboard/shared';
import {
  currentStep,
  deriveTurnChip,
  planAnnouncement,
  planHeadline,
  stepLabel,
  stepMark,
} from '../../lib/turnView';

/** chip 配色：只取既有 token（tone → 类名映射），不在组件里写死色值 */
const CHIP_CLASS: Record<'accent' | 'danger' | 'neutral', string> = {
  accent: 'border-accent text-accent',
  danger: 'border-red-300 text-red-700 dark:border-red-800 dark:text-red-300',
  neutral: 'border-hairline text-ink-3',
};

/** 步骤标记配色（同上一套语义：完成/失败/进行） */
const STEP_CLASS: Record<TurnPlanStep['state'], string> = {
  done: 'text-ink-2',
  running: 'text-accent',
  failed: 'text-red-700 dark:text-red-300',
  awaiting: 'text-accent',
  pending: 'text-ink-3',
};

/**
 * 步骤点阵（原型 chat-redesign-2026-11-05：app.js:375-382 / styles.css:303-311）
 * - 7px 圆点 + 3px 间距，只做状态可视化，不新增交互与数据源；
 * - 完成=accent、执行中=accent + 脉冲、失败=红、等待回答=accent + 描边、待执行=hairline。
 */
const DOT_CLASS: Record<TurnPlanStep['state'], string> = {
  done: 'bg-accent',
  running: 'bg-accent motion-safe:animate-pulse',
  failed: 'bg-red-600',
  awaiting: 'bg-accent ring-1 ring-accent',
  pending: 'bg-hairline',
};

/** 点阵最大可见数：超出时保留末位（当前进度在尾部），前面折成省略号 */
const MAX_VISIBLE_DOTS = 12;

export interface PlanBarProps {
  turnId: string;
  plan: TurnPlanStep[];
  currentIndex: number;
  /** 会话状态：`session_turn.state` 无前端出口，chip 只按此 + 步骤态推导（见 lib/turnView 顶部口径） */
  sessionStatus?: SessionStatus | null;
}

export function PlanBar({ turnId, plan, currentIndex, sessionStatus = null }: PlanBarProps) {
  // 默认收起：常驻一行摘要不抢正文注意力，要看步骤才展开
  const [open, setOpen] = useState(false);
  const chip = deriveTurnChip(plan, currentIndex, sessionStatus);
  const headline = planHeadline(plan, currentIndex, chip);
  const announcement = planAnnouncement(plan, currentIndex, chip);
  const active = currentStep(plan, currentIndex);
  // 点阵超出宽度时保留末位（原型截断规则：当前进度在尾部）
  const overflow = plan.length > MAX_VISIBLE_DOTS;
  const visibleDots = overflow ? plan.slice(-MAX_VISIBLE_DOTS) : plan;

  return (
    <div
      data-testid={`plan-bar-wrap-${turnId}`}
      // sticky 贴消息流顶；实底背景 + 发丝线，避免正文从条下面透出来
      className="sticky top-0 z-10 -mx-1 rounded bg-surface-page px-1 py-1 motion-reduce:transition-none motion-safe:transition-[background-color]"
    >
      <button
        type="button"
        data-testid={`plan-bar-${turnId}`}
        data-plan-state={chip.state}
        aria-expanded={open}
        aria-controls={`plan-steps-${turnId}`}
        onClick={() => setOpen((v) => !v)}
        className="flex w-full min-w-0 flex-wrap items-center gap-1.5 rounded border border-hairline bg-surface-card px-2 py-1 text-left text-xs text-ink hover:bg-surface-raised focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent"
      >
        <span
          data-testid={`plan-dots-${turnId}`}
          aria-hidden="true"
          data-count={plan.length}
          data-truncated={overflow ? 'true' : undefined}
          className="flex shrink-0 items-center gap-[3px]"
        >
          {overflow && <span className="text-[10px] leading-none text-ink-3">…</span>}
          {visibleDots.map((step) => (
            <span
              key={step.step_id}
              data-testid={`plan-dot-${turnId}-${step.step_id}`}
              data-state={step.state}
              className={`inline-block h-[7px] w-[7px] shrink-0 rounded-full ${DOT_CLASS[step.state]}`}
            />
          ))}
        </span>
        <span data-testid={`plan-headline-${turnId}`} className="min-w-0 flex-1 truncate">
          {headline}
        </span>
        <span
          data-testid={`plan-status-${turnId}`}
          data-tone={chip.tone}
          className={`shrink-0 rounded border px-1.5 py-0.5 text-[10px] font-medium ${CHIP_CLASS[chip.tone]}`}
        >
          {chip.label}
        </span>
        <span data-testid="plan-chev" aria-hidden="true" className="shrink-0 text-ink-3">
          {open ? '▴' : '▾'}
        </span>
      </button>

      {open && (
        <ol
          id={`plan-steps-${turnId}`}
          data-testid={`plan-steps-${turnId}`}
          aria-label="计划步骤"
          className="mt-1 max-h-56 space-y-0.5 overflow-y-auto rounded border border-hairline bg-surface-card px-2 py-1"
        >
          {plan.map((step, index) => (
            <li
              key={step.step_id}
              data-testid={`plan-step-${turnId}-${step.step_id}`}
              data-current={index === currentIndex}
              className="flex min-w-0 items-center gap-1.5 text-[11px]"
            >
              <span aria-hidden="true" className={`shrink-0 ${STEP_CLASS[step.state]}`}>
                {stepMark(step.state)}
              </span>
              <span className="min-w-0 flex-1 truncate text-ink-2">
                第 {index + 1} 步 · {step.title}
              </span>
              <span className={`shrink-0 ${STEP_CLASS[step.state]}`}>{stepLabel(step.state)}</span>
            </li>
          ))}
        </ol>
      )}

      {/* 隐藏播报：步骤推进 / 收口 / 失败都要读得出来；aria-live 容器常驻，只换文本 */}
      <span data-testid={`plan-live-${turnId}`} aria-live="polite" className="sr-only">
        {announcement}
      </span>
      {/* 当前步骤名同时给 aria-live 之外的兜底（活动步骤的可访问名） */}
      <span data-testid={`plan-active-step-${turnId}`} className="sr-only">
        {active === null ? '' : active.title}
      </span>
    </div>
  );
}
