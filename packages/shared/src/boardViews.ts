/**
 * ARCH-01：`kb next` / `kb stats` 的纯计算与结果契约（CLI 与 MCP 共用）。
 *
 * 这里只放「读到的数据 → 结果」的纯函数与类型，不做 IO：
 * CLI 走 `packages/cli/src/commands/next.ts|stats.ts`，MCP 走 `apps/mcp/src/tools/boardViews.ts`，
 * 两条通道调用同一份函数，保证 `--json` 字段名、排序、null/数组形状逐字一致。
 */
import type { Issue } from './types.js';

/* ------------------------------------------------------------------ next */

/** 缺省最多返回 5 张，避免一次把整区倒给 agent */
export const NEXT_DEFAULT_LIMIT = 5;

/** 依赖引用（与服务端 `GET /api/issues/:id/dependencies` 出参同构，由服务端算好 resolved） */
export interface DependencyRef {
  issue_id: string;
  title: string;
  status: string;
  resolved: boolean;
  relation?: string;
}

export interface DependencyView {
  blockers: DependencyRef[];
  blocked: DependencyRef[];
  related?: DependencyRef[];
  duplicate?: DependencyRef[];
}

export interface NextItem {
  id: string;
  title: string;
  status: string;
  priority: string;
  parent_issue_id: string | null;
  labels: string[];
  /** 本卡的前置（可派卡这里必然全部已解除，保留完整状态供核对） */
  blockers: DependencyRef[];
  /** 被本卡阻塞的后继 */
  blocks: DependencyRef[];
  /** 同标签相邻卡（未关闭，最多 5 张） */
  siblings_by_label: string[];
}

const isUnclosed = (issue: Issue): boolean => issue.status !== '已关闭';

/** 可派候选：待规划 且 无占用（依赖是否解除需另行取依赖视图） */
export function nextCandidates(all: Issue[]): Issue[] {
  return all.filter(issue => issue.status === '待规划' && (issue.claimed_by === null || issue.claimed_by === undefined || issue.claimed_by === ''));
}

/** 同标签相邻卡：共享至少一个标签的未关闭卡，按服务端顺序取前 5 张 */
function siblingsByLabel(issue: Issue, all: Issue[]): string[] {
  if (issue.labels.length === 0) return [];
  return all
    .filter(other => other.id !== issue.id && isUnclosed(other) && other.labels.some(label => issue.labels.includes(label)))
    .slice(0, 5)
    .map(other => other.id);
}

/**
 * 组合可派卡视图：`views[i]` 必须与 `candidates[i]` 一一对应（调用方为每个候选取依赖）。
 * 返回截断后的 `items` 与过滤后的真实总数 `total`（总数用于文本摘要，不随 limit 变化）。
 */
export function buildNextItems(
  all: Issue[],
  candidates: Issue[],
  views: DependencyView[],
  limit: number = NEXT_DEFAULT_LIMIT,
): { items: NextItem[]; total: number } {
  const items: NextItem[] = [];
  for (let index = 0; index < candidates.length; index += 1) {
    const issue = candidates[index]!;
    const view = views[index]!;
    if (view.blockers.some(blocker => !blocker.resolved)) continue;
    items.push({
      id: issue.id,
      title: issue.title,
      status: issue.status,
      priority: issue.priority,
      parent_issue_id: issue.parent_issue_id,
      labels: issue.labels,
      blockers: view.blockers,
      blocks: view.blocked,
      siblings_by_label: siblingsByLabel(issue, all),
    });
  }
  return { items: items.slice(0, limit), total: items.length };
}

/* ----------------------------------------------------------------- stats */

/** 内置五状态（自定义状态不计入这五行，避免和 list-tasks --status 口径打架） */
export const BUILTIN_STATUSES = ['待规划', '进行中', '待验收', '已关闭', '已废弃'] as const;
export type BuiltinStatus = (typeof BUILTIN_STATUSES)[number];

/** 「未完成」口径（待规划/进行中/待验收）；kind=blocked 的阻塞卡不计入可派统计（需人工解除） */
const UNFINISHED = new Set<string>(['待规划', '进行中', '待验收']);

export interface StatsResult {
  workspace_id: string;
  generated_at: string;
  statuses: Record<BuiltinStatus, number>;
  /** 未完成（待规划/进行中/待验收）且 claimed_by 为空的卡数 */
  unclaimed_open: number;
  /** 未完成且存在未解除前置（blocked_by_open_count > 0）的卡数 */
  blocked_open: number;
  /** 本次统计覆盖的卡总数（含自定义状态） */
  total: number;
}

/** 本地时间戳：YYYY-MM-DD HH:mm:ss±HH:mm（便于人读与事后复算） */
export function localTimestamp(date: Date = new Date()): string {
  const pad = (value: number): string => String(value).padStart(2, '0');
  const offsetMinutes = -date.getTimezoneOffset();
  const sign = offsetMinutes >= 0 ? '+' : '-';
  const abs = Math.abs(offsetMinutes);
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} `
    + `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
    + `${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`;
}

export function computeStats(workspaceId: string, issues: Issue[], now: Date = new Date()): StatsResult {
  const statuses = Object.fromEntries(BUILTIN_STATUSES.map(status => [status, 0])) as Record<BuiltinStatus, number>;
  let unclaimedOpen = 0;
  let blockedOpen = 0;
  for (const issue of issues) {
    if ((BUILTIN_STATUSES as readonly string[]).includes(issue.status)) {
      statuses[issue.status as BuiltinStatus] += 1;
    }
    if (!UNFINISHED.has(issue.status)) continue;
    if (issue.claimed_by === null || issue.claimed_by === undefined || issue.claimed_by === '') unclaimedOpen += 1;
    const openCount = issue.blocked_by_open_count ?? 0;
    if (openCount > 0) blockedOpen += 1;
  }
  return {
    workspace_id: workspaceId,
    generated_at: localTimestamp(now),
    statuses,
    unclaimed_open: unclaimedOpen,
    blocked_open: blockedOpen,
    total: issues.length,
  };
}
