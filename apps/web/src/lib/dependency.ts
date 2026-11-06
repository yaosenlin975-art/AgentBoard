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
  /** BORROW-2.1：边类型（服务端随行返回） */
  relation?: 'blocks' | 'related' | 'duplicate';
  /** DEC-V4-API-DEP：下游卡占用者，未占用为 null */
  claimed_by: string | null;
  /** DEC-V4-API-DEP：被挡原因，未记录为 null（前端显示「未记录原因」） */
  blocked_reason: string | null;
  /** DEC-V4-API-DEP：1=直接下游，2=间接下游 */
  depth: number;
  /** DEC-V4-API-DEP：间接项的上一跳 issue_id；直接项为 null */
  via: string | null;
}

export interface DependencyView {
  blockers: DependencyRef[];
  blocked: DependencyRef[];
  /** BORROW-2.2：标注边分组（空集时服务端省略字段） */
  related?: DependencyRef[];
  duplicate?: DependencyRef[];
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
