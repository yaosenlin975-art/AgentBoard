/**
 * DEP-1：任务依赖的**唯一判定口径与全部读写入口**。
 *
 * 口径（设计 §7，STATUS-3 起按 kind）：blocker 的 kind ∈ ('review','done','deprecated') 即「已解除」，
 * 判定唯一权威在 services/workspaceStatus.ts 的 `isBlockerResolvedKind` / `RESOLVED_KIND_SQL`。
 * claim 守卫、REST 投影、计数聚合都从这里取，禁止各处复制判断。
 * 方向（§5-D5）：`blocked_issue_id` ← `blocker_issue_id`，blocker 完成后 blocked 才可开工。
 */
import type { IssueStatus } from '@agentboard/shared';
import type { Db } from '../db/connection.js';
import { ApiError, NotFoundError, ValidationError } from '../errors.js';
import { getIssue } from '../db/repos/issue.js';
import { isIssueDescendant } from './taskHierarchy.js';
import { addComment as insertCommentRow } from '../db/repos/comment.js';
import { RESOLVED_KIND_SQL, isBlockerResolvedKind } from './workspaceStatus.js';

/**
 * 依赖解除的唯一口径（STATUS-3 起按 kind）：blocker 的 kind ∈ ('review','done','deprecated') 即已解除。
 * 具体判定在 services/workspaceStatus.ts 的 `isBlockerResolvedKind`，这里只做转出与 SQL 拼装，
 * 不再维护「状态名 → 是否解除」的第二份清单。
 */
export { isBlockerResolvedKind } from './workspaceStatus.js';

/** 依赖列表项：`resolved` 由唯一口径算出，前端/CLI 不再自行判断 */
/** BORROW-2.1：依赖边类型——blocks 参与门禁/计数/环检测；related/duplicate 是纯标注边 */
export type DependencyRelation = 'blocks' | 'related' | 'duplicate';
export const DEPENDENCY_RELATIONS: readonly DependencyRelation[] = ['blocks', 'related', 'duplicate'];

export interface DependencyRef {
  issue_id: string;
  title: string;
  status: IssueStatus;
  resolved: boolean;
  /** BORROW-2.1：边类型（随行返回；blocks 边恒为 'blocks'） */
  relation?: DependencyRelation;
}

export interface DependencyView {
  blockers: DependencyRef[];
  blocked: DependencyRef[];
  /** BORROW-2.2：标注边分组（空集省略；related 的 resolved 与 blocks 同口径反查 kind） */
  related?: DependencyRef[];
  duplicate?: DependencyRef[];
}

/** 行里带 kind（由 workspace_status 反查），resolved 只看 kind，不看状态名 */
const refToView = (row: { id: string; title: string; status: string; kind: string | null; relation: string }): DependencyRef => ({
  issue_id: row.id,
  title: row.title,
  status: row.status as IssueStatus,
  resolved: isBlockerResolvedKind(row.kind),
  relation: row.relation as DependencyRef['relation'],
});

/** 依赖视图查询共用：按边类型过滤；连同该状态在当前工作区的 kind 一起取出来 */
const DEPENDENCY_ROW_SQL = (where: string, relation: DependencyRelation): string => `SELECT i.id, i.title, i.status, ws.kind AS kind, d.relation AS relation
    FROM issue_dependency d
    JOIN issue i ON i.id = ${where === 'blocked' ? 'd.blocker_issue_id' : 'd.blocked_issue_id'}
    LEFT JOIN workspace_status ws ON ws.workspace_id = i.workspace_id AND ws.name = i.status
   WHERE d.relation = '${relation}' AND d.${where === 'blocked' ? 'blocked_issue_id' : 'blocker_issue_id'} = ? ORDER BY i.created_at, i.id`;

type DependencyRow = { id: string; title: string; status: string; kind: string | null; relation: string };
const rowsToRefs = (rows: DependencyRow[]): DependencyRef[] => rows.map(refToView);

/**
 * 单个任务的依赖视图（GET /dependencies；CLI/MCP 复用）。
 * BORROW-2.2：blockers/blocked 仍是 blocks 边语义（kb dep 原口径）；related/duplicate 作标注边
 * 追加为可选数组（空集省略字段，旧消费者零改动）。分组顺序固定：前置 → 被阻塞 → 关联 → 重复。
 */
export function listDependencies(db: Db, issueId: string): DependencyView {
  const blockers = db.prepare(DEPENDENCY_ROW_SQL('blocked', 'blocks')).all(issueId) as DependencyRow[];
  const blocked = db.prepare(DEPENDENCY_ROW_SQL('blocker', 'blocks')).all(issueId) as DependencyRow[];
  const related = db.prepare(DEPENDENCY_ROW_SQL('blocked', 'related')).all(issueId) as DependencyRow[];
  const duplicate = db.prepare(DEPENDENCY_ROW_SQL('blocked', 'duplicate')).all(issueId) as DependencyRow[];
  const view: DependencyView = { blockers: rowsToRefs(blockers), blocked: rowsToRefs(blocked) };
  if (related.length > 0) view.related = rowsToRefs(related);
  if (duplicate.length > 0) view.duplicate = rowsToRefs(duplicate);
  return view;
}

export interface BlockerRow { id: string; title: string; status: IssueStatus; kind?: string | null }

