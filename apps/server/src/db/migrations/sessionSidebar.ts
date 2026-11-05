import type { Db } from '../connection.js';
import { ensureColumn } from './column.js';

/**
 * CHAT-SB1（契约 #1–4）：聊天侧栏会话字段。
 *
 * - `session.title` 已由 `migrateSessionTitle`（35a0d755）加过，这里只补三列；
 * - `archived_at INTEGER NULL`：NULL=未归档，默认会话列表排除归档行；
 * - `forked_from_session_id` / `fork_message_id`：分叉来源，仅用于来源标记，无回填。
 *
 * 纯 `ALTER TABLE ADD COLUMN`（`ensureColumn` 先查 PRAGMA），不重建 session 表，
 * 老库可重复执行（验收 1：重复迁移幂等），存量行保持 NULL。
 */
export function migrateSessionSidebar(db: Db): void {
  ensureColumn(db, 'session', 'archived_at', 'archived_at INTEGER');
  ensureColumn(db, 'session', 'forked_from_session_id', 'forked_from_session_id TEXT');
  ensureColumn(db, 'session', 'fork_message_id', 'fork_message_id TEXT');
}
