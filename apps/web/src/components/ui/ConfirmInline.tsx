/**
 * F-08：行内二次确认（不弹模态）。危险动作先展开一句说明 + 确认/取消，
 * 任务删除与 A05 的会话删除共用同一实现（账号侧等 ACC-B 合并后再接）。
 */
import type { ReactNode } from 'react';

export function ConfirmInline({
  message,
  confirmLabel,
  cancelLabel = '取消',
  onConfirm,
  onCancel,
  busy = false,
  disabled = false,
  tone = 'danger',
  messageTestId,
  confirmTestId,
  cancelTestId,
}: {
  /** 说明文案（写清后果） */
  message: ReactNode;
  confirmLabel: string;
  cancelLabel?: string;
  onConfirm: () => void;
  onCancel: () => void;
  busy?: boolean;
  disabled?: boolean;
  tone?: 'danger' | 'neutral';
  messageTestId?: string;
  confirmTestId?: string;
  cancelTestId?: string;
}) {
  return (
    <>
      <span
        data-testid={messageTestId}
        className={`text-xs ${tone === 'danger' ? 'text-red-600 dark:text-red-400' : 'text-ink-2'}`}
      >
        {message}
      </span>
      <button
        type="button"
        data-testid={confirmTestId}
        onClick={onConfirm}
        disabled={busy || disabled}
        className={`rounded px-3 py-1.5 text-xs font-medium text-white disabled:opacity-40 ${
          tone === 'danger' ? 'bg-red-600 hover:bg-red-700' : 'bg-accent hover:opacity-90'
        }`}
      >
        {confirmLabel}
      </button>
      <button
        type="button"
        data-testid={cancelTestId}
        onClick={onCancel}
        className="rounded border border-neutral-300 px-3 py-1.5 text-xs text-neutral-600 hover:bg-neutral-100 dark:border-neutral-700 dark:text-neutral-300 dark:hover:bg-neutral-800"
      >
        {cancelLabel}
      </button>
    </>
  );
}
