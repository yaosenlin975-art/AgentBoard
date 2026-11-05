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
import { ModelField } from './ModelField';

export function ModelSelector({
  session,
  onUpdated,
  openSignal,
  showEditButton = true,
}: {
  session: Session;
  onUpdated: (session: Session) => void;
  /** AUDIT-SRV：外部（如错误卡片「切换模型」）递增该值即打开弹窗；弹窗开合仍由本组件持有 */
  openSignal?: number;
  /** AUDIT-3：false 时只渲染模型副标题，「修改」入口由调用方收进头部菜单 */
  showEditButton?: boolean;
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

  // 外部请求打开（0 为初值，首次挂载不触发）
  useEffect(() => {
    if (openSignal !== undefined && openSignal > 0) setOpen(true);
  }, [openSignal]);

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
      {showEditButton && (
        <button
          type="button"
          data-testid="edit-model-btn"
          onClick={() => setOpen(true)}
          title="修改模型（下一轮生效）"
          className="shrink-0 rounded px-1 py-0.5 text-xs text-accent hover:bg-accent-soft/40"
        >
          修改
        </button>
      )}

      {open && (
        <Modal open title="修改模型" onClose={() => setOpen(false)}>
          <div className="space-y-3">
            <label className="block text-sm">
              <span className="mb-1 block text-neutral-600 dark:text-neutral-300">模型（留空清除）</span>
              <ModelField
                cliId={session.cli}
                value={value}
                onChange={setValue}
                testid="model-input"
                placeholder="如 gpt-5-codex"
                ariaLabel="模型 id"
                emptyOptionLabel="（留空，清除）"
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
                className="rounded bg-accent px-3 py-1.5 text-sm font-medium text-accent-ink hover:opacity-90 disabled:opacity-40"
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
