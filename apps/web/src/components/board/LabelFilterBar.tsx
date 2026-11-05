/**
 * 顶栏标签筛选条（UI-FILTER01 / LABEL-BAR）：平铺看板 / 任务树顶栏展示当前工作空间标签，
 * 点击 toggle 多选；多选按 OR 匹配（命中任一选中标签即显示），未选任何标签 = 显示全部。
 * 标签集合来自 api/workspaceLabels.ts 的全量拉取，覆盖整个 workspace。
 *
 * LABEL-BAR：标签数量大时默认只展示前 MAX_VISIBLE 个（桌面端两行封顶，窄屏保持换行不裁切），
 * 其余收进「更多 +N」浮层（含过滤输入框，可连续多选）。排序：已选中置顶（保持标签原序、
 * 不按点击先后），其余按出现频次降序，同频按名称大小写不敏感字母序。
 *
 * A11Y-TABNOISE：roving tabindex —— 可见 chip 组只保留 1 个 Tab 停靠点（最近聚焦/默认首项），
 * 进入后用 ←/→/↑/↓/Home/End 在 chip 间移动；Space/Enter 仍是原生 button 的选中行为，
 * aria-pressed 与鼠标点击语义不变。「更多」「清除筛选」是独立操作，各自 1 个 Tab 停靠点。
 */
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { NO_SELECTED_LABELS, useAppStore } from '../../state/appStore';
import { useWorkspaceLabelCounts, useWorkspaceLabels } from '../../api/workspaceLabels';

/** 默认最多展示的 chip 数（桌面端两行内）；需要改展示密度只改这一个常量。 */
const MAX_VISIBLE = 14;

/** 桌面端两行封顶的测量阈值：视口更窄时保持现有换行行为，避免 chip 被裁切。 */
const ROW_CLAMP_MIN_VIEWPORT = 900;

function chipClassName(active: boolean): string {
  // A2：点击反馈只走颜色过渡（无位移/缩放），reduced-motion 下即时
  const base = 'shrink-0 whitespace-nowrap rounded px-2 py-0.5 text-xs transition-colors duration-150 motion-reduce:transition-none focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent ';
  return active
    ? `${base}bg-accent-soft font-medium text-accent active:bg-accent-soft dark:bg-accent-soft dark:text-accent dark:active:bg-accent-soft`
    : `${base}border border-hairline text-ink-2 hover:bg-surface-raised active:bg-neutral-200    `;
}

