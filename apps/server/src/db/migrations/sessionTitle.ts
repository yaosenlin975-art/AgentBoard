import type { Db } from '../connection.js';
import { ensureColumn } from './column.js';

/**
 * 聊天会话级标题（重命名）。
 * 幂等加列，不重建 session 表（避免丢消息/占用关系）；存量行保持 NULL，
 * 读取端在 title 为 NULL 时继续走既有派生规则（任务会话取 issue.title、自由会话取 `cli · model`）。
 */
export function migrateSessionTitle(db: Db): void {
  ensureColumn(db, 'session', 'title', 'title TEXT');
}
