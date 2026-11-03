/**
 * DEP-1：任务依赖的**唯一判定口径与全部读写入口**。
 *
 * 口径（设计 §7）：blocker 状态 ∈ `RESOLVED_STATUSES` 即「已解除」。
 * claim 守卫、REST 投影、计数聚合都从这里取，禁止各处复制判断。
 * 方向（§5-D5）：`blocked_issue_id` ← `blocker_issue_id`，blocker 完成后 blocked 才可开工。
 */
import type { IssueStatus } from '@agentboard/shared';
import type { Db } from '../db/connection.js';
import { ApiError, NotFoundError, ValidationError } from '../errors.js';
import { getIssue } from '../db/repos/issue.js';
import { addComment as insertCommentRow } from '../db/repos/comment.js';

/** 解除判定的状态集合；SQL 聚合与 TS 判定共用这一份字面量 */
export const RESOLVED_STATUSES: readonly IssueStatus[] = ['待验收', '已关闭'];

/** 唯一口径：blocker 是否已解除（`待验收` 也算解除，避免人工验收堵死流水线 §5-D2） */
export function isBlockerResolved(status: IssueStatus): boolean {
  return RESOLVED_STATUSES.includes(status);
}

/** 依赖列表项：`resolved` 由唯一口径算出，前端/CLI 不再自行判断 */
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

const refToView = (row: { id: string; title: string; status: string }): DependencyRef => ({
  issue_id: row.id,
  title: row.title,
  status: row.status as IssueStatus,
  resolved: isBlockerResolved(row.status as IssueStatus),
});

/** 单个任务的双向依赖视图（GET /dependencies；CLI/MCP 复用） */
export function listDependencies(db: Db, issueId: string): DependencyView {
  const blockers = db.prepare(`SELECT i.id, i.title, i.status FROM issue_dependency d
      JOIN issue i ON i.id = d.blocker_issue_id
    WHERE d.blocked_issue_id = ? ORDER BY i.created_at, i.id`).all(issueId) as Array<{ id: string; title: string; status: string }>;
  const blocked = db.prepare(`SELECT i.id, i.title, i.status FROM issue_dependency d
      JOIN issue i ON i.id = d.blocked_issue_id
    WHERE d.blocker_issue_id = ? ORDER BY i.created_at, i.id`).all(issueId) as Array<{ id: string; title: string; status: string }>;
  return { blockers: blockers.map(refToView), blocked: blocked.map(refToView) };
}

export interface BlockerRow { id: string; title: string; status: IssueStatus }

/** 未解除的前置任务（claim 守卫与测试共用；判定走 isBlockerResolved） */
export function unresolvedBlockers(db: Db, issueId: string): BlockerRow[] {
  const rows = db.prepare(`SELECT i.id, i.title, i.status FROM issue_dependency d
      JOIN issue i ON i.id = d.blocker_issue_id
    WHERE d.blocked_issue_id = ? ORDER BY i.created_at, i.id`).all(issueId) as BlockerRow[];
  return rows.filter(row => !isBlockerResolved(row.status));
}

export const shortIssueId = (id: string): string => id.slice(0, 8);

/** claim 守卫文案：列出未解除的前置标题 + uuid 前 8 位（超过 3 个折叠） */
export function blockedClaimMessage(blockers: readonly BlockerRow[]): string {
  const listed = blockers.slice(0, 3).map(row => `${row.title}(${shortIssueId(row.id)})`).join('、');
  const more = blockers.length > 3 ? ` 等 ${blockers.length} 个` : '';
  return `存在未完成的前置任务：${listed}${more}；完成后可领取`;
}

/**
 * 计数聚合片段（`blocked_by_count` / `blocked_by_open_count`）。
 * 预聚合子查询 + LEFT JOIN：一条 SQL 覆盖整页/整表，不做 N+1（设计 §17-B3）。
 * 调用方按 `blockedByCounts` 归零补默认值。
 */
export function blockedByAggregateJoin(): string {
  const resolved = RESOLVED_STATUSES.map(status => `'${status}'`).join(',');
  return `LEFT JOIN (
      SELECT d.blocked_issue_id AS dep_issue_id,
             COUNT(*) AS blocked_by_count,
             SUM(CASE WHEN b.status IN (${resolved}) THEN 0 ELSE 1 END) AS blocked_by_open_count
        FROM issue_dependency d JOIN issue b ON b.id = d.blocker_issue_id
       GROUP BY d.blocked_issue_id
    ) dep ON dep.dep_issue_id = i.id`;
}

export interface DependencyCounts { blocked_by_count: number; blocked_by_open_count: number; resolved: boolean }

/** 查询列 → 共享 Issue 的依赖字段；无依赖时为 0/0/true */
export function dependencyCountsFrom(row: { blocked_by_count?: number | null; blocked_by_open_count?: number | null }): DependencyCounts {
  const blockedByCount = row.blocked_by_count ?? 0;
  const openCount = row.blocked_by_open_count ?? 0;
  return { blocked_by_count: blockedByCount, blocked_by_open_count: openCount, resolved: openCount === 0 };
}

