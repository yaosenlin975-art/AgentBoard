/**
 * 工作空间卡片（WS-REORDER）：名称/路径/四列统计 + 移除入口 + 拖拽把手 + 键盘上/下移。
 * 拖拽由外层 WorkspaceList 的 DndContext 提供；键盘上/下移走同一提交路径（乐观更新 + 失败回滚）。
 */
import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useSortable } from '@dnd-kit/sortable';
import type { Issue, IssueStatus, Workspace } from '@agentboard/shared';
import { api } from '../../api/client';
import { useAppStore } from '../../state/appStore';
import { RemoveWorkspaceDialog } from './RemoveWorkspaceDialog';

const STATUS_ORDER: IssueStatus[] = ['待规划', '进行中', '待验收', '已关闭'];

export function WorkspaceCard({
  workspace,
  onMoveUp,
  onMoveDown,
  canMoveUp = false,
  canMoveDown = false,
}: {
  workspace: Workspace;
  onMoveUp?: () => void;
  onMoveDown?: () => void;
  canMoveUp?: boolean;
  canMoveDown?: boolean;
}) {
  const selected = useAppStore((s) => s.workspaceId === workspace.id);
  const selectWorkspace = useAppStore((s) => s.selectWorkspace);
  const [removeOpen, setRemoveOpen] = useState(false);
  const { data: issues } = useQuery({
    queryKey: ['issues', workspace.id],
    queryFn: () => api.get<Issue[]>(`/api/issues?workspace=${encodeURIComponent(workspace.id)}`),
  });
  const sortable = useSortable({ id: workspace.id });
  // 与 IssueCard 同一写法：不用 @dnd-kit/utilities（未在 apps/web 依赖里声明）
  const sortableStyle = {
    transform: sortable.transform ? `translate3d(${sortable.transform.x}px, ${sortable.transform.y}px, 0)` : undefined,
    transition: sortable.transition,
  };

  const counts = new Map<IssueStatus, number>(STATUS_ORDER.map((s) => [s, 0]));
  for (const issue of issues ?? []) {
    counts.set(issue.status, (counts.get(issue.status) ?? 0) + 1);
  }

  return (
    <div
      role="listitem"
      data-testid={`workspace-row-${workspace.id}`}
      ref={sortable.setNodeRef}
      style={sortableStyle}
      className={`relative mb-2 ${sortable.isDragging ? 'z-10 opacity-80' : ''}`}
    >
      <div className="flex items-start gap-1">
        <button
          type="button"
          data-testid={`workspace-drag-${workspace.id}`}
          aria-label={`拖拽排序 ${workspace.name}`}
          title="拖拽排序"
          ref={sortable.setActivatorNodeRef}
          {...sortable.attributes}
          {...sortable.listeners}
          className="mt-1 shrink-0 cursor-grab rounded px-1 text-xs text-neutral-400 hover:bg-neutral-100 focus-visible:outline-2 focus-visible:outline-blue-500 active:cursor-grabbing dark:text-neutral-500 dark:hover:bg-neutral-800"
        >
          ⋮⋮
        </button>
        <button
          type="button"
          data-testid={`workspace-card-${workspace.id}`}
          aria-pressed={selected}
          onClick={() => selectWorkspace(workspace.id)}
          className={`min-w-0 flex-1 rounded-md border p-3 text-left transition ${
            selected
              ? 'border-blue-500 bg-blue-50 dark:border-blue-500 dark:bg-blue-950/40'
              : 'border-neutral-200 hover:bg-neutral-50 dark:border-neutral-800 dark:hover:bg-neutral-900'
          }`}
        >
          <div className="truncate pr-6 text-sm font-medium">{workspace.name}</div>
          <div
            className="truncate text-xs text-neutral-500 dark:text-neutral-400"
            title={workspace.path}
          >
            {workspace.path}
          </div>
          <div className="mt-2 grid grid-cols-4 gap-1 text-center text-[11px]">
            {STATUS_ORDER.map((status) => (
              <div
                key={status}
                data-testid={`stat-${status}`}
                className="rounded bg-neutral-100 py-1 dark:bg-neutral-800"
              >
                <div className="font-semibold">{counts.get(status) ?? 0}</div>
                <div className="text-neutral-500 dark:text-neutral-400">{status}</div>
              </div>
            ))}
          </div>
        </button>
      </div>

      <button
        type="button"
        aria-label={`移除工作空间 ${workspace.name}`}
        title="移除工作空间"
        onClick={() => setRemoveOpen(true)}
        className="absolute right-1.5 top-1.5 rounded px-1.5 py-0.5 text-xs text-neutral-400 hover:bg-red-50 hover:text-red-600 dark:text-neutral-500 dark:hover:bg-red-950/40 dark:hover:text-red-400"
      >
        ✕
      </button>

      {onMoveUp !== undefined && onMoveDown !== undefined && (
        <div className="absolute bottom-1 right-1.5 flex gap-0.5">
          <button
            type="button"
            data-testid={`workspace-move-up-${workspace.id}`}
            aria-label={`上移 ${workspace.name}`}
            title={canMoveUp ? '上移' : '已在最前'}
            disabled={!canMoveUp}
            onClick={onMoveUp}
            className="rounded px-1 text-xs text-neutral-400 hover:bg-neutral-100 disabled:cursor-not-allowed disabled:opacity-30 dark:text-neutral-500 dark:hover:bg-neutral-800"
          >
            ↑
          </button>
          <button
            type="button"
            data-testid={`workspace-move-down-${workspace.id}`}
            aria-label={`下移 ${workspace.name}`}
            title={canMoveDown ? '下移' : '已在最后'}
            disabled={!canMoveDown}
            onClick={onMoveDown}
            className="rounded px-1 text-xs text-neutral-400 hover:bg-neutral-100 disabled:cursor-not-allowed disabled:opacity-30 dark:text-neutral-500 dark:hover:bg-neutral-800"
          >
            ↓
          </button>
        </div>
      )}

      <RemoveWorkspaceDialog
        workspace={workspace}
        open={removeOpen}
        onClose={() => setRemoveOpen(false)}
      />
    </div>
  );
}

