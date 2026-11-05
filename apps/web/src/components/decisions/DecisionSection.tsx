/**
 * DEC-6：卡详情里的决策区（设计 v3 §3.7 / §4.4）。
 *
 * 展示：问题、选项（含 consequence）、当前答案、答案修订时间线（第 1 版 / 第 2 版 …）、
 * checkpoint 摘要、停止信号状态；提供「回答 / 修订」入口（POST /api/decisions/:id/answer）。
 * 无决策（既无在途、也无最近已回答）时不渲染，旧卡详情零变化。
 */
import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { Issue } from '@agentboard/shared';
import { api } from '../../api/client';
import { useIssueDecision } from './useDecisions';
import type { DecisionAnswerDto, DecisionDetailDto, DecisionState } from './types';

const STATE_LABEL: Record<DecisionState, string> = {
  grace: '宽限中',
  open: '等待回答',
  answered: '已回答',
  withdrawn: '已撤回',
};

const CHECKPOINT_LABEL: Record<string, string> = {
  stash: 'stash',
  stash_sha: 'stash SHA',
  diff_summary: '改动摘要',
  next_step: '下一步',
  background_pid: '后台 PID',
  summary: '摘要',
};

function formatClock(ms: number): string {
  return new Date(ms).toLocaleString('zh-CN', { hour12: false });
}

/** checkpoint_json → 可读行（非 JSON / 标量原样展示） */
export function checkpointLines(raw: string | null): string[] {
  if (raw === null || raw.trim() === '') return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed === null || typeof parsed !== 'object') return [String(parsed)];
    const entries = Object.entries(parsed as Record<string, unknown>).filter(([, value]) => value !== null && value !== undefined);
    return entries.map(([key, value]) => {
      const label = CHECKPOINT_LABEL[key] ?? key;
      return `${label}：${typeof value === 'string' ? value : JSON.stringify(value)}`;
    });
  } catch {
    return [raw];
  }
}

function answerLabel(answer: DecisionAnswerDto, detail: DecisionDetailDto | null): string {
  const option = detail?.options.find((item) => item.id === answer.option_id);
  if (option) return `「${option.label}」`;
  if (answer.answer_text !== null && answer.answer_text !== '') return answer.answer_text;
  return '（空答案）';
}

