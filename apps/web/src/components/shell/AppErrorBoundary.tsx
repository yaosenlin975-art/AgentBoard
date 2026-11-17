/**
 * G3：顶层兜底边界（白屏止血）
 *
 * 背景：仓库此前没有任何 ErrorBoundary。React 18 在 render 期遇到未捕获异常会**卸载整棵树**，
 * 结果是整页只剩 HTML 骨架 + CSS 背景（用户看到的「白屏」，主色正是 `--ab-page`）。
 *
 * - `getDerivedStateFromError` 渲染兜底 UI（纯 div + 项目 token，不依赖任何业务组件）
 * - `componentDidCatch` 写环形缓冲（`lib/errorBuffer`）；StrictMode 下开发期可能调用两次，用 ref 去重
 * - 兜底 UI 自带「复制错误信息」：即使网络上报（G4/G5）没做，用户也能把完整栈贴给开发者
 */
import { Component, useRef, useState, type ErrorInfo, type ReactNode } from 'react';
import {
  formatClientErrorReport,
  pushClientError,
  type ClientErrorEntry,
} from '../../lib/errorBuffer';
import { isDiagnosticsDisabled } from '../../lib/errorReporting';

/** 摘要截断长度（长消息会把兜底 UI 撑变形） */
const MESSAGE_LIMIT = 200;
/** 详情区展示的 stack 行数 */
const STACK_LINES = 30;

export function summarizeError(error: Error): string {
  const text = `${error.name}: ${error.message}`;
  return text.length > MESSAGE_LIMIT ? `${text.slice(0, MESSAGE_LIMIT)}…` : text;
}

function stackExcerpt(error: Error): string {
  return (error.stack ?? '（无 stack）').split('\n').slice(0, STACK_LINES).join('\n');
}

// ---------------------------------------------------------------------------
// 顶层兜底 UI
// ---------------------------------------------------------------------------

export function AppErrorFallback({ error, reset }: { error: Error; reset: () => void }): ReactNode {
  const [expanded, setExpanded] = useState(false);
  const [copyState, setCopyState] = useState<'idle' | 'copied' | 'failed'>('idle');
  const preRef = useRef<HTMLPreElement | null>(null);

  const copy = async (): Promise<void> => {
    const entry: ClientErrorEntry = {
      ts: Date.now(),
      kind: 'react',
      message: summarizeError(error),
      stack: error.stack ?? '',
      url: typeof window === 'undefined' ? '' : window.location.href,
    };
    try {
      await navigator.clipboard.writeText(formatClientErrorReport(entry));
      setCopyState('copied');
      return;
    } catch {
      /* 非安全上下文 / 无权限 → 降级为选中文本，让用户自己 Ctrl+C */
    }
    if (preRef.current !== null) {
      const range = document.createRange();
      range.selectNodeContents(preRef.current);
      const selection = window.getSelection();
      selection?.removeAllRanges();
      selection?.addRange(range);
    }
    setCopyState('failed');
  };

  return (
    <div
      data-testid="app-error-boundary"
      role="alert"
      className="flex min-h-screen w-full items-center justify-center bg-surface-page p-6 text-ink"
    >
      <div className="w-full max-w-2xl rounded-lg border border-hairline bg-surface-card p-5">
        <h1 className="text-lg font-semibold">界面出错了</h1>
        <p className="mt-1 text-sm text-ink-2">
          界面渲染时抛出未捕获异常，已停止该部分渲染以免整页空白。
        </p>
        <pre
          data-testid="app-error-message"
          className="mt-3 max-h-24 overflow-auto whitespace-pre-wrap rounded border border-hairline bg-surface-raised p-2 text-xs text-ink-2"
        >
          {summarizeError(error)}
        </pre>
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <button
            type="button"
            data-testid="app-error-reload"
            onClick={() => window.location.reload()}
            className="rounded border border-accent bg-accent px-3 py-1.5 text-sm font-medium text-accent-ink hover:opacity-90 focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent"
          >
            重新加载
          </button>
          <button
            type="button"
            data-testid="app-error-copy"
            onClick={() => void copy()}
            className="rounded border border-hairline px-3 py-1.5 text-sm text-ink hover:bg-surface-raised focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent"
          >
            {copyState === 'copied' ? '已复制' : copyState === 'failed' ? '复制失败（已选中文本）' : '复制错误信息'}
          </button>
          <button
            type="button"
            data-testid="app-error-details-toggle"
            onClick={() => setExpanded((value) => !value)}
            className="rounded border border-hairline px-3 py-1.5 text-sm text-ink-2 hover:bg-surface-raised focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent"
          >
            {expanded ? '收起详情' : '显示详情'}
          </button>
          <button
            type="button"
            data-testid="app-error-retry"
            onClick={reset}
            className="rounded border border-hairline px-3 py-1.5 text-sm text-ink-2 hover:bg-surface-raised focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent"
          >
            重试渲染
          </button>
        </div>
        {expanded && (
          <pre
            ref={preRef}
            data-testid="app-error-stack"
            className="mt-3 max-h-72 overflow-auto rounded border border-hairline bg-surface-raised p-2 text-xs leading-5 text-ink-2"
          >
            {stackExcerpt(error)}
          </pre>
        )}
        {expanded && isDiagnosticsDisabled() && (
          <p data-testid="app-error-diagnostics-disabled" className="mt-2 text-xs text-ink-3">
            诊断上报已关闭（localStorage `ab.diagnostics.disabled=1`），本机不会发送任何错误信息。
          </p>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// 通用边界：顶层与视图级共用，只换 fallback
// ---------------------------------------------------------------------------

interface ErrorBoundaryProps {
  children: ReactNode;
  /** 不传则用顶层白屏兜底 */
  fallback?: (error: Error, reset: () => void) => ReactNode;
}

interface ErrorBoundaryState {
  error: Error | null;
}

export class AppErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  state: ErrorBoundaryState = { error: null };

  /** 去重：StrictMode 双调用、同一错误重复捕获都只记一条 */
  private reported = false;

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    if (this.reported) return;
    this.reported = true;
    pushClientError({
      kind: 'react',
      message: summarizeError(error),
      stack: [error.stack ?? '', info.componentStack ?? ''].filter((part) => part !== '').join('\n\n'),
      source: 'react-boundary',
    });
  }

  reset = (): void => {
    this.reported = false;
    this.setState({ error: null });
  };

  render(): ReactNode {
    const { error } = this.state;
    if (error === null) return this.props.children;
    const fallback = this.props.fallback;
    if (fallback !== undefined) return fallback(error, this.reset);
    return <AppErrorFallback error={error} reset={this.reset} />;
  }
}
