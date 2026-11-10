/**
 * 两段式选择（BORROW-1.1）纯逻辑：先选范围，再选卡片。
 * 范围只是「哪些卡可被勾选 / 全选作用域」，不改变看板渲染；服务端契约不变。
 * 借鉴方案原文 T1.1/T1.2 不可得，这里按卡面语义落最小实现。
 */
import type { Issue } from '@agentboard/shared';

export type SelectionScope =
  | { kind: 'board' }
  | { kind: 'column'; status: string };

export function scopeLabel(scope: SelectionScope): string {
  return scope.kind === 'board' ? '整个看板' : `列：${scope.status}`;
}

/** 该卡是否落在当前选择范围（范围未选时为 false，避免第一段就能勾卡） */
export function issueInScope(scope: SelectionScope | null, issue: Issue): boolean {
  if (scope === null) return false;
  return scope.kind === 'board' || issue.status === scope.status;
}

export function idsInScope(issues: readonly Issue[], scope: SelectionScope | null): string[] {
  if (scope === null) return [];
  return issues.filter((issue) => issueInScope(scope, issue)).map((issue) => issue.id);
}

/** 勾选/取消勾选；范围外的卡不进入选择集合 */
export function toggleSelected(
  selected: ReadonlySet<string>,
  id: string,
  inScope: boolean,
): Set<string> {
  const next = new Set(selected);
  if (!inScope) return next;
  if (next.has(id)) next.delete(id);
  else next.add(id);
  return next;
}

/** 全选作用于当前范围；再点一次清空 */
export function toggleSelectAll(selected: ReadonlySet<string>, scopeIds: readonly string[]): Set<string> {
  const allSelected = scopeIds.length > 0 && scopeIds.every((id) => selected.has(id));
  return allSelected ? new Set() : new Set(scopeIds);
}

/**
 * 列头整列 toggle：只增删本列 id —— 本列已全选时清空本列，否则补齐本列。
 * 其它列的已选 id 原样保留，保证列间互不影响。
 */
export function toggleColumnSelected(
  selected: ReadonlySet<string>,
  columnIds: readonly string[],
): Set<string> {
  const next = new Set(selected);
  const allSelected = columnIds.length > 0 && columnIds.every((id) => next.has(id));
  for (const id of columnIds) {
    if (allSelected) next.delete(id);
    else next.add(id);
  }
  return next;
}

/** 筛选出仍在看板上的已选 id（数据刷新/筛选变化后避免幽灵选择） */
export function pruneSelection(selected: ReadonlySet<string>, issues: readonly Issue[]): Set<string> {
  const alive = new Set(issues.map((issue) => issue.id));
  return new Set([...selected].filter((id) => alive.has(id)));
}
