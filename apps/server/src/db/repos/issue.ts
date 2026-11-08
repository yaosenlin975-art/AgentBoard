import { randomUUID } from 'node:crypto';
import type { Issue, IssueStatus, IssueTreeItem, IssueTreePage, Priority } from '@agentboard/shared';
import type { Db } from '../connection.js';
import { ApiError, ConflictError, NotFoundError, ValidationError } from '../../errors.js';
import type { PageResult, TaskPreview } from '@agentboard/shared';
import { pageResult, textWindow, validatePage } from '../pagination.js';
import { blockedByAggregateJoin, dependencyCountsFrom } from '../../services/dependency.js';
import { CLOSED_KIND_SQL, isClosedStatusName } from '../../services/workspaceStatus.js';

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
  /** BORROW-0.2 占用租约（内部状态，不进共享 Issue 类型）：NULL=无租约语义不可抢占 */
  claim_lease_until: number | null;
  /** 占用代次，每次 claim（含抢占）自增；校验属 B03 */
  claim_fence: number;
  /** 最后一次心跳续租时刻 */
  last_heartbeat_at: number | null;
  /** 评论总数（查询列，非落库列） */
  comment_count: number;
  /** 前置卡数（查询期聚合，非落库列） */
  blocked_by_count: number | null;
  /** 未解除的前置卡数（查询期聚合，非落库列） */
  blocked_by_open_count: number | null;
  /** BORROW-2.2 依赖违规标记（0/1，查询期检测，非落库列） */
  dep_violation: number;
  /** DEC-2 决策投影（查询期派生，非落库列） */
  decision_state: string | null;
  decision_id: string | null;
  decision_grace_until: number | null;
  decision_locked_at: number | null;
  /** CHILD-PROGRESS 子卡进度（查询期派生，仅详情与整区列表带这组列；其余查询为 undefined） */
  children_total?: number;
  children_closed?: number;
  created_at: number;
  updated_at: number;
}

const COMMENT_COUNT_COLUMN =
  '(SELECT COUNT(*) FROM issue_comment c WHERE c.issue_id = i.id) AS comment_count';
/**
 * BORROW-2.2 依赖违规检测（查询期投影，report-only）：blocks 前置中有本卡的祖先卡 → 死锁风险。
 * 正常路径 addRelation 已拒（DEPENDENCY_PARENT_CYCLE），违规只可能来自历史数据/直写库。
 */
const DEPENDENCY_VIOLATION_COLUMN = `EXISTS (
    SELECT 1 FROM issue_dependency v
    WHERE v.blocked_issue_id = i.id AND v.relation = 'blocks'
      AND EXISTS (
        WITH RECURSIVE descendants(id) AS (
          SELECT id FROM issue WHERE parent_issue_id = v.blocker_issue_id
          UNION
          SELECT child.id FROM issue child JOIN descendants d ON child.parent_issue_id = d.id
        )
        SELECT 1 FROM descendants WHERE id = i.id
      )
  ) AS dep_violation`;
/**
 * CHILD-PROGRESS：直接子卡进度（查询期派生，不落库）。
 * 只挂在「单卡详情」与「整区列表」两条查询上；分页/树查询保持原样，避免给它们加额外开销。
 * 已完成口径 = 状态名「已关闭」（卡面明确定义；自定义 done 类状态不计入）。
 */
const CHILD_PROGRESS_COLUMNS = `(SELECT COUNT(*) FROM issue c WHERE c.parent_issue_id = i.id) AS children_total,
  (SELECT COUNT(*) FROM issue c WHERE c.parent_issue_id = i.id AND c.status = '已关闭') AS children_closed`;
/** GET /issues 与树/分页共用：一条预聚合 LEFT JOIN 供全部行，不做 N+1 */
const DEPENDENCY_JOIN = blockedByAggregateJoin();
const DEPENDENCY_COLUMNS = 'dep.blocked_by_count, dep.blocked_by_open_count';
/**
 * DEC-2 决策投影： EXISTS 相关子查询派生，**不落 issue 表**，布尔字段不是权威（权威=issue_decision 行）。
 * 每列单独子查询，避免把 issue_decision 带进 LEFT JOIN 而破坏「一卡一行」。
 */
