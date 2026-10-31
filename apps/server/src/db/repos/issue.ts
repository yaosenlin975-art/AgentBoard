import { randomUUID } from 'node:crypto';
import type { Issue, IssueStatus, Priority } from '@agentboard/shared';
import type { Db } from '../connection.js';
import { NotFoundError } from '../../errors.js';

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
  created_at: number;
  updated_at: number;
}

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
}

export function createIssue(db: Db, input: CreateIssueInput): Issue {
  const id = randomUUID();
  const now = Date.now();
  db.prepare(
    `INSERT INTO issue (id, workspace_id, title, description, priority, labels, status, sort_order,
       claimed_by, claimed_at, session_id, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, '待规划', ?, NULL, NULL, NULL, ?, ?)`,
  ).run(
    id,
    input.workspace_id,
    input.title,
    input.description ?? '',
    input.priority ?? '中',
    JSON.stringify(input.labels ?? []),
    input.sort_order ?? 0,
    now,
    now,
  );
  return getIssue(db, id)!;
}

export function getIssue(db: Db, id: string): Issue | null {
  const row = db.prepare('SELECT * FROM issue WHERE id = ?').get(id) as IssueRow | undefined;
  return row ? rowToIssue(row) : null;
}

export function listIssues(db: Db, workspaceId: string): Issue[] {
  const rows = db
    .prepare('SELECT * FROM issue WHERE workspace_id = ? ORDER BY sort_order, created_at, id')
    .all(workspaceId) as IssueRow[];
  return rows.map(rowToIssue);
}

export type IssuePatch = Partial<{
  title: string;
  description: string;
  priority: Priority;
  labels: string[];
  status: IssueStatus;
  sort_order: number;
}>;

/** 任意字段子集更新；labels 转 JSON 字符串落库；总是刷新 updated_at */
export function updateIssue(db: Db, id: string, patch: IssuePatch): Issue {
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
    sets.push('status = ?');
    params.push(patch.status);
  }
  if (patch.sort_order !== undefined) {
    sets.push('sort_order = ?');
    params.push(patch.sort_order);
  }
  sets.push('updated_at = ?');
  params.push(Date.now(), id);
  const row = db.prepare(`UPDATE issue SET ${sets.join(', ')} WHERE id = ?`).run(...params);
  if (row.changes !== 1) throw new NotFoundError('任务不存在');
  return getIssue(db, id)!;
}

export function deleteIssue(db: Db, id: string): void {
  const row = db.prepare('DELETE FROM issue WHERE id = ?').run(id);
  if (row.changes !== 1) throw new NotFoundError('任务不存在');
}
