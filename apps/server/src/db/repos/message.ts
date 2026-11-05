import { randomUUID } from 'node:crypto';
import type { Message, SessionErrorCode } from '@agentboard/shared';
import type { Db } from '../connection.js';
import { classifySessionError, detectEncodingLost } from '../../services/messageSignals.js';

export interface AddMessageInput {
  session_id: string;
  role: Message['role'];
  content: string;
  /** AUDIT-SRV（F-04）：error 消息的归类码；不传则按 content 现算 */
  error_code?: SessionErrorCode | null;
  retryable?: boolean;
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
  };
  db.prepare('INSERT INTO message (id, session_id, role, content, ts, error_code, retryable) VALUES (?, ?, ?, ?, ?, ?, ?)').run(
    message.id,
    message.session_id,
    message.role,
    message.content,
    message.ts,
    errorCode,
    retryable === undefined ? null : retryable ? 1 : 0,
  );
  return message;
}

interface MessageRow {
  id: string; session_id: string; role: Message['role']; content: string; ts: number;
  error_code: string | null; retryable: number | null;
}

/**
 * 读取时补两个派生字段（不写回库）：
 * - `error_code` / `retryable`：存量 error 行没有归类列，按 content 现算兜底；
 * - `encoding_lost`：AUDIT-SRV（F-06）「原始编码不可用」标记。
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
