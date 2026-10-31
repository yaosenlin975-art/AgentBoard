import { useState, type FormEvent } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { Workspace } from '@agentboard/shared';
import { api } from '../../api/client';
import { Modal } from '../ui/Modal';

const inputCls =
  'w-full rounded border border-neutral-300 px-2 py-1.5 text-sm outline-none focus:border-blue-500 dark:border-neutral-700 dark:bg-neutral-800';

export function NewWorkspaceDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const queryClient = useQueryClient();
  const [name, setName] = useState('');
  const [path, setPath] = useState('');
  const [error, setError] = useState<string | null>(null);

  const create = useMutation({
    mutationFn: (body: { name: string; path: string }) => api.post<Workspace>('/api/workspaces', body),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['workspaces'] });
      setName('');
      setPath('');
      setError(null);
      onClose();
    },
    onError: (e) => setError(e instanceof Error ? e.message : '创建失败'),
  });

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (create.isPending) return;
    create.mutate({ name: name.trim(), path: path.trim() });
  };

  return (
    <Modal open={open} title="新增工作空间" onClose={onClose}>
      <form onSubmit={submit} className="space-y-3">
        <label className="block text-sm">
          <span className="mb-1 block text-neutral-600 dark:text-neutral-300">名称</span>
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            required
            aria-label="工作空间名称"
            placeholder="如：主项目"
            className={inputCls}
          />
        </label>
        <label className="block text-sm">
          <span className="mb-1 block text-neutral-600 dark:text-neutral-300">路径</span>
          <input
            value={path}
            onChange={(e) => setPath(e.target.value)}
            required
            aria-label="工作空间路径"
            placeholder="D:\WorkSpaces\my-project"
            className={inputCls}
          />
          <span className="mt-1 block text-xs text-neutral-400 dark:text-neutral-500">
            必须是已存在的绝对路径目录
          </span>
        </label>
        {error && (
          <p role="alert" className="text-sm text-red-600 dark:text-red-400">
            {error}
          </p>
        )}
        <div className="flex justify-end gap-2 pt-2">
          <button
            type="button"
            onClick={onClose}
            className="rounded px-3 py-1.5 text-sm text-neutral-600 hover:bg-neutral-100 dark:text-neutral-300 dark:hover:bg-neutral-800"
          >
            取消
          </button>
          <button
            type="submit"
            disabled={create.isPending || name.trim() === '' || path.trim() === ''}
            className="rounded bg-blue-600 px-3 py-1.5 text-sm font-medium text-white disabled:cursor-not-allowed disabled:opacity-40"
          >
            创建
          </button>
        </div>
      </form>
    </Modal>
  );
}
