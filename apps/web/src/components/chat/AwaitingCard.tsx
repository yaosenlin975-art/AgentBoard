/**
 * CHAT-AWAIT2：阻塞态卡片（消息区与输入区之间，不改头部结构）。
 *
 * - `awaiting_input`：展示提问正文与可选项（自由文本兜底），POST answer；
 * - `awaiting_approval`：展示工具/目标/风险与允许/拒绝（仅本次档），POST approval；
 * - `failed(awaiting_timeout)`：展示服务端超时原因与「重新开始此步」入口（整轮重发兜底）。
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
import { applyServerTurn, type TurnObservation } from '../../state/turnStore';
import {
  answerFailureText,
  approvalFailureText,
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

  const approval = turn.awaiting?.approval ?? null;
  const decide = useMutation({
    mutationFn: (decision: 'allow' | 'deny') => {
      if (approval === null) return Promise.reject(new Error('审批请求缺少 request_id'));
      return api.post<{ turn: SessionTurn }>(
        `/api/sessions/${sessionId}/turns/${turn.turn_id}/approvals/${approval.request_id}`,
        { decision, scope: 'once' },
      );
    },
    onSuccess: (res) => {
      setError(null);
      applyServerTurn(res.turn);
    },
    onError: (e) => setError(approvalFailureText(e)),
  });

  if (kind === null) return null;

  if (kind === 'approval') {
    return (
      <article
        data-testid="awaiting-approval-card"
        aria-label="等待审批"
        className="mx-3 my-2 shrink-0 rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-ink dark:border-amber-800 dark:bg-amber-950/40"
      >
        <p className="font-medium text-amber-700 dark:text-amber-300">等待审批</p>
        <p className="mt-1 text-ink-2" data-testid="awaiting-approval-summary">
          {approval === null
            ? (turn.awaiting?.message ?? '等待审批')
            : `${approval.tool} · ${approval.target}`}
        </p>
        {approval !== null && (
          <p className="mt-0.5 text-[10px] text-ink-3" data-testid="awaiting-approval-risk">
            风险：{approval.risk}
          </p>
        )}
        <AwaitingMeta at={turn.awaiting?.at ?? null} now={now} />
        <div className="mt-2 flex flex-wrap items-center gap-1.5">
          <button
            type="button"
            data-testid="awaiting-allow"
            disabled={decide.isPending}
            onClick={() => decide.mutate('allow')}
            className="rounded border border-accent bg-accent-soft px-2 py-0.5 text-xs font-medium text-accent hover:opacity-90 disabled:opacity-40"
          >
            {decide.isPending ? '提交中…' : '允许（仅本次）'}
          </button>
          <button
            type="button"
            data-testid="awaiting-deny"
            disabled={decide.isPending}
            onClick={() => decide.mutate('deny')}
            className="rounded border border-red-300 px-2 py-0.5 text-xs font-medium text-red-600 hover:bg-red-50 disabled:opacity-40 dark:border-red-800 dark:text-red-400 dark:hover:bg-red-950/40"
          >
            拒绝
          </button>
          <span className="text-[10px] text-ink-3">
            本工作区档需先提供撤销入口（暂不可用），当前仅支持「仅本次」。
          </span>
        </div>
        {error !== null && (
          <p
            data-testid="awaiting-approval-error"
            role="alert"
            className="mt-1 text-xs text-red-600 dark:text-red-400"
          >
            {error}
          </p>
        )}
      </article>
    );
  }

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
  onRestart,
}: {
  turn: TurnObservation;
  /** 重新开始此步：整轮重发兜底（服务端没有「重置单个等待步」的端点） */
  onRestart: () => Promise<void>;
}) {
  const [restarting, setRestarting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const restart = async (): Promise<void> => {
    setRestarting(true);
    setError(null);
    try {
      await onRestart();
    } catch (e) {
      setError(e instanceof Error ? e.message : '重新开始失败');
    } finally {
      setRestarting(false);
    }
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
        <button
          type="button"
          data-testid="awaiting-restart"
          disabled={restarting}
          title="以新的轮次重新发起同一请求（服务端暂无「重置单个等待步」端点）"
          onClick={() => void restart()}
          className="rounded border border-red-300 px-2 py-0.5 text-xs font-medium text-red-600 hover:bg-red-100 disabled:opacity-40 dark:border-red-800 dark:text-red-400 dark:hover:bg-red-900/40"
        >
          {restarting ? '重新开始中…' : '重新开始此步'}
        </button>
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
