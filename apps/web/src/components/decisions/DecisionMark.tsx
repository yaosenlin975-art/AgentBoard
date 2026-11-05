/**
 * DEC-6：卡面 [待决策] 标识（看板卡片 / 拖拽预览共用）。
 *
 * - grace：`[待决策] 剩 2:59`（按 `decision_grace_until` 每秒刷新；0 秒显示「待落锁」）；
 * - open ：`[待决策] 已等待 5 分`（以服务端 `decision_waiting_seconds` 为基准本地续算）。
 * 无决策（两字段皆空）时返回 null，旧卡片渲染零变化。
 */
import { useRef } from 'react';
import type { Issue } from '@agentboard/shared';
import { useDecisionClock } from './clock';
import { formatCountdown, formatWaiting } from './countdown';

export function DecisionMark({ issue }: { issue: Issue }) {
  const graceUntil = issue.decision_grace_until ?? null;
  const locked = issue.decision_locked === true;
  if (!locked && graceUntil === null) return null;
  return graceUntil !== null
    ? <GraceMark issueId={issue.id} graceUntil={graceUntil} />
    : <LockedMark issueId={issue.id} waitingSeconds={issue.decision_waiting_seconds ?? null} />;
}

function GraceMark({ issueId, graceUntil }: { issueId: string; graceUntil: number }) {
  const now = useDecisionClock();
  const remaining = Math.max(0, Math.ceil((graceUntil - now) / 1000));
  return (
    <span
      data-testid={`decision-mark-${issueId}`}
      data-decision-state="grace"
      title={`宽限倒计时：${remaining} 秒后自动落锁并停止 agent`}
      className="inline-flex items-center gap-1 whitespace-nowrap rounded bg-accent-soft px-1.5 py-0.5 text-xs font-medium text-accent tabular-nums"
    >
      [待决策] 剩 {formatCountdown(remaining)}
    </span>
  );
}

function LockedMark({ issueId, waitingSeconds }: { issueId: string; waitingSeconds: number | null }) {
  const now = useDecisionClock();
  const base = useRef({ seconds: waitingSeconds ?? 0, at: Date.now(), source: waitingSeconds });
  if (base.current.source !== waitingSeconds) {
    base.current = { seconds: waitingSeconds ?? 0, at: Date.now(), source: waitingSeconds };
  }
  const elapsed = base.current.seconds + Math.max(0, Math.floor((now - base.current.at) / 1000));
  const label = formatWaiting(elapsed);
  return (
    <span
      data-testid={`decision-mark-${issueId}`}
      data-decision-state="open"
      title="决策未回答：该卡已被锁，回答后才能重新派工"
      className="inline-flex items-center gap-1 whitespace-nowrap rounded bg-accent-soft px-1.5 py-0.5 text-xs font-medium text-accent tabular-nums"
    >
      [待决策]{label === null ? '' : ` 已等 ${label}`}
    </span>
  );
}
