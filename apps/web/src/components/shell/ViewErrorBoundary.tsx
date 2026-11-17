/**
 * G3：视图级兜底边界。
 *
 * 一个视图（看板 / 星图 / 聊天…）抛错时只让这块区域显示错误，**左栏导航与其它视图照常可用**，
 * 避免「局部组件坏 → 整页白屏」。
 *
 * 与顶层共用 `AppErrorBoundary`，只换 fallback：不占满视口、不重载整页，只重挂当前子树。
 */
import { type ReactNode } from 'react';
import { AppErrorBoundary, summarizeError } from './AppErrorBoundary';

export interface ViewErrorFallbackProps {
  label: string;
  error: Error;
  reset: () => void;
}

export function ViewErrorFallback({ label, error, reset }: ViewErrorFallbackProps): ReactNode {
  return (
    <div
      data-testid={`view-error-${label}`}
      role="alert"
      className="flex h-full min-h-40 flex-col items-start justify-center gap-2 p-6 text-ink"
    >
      <h2 className="text-base font-semibold">此视图出错</h2>
      <p className="max-w-prose text-sm text-ink-2">
        该视图渲染失败，已隔离在此区域；左栏与其它入口仍可正常使用。
      </p>
      <pre
        data-testid={`view-error-message-${label}`}
        className="max-h-24 max-w-full overflow-auto whitespace-pre-wrap rounded border border-hairline bg-surface-raised p-2 text-xs text-ink-2"
      >
        {summarizeError(error)}
      </pre>
      <button
        type="button"
        data-testid={`view-error-retry-${label}`}
        onClick={reset}
        className="rounded border border-hairline bg-surface-card px-3 py-1.5 text-sm text-ink hover:bg-surface-raised focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent"
      >
        重试
      </button>
    </div>
  );
}

export function ViewErrorBoundary({ view, children }: { view: string; children: ReactNode }): ReactNode {
  return (
    <AppErrorBoundary fallback={(error, reset) => <ViewErrorFallback label={view} error={error} reset={reset} />}>
      {children}
    </AppErrorBoundary>
  );
}
