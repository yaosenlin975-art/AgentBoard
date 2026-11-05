import type { Issue, IssueStatus, IssueTreeItem } from '@agentboard/shared';

export interface IssueTreeFilter {
  active: boolean;
  visibleIds: ReadonlySet<string>;
  matchingIds: ReadonlySet<string>;
  autoExpandedIds: ReadonlySet<string>;
  visibleChildrenByParent: ReadonlyMap<string | null, ReadonlySet<string>>;
}

export function buildIssueTreeFilter(
  issues: Issue[],
  status: IssueStatus | 'all',
  query: string,
  labels: readonly string[] = [],
): IssueTreeFilter {
  const normalizedQuery = query.trim().toLocaleLowerCase();
  const selectedLabels = new Set(labels);
  const active = status !== 'all' || normalizedQuery !== '' || selectedLabels.size > 0;
  const byId = new Map(issues.map((issue) => [issue.id, issue]));
  const matchingIds = new Set(
    issues
      .filter((issue) => (status === 'all' || issue.status === status)
        && (normalizedQuery === '' || [issue.title, issue.description, ...issue.labels].join('\n').toLocaleLowerCase().includes(normalizedQuery))
        && (selectedLabels.size === 0 || issue.labels.some((label) => selectedLabels.has(label))))
      .map((issue) => issue.id),
  );
  const visibleIds = new Set(matchingIds);
  const autoExpandedIds = new Set<string>();

  if (active) {
    for (const matchId of matchingIds) {
      let parentId = byId.get(matchId)?.parent_issue_id ?? null;
      const visited = new Set([matchId]);
      while (parentId !== null) {
        if (visited.has(parentId)) break;
        visited.add(parentId);
        visibleIds.add(parentId);
        autoExpandedIds.add(parentId);
        parentId = byId.get(parentId)?.parent_issue_id ?? null;
      }
    }
  }

  const visibleChildrenByParent = new Map<string | null, Set<string>>();
  for (const issue of issues) {
    if (!visibleIds.has(issue.id)) continue;
    const children = visibleChildrenByParent.get(issue.parent_issue_id) ?? new Set<string>();
    children.add(issue.id);
    visibleChildrenByParent.set(issue.parent_issue_id, children);
  }

  return { active, visibleIds, matchingIds, autoExpandedIds, visibleChildrenByParent };
}

/**
 * 任务树同级排序（TREE-SORT-CHILD）：仅在状态筛选为「全部状态」时启用。
 * 直接子节点数（服务端 child_count）降序；数量相同时 updated_at 降序，再按 id 升序保证稳定。
 * 只在已加载页内排序（每层每页 50 条），不额外拉取全量。
 */
export function sortTreeItemsByChildCount(items: readonly IssueTreeItem[]): IssueTreeItem[] {
  return [...items].sort((left, right) => (
    right.child_count - left.child_count
    || right.updated_at - left.updated_at
    || (left.id < right.id ? -1 : left.id > right.id ? 1 : 0)
  ));
}

/** 任务树「隐藏无子任务」开关的 localStorage 键。 */
export const TREE_HIDE_LEAF_STORAGE_KEY = 'agentboard.taskTree.hideLeaf';

/** 读取开关状态；存储不可用（禁用/抛错）时静默回落 false。 */
export function readTreeHideLeaf(): boolean {
  try {
    return window.localStorage.getItem(TREE_HIDE_LEAF_STORAGE_KEY) === '1';
  } catch {
    return false;
  }
}

/** 写入开关状态；存储不可用时静默回落，不影响当次会话内的显隐。 */
export function writeTreeHideLeaf(hideLeaf: boolean): void {
  try {
    window.localStorage.setItem(TREE_HIDE_LEAF_STORAGE_KEY, hideLeaf ? '1' : '0');
  } catch {
    // 存储不可用：忽略，仅本次会话内生效
  }
}

/** 过滤出有直接子节点的任务（TREE-HIDE-LEAF）；判定只用服务端 child_count，与状态筛选正交。 */
export function filterTreeItemsWithChildren(items: readonly IssueTreeItem[]): IssueTreeItem[] {
  return items.filter((item) => item.child_count > 0);
}

export function getIssueAncestors(issues: Issue[], issueId: string): Issue[] {
  const byId = new Map(issues.map((issue) => [issue.id, issue]));
  const ancestors: Issue[] = [];
  const visited = new Set([issueId]);
  let parentId = byId.get(issueId)?.parent_issue_id ?? null;
  while (parentId !== null && !visited.has(parentId)) {
    visited.add(parentId);
    const parent = byId.get(parentId);
    if (!parent) break;
    ancestors.push(parent);
    parentId = parent.parent_issue_id;
  }
  return ancestors.reverse();
}

export function getIssueDescendantIds(issues: Issue[], issueId: string): Set<string> {
  const childrenByParent = new Map<string, string[]>();
  for (const issue of issues) {
    if (issue.parent_issue_id === null) continue;
    const siblings = childrenByParent.get(issue.parent_issue_id) ?? [];
    siblings.push(issue.id);
    childrenByParent.set(issue.parent_issue_id, siblings);
  }

  const descendants = new Set<string>();
  const pending = [...(childrenByParent.get(issueId) ?? [])];
  while (pending.length > 0) {
    const childId = pending.pop()!;
    if (descendants.has(childId) || childId === issueId) continue;
    descendants.add(childId);
    pending.push(...(childrenByParent.get(childId) ?? []));
  }
  return descendants;
}
