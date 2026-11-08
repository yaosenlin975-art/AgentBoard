/**
 * 详情 meta 行（D2）：把「状态 / 优先级 / 截止 / 负责人」四个决策项压成一行 chip。
 *
 * - 宽屏（≥920px）严格同一横行；窄屏回流两行：状态+优先级 / 截止+负责人（未决 2）。
 * - 可交互 chip（优先级/截止/负责人）是 button：aria-haspopup + aria-expanded；同一时刻只开一个 popover。
 * - popover 贴整个 meta 行下缘（top: calc(100% + 4px)），换行时不会盖住第二排 chip。
 * - 状态 chip（DETAIL-FLOW）：未占用卡可点开「修改状态」菜单（PATCH 带 CAS，就地换缓存）；
 *   占用中保持只读 span，title 说明「先释放再改」；优先级/截止沿用防抖 PATCH。
 * - 负责人主行只显示名称 + 已占用时长；租约剩余时间本期接口未暴露（见卡面口径差异）。
 */
import { useEffect, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import type { Issue, IssueStatus, Priority } from '@agentboard/shared';
import { formatDueShort, isOverdue, overdueDays } from '../../lib/planningSort';
import { ISSUE_STATUSES, patchIssueStatus } from '../../lib/issueStatus';

type ChipKey = 'status' | 'priority' | 'due' | 'owner';

export interface DueDraft {
  date: string;
  time: string;
}

export interface MetaRowProps {
  issue: Issue;
  priority: Priority;
  dueDate: string;
  dueTime: string;
  /** 非 null = 占用中，状态 chip 只读并以该文案作为 title（提示先释放再改）；null = 未占用，chip 可改状态 */
  statusBlocked: string | null;
  onPriorityChange: (priority: Priority) => void;
  onDueChange: (due: DueDraft) => void;
}

const CHIP_BASE =
  'inline-flex h-6 items-center gap-1 whitespace-nowrap rounded-full border px-2 text-[11px] transition-colors focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent disabled:cursor-not-allowed disabled:opacity-60';

const CHIP_IDLE = 'border-hairline bg-surface-raised text-ink-2 hover:border-accent hover:text-accent';

/** 已占用时长：分钟 / 小时 / 天（静默时长的展示口径） */
export function formatClaimedDuration(claimedAt: number | null, now: number): string {
  if (claimedAt === null || !Number.isFinite(claimedAt)) return '—';
  const minutes = Math.max(0, Math.round((now - claimedAt) / 60000));
  if (minutes < 60) return `${Math.max(1, minutes)} 分钟`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} 小时`;
  return `${Math.round(hours / 24)} 天`;
}

function statusChipTone(status: IssueStatus): string {
  if (status === '进行中') return 'border-accent/50 bg-accent-soft text-accent';
  if (status === '已关闭') return 'border-hairline bg-surface-raised text-ink-3';
  return CHIP_IDLE;
}

function statusDotTone(status: IssueStatus): string {
  if (status === '进行中') return 'bg-accent';
  if (status === '待验收') return 'bg-ab-add';
  return 'bg-ink-3';
}

function priorityTone(priority: Priority): string {
  if (priority === '高') return 'border-ab-del/40 text-ab-del';
  if (priority === '低') return 'text-ink-3';
  return CHIP_IDLE;
}

/** 负责人展示名：agent:codex → codex；其它保持原值 */
function ownerName(claimedBy: string): string {
  return claimedBy.startsWith('agent:') ? claimedBy.slice('agent:'.length) : claimedBy;
}

export function MetaRow({
  issue,
  priority,
  dueDate,
  dueTime,
  statusBlocked,
  onPriorityChange,
  onDueChange,
}: MetaRowProps) {
  const queryClient = useQueryClient();
  const [open, setOpen] = useState<ChipKey | null>(null);
  const [dueDraft, setDueDraft] = useState<DueDraft>({ date: dueDate, time: dueTime });
  const [statusPending, setStatusPending] = useState(false);
  const [statusError, setStatusError] = useState<string | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRefs = useRef<Record<ChipKey, HTMLButtonElement | null>>({
    status: null,
    priority: null,
    due: null,
    owner: null,
  });

  // 同一时刻只开一个 popover；点外部关闭；Esc 关闭并把焦点还给触发 chip
  useEffect(() => {
    if (open === null) return;
    const key = open;
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      event.stopPropagation();
      setOpen(null);
      triggerRefs.current[key]?.focus();
    };
    const onMouseDown = (event: MouseEvent): void => {
      if (rootRef.current?.contains(event.target as Node) === true) return;
      setOpen(null);
    };
    document.addEventListener('keydown', onKeyDown, true);
    document.addEventListener('mousedown', onMouseDown);
    return () => {
      document.removeEventListener('keydown', onKeyDown, true);
      document.removeEventListener('mousedown', onMouseDown);
    };
  }, [open]);

  const toggle = (key: ChipKey): void => setOpen((current) => (current === key ? null : key));

  const openDue = (): void => {
    setDueDraft({ date: dueDate, time: dueTime });
    toggle('due');
  };

  /** DETAIL-FLOW：未占用卡就地改状态（PATCH 带 workspace_id + expected_updated_at CAS） */
  const changeStatus = async (next: IssueStatus): Promise<void> => {
    if (statusPending || next === issue.status) return;
    setStatusError(null);
    setStatusPending(true);
    try {
      const updated = await patchIssueStatus({
        issueId: issue.id,
        workspaceId: issue.workspace_id,
        expectedUpdatedAt: issue.updated_at,
        status: next,
      });
      // 与 DetailPanel.refreshIssue 同一口径：就地换缓存（详情 + 列表），不 invalidate（防旧快照回写）
      const { comment: _comment, ...clean } = updated as Issue & { comment?: unknown };
      queryClient.setQueryData(['issue', issue.id], clean);
      queryClient.setQueryData<Issue[]>(['issues', issue.workspace_id], (list) =>
        list === undefined ? list : list.map((item) => (item.id === clean.id ? clean : item)),
      );
    } catch (error) {
      setStatusError(error instanceof Error ? error.message : '状态修改失败');
    } finally {
      setStatusPending(false);
    }
  };

  const dueProjection = { due_date: dueDate === '' ? null : dueDate, due_time: dueTime === '' ? null : dueTime };
  const dueLabel = dueDate === '' ? '未设置' : (formatDueShort(dueProjection) ?? '未设置');
  const overdue = isOverdue(dueProjection, Date.now());
  const silent = formatClaimedDuration(issue.claimed_at, Date.now());
  const claimedBy = issue.claimed_by;

  const popoverCls =
    'absolute left-0 z-20 min-w-48 max-w-full rounded border border-hairline bg-surface-card p-1 shadow-lg';
  const popoverStyle = { top: 'calc(100% + 4px)' } as const;
  const itemCls =
    'flex w-full items-center gap-1.5 rounded px-2 py-1 text-left text-[11.5px] text-ink-2 hover:bg-accent-soft hover:text-accent disabled:cursor-not-allowed disabled:opacity-40';

  return (
    <>
      <div
        ref={rootRef}
        data-testid="meta-row"
        className="relative flex flex-col gap-1 min-[920px]:flex-row min-[920px]:items-center min-[920px]:gap-1.5"
      >
      <span className="flex items-center gap-1.5">
        {/* DETAIL-FLOW：未占用 = 可点开修改状态菜单；占用中 = 纯展示 span，title 说明先释放再改 */}
        {statusBlocked === null ? (
          <button
            ref={(node) => { triggerRefs.current.status = node; }}
            type="button"
            data-testid="status-chip"
            data-status={issue.status}
            data-readonly="false"
            aria-label={`状态：${issue.status}（点击修改）`}
            aria-haspopup="menu"
            aria-expanded={open === 'status'}
            disabled={statusPending}
            title="点击修改状态"
            onClick={() => toggle('status')}
            className={`${CHIP_BASE} ${statusChipTone(issue.status)} font-semibold`}
          >
            <span aria-hidden className={`h-1.5 w-1.5 rounded-full ${statusDotTone(issue.status)}`} />
            {issue.status}
          </button>
        ) : (
          <span
            data-testid="status-chip"
            data-status={issue.status}
            data-readonly="true"
            aria-label={`状态：${issue.status}`}
            title={statusBlocked}
            className={`${CHIP_BASE} ${statusChipTone(issue.status)} font-semibold`}
          >
            <span aria-hidden className={`h-1.5 w-1.5 rounded-full ${statusDotTone(issue.status)}`} />
            {issue.status}
          </span>
        )}
        <button
          ref={(node) => { triggerRefs.current.priority = node; }}
          type="button"
          data-testid="priority-chip"
          data-priority={priority}
          aria-label={`优先级：${priority}`}
          aria-haspopup="menu"
          aria-expanded={open === 'priority'}
          onClick={() => toggle('priority')}
          className={`${CHIP_BASE} ${priorityTone(priority)}`}
        >
          <span
            aria-hidden
            className={`h-1.5 w-1.5 rounded-full ${priority === '高' ? 'bg-ab-del' : priority === '中' ? 'bg-accent' : 'bg-ink-3'}`}
          />
          优先级 · {priority}
        </button>
      </span>

      <span className="flex items-center gap-1.5">
        <button
          ref={(node) => { triggerRefs.current.due = node; }}
          type="button"
          data-testid="due-chip"
          aria-label={`截止：${dueLabel}`}
          aria-haspopup="dialog"
          aria-expanded={open === 'due'}
          onClick={openDue}
          className={`${CHIP_BASE} ${overdue ? 'border-ab-del/40 bg-ab-del/10 text-ab-del' : CHIP_IDLE}`}
        >
          <span aria-hidden>◷</span>
          截止 · {dueLabel}
          {overdue && (
            <span data-testid="detail-due-overdue" className="font-medium">
              已逾期 {overdueDays(dueProjection, Date.now())} 天
            </span>
          )}
        </button>
        <button
          ref={(node) => { triggerRefs.current.owner = node; }}
          type="button"
          data-testid="owner-chip"
          aria-label={claimedBy === null ? '负责人：未领取' : `负责人：${ownerName(claimedBy)}`}
          aria-haspopup="dialog"
          aria-expanded={open === 'owner'}
          title={claimedBy === null ? '未领取' : `已占用 ${silent}（租约剩余时间接口未提供）`}
          onClick={() => toggle('owner')}
          className={`${CHIP_BASE} ${claimedBy === null ? CHIP_IDLE : 'border-hairline bg-surface-raised text-ink-2'}`}
        >
          <span
            aria-hidden
            className={`inline-flex h-3.5 w-3.5 items-center justify-center rounded-full text-[8.5px] ${
              claimedBy === null ? 'border border-hairline bg-surface-raised text-ink-3' : 'bg-accent text-accent-ink'
            }`}
          >
            {claimedBy === null ? '－' : ownerName(claimedBy).slice(0, 1).toUpperCase()}
          </span>
          {claimedBy === null ? '未领取' : `${ownerName(claimedBy)} · ${silent}`}
        </button>
      </span>

      {open === 'status' && (
        <div
          role="menu"
          aria-label="修改状态"
          data-testid="status-popover"
          className={popoverCls}
          style={popoverStyle}
        >
          {ISSUE_STATUSES.map((name) => (
            <button
              key={name}
              type="button"
              role="menuitem"
              data-testid={`status-option-${name}`}
              aria-current={name === issue.status ? 'true' : undefined}
              disabled={statusPending || name === issue.status}
              onClick={() => {
                setOpen(null);
                void changeStatus(name as IssueStatus);
              }}
              className={`${itemCls} ${name === issue.status ? 'font-semibold text-accent' : ''}`}
            >
              {name}
            </button>
          ))}
        </div>
      )}

      {open === 'priority' && (
        <div
          role="menu"
          aria-label="修改优先级"
          data-testid="priority-popover"
          className={popoverCls}
          style={popoverStyle}
        >
          {(['低', '中', '高'] as const).map((value) => (
            <button
              key={value}
              type="button"
              role="menuitem"
              data-testid={`priority-option-${value}`}
              aria-current={value === priority ? 'true' : undefined}
              onClick={() => {
                setOpen(null);
                onPriorityChange(value);
              }}
              className={`${itemCls} ${value === priority ? 'font-semibold text-accent' : ''}`}
            >
              {value}
            </button>
          ))}
        </div>
      )}

      {open === 'due' && (
        <div
          role="dialog"
          aria-label="修改截止"
          data-testid="due-popover"
          className={`${popoverCls} space-y-1.5 p-2`}
          style={popoverStyle}
        >
          <label className="block text-[10.5px] text-ink-3">
            日期
            <input
              id="dueDateInput"
              type="date"
              data-testid="detail-due-date"
              aria-label="截止日期"
              value={dueDraft.date}
              onChange={(event) => setDueDraft((current) => ({ ...current, date: event.target.value }))}
              className="mt-1 w-full rounded border border-hairline bg-surface-card px-1.5 py-1 text-[11.5px] text-ink outline-none focus-visible:outline-2 focus-visible:outline-accent"
            />
          </label>
          <label className="block text-[10.5px] text-ink-3">
            时间（可空）
            <input
              id="dueTimeInput"
              type="time"
              data-testid="detail-due-time"
              aria-label="截止时间"
              value={dueDraft.time}
              disabled={dueDraft.date === ''}
              onChange={(event) => setDueDraft((current) => ({ ...current, time: event.target.value }))}
              className="mt-1 w-full rounded border border-hairline bg-surface-card px-1.5 py-1 text-[11.5px] text-ink outline-none focus-visible:outline-2 focus-visible:outline-accent disabled:opacity-40"
            />
          </label>
          <div className="flex items-center justify-end gap-1.5 pt-0.5">
            <button
              type="button"
              data-testid="detail-due-clear"
              onClick={() => {
                setOpen(null);
                onDueChange({ date: '', time: '' });
              }}
              className="rounded border border-hairline px-2 py-0.5 text-[11px] text-ink-2 hover:bg-accent-soft"
            >
              清除
            </button>
            <button
              type="button"
              data-testid="due-apply"
              onClick={() => {
                // 日期空时同时清时间（保持现有语义）
                setOpen(null);
                onDueChange({ date: dueDraft.date, time: dueDraft.date === '' ? '' : dueDraft.time });
              }}
              className="rounded bg-accent px-2 py-0.5 text-[11px] font-medium text-accent-ink hover:opacity-90"
            >
              应用
            </button>
          </div>
        </div>
      )}

      {open === 'owner' && (
        <div
          role="dialog"
          aria-label="占用信息"
          data-testid="owner-popover"
          className={`${popoverCls} space-y-1 p-2 text-[11px]`}
          style={popoverStyle}
        >
          <p className="font-medium text-ink">{claimedBy === null ? '未领取' : ownerName(claimedBy)}</p>
          {claimedBy === null ? (
            <p className="text-ink-3">当前无占用者，可直接派发或领取。</p>
          ) : (
            <>
              <p data-testid="owner-popover-duration" className="text-ink-2">已占用 {silent}</p>
              <p className="text-ink-3">
                领取于 {issue.claimed_at === null ? '未知' : new Date(issue.claimed_at).toLocaleString()}
              </p>
              <p className="text-ink-3">租约剩余时间：接口未暴露（不臆造数值）</p>
            </>
          )}
        </div>
      )}

      {/* DETAIL-LAYOUT：占用/进行中的状态维护提示已上移到顶栏标题块第二行（DetailPanel），此处不再重复 */}
      </div>
      {/* DETAIL-FLOW：就地改状态的失败展示，复用 detail-action-error 同名机制（role=alert 红字） */}
      {statusError !== null && (
        <p role="alert" data-testid="detail-action-error" className="text-xs text-red-600 dark:text-red-400">
          {statusError}
        </p>
      )}
    </>
  );
}
