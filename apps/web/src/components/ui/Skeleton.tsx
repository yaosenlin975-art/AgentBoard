/**
 * BORROW-1.2（F-15）：加载基元——pulse 骨架行一种画法。
 * 只允许挂在「真实加载中」状态（UNSLOP-5 定性），数据到位即卸载。
 * data-testid 直接落在 ul 上（knowledge-skeleton 等既有测试锚点用 closest('ul') 取样式）。
 */
interface SkeletonProps {
  rows?: number;
  testId?: string;
  className?: string;
}

export function Skeleton({ rows = 3, testId, className = '' }: SkeletonProps) {
  return (
    <ul
      data-testid={testId}
      className={`divide-y divide-hairline overflow-hidden rounded-2xl border border-hairline bg-surface-card ${className}`}
    >
      {Array.from({ length: rows }, (_, i) => (
        <li key={i} className="animate-pulse px-3 py-3">
          <div className="h-3.5 w-2/3 rounded bg-surface-raised" />
          <div className="mt-2 h-3 w-full rounded bg-surface-raised" />
        </li>
      ))}
    </ul>
  );
}
