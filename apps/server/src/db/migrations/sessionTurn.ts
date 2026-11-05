import type { Db } from '../connection.js';
import { ensureColumn } from './column.js';

/**
 * CHAT-TURN1（契约 #5–8）：轮次与观测底座。
 *
 * - 新表 `session_turn`：一轮 = 一次适配器 runTurn（`seq` 会话内递增），承载 plan / awaiting / usage。
 *   唯一写入方是服务端 `sessionManager`（经 `services/turnObservation.ts`），前端只读。
 * - `message.turn_id` / `message.step_id` / `message.meta_json`：纯加列，不重建 message 表
 *   （重建会带走既有 `error_code` / `retryable` 列与全部消息）。
 *
 * 幂等口径（验收 1）：`CREATE TABLE/INDEX IF NOT EXISTS` + `ensureColumn`（先查 PRAGMA table_info 再加列），
 * 老库可重复执行；历史轮次**不回填**——存量 message 的三个新列恒为 NULL，存量会话没有 turn 行，
 * 旧路径（消息列表、EventGroup 渲染）行为不变。
 * 回滚：新列/新表留着不影响旧路径，只需停用新 UI；确要清理 `DROP TABLE IF EXISTS session_turn;`
 * （`ALTER TABLE ... DROP COLUMN` 只在 3.35+ 可用，且旧行数据无需回滚，故不提供）。
 */
export function migrateSessionTurn(db: Db): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS session_turn (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL REFERENCES session(id) ON DELETE CASCADE,
      seq INTEGER NOT NULL,
      state TEXT NOT NULL CHECK (state IN ('running','awaiting_input','awaiting_approval','failed','done','stopped')),
      current_index INTEGER NOT NULL DEFAULT -1,
      plan_json TEXT,
      awaiting_json TEXT,
      usage_json TEXT,
      started_at INTEGER NOT NULL,
      ended_at INTEGER);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_session_turn_session_seq ON session_turn(session_id, seq);
  `);
  ensureColumn(db, 'message', 'turn_id', 'turn_id TEXT');
  ensureColumn(db, 'message', 'step_id', 'step_id TEXT');
  ensureColumn(db, 'message', 'meta_json', 'meta_json TEXT');
}
