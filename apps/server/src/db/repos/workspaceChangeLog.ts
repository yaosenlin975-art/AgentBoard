import { randomUUID } from 'node:crypto';
import type { ArchivedWorkspaceChangeLogSummary, PageResult, Workspace, WorkspaceChangeLog, WorkspaceChangeType } from '@agentboard/shared';
import type { Db } from '../connection.js';
import { ApiError, ValidationError } from '../../errors.js';
import { pageResult, validatePage } from '../pagination.js';

/** 普通 UI/CLI 可写的类型；`历史` 只允许旧 CHANGELOG 导入写入 */
export type EditableChangeType = Exclude<WorkspaceChangeType, '历史'>;

export interface ChangeLogQuery {
  limit: number;
  offset: number;
  change_type?: WorkspaceChangeType;
  q?: string;
}

export interface CreateChangeLogInput {
  title: string;
  body_md: string;
  change_type: WorkspaceChangeType;
  actor: string;
  occurred_at?: number;
  legacy_source_key?: string | null;
}

export interface ChangeLogPatch {
  title?: string;
  body_md?: string;
  change_type?: WorkspaceChangeType;
  occurred_at?: number;
}

const COLUMNS = `id,workspace_id,origin_workspace_id,origin_workspace_name,origin_workspace_path,title,body_md,change_type,occurred_at,created_by,updated_by,created_at,updated_at,revision,legacy_source_key`;
const ORDER = 'ORDER BY occurred_at DESC, id DESC';
const CHANGE_TYPES: readonly WorkspaceChangeType[] = ['新增', '修复', '调整', '历史'];

/** LIKE 字面搜索：转义 \ % _，配合 ESCAPE '\' 使用 */
export function likePattern(query: string): string {
  return `%${query.replace(/[\\%_]/g, (match) => `\\${match}`)}%`;
}

function buildFilter(scopeSql: string, query: ChangeLogQuery): { sql: string; params: Record<string, unknown> } {
  validatePage(query.limit, query.offset);
  const params: Record<string, unknown> = { limit: query.limit + 1, offset: query.offset };
  let sql = scopeSql;
  if (query.change_type !== undefined) {
    if (!CHANGE_TYPES.includes(query.change_type)) throw new ValidationError('change_type 不合法');
    sql += ' AND change_type=@change_type';
    params.change_type = query.change_type;
  }
  if (query.q !== undefined && query.q !== '') {
    sql += " AND (title LIKE @q ESCAPE '\\' OR body_md LIKE @q ESCAPE '\\')";
    params.q = likePattern(query.q);
  }
  return { sql, params };
}

export function createChangeLog(db: Db, workspace: Workspace, input: CreateChangeLogInput): WorkspaceChangeLog {
  if (!CHANGE_TYPES.includes(input.change_type)) throw new ValidationError('change_type 不合法');
  if (input.change_type === '历史' && input.legacy_source_key == null) {
    throw new ValidationError('历史类型仅供旧 CHANGELOG 导入写入');
  }
  const now = Date.now();
  const log: WorkspaceChangeLog = {
    id: randomUUID(),
    workspace_id: workspace.id,
    origin_workspace_id: workspace.id,
    origin_workspace_name: workspace.name,
    origin_workspace_path: workspace.path,
    title: input.title,
    body_md: input.body_md,
    change_type: input.change_type,
    occurred_at: input.occurred_at ?? now,
    created_by: input.actor,
    updated_by: input.actor,
    created_at: now,
    updated_at: now,
    revision: 1,
    legacy_source_key: input.legacy_source_key ?? null,
  };
  db.prepare(
    `INSERT INTO workspace_change_log (${COLUMNS}) VALUES (@id,@workspace_id,@origin_workspace_id,@origin_workspace_name,@origin_workspace_path,@title,@body_md,@change_type,@occurred_at,@created_by,@updated_by,@created_at,@updated_at,@revision,@legacy_source_key)`,
  ).run({ ...log });
  return log;
}

export function getActiveChangeLog(db: Db, workspaceId: string, id: string): WorkspaceChangeLog | null {
  return (
    (db.prepare(`SELECT ${COLUMNS} FROM workspace_change_log WHERE id=? AND workspace_id=?`).get(id, workspaceId) as WorkspaceChangeLog | undefined) ??
    null
  );
}

export function listActiveChangeLogs(db: Db, workspaceId: string, query: ChangeLogQuery): PageResult<WorkspaceChangeLog> {
  const filter = buildFilter('workspace_id=@workspace', query);
  const rows = db
    .prepare(`SELECT ${COLUMNS} FROM workspace_change_log WHERE ${filter.sql} ${ORDER} LIMIT @limit OFFSET @offset`)
    .all({ ...filter.params, workspace: workspaceId }) as WorkspaceChangeLog[];
  return pageResult(rows, query.limit, query.offset);
}

