/**
 * CHAT-AWAIT2：阻塞态卡片（消息区与输入区之间，不改头部结构）。
 *
 * - `awaiting_input`：展示提问正文与可选项（自由文本兜底），POST answer；
 * - `awaiting_approval` 的交互已由 CHAT-APP2 的 `ApprovalDialog` 接管（本组件不再渲染审批卡片）；
 * - `failed(awaiting_timeout)`：展示服务端超时原因；有可定位失败步骤时提供「重试此步」
 *   （CHAT-RETRY2 单步重试端点），没有失败步骤时才退回「重发整轮」，两种口径在文案上区分。
 *
 * 约束：
 * - 状态只来自 turnStore 的服务端投影（`session.turn` / 会话详情），本组件不本地推进状态；
 * - 超时不在前端计时，`awaiting.at` 仅用于「已等待多久」与「绝对上限时刻」展示；
 * - answer/approval 返回的 turn 立即回填 store，即便 WS 事件迟到也不会停在旧态；
 * - 失败原因统一走 turnView 的可读映射（403 明确说明撤销入口缺失，不吞原始报错）。
 */
import { useEffect, useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import type { SessionTurn } from '@agentboard/shared';
import { api } from '../../api/client';
import {
  applyServerTurn,
  useRetryFailedStep,
  type TurnObservation,
} from '../../state/turnStore';
import { failedPlanStep, retryFailureText, retryStepGate } from '../../lib/turnView';
import {
  answerFailureText,
  awaitingCapText,
  awaitingElapsedText,
  awaitingKind,
  awaitingRuleText,
  parseAskMessage,
  timeoutFailureText,
} from '../../lib/turnView';

/** 已等待时长的秒级刷新（仅展示用；不是超时判定） */
function useNowTick(): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  return now;
}

function AwaitingMeta({ at, now }: { at: number | null; now: number }) {
  return (
    <div data-testid="awaiting-meta" className="mt-1 space-y-0.5 text-[10px] text-ink-3">
      <p data-testid="awaiting-elapsed">{awaitingElapsedText(at, now)}</p>
      <p data-testid="awaiting-rule">{awaitingRuleText()}</p>
      <p data-testid="awaiting-cap">{awaitingCapText(at)}</p>
    </div>
  );
}

export function AwaitingCard({
  sessionId,
  turn,
}: {
  sessionId: string;
  turn: TurnObservation;
}) {
  const kind = awaitingKind(turn.state, turn.awaiting);
  const now = useNowTick();
  const [answerText, setAnswerText] = useState('');
  const [error, setError] = useState<string | null>(null);

  const answer = useMutation({
    mutationFn: (text: string) =>
      api.post<SessionTurn>(`/api/sessions/${sessionId}/turns/${turn.turn_id}/answer`, {
        text,
      }),
    onSuccess: (updated) => {
      setError(null);
      setAnswerText('');
      // server 返回 running：立即回填（不依赖 WS 是否送达）
      applyServerTurn(updated);
    },
    onError: (e) => setError(answerFailureText(e)),
  });

  if (kind === null || kind === 'approval') return null;

  const { question, options } = parseAskMessage(turn.awaiting?.message ?? '');
  const submitText = (): void => {
    const text = answerText.trim();
    if (text === '') return;
    answer.mutate(text);
  };

  return (
    <article
      data-testid="awaiting-ask-card"
      aria-label="等待回答"
      className="mx-3 my-2 shrink-0 rounded-md border border-accent bg-accent-soft px-3 py-2 text-xs text-ink"
    >
      <p className="font-medium text-accent">等待你的回答</p>
      <div
        data-testid="awaiting-question"
        className="mt-1 whitespace-pre-wrap break-words text-ink-2"
      >
        {question !== '' ? question : (turn.awaiting?.message ?? '')}
      </div>
      {options.length > 0 && (
        <div className="mt-1.5 flex flex-wrap gap-1.5">
          {options.map((option, index) => (
            <button
              key={`${option.label}-${index}`}
              type="button"
              data-testid={`awaiting-option-${index}`}
              disabled={answer.isPending}
              title={option.description === '' ? option.label : option.description}
              onClick={() => answer.mutate(option.label)}
              className="rounded border border-accent bg-surface-card px-2 py-0.5 text-xs text-accent hover:opacity-90 disabled:opacity-40"
            >
              {option.label}
            </button>
          ))}
        </div>
      )}
      <div className="mt-1.5 flex items-end gap-1.5">
        <textarea
          data-testid="awaiting-answer-input"
          aria-label="回答内容"
          value={answerText}
          rows={2}
          onChange={(e) => setAnswerText(e.target.value)}
          placeholder="也可输入自由文本回答"
          className="min-h-0 w-full resize-none rounded border border-hairline bg-surface-card px-2 py-1 text-xs text-ink outline-none placeholder:text-ink-3 focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent"
        />
        <button
          type="button"
          data-testid="awaiting-answer-submit"
          disabled={answer.isPending || answerText.trim() === ''}
          onClick={submitText}
          className="shrink-0 rounded border border-accent bg-accent-soft px-2 py-1 text-xs font-medium text-accent hover:opacity-90 disabled:opacity-40"
        >
          {answer.isPending ? '提交中…' : '提交回答'}
        </button>
      </div>
      <AwaitingMeta at={turn.awaiting?.at ?? null} now={now} />
      {error !== null && (
        <p
          data-testid="awaiting-answer-error"
          role="alert"
          className="mt-1 text-xs text-red-600 dark:text-red-400"
        >
          {error}
        </p>
      )}
    </article>
  );
}

