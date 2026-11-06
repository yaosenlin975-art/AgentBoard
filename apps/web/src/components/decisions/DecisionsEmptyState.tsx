/**
 * DEC-V4-EMPTY（P7）：待决策真空态。
 *
 * 真空态 = 当前范围内没有 grace/open/stale。除标题与三条机制说明外，
 * 24h 内有已回答时列出最近 1–3 条「刚处理完」，点击回到该卡详情；
 * 没有则不渲染该区块。跨区的「其它工作区」提示仍由 P5 口径提供（本组件只输出这一份）。
 *
 * 筛选空态（有数据但当前 tab 为空）不在这里渲染，见 DecisionsView 的 `decisions-filter-empty`。
 */
import { useQuery } from '@tanstack/react-query';
import { api } from '../../api/client';
import type { DecisionsScope } from '../../lib/decisionsScope';
import type { DecisionDetailDto, DecisionListItemDto } from './types';

const RECENT_LIMIT = 3;

const MECHANISMS = [
  '宽限默认 3 分钟，到点自动落锁并停止 agent。',
  '通知是前置条件，没开通知就会错过宽限。',
  '「已锁」不等于失败：回答后任务卡回到待规划、需要重新 claim。',
] as const;

function formatClock(ms: number): string {
  return new Date(ms).toLocaleTimeString('zh-CN', { hour12: false });
}

/** 结论摘要：优先取当前 revision 的选项文案，拿不到时回落到「第 N 版」，不编造结论 */
function RecentAnsweredRow({
  item,
  onOpenIssue,
}: {
  item: DecisionListItemDto;
  onOpenIssue: (issueId: string) => void;
}) {
  const { data } = useQuery({
    queryKey: ['decision', item.id],
    queryFn: () => api.get<{ decision: DecisionDetailDto }>(`/api/decisions/${encodeURIComponent(item.id)}`),
  });
  const detail = data?.decision ?? null;
  const answer = detail?.answers.find((entry) => entry.revision === item.answer_revision) ?? null;
  const optionLabel =
    answer === null
      ? null
      : (detail?.options.find((option) => option.id === answer.option_id)?.label ?? answer.answer_text ?? null);
  const summary = optionLabel === null ? `第 ${item.answer_revision} 版` : `「${optionLabel}」`;

  return (
    <li data-testid={`decisions-empty-recent-${item.id}`}>
      <button
        type="button"
        onClick={() => onOpenIssue(item.issue_id)}
        className="flex w-full min-w-0 flex-col items-start gap-0.5 rounded border border-hairline bg-surface-card px-1.5 py-1 text-left hover:bg-surface-raised focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent"
      >
        <span className="w-full truncate text-xs text-ink" title={item.issue_title}>
          {item.issue_title}
        </span>
        <span className="flex w-full min-w-0 items-center gap-1.5 text-[11px] text-ink-3">
          <span className="shrink-0">{summary}</span>
          <span className="shrink-0">·</span>
          <span className="shrink-0">
            {item.answered_at === null ? '已回答' : formatClock(item.answered_at)}
          </span>
          {item.current_answer_by !== undefined && item.current_answer_by !== null && (
            <>
              <span className="shrink-0">·</span>
              <span className="min-w-0 truncate">{item.current_answer_by}</span>
            </>
          )}
        </span>
      </button>
    </li>
  );
}

export interface DecisionsEmptyStateProps {
  scope: DecisionsScope;
  /** 24h 内已回答（已按回答时间倒序） */
  answered: DecisionListItemDto[];
  onOpenIssue: (issueId: string) => void;
  onGoBoard: () => void;
}

export function DecisionsEmptyState({ scope, answered, onOpenIssue, onGoBoard }: DecisionsEmptyStateProps) {
  const recent = answered.slice(0, RECENT_LIMIT);
  return (
    <div data-testid="decisions-empty" className="flex flex-col gap-2 px-1 py-3 text-xs text-ink-3">
      <p className="text-sm font-medium text-ink">当前范围没有待决策</p>

      <ul className="flex flex-col gap-1" role="list" data-testid="decisions-empty-mechanisms">
        {MECHANISMS.map((line) => (
          <li key={line} className="flex gap-1.5">
            <span aria-hidden className="shrink-0 text-ink-3">
              ·
            </span>
            <span>{line}</span>
          </li>
        ))}
      </ul>

      <p data-testid="decisions-empty-scope-hint">
        {scope === 'all'
          ? '所有可访问工作区都没有待决策'
          : '暂无待决策：当前工作区没有在途决策；其它工作区的待决策不在这里，切到「所有工作区」可查看'}
      </p>

      {recent.length > 0 && (
        <div data-testid="decisions-empty-recent" className="flex flex-col gap-1">
          <h3 className="text-xs font-medium text-ink-2">刚处理完</h3>
          <ul className="flex flex-col gap-1" role="list">
            {recent.map((item) => (
              <RecentAnsweredRow key={item.id} item={item} onOpenIssue={onOpenIssue} />
            ))}
          </ul>
        </div>
      )}

      <button
        type="button"
        data-testid="decisions-empty-go-board"
        onClick={onGoBoard}
        className="self-start whitespace-nowrap rounded-md border border-hairline px-2 py-1 text-xs text-ink-2 hover:bg-surface-raised focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent"
      >
        去任务看板
      </button>
    </div>
  );
}
