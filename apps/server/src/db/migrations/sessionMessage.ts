import type { Db } from '../connection.js';
import { ensureColumn } from './column.js';

/**
 * AUDIT-SRV（F-04）：会话消息的错误归类列。
 *
 * - `error_code`：服务端归类后的错误码（QUOTA_EXCEEDED / RATE_LIMITED / AUTH_FAILED / CONTEXT_OVERFLOW / UNKNOWN_ERROR）；
 *   非 error 消息为 NULL。
 * - `retryable`：该错误是否值得重试（1/0，NULL = 未归类）。
 *
 * 存量行保持 NULL：读取时按 content 现算兜底（`repos/message.ts`），不写回、不迁移数据。
 */
export function migrateSessionMessageSignals(db: Db): void {
  ensureColumn(db, 'message', 'error_code', 'error_code TEXT');
  ensureColumn(db, 'message', 'retryable', 'retryable INTEGER');
}
