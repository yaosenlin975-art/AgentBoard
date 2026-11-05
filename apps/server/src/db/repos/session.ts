import { randomUUID } from 'node:crypto';
import type { Session, SessionStatus } from '@agentboard/shared';
import type { Db } from '../connection.js';
import { NotFoundError } from '../../errors.js';

export interface CreateSessionInput {
  workspace_id: string;
  issue_id?: string | null;
  cli: string;
  model?: string | null;
  status?: SessionStatus;
}

export function createSession(db: Db, input: CreateSessionInput): Session {
  const id = randomUUID();
  const created_at = Date.now();
  db.prepare(
    `INSERT INTO session (id, workspace_id, issue_id, cli, model, status, adapter_session_id, created_at)
     VALUES (?, ?, ?, ?, ?, ?, NULL, ?)`,
  ).run(
    id,
    input.workspace_id,
    input.issue_id ?? null,
    input.cli,
    input.model ?? null,
    input.status ?? '运行中',
    created_at,
  );
  return getSession(db, id)!;
}

export function getSession(db: Db, id: string): Session | null {
  return (db.prepare('SELECT * FROM session WHERE id = ?').get(id) as Session | undefined) ?? null;
}

export function listSessionsByWorkspace(db: Db, workspaceId: string): Session[] {
  return db
    .prepare('SELECT * FROM session WHERE workspace_id = ? ORDER BY created_at, id')
    .all(workspaceId) as Session[];
}

/** 绑定某 issue 的全部会话（issue 删除级联清理用） */
export function listSessionsByIssue(db: Db, issueId: string): Session[] {
  return db
    .prepare('SELECT * FROM session WHERE issue_id = ? ORDER BY created_at, id')
    .all(issueId) as Session[];
}

export type SessionPatch = Partial<{
  status: SessionStatus;
  adapter_session_id: string | null;
  model: string | null;
  /** 会话级标题（重命名）；null = 清空自定义标题，回到派生规则 */
  title: string | null;
}>;

export function updateSession(db: Db, id: string, patch: SessionPatch): Session {
  const sets: string[] = [];
  const params: unknown[] = [];
  if (patch.status !== undefined) {
    sets.push('status = ?');
    params.push(patch.status);
  }
  if (patch.adapter_session_id !== undefined) {
    sets.push('adapter_session_id = ?');
    params.push(patch.adapter_session_id);
  }
  if (patch.model !== undefined) {
    sets.push('model = ?');
    params.push(patch.model);
  }
  if (patch.title !== undefined) {
    sets.push('title = ?');
    params.push(patch.title);
  }
  if (sets.length === 0) throw new NotFoundError('无可用更新字段');
  params.push(id);
  const row = db.prepare(`UPDATE session SET ${sets.join(', ')} WHERE id = ?`).run(...params);
  if (row.changes !== 1) throw new NotFoundError('会话不存在');
  return getSession(db, id)!;
}

/** 删会话行（绑定的 message 由外层显式删，不依赖 FK CASCADE） */
export function deleteSession(db: Db, id: string): void {
  db.prepare('DELETE FROM session WHERE id = ?').run(id);
}