const DECISION_COLUMNS = `(SELECT d.state FROM issue_decision d WHERE d.issue_id=i.id AND d.state IN ('grace','open') ORDER BY d.created_at DESC, d.id DESC LIMIT 1) AS decision_state,
  (SELECT d.id FROM issue_decision d WHERE d.issue_id=i.id AND d.state IN ('grace','open') ORDER BY d.created_at DESC, d.id DESC LIMIT 1) AS decision_id,
  (SELECT d.grace_until FROM issue_decision d WHERE d.issue_id=i.id AND d.state='grace' ORDER BY d.created_at DESC LIMIT 1) AS decision_grace_until,
  (SELECT d.locked_at FROM issue_decision d WHERE d.issue_id=i.id AND d.state='open' ORDER BY d.locked_at ASC LIMIT 1) AS decision_locked_at`;

/** PERF-4a：`fields=` 白名单（字段名与共享 Issue 同名；children_* 仅查询时才存在） */
export const ISSUE_FIELD_NAMES = [
  'id', 'workspace_id', 'title', 'description', 'priority', 'labels', 'status', 'sort_order',
  'parent_issue_id', 'claimed_by', 'claimed_at', 'session_id', 'due_date', 'due_time',
  'comment_count', 'blocked_by_count', 'blocked_by_open_count', 'resolved',
  'dependency_violation', 'decision_locked', 'open_decision_id', 'decision_grace_until',
  'decision_waiting_seconds', 'children_total', 'children_closed', 'created_at', 'updated_at',
] as const;

export type IssueFieldName = (typeof ISSUE_FIELD_NAMES)[number];

export function isIssueFieldName(value: string): value is IssueFieldName {
  return (ISSUE_FIELD_NAMES as readonly string[]).includes(value);
}

/** 直接落库列：从 `i` 取，白名单命中才进 SELECT */
const BASE_ISSUE_COLUMNS: ReadonlyArray<readonly [IssueFieldName, string]> = [
  ['id', 'i.id'],
  ['workspace_id', 'i.workspace_id'],
  ['title', 'i.title'],
  ['priority', 'i.priority'],
  ['labels', 'i.labels'],
  ['status', 'i.status'],
  ['sort_order', 'i.sort_order'],
  ['parent_issue_id', 'i.parent_issue_id'],
  ['claimed_by', 'i.claimed_by'],
  ['claimed_at', 'i.claimed_at'],
  ['session_id', 'i.session_id'],
  ['due_date', 'i.due_date'],
  ['due_time', 'i.due_time'],
  ['created_at', 'i.created_at'],
  ['updated_at', 'i.updated_at'],
];

/**
 * PERF-4a：按 `fields` 组 SELECT 列表——只查被请求的列，并跳过未被请求的重聚合子查询。
 * 未给 fields 时保持旧查询（完整字段 + 全部派生列），旧调用方行为不变。
 */
function issueSelect(fields?: readonly IssueFieldName[]): { columns: string; join: string } {
  if (fields === undefined) {
    return {
      columns: `i.*, ${COMMENT_COUNT_COLUMN}, ${DEPENDENCY_COLUMNS}, ${DEPENDENCY_VIOLATION_COLUMN}, ${DECISION_COLUMNS}, ${CHILD_PROGRESS_COLUMNS}`,
      join: DEPENDENCY_JOIN,
    };
  }
  const wanted = new Set(fields);
  const columns = BASE_ISSUE_COLUMNS.filter(([name]) => wanted.has(name)).map(([, expr]) => expr);
  if (wanted.has('description')) columns.push('i.description');
  if (wanted.has('comment_count')) columns.push(COMMENT_COUNT_COLUMN);
  const needsDependency =
    wanted.has('blocked_by_count') || wanted.has('blocked_by_open_count') || wanted.has('resolved');
  if (needsDependency) columns.push(DEPENDENCY_COLUMNS);
  if (wanted.has('dependency_violation')) columns.push(DEPENDENCY_VIOLATION_COLUMN);
  if (
    wanted.has('decision_locked') ||
    wanted.has('open_decision_id') ||
    wanted.has('decision_grace_until') ||
    wanted.has('decision_waiting_seconds')
  ) {
    columns.push(DECISION_COLUMNS);
  }
  if (wanted.has('children_total') || wanted.has('children_closed')) columns.push(CHILD_PROGRESS_COLUMNS);
  return { columns: columns.join(','), join: needsDependency ? DEPENDENCY_JOIN : '' };
}

