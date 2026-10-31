/** 中央看板占位：Task 12 替换为四列看板 */
export function BoardPlaceholder({ hasWorkspace }: { hasWorkspace: boolean }) {
  return (
    <div className="flex h-full items-center justify-center p-8">
      <div className="text-center text-sm text-neutral-400 dark:text-neutral-500">
        <p className="text-base font-medium text-neutral-500 dark:text-neutral-400">看板</p>
        <p className="mt-1">
          {hasWorkspace ? '看板列将在 Task 12 实现' : '请先在左侧选择或创建工作空间'}
        </p>
      </div>
    </div>
  );
}
