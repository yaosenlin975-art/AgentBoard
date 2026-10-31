/**
 * 新建 issue 弹窗（§7.6）：标题 / 描述 / 优先级 / 标签（逗号分隔）→ POST /api/issues → 落"待规划"。
 */
import { useState, type FormEvent } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { Issue, Priority } from '@agentboard/shared';
import { api } from '../../api/client';
import { Modal } from '../ui/Modal';

const inputCls =
  'w-full rounded border border-neutral-300 px-2 py-1.5 text-sm outline-none focus:border-blue-500 dark:border-neutral-700 dark:bg-neutral-800';

export function NewIssueDialog({
  open,
  workspaceId,
  onClose,
}: {
  open: boolean;
  workspaceId: string;
  onClose: () => void;
}) {
  const queryClient = useQueryClient();
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [priority, setPriority] = useState<Priority>('中');
  const [labelsInput, setLabelsInput] = useState('');
  const [error, setError] = useState<string | null>(null);

  const create = useMutation({
    mutationFn: (body: {
      workspace_id: string;
      title: string;
      description: string;
      priority: Priority;
      labels: string[];
    }) => api.post<Issue>('/api/issues', body),
    onSuccess: async (_issue) => {
      await queryClient.invalidateQueries({ queryKey: ['issues', workspaceId] });
      setTitle('');
      setDescription('');
      setPriority('中');
      setLabelsInput('');
      setError(null);
      onClose();
    },
    onError: (e) => setError(e instanceof Error ? e.message : '创建失败'),
  });

  const submit = (e: FormEvent): void => {
    e.preventDefault();
    if (create.isPending || title.trim() === '') return;
    create.mutate({
      workspace_id: workspaceId,
      title: title.trim(),
      description,
      priority,
      labels: labelsInput
        .split(',')
        .map((t) => t.trim())
        .filter((t) => t !== ''),
    });
  };

  return (
    <Modal open={open} title="新建 issue" onClose={onClose}>
      <form onSubmit={submit} className="space-y-3">
        <label className="block text-sm">
          <span className="mb-1 block text-neutral-600 dark:text-neutral-300">标题</span>
          <input
            data-testid="new-issue-title"
            aria-label="标题"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            required
            className={inputCls}
          />
        </label>
        <label className="block text-sm">
          <span className="mb-1 block text-neutral-600 dark:text-neutral-300">描述（markdown）</span>
          <textarea
            data-testid="new-issue-description"
            aria-label="描述"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            rows={4}
            className={inputCls}
          />
        </label>
        <label className="block text-sm">
          <span className="mb-1 block text-neutral-600 dark:text-neutral-300">优先级</span>
          <select
            data-testid="new-issue-priority"
            aria-label="优先级"
            value={priority}
            onChange={(e) => setPriority(e.target.value as Priority)}
            className={inputCls}
          >
            <option value="低">低</option>
            <option value="中">中</option>
            <option value="高">高</option>
          </select>
        </label>
        <label className="block text-sm">
          <span className="mb-1 block text-neutral-600 dark:text-neutral-300">标签（逗号分隔）</span>
          <input
            data-testid="new-issue-labels"
            aria-label="标签"
            value={labelsInput}
            onChange={(e) => setLabelsInput(e.target.value)}
            placeholder="前端, 性能"
            className={inputCls}
          />
        </label>
        {error !== null && (
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
            data-testid="new-issue-submit"
            disabled={create.isPending || title.trim() === ''}
            className="rounded bg-blue-600 px-3 py-1.5 text-sm font-medium text-white disabled:cursor-not-allowed disabled:opacity-40"
          >
            创建
          </button>
        </div>
      </form>
    </Modal>
  );
}