export function patchChangeLog(
  db: Db,
  input: { workspace_id: string; id: string; expected_revision: number; actor: string; patch: ChangeLogPatch },
): WorkspaceChangeLog {
  const { patch } = input;
  const sets: string[] = [];
  const params: Record<string, unknown> = {};
  if (patch.title !== undefined) {
    sets.push('title=@title');
    params.title = patch.title;
  }
  if (patch.body_md !== undefined) {
    sets.push('body_md=@body_md');
    params.body_md = patch.body_md;
  }
  if (patch.change_type !== undefined) {
    if (!CHANGE_TYPES.includes(patch.change_type)) throw new ValidationError('change_type 不合法');
    sets.push('change_type=@change_type');
    params.change_type = patch.change_type;
  }
  if (patch.occurred_at !== undefined) {
    sets.push('occurred_at=@occurred_at');
    params.occurred_at = patch.occurred_at;
  }
  if (sets.length === 0) throw new ValidationError('至少一个可编辑字段');
  return db.transaction(() => {
    const current = getActiveChangeLog(db, input.workspace_id, input.id);
    if (!current) throw new ApiError(404, 'CHANGELOG_NOT_FOUND', '变更日志不存在');
    if (current.revision !== input.expected_revision) {
      throw new ApiError(409, 'CHANGELOG_REVISION_CONFLICT', '变更日志已更新，请重新读取', { current_revision: current.revision });
    }
    const updated_at = Math.max(Date.now(), current.updated_at + 1);
    db.prepare(
      `UPDATE workspace_change_log SET ${sets.join(',')},updated_by=@updated_by,updated_at=@updated_at,revision=revision+1 WHERE id=@id AND workspace_id=@workspace AND revision=@expected_revision`,
    ).run({ ...params, updated_by: input.actor, updated_at, id: input.id, workspace: input.workspace_id, expected_revision: input.expected_revision });
    return getActiveChangeLog(db, input.workspace_id, input.id)!;
  }).immediate();
}

export function deleteChangeLog(db: Db, input: { workspace_id: string; id: string; expected_revision: number }): void {
  db.transaction(() => {
    const current = getActiveChangeLog(db, input.workspace_id, input.id);
    if (!current) throw new ApiError(404, 'CHANGELOG_NOT_FOUND', '变更日志不存在');
    if (current.revision !== input.expected_revision) {
      throw new ApiError(409, 'CHANGELOG_REVISION_CONFLICT', '变更日志已更新，请重新读取', { current_revision: current.revision });
    }
    const row = db.prepare('DELETE FROM workspace_change_log WHERE id=? AND workspace_id=? AND revision=?').run(
      input.id,
      input.workspace_id,
      input.expected_revision,
    );
    if (row.changes !== 1) throw new ApiError(404, 'CHANGELOG_NOT_FOUND', '变更日志不存在');
  }).immediate();
}

export function listArchivedWorkspaces(db: Db, limit: number, offset: number): PageResult<ArchivedWorkspaceChangeLogSummary> {
  validatePage(limit, offset);
  const rows = db
    .prepare(
      `SELECT origin_workspace_id,origin_workspace_name,origin_workspace_path,COUNT(*) AS entry_count,MAX(occurred_at) AS last_occurred_at
       FROM workspace_change_log WHERE workspace_id IS NULL
       GROUP BY origin_workspace_id,origin_workspace_name,origin_workspace_path
       ORDER BY last_occurred_at DESC, origin_workspace_id DESC LIMIT ? OFFSET ?`,
    )
    .all(limit + 1, offset) as ArchivedWorkspaceChangeLogSummary[];
  return pageResult(rows, limit, offset);
}

export function listArchivedChangeLogs(db: Db, originWorkspaceId: string, query: ChangeLogQuery): PageResult<WorkspaceChangeLog> {
  const filter = buildFilter('workspace_id IS NULL AND origin_workspace_id=@origin', query);
  const rows = db
    .prepare(`SELECT ${COLUMNS} FROM workspace_change_log WHERE ${filter.sql} ${ORDER} LIMIT @limit OFFSET @offset`)
    .all({ ...filter.params, origin: originWorkspaceId }) as WorkspaceChangeLog[];
  return pageResult(rows, query.limit, query.offset);
}

export function getArchivedChangeLog(db: Db, originWorkspaceId: string, id: string): WorkspaceChangeLog | null {
  return (
    (db
      .prepare(`SELECT ${COLUMNS} FROM workspace_change_log WHERE id=? AND workspace_id IS NULL AND origin_workspace_id=?`)
      .get(id, originWorkspaceId) as WorkspaceChangeLog | undefined) ?? null
  );
}
