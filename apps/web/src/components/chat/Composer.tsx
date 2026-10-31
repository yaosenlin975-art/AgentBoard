/**
 * 输入区（设计 §7.5）：多行 textarea，Enter 发送 / Shift+Enter 换行（IME 组合中不发送）；
 * POST /api/sessions/:id/messages 返回 queued:true 时排队计数在 ChatPanel 维护；
 * 运行中且队列 >0 显示"排队中 N 条"，停止后显示"已停止，排队 N 条保留"。
 */
import { useState, type KeyboardEvent as ReactKeyboardEvent } from 'react';

export function Composer({
  disabled,
  running,
  queuedCount,
  onSend,
}: {
  disabled: boolean;
  running: boolean;
  queuedCount: number;
  onSend: (text: string) => Promise<void>;
}) {
  const [value, setValue] = useState('');
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const queueHint =
    queuedCount > 0
      ? running
        ? `排队中 ${queuedCount} 条`
        : `已停止，排队 ${queuedCount} 条保留`
      : null;

  const submit = async (): Promise<void> => {
    const text = value.trim();
    if (text === '' || sending || disabled) return;
    setError(null);
    setSending(true);
    try {
      await onSend(text);
      setValue('');
    } catch (e) {
      setError(e instanceof Error ? e.message : '发送失败');
    } finally {
      setSending(false);
    }
  };

  const onKeyDown = (e: ReactKeyboardEvent<HTMLTextAreaElement>): void => {
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      void submit();
    }
  };

  return (
    <div data-testid="composer" className="shrink-0 space-y-1 border-t border-neutral-200 p-2 dark:border-neutral-800">
      {queueHint !== null && (
        <p data-testid="queue-hint" className="text-xs text-amber-600 dark:text-amber-400" role="status">
          {queueHint}
        </p>
      )}
      <div className="flex items-end gap-1.5">
        <textarea
          data-testid="composer-input"
          aria-label="消息输入"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={onKeyDown}
          disabled={disabled}
          rows={2}
          placeholder={disabled ? '选择会话后输入' : '输入消息，Enter 发送，Shift+Enter 换行'}
          className="min-h-0 w-full resize-none rounded border border-neutral-300 px-2 py-1.5 text-xs outline-none focus:border-blue-500 disabled:opacity-50 dark:border-neutral-700 dark:bg-neutral-800"
        />
        <button
          type="button"
          data-testid="composer-send"
          onClick={() => void submit()}
          disabled={disabled || sending || value.trim() === ''}
          className="shrink-0 rounded bg-blue-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-40"
        >
          {sending ? '发送中…' : '发送'}
        </button>
      </div>
      {error !== null && (
        <p data-testid="composer-error" role="alert" className="text-xs text-red-600 dark:text-red-400">
          {error}
        </p>
      )}
    </div>
  );
}