export function AwaitingTimeoutCard({
  turn,
  onRestartRound,
}: {
  turn: TurnObservation;
  /** 整轮兜底：没有可定位的失败步骤时，重新发送上一条用户消息（会重跑全部步骤） */
  onRestartRound: () => Promise<void>;
}) {
  const [restarting, setRestarting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const failedStep = failedPlanStep(turn);
  const gate = retryStepGate(turn, failedStep?.step_id ?? null);
  const retry = useRetryFailedStep(turn.session_id);

  const restartRound = async (): Promise<void> => {
    setRestarting(true);
    setError(null);
    try {
      await onRestartRound();
    } catch (e) {
      setError(e instanceof Error ? e.message : '重新开始失败');
    } finally {
      setRestarting(false);
    }
  };

  const retryStep = (): void => {
    if (failedStep === null || retry.isPending) return;
    setError(null);
    retry.mutate(
      { turnId: turn.turn_id, stepId: failedStep.step_id },
      { onError: (e) => setError(retryFailureText(e)) },
    );
  };

  return (
    <article
      data-testid="awaiting-timeout-card"
      aria-label="等待超时"
      className="mx-3 my-2 shrink-0 rounded-md border border-red-300 bg-red-50 px-3 py-2 text-xs text-ink dark:border-red-800 dark:bg-red-950/40"
    >
      <p className="font-medium text-red-700 dark:text-red-300">等待超时</p>
      <div
        data-testid="awaiting-timeout-message"
        className="mt-1 whitespace-pre-wrap break-words text-ink-2"
      >
        {timeoutFailureText(turn.awaiting)}
      </div>
      <div className="mt-1 space-y-0.5 text-[10px] text-ink-3">
        <p data-testid="awaiting-rule">{awaitingRuleText()}</p>
        <p data-testid="awaiting-cap">{awaitingCapText(turn.awaiting?.at ?? null)}</p>
      </div>
      <div className="mt-2 flex flex-wrap items-center gap-1.5">
        {failedStep !== null ? (
          <>
            <button
              type="button"
              data-testid="awaiting-retry-step"
              disabled={retry.isPending || !gate.enabled}
              title={gate.reason ?? '只重跑该失败步骤，不重发整轮'}
              onClick={retryStep}
              className="rounded border border-red-300 px-2 py-0.5 text-xs font-medium text-red-600 hover:bg-red-100 disabled:cursor-not-allowed disabled:opacity-40 dark:border-red-800 dark:text-red-400 dark:hover:bg-red-900/40"
            >
              {retry.isPending ? '重试中…' : '重试此步'}
            </button>
            <span data-testid="awaiting-retry-hint" className="text-[10px] text-ink-3">
              只重跑该步（不重发整轮）
            </span>
          </>
        ) : (
          <button
            type="button"
            data-testid="awaiting-restart"
            disabled={restarting}
            title="本轮没有可定位的失败步骤，只能整轮重发上一条用户消息（会重跑全部步骤）"
            onClick={() => void restartRound()}
            className="rounded border border-red-300 px-2 py-0.5 text-xs font-medium text-red-600 hover:bg-red-100 disabled:opacity-40 dark:border-red-800 dark:text-red-400 dark:hover:bg-red-900/40"
          >
            {restarting ? '重新开始中…' : '重发整轮'}
          </button>
        )}
      </div>
      {error !== null && (
        <p
          data-testid="awaiting-restart-error"
          role="alert"
          className="mt-1 text-xs text-red-600 dark:text-red-400"
        >
          {error}
        </p>
      )}
    </article>
  );
}
