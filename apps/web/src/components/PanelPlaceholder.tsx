/** 右侧面板占位：Task 13/14 替换为任务详情/聊天双视图 */
export function PanelPlaceholder() {
  return (
    <div className="flex h-full items-center justify-center p-8">
      <div className="text-center text-sm text-neutral-400 dark:text-neutral-500">
        <p className="text-base font-medium text-neutral-500 dark:text-neutral-400">详情 / 聊天</p>
        <p className="mt-1">右侧面板将在 Task 13/14 实现</p>
      </div>
    </div>
  );
}
