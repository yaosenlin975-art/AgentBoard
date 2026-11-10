import { useEffect, useState, type FormEvent } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { Workspace } from '@agentboard/shared';
import { api } from '../../api/client';
import { Modal } from '../ui/Modal';

const inputCls =
  'w-full rounded border border-hairline px-2 py-1.5 text-sm outline-none focus:border-accent  ';

/** 与服务端兜底一致的 basename：去尾部 / 与 \，按 / 或 \ 取最后一段 */
function pathBasename(p: string): string {
  const segments = p
    .replace(/[\\/]+$/, '')
    .split(/[\\/]+/)
    .filter(Boolean);
  return segments.length > 0 ? segments[segments.length - 1]! : '';
}

export function NewWorkspaceDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const queryClient = useQueryClient();
  const [name, setName] = useState('');
  const [nameTouched, setNameTouched] = useState(false);
  const [path, setPath] = useState('');
  const [error, setError] = useState<string | null>(null);

  const create = useMutation({
    mutationFn: (body: { name: string; path: string }) => api.post<Workspace>('/api/workspaces', body),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['workspaces'] });
      setName('');
      setNameTouched(false);
      setPath('');
      setError(null);
      onClose();
    },
    onError: (e) => setError(e instanceof Error ? e.message : '创建失败'),
  });

  // 名称留空以文件夹名兜底：未手动改过 name 时，路径变化 → 实时预填 basename（非法/空路径清回空）
  useEffect(() => {
    if (nameTouched) return;
    setName(pathBasename(path));
  }, [path, nameTouched]);

  const browse = useMutation({
    mutationFn: () => api.post<{ path: string | null }>('/api/system/pick-folder'),
    onSuccess: (data) => {
      if (data.path) setPath(data.path); // null（取消/未选择）静默
    },
    onError: (e) => setError(e instanceof Error ? e.message : '打开文件夹选择窗口失败'),
  });

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (create.isPending) return;
    // 空 name 直接发空串，服务端从 path basename 兜底
    create.mutate({ name: name.trim(), path: path.trim() });
  };

  const close = () => {
    if (!create.isPending) {
      setNameTouched(false);
      setError(null);
    }
    onClose();
  };

  return (
    <Modal open={open} title="新增工作空间" onClose={close}>
      <form onSubmit={submit} className="space-y-3">
        <label className="block text-sm">
          <span className="mb-1 block text-ink-2">名称</span>
          <input
            value={name}
            onChange={(e) => {
              setName(e.target.value);
              setNameTouched(true);
            }}
            aria-label="工作空间名称"
            placeholder="留空则以文件夹名命名"
            className={inputCls}
          />
        </label>
        <label className="block text-sm">
          <span className="mb-1 block text-ink-2">路径</span>
          <div className="flex gap-2">
            <input
              value={path}
              onChange={(e) => setPath(e.target.value)}
              required
              aria-label="工作空间路径"
              placeholder="D:\WorkSpaces\my-project"
              className={`${inputCls} min-w-0 flex-1`}
            />
            <button
              type="button"
              aria-label="浏览文件夹"
              disabled={browse.isPending}
              onClick={() => {
                setError(null);
                browse.mutate();
              }}
              className="shrink-0 rounded border border-hairline px-2 py-1.5 text-sm text-ink-2 hover:bg-surface-raised disabled:cursor-not-allowed disabled:opacity-40"
            >
              {browse.isPending ? '等待选择…' : '浏览…'}
            </button>
          </div>
          {browse.isPending && (
            <span className="mt-1 block text-xs text-accent">
              请在弹出的窗口中选择文件夹
            </span>
          )}
          <span className="mt-1 block text-xs text-ink-3">
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
            onClick={close}
            className="rounded px-3 py-1.5 text-sm text-ink-2 hover:bg-surface-raised"
          >
            取消
          </button>
          <button
            type="submit"
            disabled={create.isPending || path.trim() === ''}
            className="rounded bg-accent px-3 py-1.5 text-sm font-medium text-accent-ink disabled:cursor-not-allowed disabled:opacity-40"
          >
            创建
          </button>
        </div>
      </form>
    </Modal>
  );
}