export function LabelFilterBar({ workspaceId }: { workspaceId: string }) {
  const labels = useWorkspaceLabels(workspaceId);
  const counts = useWorkspaceLabelCounts(workspaceId);
  const selected = useAppStore((s) => s.selectedLabelsByWorkspace[workspaceId] ?? NO_SELECTED_LABELS);
  const toggleLabel = useAppStore((s) => s.toggleLabel);
  const clearLabels = useAppStore((s) => s.clearLabels);

  // roving tabindex：只让 activeIndex 对应的 chip 进入 Tab 序
  const [rovingIndex, setRovingIndex] = useState(0);
  const [moreOpen, setMoreOpen] = useState(false);
  const [filterText, setFilterText] = useState('');
  // 打开浮层时冻结「未显示标签」快照：浮层内选中后条目不会因重排而消失，支持连续多选/取消
  const [moreItems, setMoreItems] = useState<string[]>([]);
  const [placeAbove, setPlaceAbove] = useState(false);
  // 桌面端两行封顶时实际可展示的数量（由布局测量收敛；窄屏恒为 MAX_VISIBLE）
  const [rowLimit, setRowLimit] = useState(MAX_VISIBLE);

  // 已选中置顶：保持标签原序（不按点击先后）；其余按频次降序，同频按名称大小写不敏感字母序
  const orderedLabels = useMemo(() => {
    const selectedFirst = labels.filter((label) => selected.includes(label));
    const rest = labels
      .filter((label) => !selected.includes(label))
      .sort((a, b) => {
        const delta = (counts.get(b) ?? 0) - (counts.get(a) ?? 0);
        if (delta !== 0) return delta;
        return a.localeCompare(b, 'zh-Hans-CN', { sensitivity: 'base' });
      });
    return [...selectedFirst, ...rest];
  }, [labels, counts, selected]);

  const limit = Math.min(MAX_VISIBLE, rowLimit);
  const visibleLabels = orderedLabels.slice(0, limit);
  const hiddenLabels = orderedLabels.slice(visibleLabels.length);

  const chipRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const barRef = useRef<HTMLDivElement | null>(null);
  const moreButtonRef = useRef<HTMLButtonElement | null>(null);
  const panelRef = useRef<HTMLDivElement | null>(null);
  const filterInputRef = useRef<HTMLInputElement | null>(null);

  const activeIndex = visibleLabels.length === 0 ? 0 : Math.min(rovingIndex, visibleLabels.length - 1);

  const closeMore = useCallback((restoreFocus: boolean): void => {
    setMoreOpen(false);
    setFilterText('');
    setMoreItems([]);
    if (restoreFocus) moreButtonRef.current?.focus();
  }, []);

  // 桌面端：14 个 chip 在中等宽度下可能占三行 —— 按实际布局收缩到两行，超出部分进浮层
  useLayoutEffect(() => {
    if (typeof window === 'undefined' || window.innerWidth <= ROW_CLAMP_MIN_VIEWPORT) {
      setRowLimit((prev) => (prev === MAX_VISIBLE ? prev : MAX_VISIBLE));
      return;
    }
    const shown = Math.min(MAX_VISIBLE, rowLimit);
    const tops = chipRefs.current
      .slice(0, shown)
      .map((el) => (el === null ? null : Math.round(el.getBoundingClientRect().top)));
    const rows = [...new Set(tops.filter((top): top is number => top !== null))].sort((a, b) => a - b);
    if (rows.length <= 2) return;
    const thirdRowTop = rows[2];
    const cutIndex = tops.findIndex((top) => top === thirdRowTop);
    if (cutIndex > 0) setRowLimit((prev) => Math.min(prev, cutIndex));
  }, [orderedLabels, rowLimit]);

  // 宽度变化（窗口缩放 / 侧栏开合）后重新测量，允许恢复到 MAX_VISIBLE 再收敛
  useLayoutEffect(() => {
    if (typeof ResizeObserver === 'undefined') return;
    const el = barRef.current;
    if (el === null) return;
    let lastWidth = el.getBoundingClientRect().width;
    const observer = new ResizeObserver((entries) => {
      const width = entries[0]?.contentRect.width ?? lastWidth;
      if (Math.abs(width - lastWidth) > 1) {
        lastWidth = width;
        setRowLimit(MAX_VISIBLE);
      }
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  // 浮层打开时：Esc / 点击外部关闭；Esc 关闭后焦点回到「更多」按钮
  useEffect(() => {
    if (!moreOpen) return;
    const onKeyDown = (event: globalThis.KeyboardEvent): void => {
      if (event.key === 'Escape') {
        event.stopPropagation();
        closeMore(true);
      }
    };
    const onMouseDown = (event: MouseEvent): void => {
      const target = event.target as Node | null;
      if (target === null) return;
      if (panelRef.current?.contains(target) || moreButtonRef.current?.contains(target)) return;
      closeMore(false);
    };
    document.addEventListener('keydown', onKeyDown);
    document.addEventListener('mousedown', onMouseDown);
    return () => {
      document.removeEventListener('keydown', onKeyDown);
      document.removeEventListener('mousedown', onMouseDown);
    };
  }, [moreOpen, closeMore]);

  // 浮层内过滤框自动聚焦，键盘可直接输入
  useEffect(() => {
    if (moreOpen) filterInputRef.current?.focus();
  }, [moreOpen]);

  function openMore(): void {
    const rect = moreButtonRef.current?.getBoundingClientRect();
    const spaceBelow = rect === undefined ? Number.POSITIVE_INFINITY : window.innerHeight - rect.bottom;
    setPlaceAbove(spaceBelow < 320 && (rect?.top ?? 0) > spaceBelow);
    setMoreItems(hiddenLabels);
    setFilterText('');
    setMoreOpen(true);
  }

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

  const filteredMoreItems = moreItems.filter((label) =>
    label.toLocaleLowerCase('zh-Hans-CN').includes(filterText.trim().toLocaleLowerCase('zh-Hans-CN')),
  );

  const moreCount = hiddenLabels.length;

  return (
    // 标签数量可能很多：默认两行封顶；<=900px 保持换行，避免 chip 被裁
    <div data-testid="label-filter-bar" className="w-full min-w-0">
      <div ref={barRef} role="toolbar" aria-label="标签筛选" className="flex flex-wrap items-center gap-1">
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
              className={chipClassName(active)}
            >
              {label}
            </button>
          );
        })}
        {moreCount > 0 && (
          <div className="relative shrink-0">
            <button
              ref={moreButtonRef}
              type="button"
              data-testid="label-filter-more"
              aria-expanded={moreOpen}
              aria-haspopup="dialog"
              onClick={() => (moreOpen ? closeMore(true) : openMore())}
              className="shrink-0 whitespace-nowrap rounded border border-hairline px-2 py-0.5 text-xs text-ink-2 transition-colors duration-[160ms] ease-[cubic-bezier(0.2,0,0,1)] hover:bg-surface-raised active:bg-neutral-200 motion-reduce:transition-none"
            >
              {moreOpen ? '收起' : `更多 +${moreCount}`}
            </button>
            {moreOpen && (
              <div
                ref={panelRef}
                role="dialog"
                aria-label="更多标签"
                data-testid="label-filter-more-panel"
                className={`absolute z-50 w-72 max-w-[calc(100vw-2rem)] rounded-lg border border-hairline bg-surface-card shadow-lg transition-opacity duration-[160ms] ease-[cubic-bezier(0.2,0,0,1)] motion-reduce:transition-none ${placeAbove ? 'bottom-full mb-1' : 'top-full mt-1'}`}
              >
                <div className="border-b border-hairline p-2">
                  <input
                    ref={filterInputRef}
                    aria-label="过滤标签"
                    data-testid="label-filter-more-filter"
                    value={filterText}
                    onChange={(event) => setFilterText(event.target.value)}
                    placeholder="过滤标签"
                    className="h-7 w-full rounded border border-hairline bg-surface-raised px-2 text-xs text-ink outline-none focus:border-accent"
                  />
                </div>
                <div className="flex max-h-64 flex-wrap gap-1 overflow-y-auto p-2">
                  {filteredMoreItems.map((label) => {
                    const active = selected.includes(label);
                    return (
                      <button
                        key={label}
                        type="button"
                        aria-pressed={active}
                        data-active={active ? 'true' : 'false'}
                        data-testid={`label-filter-more-item-${label}`}
                        title={active ? `取消标签筛选：${label}` : `按标签筛选：${label}`}
                        // 浮层不自动关闭：支持连续多选
                        onClick={() => toggleLabel(workspaceId, label)}
                        className={chipClassName(active)}
                      >
                        {active ? `✓ ${label}` : label}
                      </button>
                    );
                  })}
                  {filteredMoreItems.length === 0 && (
                    <span className="px-1 py-1 text-xs text-ink-3">没有匹配的标签</span>
                  )}
                </div>
                <div className="border-t border-hairline px-2 py-1 text-[11px] text-ink-3">
                  共 {moreItems.length} 个未显示标签 · Esc 关闭
                </div>
              </div>
            )}
          </div>
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
