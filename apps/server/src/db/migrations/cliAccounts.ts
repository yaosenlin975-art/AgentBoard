import type { Db } from '../connection.js';

/**
 * ACC-CLI-MULTI（口径 A）：CLI 额度来源的本机凭据登记表。
 *
 * 为什么独立于 `managed_account`：后者 `app_id` 的 CHECK 只允许 6 个桌面平台，且身份/快照/签到
 * 语义都绑在桌面客户端登录态上；复用会要求重建表并污染这两套语义。
 *
 * 纯追加表：`CREATE TABLE/INDEX IF NOT EXISTS`，可重复执行；老库缺表时自动建，已有数据不动。
 * `UNIQUE(app_id, identity_hash)` 就是去重口径：同一来源内同一身份只登记一条。
 */
export function migrateCliAccounts(db: Db): void {
  db.exec(`
CREATE TABLE IF NOT EXISTS cli_account (
  id TEXT PRIMARY KEY,
  app_id TEXT NOT NULL CHECK (app_id IN ('deepseek','opencode_go','codex')),
  identity_hash TEXT NOT NULL,
  credential_ref TEXT,
  created_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL);
CREATE UNIQUE INDEX IF NOT EXISTS cli_account_identity ON cli_account(app_id, identity_hash);
`);
}
