/**
 * 工作空间卡片（WS-REORDER）：名称/路径/四列统计 + 移除入口 + 拖拽把手 + 键盘上/下移 + 置顶（WS-DRAWER-01）。
 * 拖拽由外层 WorkspaceList 的 DndContext 提供；键盘上/下移与置顶走同一提交路径（乐观更新 + 失败回滚）。
 * 布局：卡片容器（边框 + 最小高度）内含内容按钮（名称/路径/统计，文案 nowrap）与操作行（置顶文本胶囊 · ↑ · ↓），
 * 操作行在卡片边框内、统计行下方的正常流里，不 absolute、不加负 margin，因此不与「已关闭」等文案重叠。
 */
import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useSortable } from '@dnd-kit/sortable';
import type { Issue, IssueStatus, Workspace } from '@agentboard/shared';
import { api } from '../../api/client';
import { useAppStore } from '../../state/appStore';
import { RemoveWorkspaceDialog } from './RemoveWorkspaceDialog';
import { GRAB_CURSOR } from '../../lib/cursor';

const STATUS_ORDER: IssueStatus[] = ['待规划', '进行中', '待验收', '已关闭'];

export function WorkspaceCard({
  workspace,
  onMoveUp,
  onMoveDown,
  onTogglePin,
  pinned = false,
  canMoveUp = false,
  canMoveDown = false,
}: {
  workspace: Workspace;
  onMoveUp?: () => void;
  onMoveDown?: () => void;
  onTogglePin?: () => void;
  pinned?: boolean;
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
          className="mt-1 shrink-0 rounded px-1 text-xs text-neutral-400 hover:bg-neutral-100 focus-visible:outline-2 focus-visible:outline-blue-500 dark:text-neutral-500 dark:hover:bg-neutral-800"
          // CURSOR-REUSE：复用 lib/cursor 的双色拖拽光标（原生 grab 在 Windows 是无描边白手掌，白底不可见）
          style={{ cursor: GRAB_CURSOR }}
        >
          ⋮⋮
        </button>
        <div
          data-workspace-card={workspace.id}
          className={`relative min-h-[6.5rem] min-w-0 flex-1 rounded-md border transition ${
            selected
              ? 'border-blue-500 bg-blue-50 dark:border-blue-500 dark:bg-blue-950/40'
              : 'border-neutral-200 hover:bg-neutral-50 dark:border-neutral-800 dark:hover:bg-neutral-900'
          }`}
        >
          <button
            type="button"
            data-testid={`workspace-card-${workspace.id}`}
            aria-pressed={selected}
            onClick={() => selectWorkspace(workspace.id)}
            className="block w-full rounded-md px-3 pb-2 pt-3 text-left focus-visible:outline-2 focus-visible:outline-blue-500"
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
                  <div className="whitespace-nowrap text-neutral-500 dark:text-neutral-400">{status}</div>
                </div>
              ))}
            </div>
          </button>

          <button
            type="button"
            aria-label={`移除工作空间 ${workspace.name}`}
            title="移除工作空间"
            onClick={() => setRemoveOpen(true)}
            className="absolute right-1 top-1 rounded px-1.5 py-0.5 text-xs text-neutral-400 hover:bg-red-50 hover:text-red-600 dark:text-neutral-500 dark:hover:bg-red-950/40 dark:hover:text-red-400"
          >
            ✕
          </button>

          {onMoveUp !== undefined && onMoveDown !== undefined && (
            <div
              data-testid={`workspace-card-actions-${workspace.id}`}
              className="flex min-h-6 items-center justify-end gap-1 px-3 pb-2"
            >
              {onTogglePin !== undefined && (
                <button
                  type="button"
                  data-testid={`workspace-pin-${workspace.id}`}
                  aria-pressed={pinned}
                  aria-label={`${pinned ? '取消置顶' : '置顶'} ${workspace.name}`}
                  title={pinned ? '取消置顶' : '置顶'}
                  onClick={onTogglePin}
                  className={`inline-flex h-5 items-center rounded border px-1.5 text-[11px] transition ${
                    pinned
                      ? 'border-blue-600 bg-blue-600 text-white hover:bg-blue-700 dark:border-blue-500 dark:bg-blue-500 dark:hover:bg-blue-400'
                      : 'border-neutral-300 text-neutral-500 hover:bg-neutral-100 dark:border-neutral-700 dark:text-neutral-400 dark:hover:bg-neutral-800'
                  }`}
                >
                  {pinned ? '已置顶' : '置顶'}
                </button>
              )}
              <button
                type="button"
                data-testid={`workspace-move-up-${workspace.id}`}
                aria-label={`上移 ${workspace.name}`}
                title={canMoveUp ? '上移' : '已在最前'}
                disabled={!canMoveUp}
                onClick={onMoveUp}
                className="inline-flex h-5 items-center rounded px-1 text-[11px] text-neutral-400 hover:bg-neutral-100 disabled:cursor-not-allowed disabled:opacity-30 dark:text-neutral-500 dark:hover:bg-neutral-800"
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
                className="inline-flex h-5 items-center rounded px-1 text-[11px] text-neutral-400 hover:bg-neutral-100 disabled:cursor-not-allowed disabled:opacity-30 dark:text-neutral-500 dark:hover:bg-neutral-800"
              >
                ↓
              </button>
            </div>
          )}
        </div>
      </div>

      <RemoveWorkspaceDialog
        workspace={workspace}
        open={removeOpen}
        onClose={() => setRemoveOpen(false)}
      />
    </div>
  );
}