export function DecisionSection({ issue }: { issue: Issue }) {
  const queryClient = useQueryClient();
  const { summary, detail } = useIssueDecision(issue.workspace_id, issue.id);
  const [pendingOption, setPendingOption] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const decision = detail ?? summary;
  const state: DecisionState = decision?.state ?? 'open';

  const answer = useMutation({
    mutationFn: (optionId: string) =>
      api.post<{ decision: DecisionDetailDto }>(`/api/decisions/${encodeURIComponent(decision!.id)}/answer`, {
        option_id: optionId,
        source: 'web',
        // 已有答案再点 = 修订：必须带 CAS 期望版本（服务端 DECISION_REVISION_CONFLICT = 409）
        ...(state === 'answered' ? { expected_revision: decision!.answer_revision } : {}),
      }),
    onMutate: (optionId) => {
      setPendingOption(optionId);
      setError(null);
    },
    onSettled: () => setPendingOption(null),
    onError: (err) => setError(err instanceof Error ? err.message : '回答失败'),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['decisions'] });
      void queryClient.invalidateQueries({ queryKey: ['decisions-count'] });
      void queryClient.invalidateQueries({ queryKey: ['decision'] });
      void queryClient.invalidateQueries({ queryKey: ['issue', issue.id] });
      void queryClient.invalidateQueries({ queryKey: ['issues'] });
    },
  });

  if (decision === null) return null;

  const options = [...(detail?.options ?? [])].sort((a, b) => a.ord - b.ord);
  const answers = [...(detail?.answers ?? [])].sort((a, b) => a.revision - b.revision);
  const current = answers.find((item) => item.revision === decision.answer_revision) ?? answers.at(-1) ?? null;
  const checkpoints = checkpointLines(detail?.checkpoint_json ?? null);
  const canAnswer = state === 'grace' || state === 'open' || state === 'answered';

  return (
    <section
      data-testid="decision-section"
      data-decision-state={state}
      aria-label="待决策"
      className="rounded-md border border-accent/40 bg-accent-soft/40 p-2"
    >
      <header className="mb-1 flex flex-wrap items-baseline gap-2">
        <span className="text-xs font-semibold text-accent">待决策</span>
        <span data-testid="decision-state" className="rounded border border-accent/40 px-1.5 text-xs text-accent">
          {STATE_LABEL[state]}
        </span>
        {state === 'grace' && (
          <span className="text-xs text-ink-3">到期自动落锁并停止 agent</span>
        )}
        {decision.stop_requested_at !== null && state === 'open' && (
          <span data-testid="decision-stop-requested" className="text-xs text-ink-2">
            已发出停止信号（{formatClock(decision.stop_requested_at)}）
          </span>
        )}
      </header>

      <p data-testid="decision-question" className="text-sm font-medium text-ink">
        {decision.question}
      </p>
      {decision.context_md !== '' && (
        <p className="mt-1 whitespace-pre-wrap text-xs text-ink-2">{decision.context_md}</p>
      )}

      {options.length > 0 && (
        <ul className="mt-2 flex flex-col gap-1" role="list">
          {options.map((option) => {
            const chosen = current?.option_id === option.id;
            return (
              <li key={option.id} className="flex min-w-0 flex-col gap-1 rounded border border-hairline bg-surface-card p-1.5">
                <div className="flex min-w-0 items-baseline gap-2">
                  <span className="shrink-0 text-xs text-ink-3">{option.ord}.</span>
                  <span className={`truncate text-sm ${chosen ? 'font-semibold text-accent' : 'text-ink'}`}>
                    {option.label}
                    {chosen && <span className="ml-1 text-xs font-normal text-ink-3">（当前答案）</span>}
                  </span>
                </div>
                <span className="text-xs text-ink-2">{option.consequence}</span>
                {canAnswer && (
                  <button
                    type="button"
                    data-testid={`decision-answer-${option.id}`}
                    disabled={answer.isPending}
                    onClick={() => answer.mutate(option.id)}
                    className="self-start whitespace-nowrap rounded border border-hairline px-2 py-0.5 text-xs text-ink-2 transition-colors duration-150 motion-reduce:transition-none hover:bg-surface-raised disabled:opacity-50 focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent"
                  >
                    {pendingOption === option.id ? '提交中…' : state === 'answered' ? `修订为「${option.label}」` : `选择「${option.label}」`}
                  </button>
                )}
              </li>
            );
          })}
        </ul>
      )}

      {error !== null && (
        <p data-testid="decision-answer-error" className="mt-1 text-xs text-red-600 dark:text-red-400">
          {error}
        </p>
      )}

      {answers.length > 0 && (
        <div data-testid="decision-answers" className="mt-2">
          <h4 className="text-xs font-medium text-ink-2">答案时间线</h4>
          <ol className="mt-1 flex flex-col gap-0.5" role="list">
            {answers.map((item) => (
              <li key={item.id} data-testid={`decision-answer-revision-${item.revision}`} className="text-xs text-ink-2">
                <span className="tabular-nums text-ink-3">第 {item.revision} 版</span>
                <span className="mx-1">·</span>
                <span>{answerLabel(item, detail)}</span>
                <span className="mx-1 text-ink-3">·</span>
                <span className="text-ink-3">
                  {item.answered_by}（{item.source}）{formatClock(item.created_at)}
                </span>
              </li>
            ))}
          </ol>
        </div>
      )}

      {checkpoints.length > 0 && (
        <div data-testid="decision-checkpoint" className="mt-2">
          <h4 className="text-xs font-medium text-ink-2">断点摘要</h4>
          <ul className="mt-1 flex flex-col gap-0.5" role="list">
            {checkpoints.map((line, index) => (
              <li key={`${index}-${line}`} className="truncate text-xs text-ink-2" title={line}>
                {line}
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}
