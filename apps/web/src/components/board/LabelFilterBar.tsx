/**
 * 顶栏标签筛选条（UI-FILTER01）：平铺看板 / 任务树切换区中间展示当前工作空间全部已有标签，
 * 点击 toggle 多选；多选按 OR 匹配（命中任一选中标签即显示），未选任何标签 = 显示全部。
 * 标签集合来自 api/workspaceLabels.ts 的全量拉取，覆盖整个 workspace。
 *
 * A11Y-TABNOISE：roving tabindex —— 整条 chip 组只保留 1 个 Tab 停靠点（最近聚焦/默认首项），
 * 进入后用 ←/→/↑/↓/Home/End 在 chip 间移动；Space/Enter 仍是原生 button 的选中行为，
 * aria-pressed 与鼠标点击语义不变。「清除筛选」是独立操作，仍是单独 1 个 Tab 停靠点。
 */
import { useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { NO_SELECTED_LABELS, useAppStore } from '../../state/appStore';
import { useWorkspaceLabels } from '../../api/workspaceLabels';

export function LabelFilterBar({ workspaceId }: { workspaceId: string }) {
  const labels = useWorkspaceLabels(workspaceId);
  const selected = useAppStore((s) => s.selectedLabelsByWorkspace[workspaceId] ?? NO_SELECTED_LABELS);
  const toggleLabel = useAppStore((s) => s.toggleLabel);
  const clearLabels = useAppStore((s) => s.clearLabels);

  // roving tabindex：只让 activeIndex 对应的 chip 进入 Tab 序
  const [rovingIndex, setRovingIndex] = useState(0);
  // AUDIT-BOARD（I-07）：选中标签置顶；其余标签收进「更多标签」，避免一条拥挤的横滚条
  const [moreOpen, setMoreOpen] = useState(false);
  // 选中态下按「已选在前、未选在后」重排；无选中时保持原顺序（默认全部可见）
  const orderedLabels = useMemo(() => {
    if (selected.length === 0) return labels;
    return [...labels.filter((label) => selected.includes(label)), ...labels.filter((label) => !selected.includes(label))];
  }, [labels, selected]);
  const folded = selected.length > 0 && !moreOpen;
  const visibleLabels = folded ? orderedLabels.filter((label) => selected.includes(label)) : orderedLabels;
  const chipRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const activeIndex = visibleLabels.length === 0 ? 0 : Math.min(rovingIndex, visibleLabels.length - 1);

  function focusChip(index: number) {
    const clamped = Math.max(0, Math.min(visibleLabels.length - 1, index));
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
        focusChip(visibleLabels.length - 1);
        break;
      default:
        break;
    }
  }

  return (
    // 标签数量可能很多：flex-wrap 换行而不是横向滚动，900 宽下也不截断（AUDIT-BOARD I-07）
    <div data-testid="label-filter-bar" className="w-full min-w-0">
      <div role="toolbar" aria-label="标签筛选" className="flex flex-wrap items-center gap-1">
        {selected.length > 0 && (
          <span
            data-testid="label-filter-selected-count"
            className="shrink-0 whitespace-nowrap rounded bg-accent-soft px-2 py-0.5 text-xs font-medium text-accent"
          >
            已选 {selected.length}
          </span>
        )}
        {visibleLabels.map((label, index) => {
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
        {selected.length > 0 && labels.length > selected.length && (
          <button
            type="button"
            data-testid="label-filter-more"
            aria-expanded={moreOpen}
            onClick={() => setMoreOpen((open) => !open)}
            className="shrink-0 whitespace-nowrap rounded border border-hairline px-2 py-0.5 text-xs text-ink-3 transition-colors duration-150 hover:bg-surface-raised active:bg-neutral-200 motion-reduce:transition-none"
          >
            {moreOpen ? '收起标签' : `更多标签（${labels.length - selected.length}）`}
          </button>
        )}
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