/** 度数上限：单卡前置/被阻塞各不超过 50，防界面与查询爆炸（设计 §15 交由实现者定） */
export const MAX_DEPENDENCY_EDGES = 50;

function assertEdgeBudget(db: Db, issueId: string): void {
  const row = db.prepare('SELECT COUNT(*) AS n FROM issue_dependency WHERE blocked_issue_id=?').get(issueId) as { n: number };
  if (row.n >= MAX_DEPENDENCY_EDGES) throw new ValidationError(`前置任务数已达上限 ${MAX_DEPENDENCY_EDGES}`);
}

/** 插入后会成环？从 blocker 沿「前置的前置」上溯，能到达 blocked 即成环（与触发器同一条 CTE） */
function wouldCreateCycle(db: Db, blockedIssueId: string, blockerIssueId: string): boolean {
  const hit = db.prepare(`WITH RECURSIVE ancestors(id) AS (
      SELECT blocker_issue_id FROM issue_dependency WHERE blocked_issue_id = ?
      UNION
      SELECT d.blocker_issue_id FROM issue_dependency d JOIN ancestors a ON d.blocked_issue_id = a.id
    ) SELECT 1 AS hit FROM ancestors WHERE id = ? LIMIT 1`).get(blockerIssueId, blockedIssueId);
  return hit !== undefined;
}

export interface AddDependencyInput { blocked_issue_id: string; blocker_issue_id: string; workspace_id: string }

/**
 * 建边：服务层先判全部错误码（跨区/自环/重复/成环/占用），触发器只兜底。
 * 已占用的卡不得新增前置（§17-B4，文案要求先 release）。
 */
export function addDependency(db: Db, input: AddDependencyInput): DependencyView {
  const { blocked_issue_id: blockedId, blocker_issue_id: blockerId, workspace_id: workspaceId } = input;
  return db.transaction(() => {
    const blocked = getIssue(db, blockedId, workspaceId);
    if (!blocked) throw new NotFoundError('任务不存在');
    if (blockedId === blockerId) throw new ApiError(400, 'DEPENDENCY_SELF', '任务不能依赖自身');
    const blocker = getIssue(db, blockerId);
    if (!blocker) throw new NotFoundError('前置任务不存在');
    if (blocker.workspace_id !== workspaceId) throw new ApiError(400, 'CROSS_WORKSPACE_DEPENDENCY', '不支持跨工作区依赖');
    if (blocked.claimed_by !== null) throw new ApiError(409, 'ISSUE_CLAIMED', '任务已被占用，请先 release 再新增前置');
    const exists = db.prepare('SELECT 1 FROM issue_dependency WHERE blocked_issue_id=? AND blocker_issue_id=?').get(blockedId, blockerId);
    if (exists) throw new ApiError(409, 'DEPENDENCY_EXISTS', '该依赖已存在');
    if (wouldCreateCycle(db, blockedId, blockerId)) throw new ApiError(409, 'DEPENDENCY_CYCLE', '依赖会成环，已拒绝');
    assertEdgeBudget(db, blockedId);
    db.prepare('INSERT INTO issue_dependency (blocked_issue_id, blocker_issue_id, created_at) VALUES (?,?,?)')
      .run(blockedId, blockerId, Date.now());
    return listDependencies(db, blockedId);
  }).immediate();
}

/** 删边：不存在 → 404 */
export function removeDependency(db: Db, input: { blocked_issue_id: string; blocker_issue_id: string; workspace_id: string }): DependencyView {
  return db.transaction(() => {
    const blocked = getIssue(db, input.blocked_issue_id, input.workspace_id);
    if (!blocked) throw new NotFoundError('任务不存在');
    const removed = db.prepare('DELETE FROM issue_dependency WHERE blocked_issue_id=? AND blocker_issue_id=?')
      .run(input.blocked_issue_id, input.blocker_issue_id);
    if (removed.changes !== 1) throw new NotFoundError('依赖不存在');
    return listDependencies(db, input.blocked_issue_id);
  }).immediate();
}

/**
 * 删除 blocker 卡时的解锁留痕（§17-B4）：对每个被阻塞卡追加系统评论，与删除同事务。
 * 返回新评论，由调用方广播 `comment.added`。直接走 repo 层插入，避免嵌套事务。
 */
export function unlockCommentsForDeletedBlocker(db: Db, blockerId: string) {
  const title = getIssue(db, blockerId)?.title ?? '前置任务';
  const rows = db.prepare('SELECT blocked_issue_id FROM issue_dependency WHERE blocker_issue_id=?').all(blockerId) as Array<{ blocked_issue_id: string }>;
  const content = `前置 ${title}(${shortIssueId(blockerId)}) 已删除，依赖自动解除`;
  return rows.map(({ blocked_issue_id: blockedId }) => {
    const comment = insertCommentRow(db, { issue_id: blockedId, author: 'system', content });
    db.prepare('UPDATE issue SET updated_at = MAX(?,updated_at+1) WHERE id=?').run(Date.now(), blockedId);
    return comment;
  });
}
