/**
 * 看板单列（§7.3）：列头（名称 + 新建入口 + 计数）、可落点容器、卡片列表；空列占位提示。
 * 新建入口（NEW-ISSUE-PLUS）：只由外层对「待规划」列传入 onCreateIssue —— 新任务由服务端固定落在待规划。
 * 列宽（BOARD-COLS）：宽高由外层 grid 的列轨道决定（minmax(240px, 1fr)），这里不再写死宽度。
 * 排序控件（SORT-PLAN）：只由外层对「待规划」列传入 sortControl，渲染在列头下方；其它列没有。
 */
import { useDroppable } from '@dnd-kit/core';
import { SortableContext, verticalListSortingStrategy } from '@dnd-kit/sortable';
import { memo, type ReactNode } from 'react';
import type { Issue } from '@agentboard/shared';
import { columnDroppableId } from '../../lib/dnd';
import { groupIssuesForDisplay, type BoardDensity, type BoardGrouping } from '../../lib/displayOptions';
import { issueInScope, type SelectionScope } from '../../lib/selection';
import { IssueCard } from './IssueCard';
import { EmptyState } from '../ui/EmptyState';
import { Skeleton } from '../ui/Skeleton';

/** CR2-6：memo 化 —— 只有本列 issues / 选择态 / 显示偏好变化时才重渲 */
export const Column = memo(function Column({
  status,
  issues,
  runningSessionIds,
  onCreateIssue,
  onReleaseRunning,
  sortControl,
  accent,
  density = 'comfortable',
  grouping = 'none',
  selectionActive = false,
  selectionScope = null,
  selectedIds,
  onToggleSelect,
  onToggleSelectColumn,
  loading = false,
}: {
  /** 列名（STATUS-3-UI：内置五条 + 任意自定义状态） */
  status: string;
  issues: Issue[];
  runningSessionIds: ReadonlySet<string>;
  onCreateIssue?: () => void;
  /** REL-2：批量退回运行中任务（只由外层对「进行中」列传入） */
  onReleaseRunning?: () => void;
  sortControl?: ReactNode;
  /** 列头强调色（按 workspace_status.kind：已废弃与已关闭要区分开） */
  accent?: string;
  /** BORROW-1.1 显示偏好 */
  density?: BoardDensity;
  grouping?: BoardGrouping;
  /** 两段式选择：仅范围内卡片可勾选 */
  selectionActive?: boolean;
  selectionScope?: SelectionScope | null;
  selectedIds?: ReadonlySet<string>;
  onToggleSelect?: (id: string) => void;
  /** 选择态下列头整列 toggle：只增删本列 id（全选本列 / 清空本列） */
  onToggleSelectColumn?: (ids: readonly string[]) => void;
  /**
   * PERF-9：真实加载中（React Query isPending）才为 true —— 渲染列骨架，不把 `[]` 当真空态。
   * 数据到位立即卸载骨架；空数组且非加载中才渲染「暂无任务」。
   */
  loading?: boolean;
}) {
  const { setNodeRef, isOver } = useDroppable({
    id: columnDroppableId(status),
    data: { type: 'column', status },
  });
  const groups = groupIssuesForDisplay(issues, grouping);
  // 选择态列头整列 toggle（BOARD-SEL-1）：只统计本列 id；空列不渲染（沿用空列隐藏附加控件的惯例）
  const columnIds = issues.map((issue) => issue.id);
  const selectedInColumn = selectionActive
    ? columnIds.filter((id) => selectedIds?.has(id) ?? false).length
    : 0;
  const allSelected = columnIds.length > 0 && selectedInColumn === columnIds.length;
  const partiallySelected = selectedInColumn > 0 && !allSelected;
  const showColumnToggle =
    selectionActive && onToggleSelectColumn !== undefined && !loading && columnIds.length > 0;
  const renderCard = (issue: Issue) => (
    <IssueCard
      key={issue.id}
      issue={issue}
      sessionRunning={runningSessionIds.has(issue.session_id ?? '')}
      density={density}
      selectable={selectionActive && issueInScope(selectionScope, issue)}
      selected={selectedIds?.has(issue.id) ?? false}
      onToggleSelect={onToggleSelect}
      dragDisabled={grouping !== 'none'}
    />
  );

  return (
    <section
      data-testid={`column-${status}`}
      className="flex min-h-0 min-w-0 flex-col rounded-xl border border-hairline bg-surface-raised"
    >
      <header className="flex items-center justify-between px-3 pb-1 pt-3">
        <div className="flex min-w-0 items-center gap-1">
          <h3 className={`text-sm font-semibold ${accent ?? ''}`}>{status}</h3>
          {onCreateIssue !== undefined && (
            <button
              type="button"
              data-testid={`column-create-${status}`}
              aria-label={`新建任务（${status}）`}
              title={`新建任务（${status}）`}
              onClick={onCreateIssue}
              className="rounded px-1.5 text-sm leading-5 text-ink-3 hover:bg-surface-card hover:text-accent focus-visible:outline-2 focus-visible:outline-accent"
            >
              +
            </button>
          )}
          {/* 排序控件（SORT-ICON）：紧跟 + 号右侧 */}
          {sortControl}
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          {/* BOARD-SEL-1：选择态下列头整列全选 toggle（沿用卡片勾选框的视觉令牌；部分选中显示「−」） */}
          {showColumnToggle && (
            <button
              type="button"
              role="checkbox"
              aria-checked={allSelected ? true : partiallySelected ? 'mixed' : false}
              aria-label={`选择本列全部任务（${status}）`}
              title={
                allSelected
                  ? `取消选择本列全部任务（${status}）`
                  : `选择本列全部任务（${status}）`
              }
              data-testid={`column-select-all-${status}`}
              onClick={() => onToggleSelectColumn(columnIds)}
              className={`flex h-4 w-4 items-center justify-center rounded border text-[10px] leading-none transition-colors focus-visible:outline-2 focus-visible:outline-accent ${
                allSelected
                  ? 'border-accent bg-accent text-accent-ink'
                  : partiallySelected
                    ? 'border-accent bg-accent-soft text-accent'
                    : 'border-hairline bg-surface-card text-transparent hover:border-ink-3'
              }`}
            >
              {partiallySelected ? '−' : '✓'}
            </button>
          )}
          {/* REL-2：进行中列头救火键（小文字按钮，不抢列头视觉；只在有卡时出现） */}
          {onReleaseRunning !== undefined && issues.length > 0 && (
            <button
              type="button"
              data-testid="column-release-running"
              aria-label={`退回运行中任务（${status}）`}
              title="批量退回运行中任务到待规划"
              onClick={onReleaseRunning}
              className="rounded px-1.5 text-xs leading-5 text-ink-3 hover:bg-surface-card hover:text-accent focus-visible:outline-2 focus-visible:outline-accent"
            >
              退回
            </button>
          )}
          <span
            data-testid={`count-${status}`}
            className="tabular-nums text-xs font-medium text-ink-3"
          >
            {loading ? '—' : issues.length}
          </span>
        </div>
      </header>
      <div
        ref={setNodeRef}
        className={`m-2 flex min-h-24 flex-1 flex-col ${density === 'compact' ? 'gap-1' : 'gap-2'} overflow-y-auto rounded-lg p-1 transition-colors ${
          isOver ? 'bg-accent-soft' : ''
        }`}
      >
        {loading ? (
          <Skeleton rows={3} testId={`column-skeleton-${status}`} className="m-1" />
        ) : (
          <>
            <SortableContext items={issues.map((i) => i.id)} strategy={verticalListSortingStrategy}>
              {groups === null
                ? issues.map(renderCard)
                : groups.map((group) => (
                    <section key={group.key} data-testid={`board-group-${status}-${group.key}`} className="flex flex-col gap-1">
                      <div className="flex items-center justify-between px-1 pt-1 text-[11px] font-medium text-ink-3">
                        <span>{group.label}</span>
                        <span className="tabular-nums">{group.issues.length}</span>
                      </div>
                      {group.issues.map(renderCard)}
                    </section>
                  ))}
            </SortableContext>
            {issues.length === 0 && (
              <>
                <EmptyState
                  compact
                  testId={`empty-${status}`}
                  title="暂无任务"
                  hint={onCreateIssue === undefined ? '把卡片拖到本列' : '把卡片拖到本列，或点下方按钮新建（新任务进入待规划）'}
                  className="flex-1 justify-center"
                />
                {/* AUDIT-BOARD（I-08）：空列直达新建；落点固定「待规划」，在提示文案里说明 */}
                {onCreateIssue !== undefined && (
                  <button
                    type="button"
                    data-testid={`empty-create-${status}`}
                    onClick={onCreateIssue}
                    className="mx-auto mb-2 shrink-0 rounded-md border border-accent bg-accent-soft px-2.5 py-1 text-xs font-medium text-accent transition-colors duration-150 hover:bg-accent hover:text-accent-ink motion-reduce:transition-none"
                  >
                    + 新建任务
                  </button>
                )}
              </>
            )}
          </>
        )}
      </div>
    </section>
  );
});
