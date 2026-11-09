/**
 * 「待规划」列排序（SORT-PLAN / design §5）。
 *
 * 六种：A-Z / Z-A / 截止日期 / 优先级 / 创建时间 / 组合（默认）。纯函数，不依赖 React 状态；
 * 选择结果由调用方写 localStorage（不落库）。只用于「待规划」列，其它列保持 sort_order 顺序。
 *
 * 组合权重：优先级 高30/中20/低10；紧迫度 逾期+50 / ≤3天+30 / ≤7天+15 / >7天+5 / 无截止0；
 * score 降序，同分按 created_at 升序（老的在前，防止老卡被无限推后）。
 * 截止字段（due_date/due_time）由 STATUS-1 迁移引入、可能尚未上线，按可选读取：缺失一律视为「无截止」。
 */
import type { Issue, Priority } from '@agentboard/shared';

export type PlanningSort = 'az' | 'za' | 'due' | 'priority' | 'created' | 'combo';

export const PLANNING_SORT_OPTIONS: ReadonlyArray<{ id: PlanningSort; label: string }> = [
  { id: 'az', label: 'A-Z' },
  { id: 'za', label: 'Z-A' },
  { id: 'due', label: '截止日期' },
  { id: 'priority', label: '优先级' },
  { id: 'created', label: '创建时间' },
  { id: 'combo', label: '组合' },
];

export const DEFAULT_PLANNING_SORT: PlanningSort = 'combo';
export const PLANNING_SORT_KEY = 'agentboard.planning-sort';

const DAY = 24 * 60 * 60 * 1000;

export const PRIORITY_SCORE: Record<Priority, number> = { 高: 30, 中: 20, 低: 10 };

export const URGENCY_SCORE = { overdue: 50, within3Days: 30, within7Days: 15, later: 5, none: 0 } as const;

function isPlanningSort(value: unknown): value is PlanningSort {
  return typeof value === 'string' && PLANNING_SORT_OPTIONS.some((option) => option.id === value);
}

/** 读取持久化的排序方式；localStorage 不可用或值非法时回落默认「组合」 */
export function readPlanningSort(): PlanningSort {
  try {
    const raw = window.localStorage.getItem(PLANNING_SORT_KEY);
    return isPlanningSort(raw) ? raw : DEFAULT_PLANNING_SORT;
  } catch {
    return DEFAULT_PLANNING_SORT;
  }
}

export function writePlanningSort(sort: PlanningSort): void {
  try {
    window.localStorage.setItem(PLANNING_SORT_KEY, sort);
  } catch {
    // localStorage 不可用（隐私模式等）：仅本次会话生效
  }
}

/**
 * 截止时间戳：`due_date`（YYYY-MM-DD）+ 可选 `due_time`（HH:mm）按本地时区合成。
 * 无日期 / 日期格式非法 → null（视为无截止，不构造非法 Date）。
 * 无时间时按当天 00:00 作为排序点（design §5）。
 */
export function dueTimestamp(issue: Pick<Issue, 'due_date' | 'due_time'>): number | null {
  const date = issue.due_date;
  if (typeof date !== 'string') return null;
  const dateMatch = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (dateMatch === null) return null;
  const time = issue.due_time;
  const timeMatch = typeof time === 'string' ? /^(\d{2}):(\d{2})$/.exec(time) : null;
  const hours = timeMatch === null ? 0 : Number(timeMatch[1]);
  const minutes = timeMatch === null ? 0 : Number(timeMatch[2]);
  const stamp = new Date(
    Number(dateMatch[1]),
    Number(dateMatch[2]) - 1,
    Number(dateMatch[3]),
    hours,
    minutes,
    0,
    0,
  ).getTime();
  return Number.isNaN(stamp) ? null : stamp;
}

/** 逾期：有时间按时间点比较；无时间则当天整天有效，过了当天才算逾期 */
export function isOverdue(issue: Pick<Issue, 'due_date' | 'due_time'>, now: number): boolean {
  const stamp = dueTimestamp(issue);
  if (stamp === null) return false;
  return typeof issue.due_time === 'string' ? stamp < now : stamp + DAY <= now;
}

/** 紧迫度分：逾期 50 / ≤3天 30 / ≤7天 15 / >7天 5 / 无截止 0 */
/**
 * 截止展示（DUE-DATE）：卡片用短格式 `11-10` / `11-10 14:30`；无截止返回 null。
 * 缺失字段按「无截止」处理（服务端未上线时的可选读取）。
 */
