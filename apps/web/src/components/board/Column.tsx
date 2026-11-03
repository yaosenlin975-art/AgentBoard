/**
 * 看板单列（§7.3）：列头（名称 + 新建入口 + 计数）、可落点容器、卡片列表；空列占位提示。
 * 新建入口（NEW-ISSUE-PLUS）：只由外层对「待规划」列传入 onCreateIssue —— 新任务由服务端固定落在待规划。
 * 列宽（BOARD-COLS）：宽高由外层 grid 的列轨道决定（minmax(280px, 1fr)），这里不再写死宽度。
 * 排序控件（SORT-PLAN）：只由外层对「待规划」列传入 sortControl，渲染在列头下方；其它列没有。
 */
import { useDroppable } from '@dnd-kit/core';
import { SortableContext, verticalListSortingStrategy } from '@dnd-kit/sortable';
import type { ReactNode } from 'react';
import type { Issue, IssueStatus } from '@agentboard/shared';
import { columnDroppableId } from '../../lib/dnd';
import { IssueCard } from './IssueCard';

export function Column({
  status,
  issues,
  runningSessionIds,
  onCreateIssue,
  sortControl,
}: {
  status: IssueStatus;
  issues: Issue[];
  runningSessionIds: ReadonlySet<string>;
  onCreateIssue?: () => void;
  sortControl?: ReactNode;
}) {
  const { setNodeRef, isOver } = useDroppable({
    id: columnDroppableId(status),
    data: { type: 'column', status },
  });

  return (
    <section
      data-testid={`column-${status}`}
      className="flex min-h-0 min-w-0 flex-col rounded-lg bg-neutral-100 dark:bg-neutral-900"
    >
      <header className="flex items-center justify-between px-2.5 pt-2.5">
        <div className="flex min-w-0 items-center gap-1">
          <h3 className="text-sm font-semibold">{status}</h3>
          {onCreateIssue !== undefined && (
            <button
              type="button"
              data-testid={`column-create-${status}`}
              aria-label={`新建任务（${status}）`}
              title={`新建任务（${status}）`}
              onClick={onCreateIssue}
              className="rounded px-1.5 text-sm leading-5 text-neutral-500 hover:bg-white hover:text-blue-600 focus-visible:outline-2 focus-visible:outline-blue-500 dark:text-neutral-400 dark:hover:bg-neutral-800 dark:hover:text-blue-400"
            >
              +
            </button>
          )}
          {/* 排序控件（SORT-ICON）：紧跟 + 号右侧 */}
          {sortControl}
        </div>
        <span
          data-testid={`count-${status}`}
          className="rounded-full bg-white px-2 py-0.5 text-xs font-medium text-neutral-600 dark:bg-neutral-800 dark:text-neutral-300"
        >
          {issues.length}
        </span>
      </header>
      <div
        ref={setNodeRef}
        className={`m-2 flex min-h-24 flex-1 flex-col gap-2 overflow-y-auto rounded-md p-1 transition-colors ${
          isOver ? 'bg-neutral-200/70 dark:bg-neutral-800/70' : ''
        }`}
      >
        <SortableContext items={issues.map((i) => i.id)} strategy={verticalListSortingStrategy}>
          {issues.map((issue) => (
            <IssueCard key={issue.id} issue={issue} sessionRunning={runningSessionIds.has(issue.session_id ?? '')} />
          ))}
        </SortableContext>
        {issues.length === 0 && (
          <div
            data-testid={`empty-${status}`}
            className="flex flex-1 items-center justify-center py-4 text-xs text-neutral-400 dark:text-neutral-600"
          >
            暂无任务
          </div>
        )}
      </div>
    </section>
  );
}
