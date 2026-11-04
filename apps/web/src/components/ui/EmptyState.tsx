/**
 * BORROW-1.2（F-15）：空态基元——「说明 + 下一步能做什么」统一画法。
 * 空列 / 空依赖 / 空会话 / 空评论等所有空语义只准用这一个组件。
 */
interface EmptyStateProps {
  /** 一句话说明为什么是空的 */
  title: string;
  /** 下一步动作指引（可省略；省略时只渲染标题） */
  hint?: string;
  /** 原有 DOM 的 data-testid（替换旧空态时透传，测试锚点不漂移） */
  testId?: string;
  /** 紧凑模式：嵌入列内/小容器的低高度变体 */
  compact?: boolean;
  className?: string;
}

export function EmptyState({ title, hint, testId, compact = false, className = '' }: EmptyStateProps) {
  return (
    <div
      data-testid={testId}
      className={`rounded-md border border-dashed border-hairline text-center ${compact ? 'px-3 py-4' : 'px-4 py-10'} ${className}`}
    >
      <p className="text-sm font-medium text-ink-2">{title}</p>
      {hint !== undefined && <p className="mt-1 text-xs text-ink-3">{hint}</p>}
    </div>
  );
}