export function formatDueShort(issue: Pick<Issue, 'due_date' | 'due_time'>): string | null {
  const date = issue.due_date;
  if (typeof date !== 'string' || date.length < 10) return null;
  const short = `${date.slice(5, 7)}-${date.slice(8, 10)}`;
  const time = issue.due_time;
  return typeof time === 'string' && time !== '' ? `${short} ${time}` : short;
}

/**
 * 逾期天数（DUE-DATE）：未逾期返回 0；逾期返回至少 1（当天时间已过 = 1 天）。
 * 与 `isOverdue` 同源（含「有 time 比到分钟、无 time 比到当天 24:00」的口径）。
 */
export function overdueDays(issue: Pick<Issue, 'due_date' | 'due_time'>, now: number): number {
  if (!isOverdue(issue, now)) return 0;
  const stamp = dueTimestamp(issue);
  if (stamp === null) return 0;
  // 无时间时当天 24:00 才失效，所以逾期天数从「有效截止时刻」起算
  const deadline = typeof issue.due_time === 'string' && issue.due_time !== '' ? stamp : stamp + DAY;
  return Math.max(1, Math.ceil((now - deadline) / DAY));
}

export function urgencyScore(issue: Pick<Issue, 'due_date' | 'due_time'>, now: number): number {
  const stamp = dueTimestamp(issue);
  if (stamp === null) return URGENCY_SCORE.none;
  if (isOverdue(issue, now)) return URGENCY_SCORE.overdue;
  const days = Math.ceil((stamp - now) / DAY);
  if (days <= 3) return URGENCY_SCORE.within3Days;
  if (days <= 7) return URGENCY_SCORE.within7Days;
  return URGENCY_SCORE.later;
}

/** 组合分 = 优先级分 + 紧迫度分 */
export function comboScore(issue: Pick<Issue, 'due_date' | 'due_time' | 'priority'>, now: number): number {
  return (PRIORITY_SCORE[issue.priority] ?? 0) + urgencyScore(issue, now);
}

/** 标题比较：不分大小写，中文按 zh 排序规则 */
export function compareTitle(left: string, right: string): number {
  return left.localeCompare(right, 'zh', { sensitivity: 'base' });
}

/** 同分兜底与创建时间排序：创建时间升序，再按 id 保证稳定 */
export function byCreatedAtThenId(
  left: Pick<Issue, 'created_at' | 'id'>,
  right: Pick<Issue, 'created_at' | 'id'>,
): number {
  if (left.created_at !== right.created_at) return left.created_at - right.created_at;
  return left.id.localeCompare(right.id);
}

/**
 * 按指定方式排序「待规划」列的卡片。不修改入参。
 * @param now 判定紧迫度的时间基准（测试注入固定值）
 */
export function sortPlanning(issues: readonly Issue[], sort: PlanningSort, now: number = Date.now()): Issue[] {
  const list = [...issues];
  switch (sort) {
    case 'az':
      return list.sort((left, right) => compareTitle(left.title, right.title) || byCreatedAtThenId(left, right));
    case 'za':
      return list.sort((left, right) => compareTitle(right.title, left.title) || byCreatedAtThenId(left, right));
    case 'due':
      return list.sort((left, right) => {
        const leftDue = dueTimestamp(left);
        const rightDue = dueTimestamp(right);
        if (leftDue === null && rightDue === null) return byCreatedAtThenId(left, right);
        // 无截止排最后
        if (leftDue === null) return 1;
        if (rightDue === null) return -1;
        if (leftDue !== rightDue) return leftDue - rightDue;
        return byCreatedAtThenId(left, right);
      });
    case 'priority':
      return list.sort((left, right) => {
        const delta = (PRIORITY_SCORE[right.priority] ?? 0) - (PRIORITY_SCORE[left.priority] ?? 0);
        return delta !== 0 ? delta : byCreatedAtThenId(left, right);
      });
    case 'created':
      return list.sort(byCreatedAtThenId);
    case 'combo':
    default:
      return list.sort((left, right) => {
        const delta = comboScore(right, now) - comboScore(left, now);
        return delta !== 0 ? delta : byCreatedAtThenId(left, right);
      });
  }
}
