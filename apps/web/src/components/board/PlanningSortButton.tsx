/**
 * 待规划列排序按钮（SORT-ICON）。
 *
 * 位置：列头「待规划 +」右侧，单个图标按钮，无文字；点击按固定顺序循环切换，写既有
 * `localStorage['agentboard.planning-sort']`（排序算法本身在 lib/planningSort.ts，本组件只切模式）。
 *
 * 循环顺序：组合 → 截止日期 → 优先级 → A-Z → Z-A → 创建时间 → 组合…
 *
 * 图标用内联 SVG（6 个模式各一个），不用 emoji、不引入图标库。
 * 可达性：原生 button（Tab 聚焦、Enter/Space 触发）+ `aria-label` 描述当前模式与下一档，`title` 显示当前模式中文名。
 */
import type { PlanningSort } from '../../lib/planningSort';
import { PLANNING_SORT_OPTIONS } from '../../lib/planningSort';

/** 固定循环顺序（顺序调整只改这一行） */
export const PLANNING_SORT_CYCLE: readonly PlanningSort[] = ['combo', 'due', 'priority', 'az', 'za', 'created'];

export function nextPlanningSort(current: PlanningSort): PlanningSort {
  const index = PLANNING_SORT_CYCLE.indexOf(current);
  if (index < 0) return PLANNING_SORT_CYCLE[0] ?? 'combo';
  return PLANNING_SORT_CYCLE[(index + 1) % PLANNING_SORT_CYCLE.length] ?? 'combo';
}

export function planningSortLabel(sort: PlanningSort): string {
  return PLANNING_SORT_OPTIONS.find((option) => option.id === sort)?.label ?? sort;
}

const ICON_PATHS: Record<PlanningSort, string> = {
  // 组合：加权堆叠的横线（越靠上权重越大）
  combo: 'M2 4h10M2 8h7M2 12h4',
  // 截止日期：日历
  due: 'M3 3h8v9H3zM3 6h8M5.5 2v2M8.5 2v2',
  // 优先级：flag
  priority: 'M4 2v11M4 3h7l-2 2.5L9 8H4',
  // A-Z：升序箭头 + A
  az: 'M3 12l3-8 3 8M4 9.5h4M11 4h3l-3 8h3',
  // Z-A：降序箭头 + Z
  za: 'M3 4h4L3 11h4M11 4l2 3-2 3',
  // 创建时间：时钟
  created: 'M7 2a5 5 0 1 0 0 10a5 5 0 0 0 0-10M7 4v3l2 1',
};

function SortIcon({ sort }: { sort: PlanningSort }) {
  return (
    <svg
      data-testid={`planning-sort-icon-${sort}`}
      aria-hidden="true"
      viewBox="0 0 14 14"
      width="14"
      height="14"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.4"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d={ICON_PATHS[sort]} />
    </svg>
  );
}

export function PlanningSortButton({
  sort,
  onChange,
}: {
  sort: PlanningSort;
  onChange: (next: PlanningSort) => void;
}) {
  const label = planningSortLabel(sort);
  const next = nextPlanningSort(sort);
  const nextLabel = planningSortLabel(next);
  return (
    <button
      type="button"
      data-testid="planning-sort"
      data-sort={sort}
      aria-label={`待规划排序：${label}（点击切换为${nextLabel}）`}
      title={`排序：${label}`}
      onClick={() => onChange(next)}
      className="inline-flex h-5 items-center rounded px-1 text-ink-3 hover:bg-surface-card hover:text-accent focus-visible:outline-2 focus-visible:outline-accent"
    >
      <SortIcon sort={sort} />
    </button>
  );
}
