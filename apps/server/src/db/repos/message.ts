import { randomUUID } from 'node:crypto';
import type { Message } from '@agentboard/shared';
import type { Db } from '../connection.js';

export interface AddMessageInput {
  session_id: string;
  role: Message['role'];
  content: string;
}

export function addMessage(db: Db, input: AddMessageInput): Message {
  const message: Message = {
    id: randomUUID(),
    session_id: input.session_id,
    role: input.role,
    content: input.content,
    ts: Date.now(),
  };
  db.prepare('INSERT INTO message (id, session_id, role, content, ts) VALUES (?, ?, ?, ?, ?)').run(
    message.id,
    message.session_id,
    message.role,
    message.content,
    message.ts,
  );
  return message;
}

/** after 之后的消息，ts 升序（after=0 即全量） */
export function listMessagesBySession(db: Db, sessionId: string, after = 0): Message[] {
  return db
    .prepare('SELECT * FROM message WHERE session_id = ? AND ts > ? ORDER BY ts, id')
    .all(sessionId, after) as Message[];
}
