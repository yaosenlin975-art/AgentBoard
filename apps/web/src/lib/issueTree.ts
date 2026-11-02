import type { Issue, IssueStatus } from '@agentboard/shared';

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
