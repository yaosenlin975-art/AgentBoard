/**
 * 看板卡片（§7.3）：标题、左缘优先级色条、标签 chips、占用徽标（会话运行中加动效点）、
 * 关联会话标记、评论数徽标（0 条隐藏，详情看右侧面板）；点击开任务详情。
 * 占用中卡片禁止拖出：useSortable 仅禁 draggable，仍可作为落点；光标 not-allowed + title。
 */
import { useRef, type CSSProperties, type PointerEvent as ReactPointerEvent, type MouseEvent as ReactMouseEvent } from 'react';
import { useSortable } from '@dnd-kit/sortable';
import type { Issue, Priority } from '@agentboard/shared';
import { formatDueShort, isOverdue, overdueDays } from '../../lib/planningSort';
import { Badge } from '../ui/Badge';
import { IconBolt, IconComment, IconLock } from '../ui/Icon';
import { dependencyBadge } from '../../lib/dependency';
import { GRAB_CURSOR, GRABBING_CURSOR } from '../../lib/cursor';
import { usePanelStore } from '../../state/panelStore';

/**
 * UNSLOP：左缘 3px 是「状态轨」（签名细节），优先级退到文本层。
 * chrome 里只有一个强调色（琥珀），所以低/中走暖石墨台阶，高优先级才用琥珀。
 */
export const PRIORITY_BAR: Record<Priority, string> = {
  低: 'bg-ink-3',
  中: 'bg-ink-2',
  高: 'bg-accent',
};

const CARD_CLASS =
  'relative shrink-0 overflow-hidden rounded-xl border border-hairline bg-surface-card text-left text-sm transition-colors hover:border-ink-3';

function IssueCardPriority({ issue }: { issue: Issue }) {
  return (
    <span
      data-testid={`priority-bar-${issue.id}`}
      title={`优先级：${issue.priority}`}
      className={`absolute inset-y-0 left-0 w-1.5 ${PRIORITY_BAR[issue.priority]}`}
    />
  );
}

function IssueCardContents({ issue, sessionRunning }: { issue: Issue; sessionRunning: boolean }) {
  const claimedBy = issue.claimed_by;
  const claimed = claimedBy !== null;
  const depBadge = dependencyBadge(issue);

  return (
    <>
      <div className="font-medium leading-snug text-ink">{issue.title}</div>
      {(() => {
        const due = formatDueShort(issue);
        if (due === null) return null;
        const late = isOverdue(issue, Date.now());
        const days = overdueDays(issue, Date.now());
        return (
          <span
            data-testid={`due-badge-${issue.id}`}
            data-overdue={late ? 'true' : 'false'}
            title={late ? `已逾期 ${days} 天（截止 ${due}）` : `截止 ${due}`}
            className={`w-fit rounded px-1.5 py-0.5 text-xs ${late ? 'bg-red-100 font-medium text-red-700 dark:bg-red-950/50 dark:text-red-300' : 'bg-neutral-100 text-neutral-600 dark:bg-neutral-800 dark:text-neutral-300'}`}
          >
            {late ? `逾期 ${days} 天 · ${due}` : `截止 ${due}`}
          </span>
        );
      })()}
      {issue.labels.length > 0 && (
        <div className="flex flex-wrap gap-1">
          {issue.labels.map((label) => (
            <span
              key={label}
              data-testid={`label-${issue.id}-${label}`}
              className="rounded bg-neutral-100 px-1.5 py-0.5 text-xs text-neutral-600 dark:bg-neutral-800 dark:text-neutral-400"
            >
              {label}
            </span>
          ))}
        </div>
      )}
      <div className="flex flex-wrap items-center gap-1.5 text-xs text-neutral-500 dark:text-neutral-400">
        {claimed && (
          <Badge
            tone={sessionRunning ? 'green' : 'neutral'}
            title={sessionRunning ? '占用中（会话运行中）' : '占用中'}
          >
            <span data-testid={`claimed-badge-${issue.id}`}>{claimedCli(claimedBy)}</span>
            {sessionRunning && (
              <span data-testid={`session-running-${issue.id}`} className="" aria-hidden>
                ●
              </span>
            )}
          </Badge>
        )}
        {issue.session_id !== null && (
          <span data-testid={`session-link-${issue.id}`} title="关联会话" className="inline-flex text-ink-3">
            <IconBolt />
          </span>
        )}
        {issue.comment_count > 0 && (
          <span
            data-testid={`comment-count-${issue.id}`}
            title="评论（在任务详情查看）"
            className="inline-flex items-center gap-1 tabular-nums text-ink-3"
          >
            <IconComment />{issue.comment_count}
          </span>
        )}
        {depBadge?.kind === 'blocked' && (
          <span
            data-testid={`dependency-badge-${issue.id}`}
            title={`存在 ${depBadge.open} 项未解除的前置任务`}
            className="inline-flex items-center gap-1 tabular-nums text-accent"
          >
            <IconLock />等 {depBadge.open} 项
          </span>
        )}
        {depBadge?.kind === 'cleared' && (
          <span
            data-testid={`dependency-cleared-${issue.id}`}
            title={`${depBadge.total} 项前置已全部解除`}
            className="text-ink-3"
          >
            依赖已清
          </span>
        )}
      </div>
    </>
  );
}

