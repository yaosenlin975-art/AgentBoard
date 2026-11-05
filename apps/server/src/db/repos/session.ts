import { randomUUID } from 'node:crypto';
import type { Message, Session, SessionStatus } from '@agentboard/shared';
import type { Db } from '../connection.js';
import { NotFoundError, ValidationError } from '../../errors.js';

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

/**
 * CHAT-SB1（契约 #11）：会话列表默认排除归档（`archived_at IS NOT NULL`）；
 * `includeArchived=true` 时全量返回（侧栏「归档组」用）。既有调用方不传选项，行为不变
 * （存量行 archived_at 恒为 NULL）。
 */
export function listSessionsByWorkspace(
  db: Db,
  workspaceId: string,
  options: { includeArchived?: boolean } = {},
): Session[] {
  const archivedFilter = options.includeArchived ? '' : ' AND archived_at IS NULL';
  return db
    .prepare(`SELECT * FROM session WHERE workspace_id = ?${archivedFilter} ORDER BY created_at, id`)
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
  /** CHAT-SB1：归档时间戳；null = 取消归档 */
  archived_at: number | null;
  /** CHAT-SB1（分叉）：源会话 id 与分叉起点消息 id，仅由 fork 写入 */
  forked_from_session_id: string | null;
  fork_message_id: string | null;
  /** BORROW-4.3：暂停时间戳；null = 恢复。只改该列，不动 status（status 语义不变） */
  paused_at: number | null;
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
  if (patch.archived_at !== undefined) {
    sets.push('archived_at = ?');
    params.push(patch.archived_at);
  }
  if (patch.forked_from_session_id !== undefined) {
    sets.push('forked_from_session_id = ?');
    params.push(patch.forked_from_session_id);
  }
  if (patch.fork_message_id !== undefined) {
    sets.push('fork_message_id = ?');
    params.push(patch.fork_message_id);
  }
  if (patch.paused_at !== undefined) {
    sets.push('paused_at = ?');
    params.push(patch.paused_at);
  }
  if (sets.length === 0) throw new NotFoundError('无可用更新字段');
  params.push(id);
  const row = db.prepare(`UPDATE session SET ${sets.join(', ')} WHERE id = ?`).run(...params);
  if (row.changes !== 1) throw new NotFoundError('会话不存在');
  return getSession(db, id)!;
}

interface ForkMessageRow {
  id: string; role: Message['role']; content: string; ts: number;
  error_code: string | null; retryable: number | null; meta_json: string | null;
}

/**
 * CHAT-SB1（契约 #12）：分叉会话。
 *
 * - `from_message_id` 缺省 = 源会话最后一条消息；给定时按 (ts, id) 取到该消息（含）为止；
 * - 新会话继承 `issue_id / cli / model`（以及未显式改名时的 `title`），**不复制** adapter_session_id、
 *   `session_turn`（plan/审批状态）与运行时态——新会话直接落「已结束」，等用户再发消息才起轮；
 * - 新会话写 `forked_from_session_id` + `fork_message_id`（来源标记）；
 * - 消息复制只搬 role/content/ts/error_code/retryable/meta_json，`turn_id`/`step_id` 置 NULL
 *  （turn 行属于源会话，不能挂到新会话上），源会话消息不动。
 */
export function forkSession(
  db: Db,
  sourceSessionId: string,
  input: { fromMessageId?: string | null; title?: string | null } = {},
): Session {
  const source = getSession(db, sourceSessionId);
  if (!source) throw new NotFoundError('会话不存在');
  const rows = db
    .prepare('SELECT id, role, content, ts, error_code, retryable, meta_json FROM message WHERE session_id = ? ORDER BY ts, id')
    .all(sourceSessionId) as ForkMessageRow[];
  let cutoff = rows.length - 1;
  if (input.fromMessageId !== undefined && input.fromMessageId !== null) {
    cutoff = rows.findIndex((row) => row.id === input.fromMessageId);
    if (cutoff < 0) throw new ValidationError('from_message_id 不属于该会话');
  }
  const copied = cutoff >= 0 ? rows.slice(0, cutoff + 1) : [];
  const id = randomUUID();
  const createdAt = Date.now();
  const forkMessageId = copied.length > 0 ? copied[copied.length - 1]!.id : null;
  const title = input.title === undefined ? source.title ?? null : input.title;
  db.transaction(() => {
    db.prepare(
      `INSERT INTO session (id, workspace_id, issue_id, cli, model, status, adapter_session_id, created_at,
         title, archived_at, forked_from_session_id, fork_message_id)
       VALUES (?, ?, ?, ?, ?, '已结束', NULL, ?, ?, NULL, ?, ?)`,
    ).run(id, source.workspace_id, source.issue_id, source.cli, source.model, createdAt, title, source.id, forkMessageId);
    const insert = db.prepare(
      `INSERT INTO message (id, session_id, role, content, ts, error_code, retryable, turn_id, step_id, meta_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?)`,
    );
    for (const row of copied) {
      insert.run(randomUUID(), id, row.role, row.content, row.ts, row.error_code, row.retryable, row.meta_json);
    }
  })();
  return getSession(db, id)!;
}

/** 删会话行（绑定的 message 由外层显式删，不依赖 FK CASCADE） */
export function deleteSession(db: Db, id: string): void {
  db.prepare('DELETE FROM session WHERE id = ?').run(id);
}
