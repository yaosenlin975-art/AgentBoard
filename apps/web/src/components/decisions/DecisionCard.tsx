/**
 * DEC-V4-INLINE（P3）：待决策就地作答卡。
 *
 * 收起态（默认）：rank + 卡名 + 倒计时 / 停止信号 + 问题（2 行截断）+ 选项 chip 行
 * + 单行后果预览 + 动作行（主按钮「提交回答」默认禁用，选中后可用）。
 * 展开态：只渲染详细卡（全文问题、带 consequence 的选项列表、关键值、断点、答案时间线），
 * chip 行不进入 DOM（验收：展开后 queryByTestId('decision-chips-<id>') 为 null）。
 *
 * 数据口径：全部消费 P1A/P1B 已提交字段（options / issue_priority / blocked_downstream_count /
 * waiting_seconds / stop_*），详情（checkpoint / 全量 answers）走 `GET /api/decisions/:id`，
 * 不在前端自造数据源。
 */
import { useEffect, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { ApiError } from '../../api/client';
import { formatCountdown, formatWaiting } from './countdown';
import { checkpointLines } from './DecisionSection';
import { useAnswerDecision, useDecisionDetail } from './useDecisions';
import type { DecisionAnswerDto, DecisionDetailDto, DecisionListItemDto } from './types';

/** 容器宽度阈值：≤660px 时动作行纵向堆叠、主按钮占满 */
const NARROW_BREAKPOINT = 660;

function useNarrowContainer(breakpoint: number) {
  const ref = useRef<HTMLLIElement | null>(null);
  const [narrow, setNarrow] = useState(false);
  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    const measure = () => {
      const width = element.getBoundingClientRect().width;
      // jsdom / 尚未布局时 width=0：回退到视口宽度，保证首屏也能给出确定值
      setNarrow(width > 0 ? width <= breakpoint : window.innerWidth <= breakpoint);
    };
    measure();
    if (typeof ResizeObserver === 'undefined') {
      window.addEventListener('resize', measure);
      return () => window.removeEventListener('resize', measure);
    }
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [breakpoint]);
  return { ref, narrow };
}

function formatClock(ms: number): string {
  return new Date(ms).toLocaleTimeString('zh-CN', { hour12: false });
}

function currentAnswer(detail: DecisionDetailDto | null, revision: number): DecisionAnswerDto | null {
  if (detail === null) return null;
  return detail.answers.find((answer) => answer.revision === revision) ?? null;
}

function optionLabel(detail: DecisionDetailDto | null, answer: DecisionAnswerDto | null): string | null {
  if (answer === null) return null;
  const option = detail?.options.find((item) => item.id === answer.option_id);
  if (option) return option.label;
  if (answer.answer_text !== null && answer.answer_text !== '') return answer.answer_text;
  return '（空答案）';
}

export interface DecisionCardProps {
  item: DecisionListItemDto;
  now: number;
  rank: number | undefined;
  focused: boolean;
  scope: 'grace' | 'open' | 'stale' | 'answered';
  expanded: boolean;
  onToggle: (decisionId: string) => void;
  onOpenIssue: (issueId: string) => void;
}

