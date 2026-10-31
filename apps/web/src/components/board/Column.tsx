/**
 * 看板单列（§7.3）：列头（名称 + 计数）、可落点容器、卡片列表；空列占位提示。
 */
import { useDroppable } from '@dnd-kit/core';
import { SortableContext, verticalListSortingStrategy } from '@dnd-kit/sortable';
import type { Issue, IssueStatus } from '@agentboard/shared';
import { columnDroppableId } from '../../lib/dnd';
import { IssueCard } from './IssueCard';

export function Column({
  status,
  issues,
  runningSessionIds,
}: {
  status: IssueStatus;
  issues: Issue[];
  runningSessionIds: ReadonlySet<string>;
}) {
  const { setNodeRef, isOver } = useDroppable({
    id: columnDroppableId(status),
    data: { type: 'column', status },
  });

  return (
    <section
      data-testid={`column-${status}`}
      className="flex w-64 shrink-0 flex-col rounded-lg bg-neutral-100 dark:bg-neutral-900"
    >
      <header className="flex items-center justify-between px-2.5 pt-2.5">
        <h3 className="text-sm font-semibold">{status}</h3>
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