/** PERF-4a：把整行投影成白名单字段；未查询的列不参与 JSON.parse / 文本窗口 */
function projectIssueRow(row: IssueRow, fields: readonly IssueFieldName[]): Record<string, unknown> {
  // 未选中的列补安全默认值：rowToIssue 会解析 labels 并读取 dep_violation，缺值会让投影直接抛错
  const full = rowToIssue({
    ...row,
    description: row.description ?? '',
    labels: row.labels ?? '[]',
    dep_violation: row.dep_violation ?? 0,
    comment_count: row.comment_count ?? 0,
  }) as unknown as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const field of fields) if (Object.hasOwn(full, field)) out[field] = full[field];
  return out;
}

/**
 * CR-5：labels 是 TEXT 列且没有 JSON 约束——旧版本写入、手工改库、外部工具都可能留下非法值。
 * 容错解析的判定口径：必须是 JSON 字符串数组；其余（语法错误 / null / 对象 / 数字数组）一律视为无效。
 * 返回 null 表示「按本口径无效」，与合法空数组区分开，供启动期体检复用。
 */
export function tryParseLabels(raw: string | null | undefined): string[] | null {
  if (typeof raw !== 'string') return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed) || parsed.some((item) => typeof item !== 'string')) return null;
    return parsed as string[];
  } catch {
    return null;
  }
}

/**
 * CR-5：单行脏 labels 不能让整个看板列表 500 —— 失败退 [] 并告警（带 issue id），数据本身不改写。
 */
export function parseLabelsOrEmpty(raw: string | null | undefined, issueId: string): string[] {
  const labels = tryParseLabels(raw);
  if (labels !== null) return labels;
  console.warn(
    `[agentboard] issue ${issueId} 的 labels 不是合法的 JSON 字符串数组，已按 [] 处理；原值前 80 字符：${String(raw).slice(0, 80)}`,
  );
  return [];
}

