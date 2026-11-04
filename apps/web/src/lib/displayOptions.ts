/**
 * 看板显示偏好（BORROW-1.1）：密度 + 分组，仅本地持久化，不改服务端契约。
 * 借鉴方案原文 T1.1/T1.2 在本工作区不可得；这里按卡面语义落最小实现：
 * - 密度：舒适 / 紧凑（影响卡片内边距与列内间距）。
 * - 分组：不分组 / 按标签（列内按首个标签分组；分组显示时禁用拖拽排序，
 *   因为视觉顺序不再等于 sort_order，继续拖会写出错误顺序）。
 */
import type { Issue } from '@agentboard/shared';

export type BoardDensity = 'comfortable' | 'compact';
export type BoardGrouping = 'none' | 'label';

export interface DisplayOptions {
  density: BoardDensity;
  grouping: BoardGrouping;
}

export const DEFAULT_DISPLAY_OPTIONS: DisplayOptions = { density: 'comfortable', grouping: 'none' };

const STORAGE_KEY = 'agentboard.board.displayOptions.v1';

export function parseDisplayOptions(raw: string | null): DisplayOptions {
  if (raw === null) return DEFAULT_DISPLAY_OPTIONS;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null) return DEFAULT_DISPLAY_OPTIONS;
    const density = (parsed as { density?: unknown }).density;
    const grouping = (parsed as { grouping?: unknown }).grouping;
    return {
      density: density === 'compact' ? 'compact' : 'comfortable',
      grouping: grouping === 'label' ? 'label' : 'none',
    };
  } catch {
    return DEFAULT_DISPLAY_OPTIONS;
  }
}

export function readDisplayOptions(storage: Pick<Storage, 'getItem'> | null = globalThis.localStorage ?? null): DisplayOptions {
  return parseDisplayOptions(storage?.getItem(STORAGE_KEY) ?? null);
}

export function writeDisplayOptions(
  options: DisplayOptions,
  storage: Pick<Storage, 'setItem'> | null = globalThis.localStorage ?? null,
): void {
  storage?.setItem(STORAGE_KEY, JSON.stringify(options));
}

export interface DisplayGroup {
  key: string;
  label: string;
  issues: Issue[];
}

/** 列内分组：按首个标签；无标签归「未分类」。组顺序按首次出现，组内保持原顺序。 */
export function groupIssuesForDisplay(issues: Issue[], grouping: BoardGrouping): DisplayGroup[] | null {
  if (grouping === 'none') return null;
  const groups = new Map<string, DisplayGroup>();
  for (const issue of issues) {
    const label = issue.labels[0]?.trim() || '未分类';
    const existing = groups.get(label);
    if (existing) existing.issues.push(issue);
    else groups.set(label, { key: label, label, issues: [issue] });
  }
  return [...groups.values()];
}
