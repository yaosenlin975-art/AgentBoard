import type { Db } from '../connection.js';

/**
 * BORROW-4.2：会话事件流仓储。
 *
 * 语义约定（给读取方）：
 * - `seq` 按会话单调递增，从 1 开始，无空洞（除非写入失败后人工修复）；
 * - `payload` 是写入时的快照，读取时坏 JSON 降级为 null（事件流不参与业务判定，不能因此炸列表）；
 * - 老会话（本表上线前创建）没有事件，返回空数组，不回填 message。
 */
export interface SessionEvent {
  session_id: string;
  seq: number;
  type: string;
  payload: unknown;
  created_at: number;
}

interface SessionEventRow {
  session_id: string;
  seq: number;
  type: string;
  payload: string;
  created_at: number;
}

function parsePayload(raw: string): unknown {
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return null;
  }
}

function toEvent(row: SessionEventRow): SessionEvent {
  return {
    session_id: row.session_id,
    seq: row.seq,
    type: row.type,
    payload: parsePayload(row.payload),
    created_at: row.created_at,
  };
}

/**
 * 追加一条会话事件并返回落库结果。
 *
 * `SELECT MAX(seq) + 1` 与 `INSERT` 在 better-sqlite3 的同一次同步调用链内完成，
 * Node 单线程不会插入其他写入，所以 seq 不会重复/回退。调用方应保证「先写 message，
 * 再写事件」，这样事件顺序与消息顺序一致；事件丢失时可用 message 表按 ts 重放。
 */
export function appendSessionEvent(
  db: Db,
  sessionId: string,
  type: string,
  payload: unknown,
): SessionEvent {
  const { seq } = db
    .prepare('SELECT COALESCE(MAX(seq), 0) + 1 AS seq FROM session_event WHERE session_id = ?')
    .get(sessionId) as { seq: number };
  const created_at = Date.now();
  db.prepare(
    'INSERT INTO session_event (session_id, seq, type, payload, created_at) VALUES (?, ?, ?, ?, ?)',
  ).run(sessionId, seq, type, JSON.stringify(payload ?? null), created_at);
  return { session_id: sessionId, seq, type, payload: payload ?? null, created_at };
}

/** `after_seq` 之后的全部事件，seq 升序（after_seq=0 即全量） */
export function listSessionEvents(db: Db, sessionId: string, afterSeq = 0): SessionEvent[] {
  const rows = db
    .prepare('SELECT * FROM session_event WHERE session_id = ? AND seq > ? ORDER BY seq')
    .all(sessionId, afterSeq) as SessionEventRow[];
  return rows.map(toEvent);
}

/**
 * BORROW-4.3：会话事件流的当前最大 seq（无事件 = 0）。
 * 恢复会话时作为「从这里之后继续」的锚点：暂停/恢复本身也是事件行，
 * 已完成步骤的 seq 全部 ≤ 该值，客户端 `after_seq` 拉取不会重放旧内容。
 */
export function lastSessionEventSeq(db: Db, sessionId: string): number {
  const row = db
    .prepare('SELECT COALESCE(MAX(seq), 0) AS seq FROM session_event WHERE session_id = ?')
    .get(sessionId) as { seq: number };
  return row.seq;
}
