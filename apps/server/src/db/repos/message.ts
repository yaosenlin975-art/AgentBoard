import { randomUUID } from 'node:crypto';
import type { Message, MessageMeta, SessionErrorCode } from '@agentboard/shared';
import type { Db } from '../connection.js';
import { classifySessionError, detectEncodingLost } from '../../services/messageSignals.js';

export interface AddMessageInput {
  session_id: string;
  role: Message['role'];
  content: string;
  /** AUDIT-SRV（F-04）：error 消息的归类码；不传则按 content 现算 */
  error_code?: SessionErrorCode | null;
  retryable?: boolean;
  /** CHAT-TURN1 #6/#7/#8：轮次归属与工具观测；不传即 NULL（历史路径与轮次外消息） */
  turn_id?: string | null;
  step_id?: string | null;
  meta_json?: MessageMeta | null;
}

export function addMessage(db: Db, input: AddMessageInput): Message {
  const signal = classifySessionError(input.content);
  const errorCode = input.error_code ?? (input.role === 'error' ? signal?.code ?? 'UNKNOWN_ERROR' : null);
  const retryable = input.retryable ?? (input.role === 'error' ? signal?.retryable ?? true : undefined);
  const message: Message = {
    id: randomUUID(),
    session_id: input.session_id,
    role: input.role,
    content: input.content,
    ts: Date.now(),
    error_code: errorCode,
    ...(retryable === undefined ? {} : { retryable }),
    turn_id: input.turn_id ?? null,
    step_id: input.step_id ?? null,
    meta_json: input.meta_json ?? null,
  };
  db.prepare(
    `INSERT INTO message (id, session_id, role, content, ts, error_code, retryable, turn_id, step_id, meta_json)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    message.id,
    message.session_id,
    message.role,
    message.content,
    message.ts,
    errorCode,
    retryable === undefined ? null : retryable ? 1 : 0,
    message.turn_id,
    message.step_id,
    message.meta_json === null ? null : JSON.stringify(message.meta_json),
  );
  return message;
}

interface MessageRow {
  id: string; session_id: string; role: Message['role']; content: string; ts: number;
  error_code: string | null; retryable: number | null;
  turn_id: string | null; step_id: string | null; meta_json: string | null;
}

/** meta_json 坏 JSON 按 null 降级：观测列不参与业务判定，不能因为它炸消息列表 */
function parseMeta(raw: string | null): MessageMeta | null {
  if (raw === null || raw === '') return null;
  try {
    return JSON.parse(raw) as MessageMeta;
  } catch {
    return null;
  }
}

/**
 * 读取时补两个派生字段（不写回库）：
 * - `error_code` / `retryable`：存量 error 行没有归类列，按 content 现算兜底；
 * - `encoding_lost`：AUDIT-SRV（F-06）「原始编码不可用」标记。
 * CHAT-TURN1 的三个新列是实列，直接透传；老消息为 NULL → 前端沿用旧渲染（验收 5）。
 */
function toMessage(row: MessageRow): Message {
  const signal = row.role === 'error' ? classifySessionError(row.content) : null;
  const errorCode = (row.error_code ?? signal?.code ?? (row.role === 'error' ? 'UNKNOWN_ERROR' : null)) as SessionErrorCode | null;
  const retryable = row.retryable === null
    ? (row.role === 'error' ? signal?.retryable ?? true : undefined)
    : row.retryable === 1;
  return {
    id: row.id,
    session_id: row.session_id,
    role: row.role,
    content: row.content,
    ts: row.ts,
    error_code: errorCode,
    ...(retryable === undefined ? {} : { retryable }),
    encoding_lost: detectEncodingLost(row.content),
    turn_id: row.turn_id,
    step_id: row.step_id,
    meta_json: parseMeta(row.meta_json),
  };
}

/** after 之后的消息，ts 升序（after=0 即全量） */
export function listMessagesBySession(db: Db, sessionId: string, after = 0): Message[] {
  const rows = db
    .prepare('SELECT * FROM message WHERE session_id = ? AND ts > ? ORDER BY ts, id')
    .all(sessionId, after) as MessageRow[];
  return rows.map(toMessage);
}

/**
 * AUDIT-SRV（F-03）：一次查回多个会话的首条 user 消息（会话列表预览用，避免 N+1）。
 * 空数组直接返回空 Map（`IN ()` 在 SQLite 里是语法错误）。
 */
export function listFirstUserMessages(db: Db, sessionIds: string[]): Map<string, string> {
  if (sessionIds.length === 0) return new Map();
  const placeholders = sessionIds.map(() => '?').join(',');
  const rows = db
    .prepare(`SELECT session_id, content FROM (
        SELECT session_id, content, ROW_NUMBER() OVER (PARTITION BY session_id ORDER BY ts, id) AS rn
        FROM message WHERE role = 'user' AND session_id IN (${placeholders})
      ) WHERE rn = 1`)
    .all(...sessionIds) as Array<{ session_id: string; content: string }>;
  return new Map(rows.map((row) => [row.session_id, row.content]));
}

/** 删某会话全部消息（issue 删除级联清理用，显式 DELETE 不依赖 FK CASCADE） */
export function deleteMessagesBySession(db: Db, sessionId: string): void {
  db.prepare('DELETE FROM message WHERE session_id = ?').run(sessionId);
}

/**
 * CHAT-TURN1 #8：步骤结束时回填工具观测（耗时/成败）。
 * 工具消息在事件到达时先落库（status=ok、duration_ms=null），CLI 侧没有结果回调，
 * 所以耗时与失败只能在「下一步开始 / 轮次收尾」时按可观测信号补写。
 */
export function updateMessageMeta(db: Db, messageId: string, meta: MessageMeta): void {
  db.prepare('UPDATE message SET meta_json = ? WHERE id = ?').run(JSON.stringify(meta), messageId);
}

/**
 * CHAT-TURN1 #6：把发送时先落库的 user 消息挂到后建好的轮次上
 * （user 行必须先落库以保证排队/合并语义，turn 行则在真正起轮时才建）。空数组直接返回。
 */
export function linkMessagesToTurn(db: Db, messageIds: string[], turnId: string): void {
  if (messageIds.length === 0) return;
  const placeholders = messageIds.map(() => '?').join(',');
  db.prepare(`UPDATE message SET turn_id = ? WHERE id IN (${placeholders}) AND turn_id IS NULL`)
    .run(turnId, ...messageIds);
}
