import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { Workspace } from '@agentboard/shared';
import { api } from '../../api/client';
import { WorkspaceCard } from './WorkspaceCard';
import { NewWorkspaceDialog } from './NewWorkspaceDialog';

/** 左栏：工作空间列表（260px），空态引导 + 新增弹窗 */
export function WorkspaceList() {
  const [dialogOpen, setDialogOpen] = useState(false);
  const { data: workspaces, isLoading } = useQuery({
    queryKey: ['workspaces'],
    queryFn: () => api.get<Workspace[]>('/api/workspaces'),
  });
  const list = workspaces ?? [];

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center justify-between px-3 pb-2 pt-3">
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

      <div className="flex-1 overflow-y-auto px-3 pb-3" role="list" aria-label="工作空间列表">
        {isLoading && <p className="py-6 text-center text-sm text-neutral-400">加载中…</p>}
        {!isLoading && list.length === 0 && (
          <div className="mt-8 rounded-md border border-dashed border-neutral-300 p-6 text-center text-sm text-neutral-500 dark:border-neutral-700 dark:text-neutral-400">
            <p>还没有工作空间</p>
            <p className="mt-1 text-xs">点击右上角「+ 新增」创建第一个工作空间</p>
          </div>
        )}
        {list.map((workspace) => (
          <WorkspaceCard key={workspace.id} workspace={workspace} />
        ))}
      </div>

      <NewWorkspaceDialog open={dialogOpen} onClose={() => setDialogOpen(false)} />
    </div>
  );
}
