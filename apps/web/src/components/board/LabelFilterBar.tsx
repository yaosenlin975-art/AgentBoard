/**
 * 顶栏标签筛选条（UI-FILTER01）：平铺看板 / 任务树切换区中间展示当前工作空间全部已有标签，
 * 点击 toggle 多选；多选按 OR 匹配（命中任一选中标签即显示），未选任何标签 = 显示全部。
 * 标签集合来自 api/workspaceLabels.ts 的全量拉取，覆盖整个 workspace。
 *
 * A11Y-TABNOISE：roving tabindex —— 整条 chip 组只保留 1 个 Tab 停靠点（最近聚焦/默认首项），
 * 进入后用 ←/→/↑/↓/Home/End 在 chip 间移动；Space/Enter 仍是原生 button 的选中行为，
 * aria-pressed 与鼠标点击语义不变。「清除筛选」是独立操作，仍是单独 1 个 Tab 停靠点。
 */
import { useRef, useState, type KeyboardEvent } from 'react';
import { NO_SELECTED_LABELS, useAppStore } from '../../state/appStore';
import { useWorkspaceLabels } from '../../api/workspaceLabels';

export function LabelFilterBar({ workspaceId }: { workspaceId: string }) {
  const labels = useWorkspaceLabels(workspaceId);
  const selected = useAppStore((s) => s.selectedLabelsByWorkspace[workspaceId] ?? NO_SELECTED_LABELS);
  const toggleLabel = useAppStore((s) => s.toggleLabel);
  const clearLabels = useAppStore((s) => s.clearLabels);

  // roving tabindex：只让 activeIndex 对应的 chip 进入 Tab 序
  const [rovingIndex, setRovingIndex] = useState(0);
  const chipRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const activeIndex = labels.length === 0 ? 0 : Math.min(rovingIndex, labels.length - 1);

  function focusChip(index: number) {
    const clamped = Math.max(0, Math.min(labels.length - 1, index));
    setRovingIndex(clamped);
    chipRefs.current[clamped]?.focus();
  }

  function handleChipKeyDown(event: KeyboardEvent<HTMLButtonElement>, index: number) {
    switch (event.key) {
      case 'ArrowRight':
      case 'ArrowDown':
        event.preventDefault();
        focusChip(index + 1);
        break;
      case 'ArrowLeft':
      case 'ArrowUp':
        event.preventDefault();
        focusChip(index - 1);
        break;
      case 'Home':
        event.preventDefault();
        focusChip(0);
        break;
      case 'End':
        event.preventDefault();
        focusChip(labels.length - 1);
        break;
      default:
        break;
    }
  }

  return (
    // 标签数量可能很多：单行横向滚动，保证不被撑高。
    // 固定独占工具栏第二行（宽度随容器自适应），不再与切换按钮/搜索框抢同一行。
    <div data-testid="label-filter-bar" className="w-full min-w-0 overflow-x-auto">
      <div role="toolbar" aria-label="标签筛选" className="flex w-max items-center gap-1">
        {labels.map((label, index) => {
          const active = selected.includes(label);
          return (
            <button
              key={label}
              ref={(el) => { chipRefs.current[index] = el; }}
              type="button"
              tabIndex={index === activeIndex ? 0 : -1}
              aria-pressed={active}
              data-testid={`label-filter-${label}`}
              title={active ? `取消标签筛选：${label}` : `按标签筛选：${label}`}
              onFocus={() => setRovingIndex(index)}
              onKeyDown={(event) => handleChipKeyDown(event, index)}
              onClick={() => toggleLabel(workspaceId, label)}
              data-active={active ? 'true' : 'false'}
              // A2：点击反馈只走颜色过渡（无位移/缩放），reduced-motion 下即时
              className={`shrink-0 whitespace-nowrap rounded px-2 py-0.5 text-xs transition-colors duration-150 motion-reduce:transition-none focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent ${active
                ? 'bg-accent-soft font-medium text-accent active:bg-accent-soft dark:bg-accent-soft dark:text-accent dark:active:bg-accent-soft'
                : 'border border-hairline text-ink-2 hover:bg-surface-raised active:bg-neutral-200    '}`}
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
            className="shrink-0 whitespace-nowrap rounded px-2 py-0.5 text-xs text-ink-3 transition-colors duration-150 hover:bg-surface-raised active:bg-neutral-200 motion-reduce:transition-none"
          >
            清除筛选
          </button>
        )}
      </div>
    </div>
  );
}
