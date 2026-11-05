import type { Db } from '../connection.js';
import { ensureColumn } from './column.js';

/**
 * CHAT-AWAIT1（契约 #13 / 超时兜底）：阻塞轮次的心跳列。
 *
 * `awaiting_json.at` 记录进入阻塞的时刻（超时从它起算，单一阈值 `TURN_AWAITING_TIMEOUT_MS`）；
 * 本列只记录服务端最近一次心跳，供观测/测试断言「awaiting 期间心跳持续更新」。
 * 纯 `ALTER TABLE ADD COLUMN`（ensureColumn 先查 PRAGMA），不重建 session_turn 表，幂等。
 */
export function migrateSessionAwaiting(db: Db): void {
  ensureColumn(db, 'session_turn', 'awaiting_heartbeat_at', 'awaiting_heartbeat_at INTEGER');
}
