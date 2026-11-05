import type { Db } from '../connection.js';
import { ensureColumn } from './column.js';

/**
 * BORROW-4.3：会话暂停标记。
 *
 * `paused_at` 非空即视为暂停（值为暂停时刻毫秒）；`session.status` 语义完全不变
 * （仍是 运行中 | 已结束 | 失败），读接口另给派生字段 `paused`，调用方不必自己猜。
 *
 * 纯 `ALTER TABLE ADD COLUMN`（ensureColumn 先查 PRAGMA）——**不重建 session 表**：
 * message / session_turn / session_event 都有 FK 指向 session，SQLite 重建有级联清空风险
 * （同工作区行只能 UPDATE 镜像的教训）。幂等：连跑两次结果一致，老库自动补列，存量行保持 NULL。
 */
export function migrateSessionPaused(db: Db): void {
  ensureColumn(db, 'session', 'paused_at', 'paused_at INTEGER');
}
