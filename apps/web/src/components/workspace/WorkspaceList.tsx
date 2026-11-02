/**
 * 左浮窗内容：工作空间列表（260px），空态引导 + 新增弹窗 + 拖拽排序（WS-REORDER）。
 * 排序：本地立即乐观重排 → POST /api/workspaces/reorder（带 Idempotency-Key）→ 用响应整体覆盖；
 * 失败回滚并提示；集合冲突（409 WORKSPACE_SET_CHANGED）只提示刷新，不重试；顺序冲突是 LWW，不报「他人已修改」。
 */
import { useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { DndContext, KeyboardSensor, PointerSensor, closestCenter, useSensor, useSensors, type DragEndEvent } from '@dnd-kit/core';
import { SortableContext, sortableKeyboardCoordinates, verticalListSortingStrategy } from '@dnd-kit/sortable';
import type { Workspace } from '@agentboard/shared';
import { api } from '../../api/client';
import { commitWorkspaceOrder, moveWorkspace, sortWorkspaces, WORKSPACES_KEY } from '../../lib/workspaceReorder';
import { WorkspaceCard } from './WorkspaceCard';
import { NewWorkspaceDialog } from './NewWorkspaceDialog';

export function WorkspaceList() {
  const [dialogOpen, setDialogOpen] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const queryClient = useQueryClient();
  /** 同一次拖拽/移动重试复用同一个幂等键 */
  const idempotencyRef = useRef<string | null>(null);

  const { data: workspaces, isLoading } = useQuery({
    queryKey: WORKSPACES_KEY,
    queryFn: () => api.get<Workspace[]>('/api/workspaces'),
  });
  const list = sortWorkspaces(workspaces ?? []);
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  const submit = async (ordered: Workspace[]): Promise<void> => {
    if (idempotencyRef.current === null) idempotencyRef.current = crypto.randomUUID();
    const key = idempotencyRef.current;
    const outcome = await commitWorkspaceOrder(queryClient, ordered, key);
    if (outcome.ok) {
      idempotencyRef.current = null;
      setNotice(null);
      return;
    }
    setNotice(outcome.message);
  };

  const onDragEnd = (event: DragEndEvent): void => {
    idempotencyRef.current = null; // 新的拖拽 = 新操作 = 新幂等键
    const { active, over } = event;
    if (over === null || active.id === over.id) return;
    const from = list.findIndex((item) => item.id === active.id);
    const to = list.findIndex((item) => item.id === over.id);
    if (from < 0 || to < 0) return;
    void submit(moveWorkspace(list, from, to));
  };

  const moveBy = (index: number, delta: number): void => {
    idempotencyRef.current = null;
    void submit(moveWorkspace(list, index, index + delta));
  };

  return (
    <div className="flex h-full flex-col">
      <div className="flex h-10 shrink-0 items-center justify-between px-2">
        <h2 className="text-xs font-semibold uppercase tracking-wide text-neutral-500 dark:text-neutral-400">
          工作空间
        </h2>
        <button
          type="button"
          aria-label="新增工作空间"
          onClick={() => setDialogOpen(true)}
          className="rounded px-2 py-1 text-xs text-blue-600 hover:bg-blue-50 dark:text-blue-400 dark:hover:bg-blue-950/40"
        >
          + 新增
        </button>
      </div>

      {notice !== null && (
        <p role="alert" data-testid="workspace-order-notice" className="mx-2 mb-1 rounded border border-amber-300 bg-amber-50 px-2 py-1 text-xs text-amber-900 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-200">
          {notice}
        </p>
      )}

      <div className="flex-1 overflow-y-auto px-2 pb-2" role="list" aria-label="工作空间列表">
        {isLoading && <p className="py-6 text-center text-sm text-neutral-400">加载中…</p>}
        {!isLoading && list.length === 0 && (
          <div className="mt-8 rounded-md border border-dashed border-neutral-300 p-6 text-center text-sm text-neutral-500 dark:border-neutral-700 dark:text-neutral-400">
            <p>还没有工作空间</p>
            <p className="mt-1 text-xs">点击右上角「+ 新增」创建第一个工作空间</p>
          </div>
        )}
        <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
          <SortableContext items={list.map((workspace) => workspace.id)} strategy={verticalListSortingStrategy}>
            {list.map((workspace, index) => (
              <WorkspaceCard
                key={workspace.id}
                workspace={workspace}
                canMoveUp={index > 0}
                canMoveDown={index < list.length - 1}
                onMoveUp={() => moveBy(index, -1)}
                onMoveDown={() => moveBy(index, 1)}
              />
            ))}
          </SortableContext>
        </DndContext>
      </div>

      <NewWorkspaceDialog open={dialogOpen} onClose={() => setDialogOpen(false)} />
    </div>
  );
}
