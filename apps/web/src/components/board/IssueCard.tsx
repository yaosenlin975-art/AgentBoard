/**
 * 看板卡片（§7.3）：标题、左缘优先级色条、标签 chips、占用徽标（会话运行中加动效点）、
 * 关联会话标记、评论数徽标（0 条隐藏，详情看右侧面板）；点击开任务详情。
 * 详情打开中（panelStore view='detail' 且 issueId 命中本卡）输出选中高亮，与批量勾选同 token（DETAIL-HIGHLIGHT）。
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
import { DecisionMark } from '../decisions/DecisionMark';
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
      className={`absolute inset-y-0 left-0 w-[3px] ${PRIORITY_BAR[issue.priority]}`}
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
            className={`w-fit rounded px-1.5 py-0.5 text-xs ${late ? 'bg-red-100 font-medium text-red-700 dark:bg-red-950/50 dark:text-red-300' : 'bg-surface-raised text-ink-2  '}`}
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
              className="rounded bg-surface-raised px-1.5 py-0.5 text-xs text-ink-2"
            >
              {label}
            </span>
          ))}
        </div>
      )}
      <div className="flex flex-wrap items-center gap-1.5 text-xs text-ink-3">
        <DecisionMark issue={issue} />
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
        {issue.dependency_violation !== undefined && issue.dependency_violation !== null && (
          <span
            data-testid={`dependency-violation-${issue.id}`}
            title="依赖违规：祖先卡被声明为前置（父卡等子卡、子卡又等祖先卡 → 流程死锁）。请检查并移除该前置。"
            className="inline-flex items-center gap-1 font-medium text-red-600 dark:text-red-400"
          >
            ⚠ 祖先阻塞
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

export function IssueCard({
  issue,
  sessionRunning,
  density = 'comfortable',
  selectable = false,
  selected = false,
  onToggleSelect,
  dragDisabled = false,
}: {
  issue: Issue;
  sessionRunning: boolean;
  /** BORROW-1.1：紧凑密度减小内边距/行距（仅显示层，不影响排序） */
  density?: 'comfortable' | 'compact';
  /** 两段式选择的第二段：选中范围内卡片可勾选；此时点击不再打开详情 */
  selectable?: boolean;
  selected?: boolean;
  onToggleSelect?: (id: string) => void;
  /** 分组显示时视觉顺序不等于 sort_order，禁用拖拽避免写出错误顺序 */
  dragDisabled?: boolean;
}) {
  const claimedBy = issue.claimed_by;
  const claimed = claimedBy !== null;
  // DEC-6：open 决策把卡锁在待规划（占用已释放但不可 claim / 派工），拖拽同样冻结
  const locked = issue.decision_locked === true;
  const frozen = claimed || locked;
  const openDetail = usePanelStore((s) => s.openDetail);
  // DETAIL-HIGHLIGHT：详情打开中的卡有选中态。布尔选择器等值稳定（Object.is），只有命中翻转的这张卡重渲。
  const detailOpen = usePanelStore((s) => s.view === 'detail' && s.issueId === issue.id);
  // 批量勾选与详情打开任一命中即高亮，同时命中不互相抹掉（批量勾选的勾选框仍只看 selected）。
  const highlighted = selected || detailOpen;
  // 拖拽结束后浏览器仍派发 click：记录按下位置，位移超过激活阈值(5px)即视为拖拽，不打开详情
  const downPos = useRef<{ x: number; y: number } | null>(null);

  const { attributes, listeners, setNodeRef, setActivatorNodeRef, transform, transition, isDragging } =
    useSortable({
      id: issue.id,
      // 选择模式或分组显示时禁用拖拽：点击语义改为勾选 / 视觉顺序不等于 sort_order
      disabled: frozen || selectable || dragDisabled ? { draggable: true } : false,
      data: { type: 'issue', status: issue.status },
    });

  const style: CSSProperties = {
    transform: transform ? `translate3d(${transform.x}px, ${transform.y}px, 0)` : undefined,
    transition: transition ?? undefined,
    // CURSOR-WHITE：原生 grab 在 Windows 是合成的白手掌位图（无描边），白底看不见；
    // 换成双色自定义光标（白填充 + 深色描边），浅/深主题都可见。占用中仍用禁止符。
    cursor: selectable ? 'pointer' : frozen ? 'not-allowed' : GRAB_CURSOR,
  };

  const onPointerDown = (e: ReactPointerEvent): void => {
    downPos.current = { x: e.clientX, y: e.clientY };
  };
  const onClick = (e: ReactMouseEvent): void => {
    const d = downPos.current;
    downPos.current = null;
    if (d && Math.hypot(e.clientX - d.x, e.clientY - d.y) > 5) return;
    if (selectable) {
      onToggleSelect?.(issue.id);
      return;
    }
    openDetail(issue.id);
  };

  return (
    <div
      ref={setNodeRef}
      style={style}
      data-testid={`issue-card-${issue.id}`}
      data-selected={highlighted ? 'true' : selectable ? 'false' : undefined}
      aria-disabled={frozen || undefined}
      title={locked ? '等待决策回答，暂不可拖动' : claimed ? '占用中，不可拖动' : undefined}
      // AUDIT-P0（I-01）：卡片本身可 Tab 聚焦、可 Enter/Space 打开详情，并且 focus-visible 有可见描边。
      // Space 的归属见 onKeyDown 注释：未占用卡片的 Space 留给 dnd-kit 键盘抓取，不抢。
      role="button"
      tabIndex={0}
      aria-label={selectable ? `${selected ? '取消选择' : '选择'}任务：${issue.title}` : `打开任务：${issue.title}`}
      aria-pressed={selectable ? selected : undefined}
      onKeyDown={(event) => {
        if (selectable) {
          if (event.key === 'Enter' || event.key === ' ' || event.key === 'Spacebar') {
            event.preventDefault();
            onToggleSelect?.(issue.id);
          }
          return;
        }
        if (event.key === 'Enter') {
          event.preventDefault();
          openDetail(issue.id);
          return;
        }
        // Space：dnd-kit 的 KeyboardSensor 用 Space 抓取（未占用卡片）。占用中卡片不可拖，
        // 此时 Space 没有拖拽语义，按「打开详情」处理，避免键盘用户按 Space 无反应。
        if (event.key === ' ' || event.key === 'Spacebar') {
          if (frozen) {
            event.preventDefault();
            openDetail(issue.id);
          }
        }
      }}
      onPointerDown={onPointerDown}
      onClick={onClick}
      className={`${CARD_CLASS} focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent ${isDragging ? 'opacity-50' : ''} ${highlighted ? 'border-accent bg-accent-soft/40' : ''}`}
    >
      <IssueCardPriority issue={issue} />
      {selectable && (
        <span
          data-testid={`card-select-${issue.id}`}
          aria-hidden
          className={`absolute right-2 top-2 flex h-4 w-4 items-center justify-center rounded border text-[10px] leading-none ${selected ? 'border-accent bg-accent text-accent-ink' : 'border-hairline bg-surface-card text-transparent'}`}
        >
          ✓
        </span>
      )}
      <div
        ref={setActivatorNodeRef}
        {...attributes}
        {...listeners}
        className={density === 'compact' ? 'space-y-1 py-1.5 pl-3 pr-2' : 'space-y-1.5 py-2 pl-3.5 pr-2'}
      >
        <IssueCardContents issue={issue} sessionRunning={sessionRunning} />
      </div>
    </div>
  );
}
