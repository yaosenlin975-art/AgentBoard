/**
 * BORROW-1.2（F-15）：错误基元——横幅一种画法（role=alert）。
 * 正文纯文本渲染：错误码经 errorCodeText 转中文；错误正文里的长 URL 不做链接化、不抢眼（V-02）。
 */
import { errorText } from '../../lib/errorCodeText.js';

interface ErrorStateProps {
  /** 任意错误对象（ApiError / Error / string） */
  error?: unknown;
  /** 已备好的展示文本；给了就直接用（如 RefPanel 的 404/403 特判文案） */
  message?: string;
  /** error 为空时的兜底文案 */
  fallback?: string;
  /** 语境前缀，如「加载任务树」 → 「加载任务树：<原因>」 */
  prefix?: string;
  testId?: string;
  onDismiss?: () => void;
  className?: string;
}

export function ErrorState({ error, message, fallback = '操作失败', prefix, testId, onDismiss, className = '' }: ErrorStateProps) {
  const base = message ?? errorText(error, fallback);
  const text = prefix !== undefined ? `${prefix}：${base}` : base;
  return (
    <div
      role="alert"
      data-testid={testId}
      className={`flex items-start justify-between gap-2 rounded-md border border-red-200 bg-red-50 px-2 py-1.5 text-red-700 dark:border-red-900 dark:bg-red-950/60 dark:text-red-300 ${className}`}
    >
      <span className="min-w-0 break-words">{text}</span>
      {onDismiss !== undefined && (
        <button type="button" onClick={onDismiss} className="px-1 text-red-500" aria-label="关闭提示">
          ×
        </button>
      )}
    </div>
  );
}
