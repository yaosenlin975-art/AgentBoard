import { useEffect, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { Workspace } from '@agentboard/shared';
import { api } from '../../api/client';
import { useAppStore } from '../../state/appStore';
import { Modal } from '../ui/Modal';

const inputCls =
  'w-full rounded border border-neutral-300 px-2 py-1.5 text-sm outline-none focus:border-blue-500 dark:border-neutral-700 dark:bg-neutral-800';

/**
 * 移除工作空间二次确认（WORKSPACE-REMOVE）：
 * 需原样输入空间名称才可提交；服务端拒绝（知识页/运行中会话/父子任务）时原样展示原因并保持空间不变。
 */
export function RemoveWorkspaceDialog({
  workspace,
  open,
  onClose,
}: {
  workspace: Workspace;
  open: boolean;
  onClose: () => void;
}) {
  const queryClient = useQueryClient();
  const [confirmName, setConfirmName] = useState('');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setConfirmName('');
    setError(null);
  }, [open, workspace.id]);

  const remove = useMutation({
    mutationFn: () => api.del<void>(`/api/workspaces/${encodeURIComponent(workspace.id)}`),
    onSuccess: async () => {
      queryClient.removeQueries({ queryKey: ['issues', workspace.id] });
      queryClient.removeQueries({ queryKey: ['sessions', workspace.id] });
      if (useAppStore.getState().workspaceId === workspace.id) useAppStore.getState().selectWorkspace(null);
      await queryClient.invalidateQueries({ queryKey: ['workspaces'] });
      onClose();
    },
    onError: (e) => setError(e instanceof Error ? e.message : '移除失败'),
  });

  return (
    <Modal open={open} title="移除工作空间" scrollable onClose={() => { if (!remove.isPending) onClose(); }}>
      <div className="space-y-3">
        <p className="text-sm text-neutral-700 dark:text-neutral-200">
          将移除「{workspace.name}」及其在该空间的全部任务、评论、会话与消息（附件一并回收）。磁盘上的项目目录不受影响。
        </p>
        <p className="text-xs text-neutral-500 dark:text-neutral-400">
          空间内存在知识页、运行中会话或父子任务关联时会被拒绝，并给出处理方式。
        </p>
        <label className="block text-sm">
          <span className="mb-1 block text-neutral-600 dark:text-neutral-300">
            输入空间名称「{workspace.name}」确认
          </span>
          <input
            value={confirmName}
            onChange={(e) => setConfirmName(e.target.value)}
            aria-label="确认空间名称"
            placeholder={workspace.name}
            className={inputCls}
          />
        </label>
        {error && (
          <p role="alert" data-testid="remove-workspace-error" className="text-sm text-red-600 dark:text-red-400">
            {error}
          </p>
        )}
        <div className="flex justify-end gap-2 pt-2">
          <button
            type="button"
            disabled={remove.isPending}
            onClick={onClose}
            className="min-w-[4.5rem] whitespace-nowrap rounded px-3 py-1.5 text-sm text-neutral-600 hover:bg-neutral-100 disabled:cursor-not-allowed disabled:opacity-40 dark:text-neutral-300 dark:hover:bg-neutral-800"
          >
            取消
          </button>
          <button
            type="button"
            disabled={remove.isPending || confirmName.trim() !== workspace.name}
            onClick={() => remove.mutate()}
            className="min-w-[8.5rem] whitespace-nowrap rounded bg-red-600 px-3 py-1.5 text-sm font-medium text-white disabled:cursor-not-allowed disabled:opacity-40"
          >
            移除工作空间
          </button>
        </div>
      </div>
    </Modal>
  );
}

