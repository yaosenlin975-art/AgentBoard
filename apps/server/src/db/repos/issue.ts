import { randomUUID } from 'node:crypto';
import type { Issue, IssueStatus, IssueTreeItem, IssueTreePage, Priority } from '@agentboard/shared';
import type { Db } from '../connection.js';
import { ApiError, ConflictError, NotFoundError, ValidationError } from '../../errors.js';
import type { PageResult, TaskPreview } from '@agentboard/shared';
import { pageResult, textWindow, validatePage } from '../pagination.js';
import { blockedByAggregateJoin, dependencyCountsFrom } from '../../services/dependency.js';

interface IssueRow {
  id: string;
  workspace_id: string;
  title: string;
  description: string;
  priority: string;
  labels: string;
  status: string;
  sort_order: number;
  claimed_by: string | null;
  claimed_at: number | null;
  session_id: string | null;
  parent_issue_id: string | null;
  /** 截止日期 / 时间（STATUS-1 新增列，可空） */
  due_date: string | null;
  due_time: string | null;
  /** 留言游标（内部状态，不进共享 Issue 类型）：NULL=无游标，consume 后=最新评论 id */
  last_seen_comment_id: string | null;
  /** 评论总数（查询列，非落库列） */
  comment_count: number;
  /** 前置卡数（查询期聚合，非落库列） */
  blocked_by_count: number | null;
  /** 未解除的前置卡数（查询期聚合，非落库列） */
  blocked_by_open_count: number | null;
  created_at: number;
  updated_at: number;
}

const COMMENT_COUNT_COLUMN =
  '(SELECT COUNT(*) FROM issue_comment c WHERE c.issue_id = i.id) AS comment_count';
/** GET /issues 与树/分页共用：一条预聚合 LEFT JOIN 供全部行，不做 N+1 */
const DEPENDENCY_JOIN = blockedByAggregateJoin();
const DEPENDENCY_COLUMNS = 'dep.blocked_by_count, dep.blocked_by_open_count';

