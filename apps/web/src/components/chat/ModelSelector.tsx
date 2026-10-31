/**
 * 当前会话 CLI/模型显示与"修改模型"（设计 §7.5）：
 * PATCH /api/sessions/:id {model}（只改 model 字段，下一轮生效——runTurn 起轮时读取 session.model）。
 * 输入留空保存即清空模型（null）。
 */
import { useEffect, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { Session } from '@agentboard/shared';
import { api } from '../../api/client';
import { Modal } from '../ui/Modal';

const inputCls =
  'w-full rounded border border-neutral-300 px-2 py-1.5 text-sm outline-none focus:border-blue-500 dark:border-neutral-700 dark:bg-neutral-800';

export function ModelSelector({
  session,
  onUpdated,
}: {
  session: Session;
  onUpdated: (session: Session) => void;
}) {
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const [value, setValue] = useState('');
  const [error, setError] = useState<string | null>(null);

  // 打开弹窗时以当前会话模型预填
  useEffect(() => {
    if (open) {
      setValue(session.model ?? '');
      setError(null);
    }
  }, [open, session.id, session.model]);

  const save = useMutation({
    mutationFn: () =>
      api.patch<Session>(`/api/sessions/${session.id}`, {
        model: value.trim() === '' ? null : value.trim(),
      }),
    onSuccess: (updated) => {
      setOpen(false);
      onUpdated(updated);
      void queryClient.invalidateQueries({ queryKey: ['sessions'] });
    },
    onError: (e) => setError(e instanceof Error ? e.message : '保存失败'),
  });

  return (
    <span className="flex min-w-0 items-center gap-1">
      <span
        data-testid="model-display"
        title={`${session.cli}${session.model !== null ? ` · ${session.model}` : ''}`}
        className="max-w-28 truncate text-xs text-neutral-500 dark:text-neutral-400"
      >
        {session.cli}
        {session.model !== null ? ` · ${session.model}` : ''}
      </span>
      <button
        type="button"
        data-testid="edit-model-btn"
        onClick={() => setOpen(true)}
        title="修改模型（下一轮生效）"
        className="shrink-0 rounded px-1 py-0.5 text-xs text-blue-600 hover:bg-blue-50 dark:text-blue-400 dark:hover:bg-blue-950/40"
      >
        修改
      </button>

      {open && (
        <Modal open title="修改模型" onClose={() => setOpen(false)}>
          <div className="space-y-3">
            <label className="block text-sm">
              <span className="mb-1 block text-neutral-600 dark:text-neutral-300">模型（留空清除）</span>
              <input
                data-testid="model-input"
                aria-label="模型 id"
                value={value}
                onChange={(e) => setValue(e.target.value)}
                placeholder="如 gpt-5-codex"
                className={inputCls}
              />
            </label>
            <p data-testid="model-hint" className="text-xs text-neutral-400 dark:text-neutral-500">
              修改在下一轮对话生效
            </p>
            {error !== null && (
              <p data-testid="model-error" role="alert" className="text-xs text-red-600 dark:text-red-400">
                {error}
              </p>
            )}
            <div className="flex justify-end gap-2 pt-1">
              <button
                type="button"
                onClick={() => setOpen(false)}
                className="rounded px-3 py-1.5 text-sm text-neutral-600 hover:bg-neutral-100 dark:text-neutral-300 dark:hover:bg-neutral-800"
              >
                取消
              </button>
              <button
                type="button"
                data-testid="model-confirm"
                onClick={() => save.mutate()}
                disabled={save.isPending}
                className="rounded bg-blue-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-40"
              >
                {save.isPending ? '保存中…' : '保存'}
              </button>
            </div>
          </div>
        </Modal>
      )}
    </span>
  );
}