export function IssueCardPreview({
  issue,
  sessionRunning,
  width,
}: {
  issue: Issue;
  sessionRunning: boolean;
  width?: number;
}) {
  return (
    <div
      aria-hidden="true"
      data-testid={`drag-overlay-${issue.id}`}
      style={{ cursor: GRABBING_CURSOR, ...(width === undefined ? {} : { width }) }}
      className={`${CARD_CLASS} shadow-lg`}
    >
      <IssueCardPriority issue={issue} />
      <div className="space-y-2 p-3 pl-4">
        <IssueCardContents issue={issue} sessionRunning={sessionRunning} />
      </div>
    </div>
  );
}

/** 'agent:codex' → 'codex' */
function claimedCli(claimedBy: string): string {
  return claimedBy.startsWith('agent:') ? claimedBy.slice('agent:'.length) : claimedBy;
}

export function IssueCard({ issue, sessionRunning }: { issue: Issue; sessionRunning: boolean }) {
  const claimedBy = issue.claimed_by;
  const claimed = claimedBy !== null;
  const openDetail = usePanelStore((s) => s.openDetail);
  // 拖拽结束后浏览器仍派发 click：记录按下位置，位移超过激活阈值(5px)即视为拖拽，不打开详情
  const downPos = useRef<{ x: number; y: number } | null>(null);

  const { attributes, listeners, setNodeRef, setActivatorNodeRef, transform, transition, isDragging } =
    useSortable({
      id: issue.id,
      disabled: claimed ? { draggable: true } : false,
      data: { type: 'issue', status: issue.status },
    });

  const style: CSSProperties = {
    transform: transform ? `translate3d(${transform.x}px, ${transform.y}px, 0)` : undefined,
    transition: transition ?? undefined,
    // CURSOR-WHITE：原生 grab 在 Windows 是合成的白手掌位图（无描边），白底看不见；
    // 换成双色自定义光标（白填充 + 深色描边），浅/深主题都可见。占用中仍用禁止符。
    cursor: claimed ? 'not-allowed' : GRAB_CURSOR,
  };

  const onPointerDown = (e: ReactPointerEvent): void => {
    downPos.current = { x: e.clientX, y: e.clientY };
  };
  const onClick = (e: ReactMouseEvent): void => {
    const d = downPos.current;
    downPos.current = null;
    if (d && Math.hypot(e.clientX - d.x, e.clientY - d.y) > 5) return;
    openDetail(issue.id);
  };

  return (
    <div
      ref={setNodeRef}
      style={style}
      data-testid={`issue-card-${issue.id}`}
      aria-disabled={claimed || undefined}
      title={claimed ? '占用中，不可拖动' : undefined}
      onPointerDown={onPointerDown}
      onClick={onClick}
      className={`${CARD_CLASS} ${isDragging ? 'opacity-50' : ''}`}
    >
      <IssueCardPriority issue={issue} />
      <div
        ref={setActivatorNodeRef}
        {...attributes}
        {...listeners}
        className="space-y-1.5 py-2 pl-3.5 pr-2"
      >
        <IssueCardContents issue={issue} sessionRunning={sessionRunning} />
      </div>
    </div>
  );
}
