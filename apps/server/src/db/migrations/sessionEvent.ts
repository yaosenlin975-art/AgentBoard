import type { Db } from '../connection.js';

/**
 * BORROW-4.2：会话事件流（增量拉取 / 回放底稿）。
 *
 * 纯追加表，幂等：`(session_id, seq)` 主键天然承担翻页索引（after_seq 走主键区间扫描），
 * 不额外建重复索引。seq 按会话单调递增，由写入方（services/sessionManager）在同一次同步写里分配。
 * 老库没有历史事件：读取返回空列表即可，不回填（message 表仍是消息的唯一事实源）。
 */
export function migrateSessionEvent(db: Db): void {
  db.exec(`
CREATE TABLE IF NOT EXISTS session_event (
  session_id TEXT NOT NULL REFERENCES session(id) ON DELETE CASCADE,
  seq INTEGER NOT NULL,
  type TEXT NOT NULL,
  payload TEXT NOT NULL DEFAULT '{}',
  created_at INTEGER NOT NULL,
  PRIMARY KEY (session_id, seq));
`);
}