function rowToIssue(row: IssueRow): Issue {
  return {
    id: row.id,
    workspace_id: row.workspace_id,
    title: row.title,
    description: row.description,
    priority: row.priority as Priority,
    labels: JSON.parse(row.labels) as string[],
    status: row.status as IssueStatus,
    sort_order: row.sort_order,
    claimed_by: row.claimed_by,
    claimed_at: row.claimed_at,
    session_id: row.session_id,
    parent_issue_id: row.parent_issue_id,
    due_date: row.due_date,
    due_time: row.due_time,
    comment_count: row.comment_count,
    ...dependencyCountsFrom(row),
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

export interface CreateIssueInput {
  workspace_id: string;
  title: string;
  description?: string;
  priority?: Priority;
  labels?: string[];
  sort_order?: number;
  parent_issue_id?: string | null;
  due_date?: string | null;
  due_time?: string | null;
}

export function createIssue(db: Db, input: CreateIssueInput): Issue {
  const id = randomUUID();
  const now = Date.now();
  db.prepare(
    `INSERT INTO issue (id, workspace_id, title, description, priority, labels, status, sort_order,
       claimed_by, claimed_at, session_id, parent_issue_id, due_date, due_time, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, '待规划', ?, NULL, NULL, NULL, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    input.workspace_id,
    input.title,
    input.description ?? '',
    input.priority ?? '中',
    JSON.stringify(input.labels ?? []),
    input.sort_order ?? 0,
    input.parent_issue_id ?? null,
    input.due_date ?? null,
    input.due_time ?? null,
    now,
    now,
  );
  return getIssue(db, id)!;
}

export function getIssue(db: Db, id: string, workspaceId?: string): Issue | null {
  const row = db
    .prepare(`SELECT i.*, ${COMMENT_COUNT_COLUMN}, ${DEPENDENCY_COLUMNS} FROM issue i ${DEPENDENCY_JOIN} WHERE i.id = ?${workspaceId ? ' AND i.workspace_id=?' : ''}`)
    .get(...(workspaceId ? [id, workspaceId] : [id])) as IssueRow | undefined;
  return row ? rowToIssue(row) : null;
}

export function listIssues(db: Db, workspaceId: string): Issue[] {
  const rows = db
    .prepare(
      `SELECT i.*, ${COMMENT_COUNT_COLUMN}, ${DEPENDENCY_COLUMNS} FROM issue i ${DEPENDENCY_JOIN}
       WHERE i.workspace_id = ? ORDER BY i.sort_order, i.created_at, i.id`,
    )
    .all(workspaceId) as IssueRow[];
  return rows.map(rowToIssue);
}
export function listIssuesPage(db: Db, workspaceId: string, input: { limit: number; offset: number; status?: IssueStatus }): PageResult<TaskPreview> {
  validatePage(input.limit, input.offset);
  const params: unknown[] = [workspaceId];
  if (input.status) params.push(input.status);
  params.push(input.limit + 1, input.offset);
  const rows = db.prepare(`SELECT i.*,${COMMENT_COUNT_COLUMN},${DEPENDENCY_COLUMNS} FROM issue i ${DEPENDENCY_JOIN} WHERE i.workspace_id=?${input.status ? ' AND i.status=?' : ''} ORDER BY i.id ASC LIMIT ? OFFSET ?`).all(...params) as IssueRow[];
  return pageResult(rows.map(row => {
    const issue = rowToIssue(row); const window = textWindow(issue.description);
    return { ...issue, description: window.content, description_truncated: window.truncated, next_description_offset_chars: window.next_offset_chars };
  }), input.limit, input.offset);
}

export type IssuePatch = Partial<{
  title: string;
  description: string;
  priority: Priority;
  labels: string[];
  /** STATUS-1：状态名不再受枚举限制，合法性由服务层按工作区字典校验 */
  status: string;
  sort_order: number;
  parent_issue_id: string | null;
  due_date: string | null;
  due_time: string | null;
}>;

/** 任意字段子集更新；labels 转 JSON 字符串落库；总是刷新 updated_at */
export function updateIssue(db: Db, id: string, patch: IssuePatch, guard?: { workspaceId: string; expectedUpdatedAt: number }): Issue {
  const sets: string[] = [];
  const params: unknown[] = [];
  if (patch.title !== undefined) {
    sets.push('title = ?');
    params.push(patch.title);
  }
  if (patch.description !== undefined) {
    sets.push('description = ?');
    params.push(patch.description);
  }
  if (patch.priority !== undefined) {
    sets.push('priority = ?');
    params.push(patch.priority);
  }
  if (patch.labels !== undefined) {
    sets.push('labels = ?');
    params.push(JSON.stringify(patch.labels));
  }
  if (patch.status !== undefined) {
    if (patch.status === '已关闭') requireAllDescendantsClosed(db, id);
    sets.push('status = ?');
    params.push(patch.status);
  }
  if (patch.sort_order !== undefined) {
    sets.push('sort_order = ?');
    params.push(patch.sort_order);
  }
  if (patch.parent_issue_id !== undefined) {
    sets.push('parent_issue_id = ?');
    params.push(patch.parent_issue_id);
  }
  if (patch.due_date !== undefined) {
    sets.push('due_date = ?');
    params.push(patch.due_date);
  }
  if (patch.due_time !== undefined) {
    sets.push('due_time = ?');
    params.push(patch.due_time);
  }
  sets.push('updated_at = MAX(?,updated_at+1)');
  params.push(Date.now(), id);
  if (guard) params.push(guard.workspaceId, guard.expectedUpdatedAt);
  const row = db.prepare(`UPDATE issue SET ${sets.join(', ')} WHERE id = ?${guard ? ' AND workspace_id=? AND updated_at=?' : ''}`).run(...params);
  if (row.changes !== 1) {
    const current = guard ? getIssue(db, id, guard.workspaceId) : null;
    if (current) throw new ApiError(409, 'TASK_REVISION_CONFLICT', '任务已更新，请重新读取', { current_updated_at: current.updated_at });
    throw new NotFoundError('任务不存在');
  }
  return getIssue(db, id)!;
}

export function deleteIssue(db: Db, id: string): void {
  requireNoIssueChildren(db, id);
  const row = db.prepare('DELETE FROM issue WHERE id = ?').run(id);
  if (row.changes !== 1) throw new NotFoundError('任务不存在');
}

export function requireNoIssueChildren(db: Db, id: string): void {
  if (db.prepare('SELECT 1 FROM issue WHERE parent_issue_id=? LIMIT 1').get(id)) {
    throw new ConflictError('任务仍有子任务，请先移动或删除子任务');
  }
}

/** 留言游标读取；issue 不存在返回 null */
export function getLastSeenCommentId(db: Db, issueId: string): string | null {
  const row = db.prepare('SELECT last_seen_comment_id FROM issue WHERE id = ?').get(issueId) as
    | { last_seen_comment_id: string | null }
    | undefined;
  return row?.last_seen_comment_id ?? null;
}

/** 留言游标写入（issue 不存在抛 NotFoundError） */
export function setLastSeenCommentId(db: Db, issueId: string, commentId: string | null): void {
  const row = db.prepare('UPDATE issue SET last_seen_comment_id = ? WHERE id = ?').run(commentId, issueId);
  if (row.changes !== 1) throw new NotFoundError('任务不存在');
}

function requireAllDescendantsClosed(db: Db, issueId: string): void {
  const counts = descendantStats(db, [issueId]).get(issueId);
  if (counts && counts.descendants_closed_count < counts.descendant_count) {
    throw new ConflictError('存在未关闭的后代任务，不能关闭此父任务');
  }
}

interface TreeCursor {
  version: 1;
  workspace_id: string;
  parent_issue_id: string | null;
  status: IssueStatus | null;
  sort_order: number;
  created_at: number;
  id: string;
}

function encodeTreeCursor(cursor: TreeCursor): string {
  return Buffer.from(JSON.stringify(cursor), 'utf8').toString('base64url');
}

function decodeTreeCursor(value: string): TreeCursor {
  try {
    const parsed = JSON.parse(Buffer.from(value, 'base64url').toString('utf8')) as Partial<TreeCursor>;
    if (
      parsed.version === 1 && typeof parsed.workspace_id === 'string' &&
      (parsed.parent_issue_id === null || typeof parsed.parent_issue_id === 'string') &&
      (parsed.status === null || parsed.status === '待规划' || parsed.status === '进行中' || parsed.status === '待验收' || parsed.status === '已关闭') &&
      Number.isSafeInteger(parsed.sort_order) && Number.isSafeInteger(parsed.created_at) && typeof parsed.id === 'string'
    ) return parsed as TreeCursor;
  } catch {
    // Invalid cursor is reported as a validation error below.
  }
  throw new ValidationError('任务树 cursor 不合法，请重新读取');
}

/** Keyset-paginated children. Each page carries the requested parent's full ancestor path. */
export function listIssueTreePage(
  db: Db,
  input: { workspace_id: string; parent_issue_id: string | null; limit: number; status?: IssueStatus; cursor?: string },
): IssueTreePage {
  validatePage(input.limit, 0);
  const status = input.status ?? null;
  const cursor = input.cursor === undefined ? null : decodeTreeCursor(input.cursor);
  if (cursor && (cursor.workspace_id !== input.workspace_id || cursor.parent_issue_id !== input.parent_issue_id || cursor.status !== status)) {
    throw new ValidationError('任务树查询条件已变化，请从第一页重新读取');
  }

  const ancestors = getIssueAncestors(db, input.workspace_id, input.parent_issue_id);
  const params: unknown[] = [input.workspace_id, input.parent_issue_id];
  const filters = ['i.workspace_id=?', 'i.parent_issue_id IS ?'];
  if (status !== null) { filters.push('i.status=?'); params.push(status); }
  if (cursor) {
    filters.push('(i.sort_order>? OR (i.sort_order=? AND (i.created_at>? OR (i.created_at=? AND i.id>?))))');
    params.push(cursor.sort_order, cursor.sort_order, cursor.created_at, cursor.created_at, cursor.id);
  }
  params.push(input.limit + 1);
  const rows = db.prepare(`SELECT i.*,${COMMENT_COUNT_COLUMN},${DEPENDENCY_COLUMNS},
      (SELECT COUNT(*) FROM issue child WHERE child.parent_issue_id=i.id) AS child_count
    FROM issue i ${DEPENDENCY_JOIN} WHERE ${filters.join(' AND ')} ORDER BY i.sort_order,i.created_at,i.id LIMIT ?`).all(...params) as Array<IssueRow & { child_count: number }>;
  const hasMore = rows.length > input.limit;
  const visibleRows = hasMore ? rows.slice(0, input.limit) : rows;
  const stats = descendantStats(db, visibleRows.map((row) => row.id));
  const items: IssueTreeItem[] = visibleRows.map((row) => {
    const issue = rowToIssue(row);
    const counts = stats.get(issue.id) ?? { descendant_count: 0, descendants_closed_count: 0 };
    return { ...issue, child_count: row.child_count, ...counts };
  });
  const last = visibleRows.at(-1);
  const next_cursor = hasMore && last ? encodeTreeCursor({
    version: 1, workspace_id: input.workspace_id, parent_issue_id: input.parent_issue_id, status,
    sort_order: last.sort_order, created_at: last.created_at, id: last.id,
  }) : null;
  return { items, ancestors, next_cursor };
}

function getIssueAncestors(db: Db, workspaceId: string, parentId: string | null): Issue[] {
  const ancestors: Issue[] = [];
  const seen = new Set<string>();
  let currentId = parentId;
  while (currentId !== null) {
    if (seen.has(currentId)) throw new ApiError(500, 'TASK_TREE_INTEGRITY_ERROR', '检测到任务父链循环');
    seen.add(currentId);
    const current = getIssue(db, currentId, workspaceId);
    if (!current) {
      if (ancestors.length === 0) throw new NotFoundError('父任务不存在');
      throw new ApiError(500, 'TASK_TREE_INTEGRITY_ERROR', '任务父链缺少节点');
    }
    ancestors.push(current);
    currentId = current.parent_issue_id;
  }
  ancestors.reverse();
  return ancestors;
}

function descendantStats(db: Db, rootIds: string[]): Map<string, { descendant_count: number; descendants_closed_count: number }> {
  const result = new Map<string, { descendant_count: number; descendants_closed_count: number }>();
  if (rootIds.length === 0) return result;
  const placeholders = rootIds.map(() => '?').join(',');
  const rows = db.prepare(`WITH RECURSIVE descendants(root_id,id,status,path,cycle) AS (
      SELECT root.id,child.id,child.status,':'||hex(root.id)||':'||hex(child.id)||':',child.id=root.id
      FROM issue root JOIN issue child ON child.parent_issue_id=root.id WHERE root.id IN (${placeholders})
      UNION ALL
      SELECT d.root_id,child.id,child.status,
        CASE WHEN instr(d.path,':'||hex(child.id)||':')>0 THEN d.path ELSE d.path||hex(child.id)||':' END,
        instr(d.path,':'||hex(child.id)||':')>0
      FROM descendants d JOIN issue child ON child.parent_issue_id=d.id WHERE d.cycle=0
    )
    SELECT root_id,COUNT(*) AS descendant_count,SUM(CASE WHEN status='已关闭' THEN 1 ELSE 0 END) AS descendants_closed_count,
      MAX(cycle) AS has_cycle FROM descendants GROUP BY root_id`).all(...rootIds) as Array<{
      root_id: string; descendant_count: number; descendants_closed_count: number; has_cycle: number;
    }>;
  for (const row of rows) {
    if (row.has_cycle !== 0) throw new ApiError(500, 'TASK_TREE_INTEGRITY_ERROR', '检测到任务层级循环');
    result.set(row.root_id, { descendant_count: row.descendant_count, descendants_closed_count: row.descendants_closed_count });
  }
  return result;
}
