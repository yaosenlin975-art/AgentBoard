/**
 * 日志类型标签（LOG-SCROLL）：定宽 44px（w-11）+ 居中文字，四种类型同宽。
 * 不用 `min-width`：短标签（新增/修复/调整 都是两字）也必须等宽，否则列表与滚动区里的标签会左右跳动。
 * 颜色沿用 Badge 的 tone 语义（新增=绿 / 修复=蓝 / 调整=中性 / 历史=紫），但宽度是固定的，故不复用 Badge 的 pill。
 */
import type { WorkspaceChangeType } from '@agentboard/shared';

const TYPE_CLASS: Record<string, string> = {
  新增: 'bg-green-100 text-green-800 dark:bg-green-900/40 dark:text-green-300',
  修复: 'bg-blue-100 text-blue-800 dark:bg-blue-900/40 dark:text-blue-300',
  调整: 'bg-neutral-200 text-neutral-700 dark:bg-neutral-800 dark:text-neutral-300',
  历史: 'bg-purple-100 text-purple-800 dark:bg-purple-900/40 dark:text-purple-300',
};

export function ChangelogTypeTag({ type }: { type: WorkspaceChangeType | string }) {
  return (
    <span
      data-testid={`changelog-type-${type}`}
      className={`inline-flex h-5 w-11 shrink-0 items-center justify-center rounded text-[11px] font-medium ${TYPE_CLASS[type] ?? TYPE_CLASS.调整}`}
    >
      {type}
    </span>
  );
}
