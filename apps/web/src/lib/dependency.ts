/**
 * 依赖展示口径（设计 §11 / §17-B3）：卡角标、树锁标、详情区共用。
 * `blocked_by_count` / `blocked_by_open_count` / `resolved` 一律取服务端投影字段，
 * 前端不按状态本地推断「解除」。
 */
import type { Issue, IssueStatus } from '@agentboard/shared';
import { getIssueDescendantIds } from './issueTree';

/** GET/POST /api/issues/:id/dependencies 的条目（服务端 DependencyRef 同构） */
export interface DependencyRef {
  issue_id: string;
  title: string;
  status: IssueStatus;
  resolved: boolean;
}

export interface DependencyView {
  blockers: DependencyRef[];
  blocked: DependencyRef[];
}

export function openBlockerCount(issue: Pick<Issue, 'blocked_by_open_count'>): number {
  return issue.blocked_by_open_count ?? 0;
}

/** 卡片右上角依赖角标：未解除 → 「等 N 项」；有前置且全解除 → 淡色「依赖已清」；无前置 → 不显示 */
export type DependencyBadge =
  | { kind: 'blocked'; open: number }
  | { kind: 'cleared'; total: number }
  | null;

export function dependencyBadge(issue: Issue): DependencyBadge {
  const open = openBlockerCount(issue);
  const total = issue.blocked_by_count ?? 0;
  if (open > 0) return { kind: 'blocked', open };
  if (issue.resolved === true && total > 0) return { kind: 'cleared', total };
  return null;
}

/** 子树（不含自身）未解除前置总数：树视图父卡汇总用，数据来自同一份工作区 issue 列表 */
export function countSubtreeOpenBlockers(issues: readonly Issue[], issueId: string): number {
  const descendantIds = getIssueDescendantIds(issues as Issue[], issueId);
  let total = 0;
  for (const id of descendantIds) {
    const item = issues.find((candidate) => candidate.id === id);
    if (item !== undefined) total += openBlockerCount(item);
  }
  return total;
}
