/**
 * 中央四列看板（§7.3）：react-query 拉 issues/sessions，dnd-kit 跨列 + 列内排序。
 * 拖放经 resolveDrop 结算 → 乐观更新 → PATCH（跨列带 status，列内只带 sort_order）；
 * PATCH 失败（如 409 占用冲突）回滚缓存并提示。
 */
import { useEffect, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  DndContext,
  KeyboardSensor,
  PointerSensor,
  closestCorners,
  useSensor,
  useSensors,
  type DragEndEvent,
} from '@dnd-kit/core';
import { sortableKeyboardCoordinates } from '@dnd-kit/sortable';
import type { Issue, Session } from '@agentboard/shared';
import { api } from '../../api/client';
import { useAppStore } from '../../state/appStore';
import { BOARD_COLUMNS, commitDrop, groupByColumn, resolveDrop } from '../../lib/dnd';
import { Column } from './Column';

export function Board() {
  const workspaceId = useAppStore((s) => s.workspaceId);
  const queryClient = useQueryClient();
  const [error, setError] = useState<string | null>(null);

  const enabled = workspaceId !== null;
  const { data: issues } = useQuery({
    queryKey: ['issues', workspaceId],
    queryFn: () => api.get<Issue[]>(`/api/issues?workspace=${encodeURIComponent(workspaceId ?? '')}`),
    enabled,
  });
  const { data: sessions } = useQuery({
    queryKey: ['sessions', workspaceId],
    queryFn: () => api.get<Session[]>(`/api/sessions?workspace=${encodeURIComponent(workspaceId ?? '')}`),
    enabled,
  });

  useEffect(() => {
    if (error === null) return;
    const timer = setTimeout(() => setError(null), 4000);
    return () => clearTimeout(timer);
  }, [error]);

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  if (workspaceId === null) {
    return (
      <div className="flex h-full items-center justify-center p-8">
        <div className="text-center text-sm text-neutral-400 dark:text-neutral-500">
          <p className="text-base font-medium text-neutral-500 dark:text-neutral-400">看板</p>
          <p className="mt-1">请先在左侧选择或创建工作空间</p>
        </div>
      </div>
    );
  }

  const runningSessionIds = new Set(
    (sessions ?? []).filter((s) => s.status === '运行中').map((s) => s.id),
  );
  const grouped = groupByColumn(issues ?? []);

  const handleDragEnd = (event: DragEndEvent): void => {
    const { active, over } = event;
    if (!over || !issues) return;
    const drop = resolveDrop(issues, String(active.id), String(over.id));
    if (!drop) return;
    commitDrop({
      queryClient,
      queryKey: ['issues', workspaceId],
      drop,
      patchIssue: (id, patch) => api.patch<Issue>(`/api/issues/${id}`, patch),
      onError: (err) => setError(err instanceof Error ? err.message : '移动失败，请重试'),
    });
  };

  return (
    <div className="flex h-full flex-col">
      {error !== null && (
        <div
          role="alert"
          className="flex items-center justify-between gap-2 border-b border-red-200 bg-red-50 px-3 py-1.5 text-sm text-red-700 dark:border-red-900 dark:bg-red-950/60 dark:text-red-300"
        >
          <span>{error}</span>
          <button type="button" onClick={() => setError(null)} className="px-1 text-red-500" aria-label="关闭提示">
            ×
          </button>
        </div>
      )}
      <DndContext
        sensors={sensors}
        collisionDetection={closestCorners}
        onDragEnd={handleDragEnd}
      >
        <div className="flex flex-1 gap-3 overflow-auto p-3">
          {BOARD_COLUMNS.map((status) => (
            <Column
              key={status}
              status={status}
              issues={grouped[status]}
              runningSessionIds={runningSessionIds}
            />
          ))}
        </div>
      </DndContext>
    </div>
  );
}
