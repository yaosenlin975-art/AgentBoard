/** 聊天视图占位：Task 14 替换为 ChatPanel（§7.5） */
export function ChatPanelPlaceholder() {
  return (
    <div className="flex h-full items-center justify-center p-8">
      <div className="text-center text-sm text-neutral-400 dark:text-neutral-500">
        <p className="text-base font-medium text-neutral-500 dark:text-neutral-400">聊天</p>
        <p className="mt-1">聊天视图将在 Task 14 实现</p>
      </div>
    </div>
  );
}
