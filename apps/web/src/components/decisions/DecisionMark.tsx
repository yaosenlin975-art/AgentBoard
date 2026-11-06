/**
 * DEC-6 / P8：卡面 [待决策] 标识（看板卡片 / 拖拽预览共用）。
 *
 * - grace：`[待决策] 剩 2:59`（按 `decision_grace_until` 每秒刷新；0 秒显示「待落锁」）；
 * - open ：`[待决策] 已等待 5 分`（以服务端 `decision_waiting_seconds` 为基准本地续算）。
 * 无决策（两字段皆空）时返回 null，旧卡片渲染零变化。
 *
 * P8：有 `open_decision_id` 时可点击，经 `navStore.focusDecision` 切到待决策并定位高亮；
 * 缺 id（旧投影 / 已答已撤回尚未刷新）时降级为不可点的 span，不出现「点进去空白」。
 */
import { useRef, type ReactNode } from 'react';
import type { Issue } from '@agentboard/shared';
import { useNavStore } from '../../state/navStore';
import { useDecisionClock } from './clock';
import { formatCountdown, formatWaiting } from './countdown';

const MARK_CLASS =
  'inline-flex items-center gap-1 whitespace-nowrap rounded bg-accent-soft px-1.5 py-0.5 text-xs font-medium text-accent tabular-nums';

/** 有决策 id → 可点按钮；缺 id → 降级 span（保持原样式与 testid） */
function MarkShell({
  issueId,
  decisionId,
  state,
  title,
  children,
}: {
  issueId: string;
  decisionId: string | null;
  state: 'grace' | 'open';
  title: string;
  children: ReactNode;
}) {
  if (decisionId === null) {
    return (
      <span data-testid={`decision-mark-${issueId}`} data-decision-state={state} title={title} className={MARK_CLASS}>
        {children}
      </span>
    );
  }
  return (
    <button
      type="button"
      data-testid={`decision-mark-${issueId}`}
      data-decision-state={state}
      title={`${title}（点击查看待决策）`}
      onClick={() => useNavStore.getState().focusDecision(decisionId)}
      className={`${MARK_CLASS} transition-colors duration-150 motion-reduce:transition-none hover:bg-accent/20 focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent`}
    >
      {children}
    </button>
  );
}

export function DecisionMark({ issue }: { issue: Issue }) {
  const graceUntil = issue.decision_grace_until ?? null;
  const locked = issue.decision_locked === true;
  if (!locked && graceUntil === null) return null;
  const decisionId = issue.open_decision_id ?? null;
  return graceUntil !== null ? (
    <GraceMark issueId={issue.id} decisionId={decisionId} graceUntil={graceUntil} />
  ) : (
    <LockedMark issueId={issue.id} decisionId={decisionId} waitingSeconds={issue.decision_waiting_seconds ?? null} />
  );
}

function GraceMark({
  issueId,
  decisionId,
  graceUntil,
}: {
  issueId: string;
  decisionId: string | null;
  graceUntil: number;
}) {
  const now = useDecisionClock();
  const remaining = Math.max(0, Math.ceil((graceUntil - now) / 1000));
  return (
    <MarkShell
      issueId={issueId}
      decisionId={decisionId}
      state="grace"
      title={`宽限倒计时：${remaining} 秒后自动落锁并停止 agent`}
    >
      [待决策] 剩 {formatCountdown(remaining)}
    </MarkShell>
  );
}

function LockedMark({
  issueId,
  decisionId,
  waitingSeconds,
}: {
  issueId: string;
  decisionId: string | null;
  waitingSeconds: number | null;
}) {
  const now = useDecisionClock();
  const base = useRef({ seconds: waitingSeconds ?? 0, at: Date.now(), source: waitingSeconds });
  if (base.current.source !== waitingSeconds) {
    base.current = { seconds: waitingSeconds ?? 0, at: Date.now(), source: waitingSeconds };
  }
  const elapsed = base.current.seconds + Math.max(0, Math.floor((now - base.current.at) / 1000));
  const label = formatWaiting(elapsed);
  return (
    <MarkShell
      issueId={issueId}
      decisionId={decisionId}
      state="open"
      title="决策未回答：该卡已被锁，回答后才能重新派工"
    >
      [待决策]{label === null ? '' : ` 已等 ${label}`}
    </MarkShell>
  );
}