function rowToIssue(row: IssueRow): Issue {
  const issue: Issue & { children_total?: number; children_closed?: number } = {
    id: row.id,
    workspace_id: row.workspace_id,
    title: row.title,
    description: row.description,
    priority: row.priority as Priority,
    labels: parseLabelsOrEmpty(row.labels, row.id),
    status: row.status as IssueStatus,
    sort_order: row.sort_order,
    claimed_by: row.claimed_by,
    claimed_at: row.claimed_at,
    // BORROW-0.2 租约投影（034427fa）：内部列带出（列已存在于 issue 表，零迁移）；fields= 白名单模式不带（PERF-4 白名单未决，本卡不动）
    claim_lease_until: row.claim_lease_until,
    last_heartbeat_at: row.last_heartbeat_at,
    session_id: row.session_id,
    parent_issue_id: row.parent_issue_id,
    due_date: row.due_date,
    due_time: row.due_time,
    comment_count: row.comment_count,
    dependency_violation: row.dep_violation === 1 ? 'blocked-by-ancestor' : null,
    decision_locked: row.decision_state === 'open',
    open_decision_id: row.decision_id ?? null,
    decision_grace_until: row.decision_state === 'grace' ? (row.decision_grace_until ?? null) : null,
    decision_waiting_seconds:
      row.decision_state === 'open' && row.decision_locked_at !== null
        ? Math.max(0, Math.floor((Date.now() - row.decision_locked_at) / 1000))
        : null,
    ...dependencyCountsFrom(row),
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
  // 只有带了 CHILD_PROGRESS_COLUMNS 的查询才有值；其余查询不带这两个字段，保持响应形状不变
  if (row.children_total !== undefined) {
    issue.children_total = row.children_total;
    issue.children_closed = row.children_closed ?? 0;
  }
  return issue;
}

/**
 * DEC-2：锁判定。权威是 issue_decision 行本身（state='open'），不是任何布尔投影字段。
 * grace 只是宽限计时，**不算锁**：宽限内占用照常有效，可正常续租/收尾。
 */
export function findOpenDecisionId(db: Db, issueId: string): string | null {
  const row = db
    .prepare("SELECT id FROM issue_decision WHERE issue_id=? AND state='open' ORDER BY locked_at DESC, created_at DESC LIMIT 1")
    .get(issueId) as { id: string } | undefined;
  return row?.id ?? null;
}

/** 是否存在 grace（宽限内）决策；租约清扫与批量退回必须放行这类卡 */
export function findGraceDecisionId(db: Db, issueId: string): string | null {
  const row = db
    .prepare("SELECT id FROM issue_decision WHERE issue_id=? AND state='grace' ORDER BY created_at DESC LIMIT 1")
    .get(issueId) as { id: string } | undefined;
  return row?.id ?? null;
}

/** 锁卡写入被拒的统一错误：409 DECISION_LOCKED，文案带决策 id 与卡标题（CLI 退出码 2） */
export function decisionLockedError(db: Db, issueId: string, decisionId: string, action: string): ApiError {
  const row = db.prepare('SELECT title FROM issue WHERE id=?').get(issueId) as { title: string } | undefined;
  const title = row?.title ?? issueId;
  return new ApiError(
    409,
    'DECISION_LOCKED',
    `任务「${title}」已被待决策锁住（decision=${decisionId}），不能${action}；先 kb decision answer ${decisionId} 回答决策`,
  );
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
  /** CREATE-STATUS：建卡初始状态，仅允许待规划 / 待验收；缺省待规划 */
  status?: '待规划' | '待验收';
}

export function createIssue(db: Db, input: CreateIssueInput): Issue {
  const id = randomUUID();
  const now = Date.now();
  db.prepare(
    `INSERT INTO issue (id, workspace_id, title, description, priority, labels, status, sort_order,
       claimed_by, claimed_at, session_id, parent_issue_id, due_date, due_time, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    input.workspace_id,
    input.title,
    input.description ?? '',
    input.priority ?? '中',
    JSON.stringify(input.labels ?? []),
    input.status ?? '待规划',
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
    .prepare(`SELECT i.*, ${COMMENT_COUNT_COLUMN}, ${DEPENDENCY_COLUMNS}, ${DEPENDENCY_VIOLATION_COLUMN}, ${DECISION_COLUMNS}, ${CHILD_PROGRESS_COLUMNS} FROM issue i ${DEPENDENCY_JOIN} WHERE i.id = ?${workspaceId ? ' AND i.workspace_id=?' : ''}`)
    .get(...(workspaceId ? [id, workspaceId] : [id])) as IssueRow | undefined;
  return row ? rowToIssue(row) : null;
}

export function listIssues(
  db: Db,
  workspaceId: string,
  status?: string,
  fields?: readonly IssueFieldName[],
): Array<Issue | Record<string, unknown>> {
  const params: unknown[] = [workspaceId];
  if (status !== undefined) params.push(status);
  const select = issueSelect(fields);
  const rows = db
    .prepare(
      `SELECT ${select.columns} FROM issue i ${select.join}
       WHERE i.workspace_id = ?${status === undefined ? '' : ' AND i.status = ?'} ORDER BY i.sort_order, i.created_at, i.id`,
    )
    .all(...params) as IssueRow[];
  return rows.map(row => (fields === undefined ? rowToIssue(row) : projectIssueRow(row, fields)));
}
export function listIssuesPage(
  db: Db,
  workspaceId: string,
  input: {
    limit: number;
    offset: number;
    /** CLI-LIST-GUARD：任意工作区状态名 */
    status?: string;
    /** PERF-4a：字段白名单；给了只返回所列字段并跳过未请求的重聚合列 */
    fields?: readonly IssueFieldName[];
  },
): PageResult<TaskPreview | Record<string, unknown>> {
  validatePage(input.limit, input.offset);
  const params: unknown[] = [workspaceId];
  if (input.status) params.push(input.status);
  params.push(input.limit + 1, input.offset);
  const select = issueSelect(input.fields);
  const rows = db.prepare(`SELECT ${select.columns} FROM issue i ${select.join} WHERE i.workspace_id=?${input.status ? ' AND i.status=?' : ''} ORDER BY i.id ASC LIMIT ? OFFSET ?`).all(...params) as IssueRow[];
  return pageResult(rows.map(row => {
    if (input.fields === undefined) {
      const issue = rowToIssue(row); const window = textWindow(issue.description);
      return { ...issue, description: window.content, description_truncated: window.truncated, next_description_offset_chars: window.next_offset_chars };
    }
    const projected = projectIssueRow(row, input.fields);
    // 只有正文被请求时才做文本窗口；未请求 description 的响应里不出现正文与截断标记
    if (input.fields.includes('description')) {
      const window = textWindow(String(projected.description ?? ''));
      projected.description = window.content;
      projected.description_truncated = window.truncated;
      projected.next_description_offset_chars = window.next_offset_chars;
    }
    return projected;
  }), input.limit, input.offset);
}

export interface WorkspaceIssueCounts {
  workspace_id: string;
  total: number;
  counts: Record<string, number>;
}

/** PERF-4a：单库内按状态聚合；调用方负责按目标库分组后逐库调用（不跨库拼 SQL） */
export function countIssuesByStatus(db: Db, workspaceIds: readonly string[]): WorkspaceIssueCounts[] {
  if (workspaceIds.length === 0) return [];
  const placeholders = workspaceIds.map(() => '?').join(',');
  const rows = db
    .prepare(`SELECT workspace_id, status, COUNT(*) AS n FROM issue WHERE workspace_id IN (${placeholders}) GROUP BY workspace_id, status`)
    .all(...workspaceIds) as Array<{ workspace_id: string; status: string; n: number }>;
  const byWorkspace = new Map<string, WorkspaceIssueCounts>();
  for (const workspaceId of workspaceIds) byWorkspace.set(workspaceId, { workspace_id: workspaceId, total: 0, counts: {} });
  for (const row of rows) {
    const item = byWorkspace.get(row.workspace_id);
    if (item === undefined) continue;
    item.counts[row.status] = row.n;
    item.total += row.n;
  }
  return workspaceIds.map(workspaceId => byWorkspace.get(workspaceId)!);
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
    // STATUS-3：关闭类按 kind 判（done | deprecated），不再比较状态名
    const workspaceId = (db.prepare('SELECT workspace_id FROM issue WHERE id=?').get(id) as { workspace_id: string } | undefined)?.workspace_id;
    if (workspaceId && isClosedStatusName(db, workspaceId, patch.status)) requireAllDescendantsClosed(db, id);
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
  status: string | null;
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
      // STATUS-3：状态名不再受四值枚举约束（自定义状态 / 已废弃 都能作为筛选值），只校验类型
      (parsed.status === null || typeof parsed.status === 'string') &&
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
  input: { workspace_id: string; parent_issue_id: string | null; limit: number; /** CLI-LIST-GUARD：任意工作区状态名 */ status?: string; cursor?: string },
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
  const rows = db.prepare(`SELECT i.*,${COMMENT_COUNT_COLUMN},${DEPENDENCY_COLUMNS},${DEPENDENCY_VIOLATION_COLUMN},${DECISION_COLUMNS},
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
  // STATUS-3：关闭类判定按 workspace_status.kind ∈ ('done','deprecated')，不再按状态名 '已关闭'
  const rows = db.prepare(`WITH RECURSIVE descendants(root_id,id,workspace_id,status,path,cycle) AS (
      SELECT root.id,child.id,child.workspace_id,child.status,':'||hex(root.id)||':'||hex(child.id)||':',child.id=root.id
      FROM issue root JOIN issue child ON child.parent_issue_id=root.id WHERE root.id IN (${placeholders})
      UNION ALL
      SELECT d.root_id,child.id,child.workspace_id,child.status,
        CASE WHEN instr(d.path,':'||hex(child.id)||':')>0 THEN d.path ELSE d.path||hex(child.id)||':' END,
        instr(d.path,':'||hex(child.id)||':')>0
      FROM descendants d JOIN issue child ON child.parent_issue_id=d.id WHERE d.cycle=0
    )
    SELECT d.root_id,COUNT(*) AS descendant_count,
      SUM(CASE WHEN ws.kind IS NOT NULL THEN 1 ELSE 0 END) AS descendants_closed_count,
      MAX(d.cycle) AS has_cycle
    FROM descendants d
    LEFT JOIN workspace_status ws ON ws.workspace_id=d.workspace_id AND ws.name=d.status AND ws.kind IN (${CLOSED_KIND_SQL})
    GROUP BY d.root_id`).all(...rootIds) as Array<{
      root_id: string; descendant_count: number; descendants_closed_count: number; has_cycle: number;
    }>;
  for (const row of rows) {
    if (row.has_cycle !== 0) throw new ApiError(500, 'TASK_TREE_INTEGRITY_ERROR', '检测到任务层级循环');
    result.set(row.root_id, { descendant_count: row.descendant_count, descendants_closed_count: row.descendants_closed_count });
  }
  return result;
}