/** 未解除的前置任务（claim 守卫与测试共用；判定走 isBlockerResolvedKind） */
export function unresolvedBlockers(db: Db, issueId: string): BlockerRow[] {
  const rows = db.prepare(DEPENDENCY_ROW_SQL('blocked', 'blocks')).all(issueId) as BlockerRow[];
  return rows.filter(row => !isBlockerResolvedKind(row.kind));
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
  return `LEFT JOIN (
      SELECT d.blocked_issue_id AS dep_issue_id,
             COUNT(*) AS blocked_by_count,
             SUM(CASE WHEN ws.kind IN (${RESOLVED_KIND_SQL}) THEN 0 ELSE 1 END) AS blocked_by_open_count
        FROM issue_dependency d
        JOIN issue b ON b.id = d.blocker_issue_id
        LEFT JOIN workspace_status ws ON ws.workspace_id = b.workspace_id AND ws.name = b.status
       WHERE d.relation = 'blocks'
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
      SELECT blocker_issue_id FROM issue_dependency WHERE blocked_issue_id = ? AND relation = 'blocks'
      UNION
      SELECT d.blocker_issue_id FROM issue_dependency d JOIN ancestors a ON d.blocked_issue_id = a.id
      WHERE d.relation = 'blocks'
    ) SELECT 1 AS hit FROM ancestors WHERE id = ? LIMIT 1`).get(blockerIssueId, blockedIssueId);
  return hit !== undefined;
}

export interface AddDependencyInput { blocked_issue_id: string; blocker_issue_id: string; workspace_id: string }

/**
 * 建边（BORROW-2.1 泛化）：服务层先判全部错误码（跨区/自环/重复），触发器只兜底。
 * blocks 独有守卫：占用中禁新增前置（§17-B4）、父子反向死锁、成环、前置数上限——
 * related/duplicate 不参与环检测与流程门禁，一律放行（除基础校验外）。
 */
export function addRelation(db: Db, input: AddDependencyInput & { relation: DependencyRelation }): DependencyView {
  const { blocked_issue_id: blockedId, blocker_issue_id: blockerId, workspace_id: workspaceId, relation } = input;
  return db.transaction(() => {
    const blocked = getIssue(db, blockedId, workspaceId);
    if (!blocked) throw new NotFoundError('任务不存在');
    if (blockedId === blockerId) throw new ApiError(400, 'DEPENDENCY_SELF', '任务不能依赖自身');
    const blocker = getIssue(db, blockerId);
    if (!blocker) throw new NotFoundError('前置任务不存在');
    if (blocker.workspace_id !== workspaceId) throw new ApiError(400, 'CROSS_WORKSPACE_DEPENDENCY', '不支持跨工作区依赖');
    // 重复边判定先于 blocks 专属守卫（原顺序：重复报 DEPENDENCY_EXISTS，不得被「成环」文案遮蔽）
    const exists = db.prepare('SELECT 1 FROM issue_dependency WHERE blocked_issue_id=? AND blocker_issue_id=?').get(blockedId, blockerId);
    if (exists) throw new ApiError(409, 'DEPENDENCY_EXISTS', '该依赖已存在');
    if (relation === 'blocks') {
      if (blocked.claimed_by !== null) throw new ApiError(409, 'ISSUE_CLAIMED', '任务已被占用，请先 release 再新增前置');
      // DEP-GUARD：父子反向依赖的流程死锁——blocker 是 blocked 的祖先（父卡等子卡全完才 done），
      // 再让子卡把父卡设为前置 → 双向互等，整条链锁死。反向（父卡依赖子卡）语义合理，放行。
      if (isIssueDescendant(db, blockerId, blockedId)) {
        throw new ApiError(409, 'DEPENDENCY_PARENT_CYCLE', '子卡不能依赖其父/祖先卡（父卡需等子卡完成，会形成流程死锁）');
      }
      if (wouldCreateCycle(db, blockedId, blockerId)) throw new ApiError(409, 'DEPENDENCY_CYCLE', '依赖会成环，已拒绝');
      assertEdgeBudget(db, blockedId);
    }
    db.prepare('INSERT INTO issue_dependency (blocked_issue_id, blocker_issue_id, relation, created_at) VALUES (?,?,?,?)')
      .run(blockedId, blockerId, relation, Date.now());
    return listDependencies(db, blockedId);
  }).immediate();
}

/** 兼容入口：默认建 blocks 边（原 DEP-1 语义不变） */
export function addDependency(db: Db, input: AddDependencyInput): DependencyView {
  return addRelation(db, { ...input, relation: 'blocks' });
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
  const rows = db.prepare("SELECT blocked_issue_id FROM issue_dependency WHERE blocker_issue_id=? AND relation='blocks'").all(blockerId) as Array<{ blocked_issue_id: string }>;
  const content = `前置 ${title}(${shortIssueId(blockerId)}) 已删除，依赖自动解除`;
  return rows.map(({ blocked_issue_id: blockedId }) => {
    const comment = insertCommentRow(db, { issue_id: blockedId, author: 'system', content });
    db.prepare('UPDATE issue SET updated_at = MAX(?,updated_at+1) WHERE id=?').run(Date.now(), blockedId);
    return comment;
  });
}