export function DecisionCard({ item, now, rank, focused, scope, expanded, onToggle, onOpenIssue }: DecisionCardProps) {
  const queryClient = useQueryClient();
  const { ref, narrow } = useNarrowContainer(NARROW_BREAKPOINT);
  const [selectedOptionId, setSelectedOptionId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  // 已回答卡收起态也要展示当前答案选项 → 仅在 answered 时预取详情；展开时一律取详情
  const detailQueryEnabled = expanded || scope === 'answered';
  const detail = useDecisionDetail(detailQueryEnabled ? item.id : null);
  const answerMutation = useAnswerDecision();

  const options = [...item.options].sort((a, b) => a.ord - b.ord);
  const defaultOption = options.find((option) => option.is_default === 1) ?? options[0] ?? null;
  const selectedOption = options.find((option) => option.id === selectedOptionId) ?? null;
  const preview = selectedOption ?? defaultOption;
  const current = currentAnswer(detail, item.answer_revision);
  const currentLabel = optionLabel(detail, current);
  const isAnswered = scope === 'answered' || item.state === 'answered';
  const canSubmit = !answerMutation.isPending && (current === null || selectedOptionId !== current.option_id);

  const graceRemaining =
    item.state === 'grace' && item.grace_until > now ? Math.max(0, Math.ceil((item.grace_until - now) / 1000)) : null;
  const waiting = item.state === 'open' ? formatWaiting(item.waiting_seconds ?? null) : null;

  function submit() {
    if (selectedOptionId === null || !canSubmit) return;
    setError(null);
    answerMutation.mutate(
      {
        decisionId: item.id,
        optionId: selectedOptionId,
        ...(isAnswered ? { expectedRevision: item.answer_revision } : {}),
      },
      {
        onSuccess: () => setSelectedOptionId(null),
        onError: (err) => {
          if (err instanceof ApiError && err.status === 409) {
            setError('答案版本冲突：已为你刷新，请重新选择后再提交');
            void queryClient.invalidateQueries({ queryKey: ['decisions'] });
            void queryClient.invalidateQueries({ queryKey: ['decision'] });
            return;
          }
          setError(err instanceof Error ? err.message : '提交失败');
        },
      },
    );
  }

  const actionLabel = answerMutation.isPending ? '提交中…' : isAnswered ? '提交修订' : '提交回答';

  return (
    <li
      ref={ref}
      data-testid={`decision-item-${item.id}`}
      data-selected={focused ? 'true' : 'false'}
      data-expanded={expanded ? 'true' : 'false'}
      className={`flex min-w-0 flex-col gap-1.5 rounded-md border bg-surface-card px-2 py-1.5 transition-colors duration-150 motion-reduce:transition-none ${
        focused ? 'border-accent bg-accent-soft' : 'border-hairline hover:bg-surface-raised'
      }`}
    >
      <div className="flex min-w-0 items-center gap-2">
        {rank !== undefined && (
          <span
            data-testid={`decision-rank-${item.id}`}
            className="shrink-0 whitespace-nowrap rounded bg-surface-raised px-1 font-mono text-xs tabular-nums text-ink-3"
          >
            #{rank}
          </span>
        )}
        <button
          type="button"
          onClick={() => onOpenIssue(item.issue_id)}
          title={`打开卡详情：${item.issue_title}`}
          className="min-w-0 truncate text-left text-sm text-ink focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent"
        >
          {item.issue_title}
        </button>
        {graceRemaining !== null && (
          <span
            data-testid={`decision-countdown-${item.id}`}
            className="ml-auto shrink-0 whitespace-nowrap rounded bg-accent-soft px-1.5 text-xs font-medium tabular-nums text-accent"
          >
            {formatCountdown(graceRemaining)}
          </span>
        )}
        {scope === 'stale' && (
          <span className="ml-auto shrink-0 whitespace-nowrap rounded border border-hairline px-1.5 text-xs text-ink-2">
            超时
          </span>
        )}
        {scope === 'answered' && item.answered_at !== null && (
          <span className="ml-auto shrink-0 whitespace-nowrap text-xs text-ink-3">
            已回答于 {formatClock(item.answered_at)}
          </span>
        )}
        <button
          type="button"
          data-testid={`decision-toggle-${item.id}`}
          aria-expanded={expanded}
          onClick={() => onToggle(item.id)}
          className="shrink-0 whitespace-nowrap rounded border border-hairline px-1.5 py-0.5 text-xs text-ink-2 hover:bg-surface-raised focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent"
        >
          {expanded ? '收起' : '展开'}
        </button>
      </div>

      {/* 停止确认状态（open / stale）：已确认优先于未确认 */}
      {item.stop_ack_at !== null ? (
        <span data-testid={`decision-stop-acked-${item.id}`} className="self-start rounded bg-surface-raised px-1.5 text-xs text-ink-2">
          已确认停止（{formatClock(item.stop_ack_at)}）
        </span>
      ) : item.stop_requested_at !== null ? (
        <span
          data-testid={`decision-stop-unacked-${item.id}`}
          className="self-start rounded border border-red-300 px-1.5 text-xs text-red-600 dark:border-red-800 dark:text-red-400"
        >
          停止未确认（{formatClock(item.stop_requested_at)}）
        </span>
      ) : null}

      {expanded ? (
        <ExpandedBody
          item={item}
          detail={detail}
          selectedOptionId={selectedOptionId}
          onSelect={setSelectedOptionId}
        />
      ) : (
        <CollapsedBody
          item={item}
          options={options}
          selectedOptionId={selectedOptionId}
          preview={preview}
          onSelect={setSelectedOptionId}
        />
      )}

      {currentLabel !== null && (
        <span data-testid={`decision-current-answer-${item.id}`} className="text-xs text-ink-2">
          当前答案：第 {item.answer_revision} 版「{currentLabel}」
        </span>
      )}

      {waiting !== null && <span className="text-xs text-ink-3">已等 {waiting}</span>}

      {error !== null && (
        <p data-testid={`decision-error-${item.id}`} className="text-xs text-red-600 dark:text-red-400">
          {error}
        </p>
      )}

      <div
        data-testid={`decision-actions-${item.id}`}
        style={{ flexDirection: narrow ? 'column' : 'row' }}
        className="flex items-stretch gap-1.5"
      >
        <button
          type="button"
          data-testid={`decision-action-${item.id}`}
          disabled={selectedOptionId === null || !canSubmit}
          onClick={submit}
          className={`whitespace-nowrap rounded-md px-2 py-1 text-xs transition-colors duration-150 motion-reduce:transition-none focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent disabled:opacity-50 ${
            isAnswered
              ? 'border border-hairline text-ink-2 hover:bg-surface-raised'
              : 'bg-accent font-medium text-white hover:opacity-90'
          } ${narrow ? 'w-full' : ''}`}
        >
          {actionLabel}
        </button>
        {isAnswered && !expanded && (
          <button
            type="button"
            data-testid={`decision-revise-${item.id}`}
            onClick={() => onToggle(item.id)}
            className="whitespace-nowrap rounded-md border border-hairline px-2 py-1 text-xs text-ink-2 hover:bg-surface-raised focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent"
          >
            改答案
          </button>
        )}
        <button
          type="button"
          data-testid={`decision-open-${item.id}`}
          onClick={() => onOpenIssue(item.issue_id)}
          className={`whitespace-nowrap rounded-md border border-hairline px-2 py-1 text-xs text-ink-2 hover:bg-surface-raised focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent ${
            narrow ? 'w-full' : 'ml-auto'
          }`}
        >
          卡详情
        </button>
      </div>
    </li>
  );
}

interface CollapsedBodyProps {
  item: DecisionListItemDto;
  options: DecisionListItemDto['options'];
  selectedOptionId: string | null;
  preview: DecisionListItemDto['options'][number] | null;
  onSelect: (optionId: string) => void;
}

function CollapsedBody({ item, options, selectedOptionId, preview, onSelect }: CollapsedBodyProps) {
  return (
    <>
      <p className="line-clamp-2 text-xs text-ink-2">{item.question}</p>
      <div data-testid={`decision-chips-${item.id}`} role="group" aria-label="选择回答选项" className="flex flex-wrap gap-1">
        {options.map((option) => {
          const selected = option.id === selectedOptionId;
          return (
            <button
              key={option.id}
              type="button"
              data-testid={`decision-option-${option.id}`}
              aria-pressed={selected}
              onClick={() => onSelect(option.id)}
              className={`rounded-full border px-2 py-0.5 text-xs transition-colors duration-150 motion-reduce:transition-none focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent ${
                selected ? 'border-accent bg-accent-soft font-medium text-accent' : 'border-hairline text-ink-2 hover:bg-surface-raised'
              }`}
            >
              {option.label}
            </button>
          );
        })}
      </div>
      <p data-testid={`decision-consequence-${item.id}`} className="truncate text-xs text-ink-3">
        {preview === null ? '暂无选项' : `后果：${preview.consequence}`}
      </p>
    </>
  );
}

interface ExpandedBodyProps {
  item: DecisionListItemDto;
  detail: DecisionDetailDto | null;
  selectedOptionId: string | null;
  onSelect: (optionId: string) => void;
}

function ExpandedBody({ item, detail, selectedOptionId, onSelect }: ExpandedBodyProps) {
  const options = [...(detail?.options ?? item.options)].sort((a, b) => a.ord - b.ord);
  const answers = [...(detail?.answers ?? [])].sort((a, b) => a.revision - b.revision);
  const current = currentAnswer(detail, item.answer_revision);
  const checkpoints = checkpointLines(detail?.checkpoint_json ?? null);

  return (
    <div data-testid={`decision-detail-${item.id}`} className="flex min-w-0 flex-col gap-1.5">
      <p data-testid={`decision-full-question-${item.id}`} className="whitespace-pre-wrap text-sm font-medium text-ink">
        {item.question}
      </p>
      {item.context_md !== '' && <p className="whitespace-pre-wrap text-xs text-ink-2">{item.context_md}</p>}

      <ul data-testid={`decision-options-${item.id}`} className="flex flex-col gap-1" role="list">
        {options.map((option) => {
          const selected = option.id === selectedOptionId;
          const answered = current?.option_id === option.id;
          return (
            <li key={option.id}>
              <button
                type="button"
                data-testid={`decision-detail-option-${option.id}`}
                aria-pressed={selected}
                onClick={() => onSelect(option.id)}
                className={`flex w-full min-w-0 flex-col items-start gap-0.5 rounded border px-1.5 py-1 text-left transition-colors duration-150 motion-reduce:transition-none focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent ${
                  selected ? 'border-accent bg-accent-soft' : 'border-hairline bg-surface-card hover:bg-surface-raised'
                }`}
              >
                <span className="flex w-full min-w-0 items-baseline gap-2">
                  <span className="shrink-0 text-xs text-ink-3">{option.ord}.</span>
                  <span className={`min-w-0 truncate text-sm ${selected || answered ? 'font-semibold text-accent' : 'text-ink'}`}>
                    {option.label}
                  </span>
                  {option.is_default === 1 && (
                    <span data-testid={`decision-default-${option.id}`} className="shrink-0 rounded bg-surface-raised px-1 text-xs text-ink-3">
                      默认
                    </span>
                  )}
                  {answered && <span className="ml-auto shrink-0 text-xs text-ink-3">（当前答案）</span>}
                </span>
                <span className="w-full text-xs text-ink-2">{option.consequence}</span>
              </button>
            </li>
          );
        })}
      </ul>

      <dl data-testid={`decision-meta-${item.id}`} className="grid grid-cols-2 gap-x-3 gap-y-0.5 text-xs text-ink-3">
        <div className="flex min-w-0 gap-1">
          <dt className="shrink-0">优先级</dt>
          <dd className="truncate text-ink-2">{item.issue_priority}</dd>
        </div>
        <div className="flex min-w-0 gap-1">
          <dt className="shrink-0">下游阻塞</dt>
          <dd className="truncate text-ink-2">{item.blocked_downstream_count}</dd>
        </div>
        <div className="flex min-w-0 gap-1">
          <dt className="shrink-0">提问</dt>
          <dd className="truncate text-ink-2">{item.created_by}</dd>
        </div>
        <div className="flex min-w-0 gap-1">
          <dt className="shrink-0">提问于</dt>
          <dd className="truncate text-ink-2">{formatClock(item.created_at)}</dd>
        </div>
      </dl>

      {checkpoints.length > 0 && (
        <div data-testid={`decision-checkpoint-${item.id}`}>
          <h4 className="text-xs font-medium text-ink-2">断点</h4>
          <ul className="mt-0.5 flex flex-col gap-0.5" role="list">
            {checkpoints.map((line, index) => (
              <li key={`${index}-${line}`} className="truncate text-xs text-ink-2" title={line}>
                {line}
              </li>
            ))}
          </ul>
        </div>
      )}

      {answers.length > 0 && (
        <div data-testid={`decision-answers-${item.id}`}>
          <h4 className="text-xs font-medium text-ink-2">答案时间线</h4>
          <ol className="mt-0.5 flex flex-col gap-0.5" role="list">
            {answers.map((answer) => {
              const label = optionLabel(detail, answer);
              const isCurrent = answer.revision === item.answer_revision;
              return (
                <li
                  key={answer.id}
                  data-testid={`decision-answer-revision-${item.id}-${answer.revision}`}
                  data-current={isCurrent ? 'true' : 'false'}
                  className={`text-xs ${isCurrent ? 'font-semibold text-accent' : 'text-ink-2'}`}
                >
                  <span className="tabular-nums text-ink-3">第 {answer.revision} 版</span>
                  <span className="mx-1">·</span>
                  <span>{label === null ? '（空答案）' : `「${label}」`}</span>
                  {answer.revoked_at !== null && <span className="ml-1 text-ink-3">（已撤销）</span>}
                  <span className="mx-1 text-ink-3">·</span>
                  <span className="text-ink-3">
                    {answer.answered_by}（{answer.source}）{formatClock(answer.created_at)}
                  </span>
                </li>
              );
            })}
          </ol>
        </div>
      )}
    </div>
  );
}
