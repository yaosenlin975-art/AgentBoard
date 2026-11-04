/**
 * 顶栏标签筛选条（UI-FILTER01）：平铺看板 / 任务树切换区中间展示当前工作空间全部已有标签，
 * 点击 toggle 多选；多选按 OR 匹配（命中任一选中标签即显示），未选任何标签 = 显示全部。
 * 标签集合来自 api/workspaceLabels.ts 的全量拉取，覆盖整个 workspace。
 * 原生 button：可 Tab 聚焦，Enter / Space 触发。
 */
import { NO_SELECTED_LABELS, useAppStore } from '../../state/appStore';
import { useWorkspaceLabels } from '../../api/workspaceLabels';

export function LabelFilterBar({ workspaceId }: { workspaceId: string }) {
  const labels = useWorkspaceLabels(workspaceId);
  const selected = useAppStore((s) => s.selectedLabelsByWorkspace[workspaceId] ?? NO_SELECTED_LABELS);
  const toggleLabel = useAppStore((s) => s.toggleLabel);
  const clearLabels = useAppStore((s) => s.clearLabels);

  return (
    // 标签数量可能很多：单行横向滚动，保证不被撑高。
    // 固定独占工具栏第二行（宽度随容器自适应），不再与切换按钮/搜索框抢同一行。
    <div data-testid="label-filter-bar" className="w-full min-w-0 overflow-x-auto">
      <div className="flex w-max items-center gap-1">
        <span className="sr-only">标签筛选</span>
        {labels.map((label) => {
          const active = selected.includes(label);
          return (
            <button
              key={label}
              type="button"
              aria-pressed={active}
              data-testid={`label-filter-${label}`}
              title={active ? `取消标签筛选：${label}` : `按标签筛选：${label}`}
              onClick={() => toggleLabel(workspaceId, label)}
              data-active={active ? 'true' : 'false'}
              // A2：点击反馈只走颜色过渡（无位移/缩放），reduced-motion 下即时
              className={`shrink-0 whitespace-nowrap rounded px-2 py-0.5 text-xs transition-colors duration-150 motion-reduce:transition-none ${active
                ? 'bg-blue-100 font-medium text-blue-800 active:bg-blue-200 dark:bg-blue-950 dark:text-blue-200 dark:active:bg-blue-900'
                : 'border border-neutral-200 text-neutral-600 hover:bg-neutral-100 active:bg-neutral-200 dark:border-neutral-700 dark:text-neutral-300 dark:hover:bg-neutral-800 dark:active:bg-neutral-700'}`}
            >
              {label}
            </button>
          );
        })}
        {selected.length > 0 && (
          <button
            type="button"
            data-testid="label-filter-clear"
            onClick={() => clearLabels(workspaceId)}
            className="shrink-0 whitespace-nowrap rounded px-2 py-0.5 text-xs text-neutral-500 transition-colors duration-150 hover:bg-neutral-100 active:bg-neutral-200 motion-reduce:transition-none dark:text-neutral-400 dark:hover:bg-neutral-800 dark:active:bg-neutral-700"
          >
            清除筛选
          </button>
        )}
      </div>
    </div>
  );
}
