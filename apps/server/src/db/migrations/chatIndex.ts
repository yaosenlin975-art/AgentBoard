import type { Db } from '../connection.js';

/**
 * CR2-2：聊天热表索引 `message(session_id)`、`session(workspace_id)`。
 *
 * `message` 原先只有 `id` 主键，按会话取消息的每次查询都是全表扫描；`session` 按
 * 工作区列会话（侧栏列表、级联清理定位）同理。补索引后查询计划由
 * `SCAN message` / `SCAN session` 变 `SEARCH … USING INDEX idx_message_session` / `idx_session_workspace`。
 *
 * `CREATE INDEX IF NOT EXISTS` 幂等，新旧库收敛到同一结构；不改列定义、不重建表。
 * 回滚：DROP INDEX idx_message_session / idx_session_workspace（行为不变，仅退化为全表扫描）。
 */
export function migrateChatIndex(db: Db): void {
  db.exec('CREATE INDEX IF NOT EXISTS idx_message_session ON message(session_id)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_session_workspace ON session(workspace_id)');
}
