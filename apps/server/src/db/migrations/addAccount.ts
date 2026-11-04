import type { Db } from '../connection.js';

/**
 * ACC-KB-B2S：协议级「添加账号」的授权会话表（纯追加表，不改既有 pinned DDL）。
 *
 * 幂等依据：表与索引全部 `IF NOT EXISTS`，重复执行只做存在性判断，不写数据、不改列；
 * `initSchema` 每次启动都调用本迁移，因此「新库首次建表后结构」必须等于「重复启动后结构」。
 *
 * 表里**不放任何凭据**：待激活凭据（device_code / PKCE verifier / poll token 等）只在 vault
 * （purpose=`pending_credential`），本表只存 `pending_secret_ref` 与其 sha256；
 * `pending_secret_hash` 用于校验「拿出来的密文是不是这一条会话的」，不用于反查原文。
 *
 * 回滚步骤（按依赖顺序执行，均在事务外）：
 *   DROP INDEX IF EXISTS add_account_session_account;
 *   DROP INDEX IF EXISTS add_account_session_open;
 *   DROP TABLE IF EXISTS add_account_session;
 * `managed_account` 未被修改；回滚后 vault 里可能残留 purpose=pending_credential 的文件，
 * 需由调用方按 ref 清理（本迁移不触碰文件与凭据）。
 */
export function migrateAddAccount(db: Db): void {
  db.exec(`CREATE TABLE IF NOT EXISTS add_account_session (
    id TEXT PRIMARY KEY,
    app_id TEXT NOT NULL CHECK(app_id IN ('workbuddy_desktop','codebuddy_desktop','minimax','trae','qoder_cn','zcode')),
    protocol TEXT NOT NULL CHECK(protocol IN ('minimax_device','zcode_cli','qoder_device','workbuddy_oneid','trae_oauth')),
    status TEXT NOT NULL CHECK(status IN ('pending','authorized','failed','expired','cancelled')),
    service_region TEXT NOT NULL CHECK(service_region IN ('cn','global','unknown')),
    client_instance_id TEXT NOT NULL,
    authorization_url TEXT,
    user_code TEXT,
    pending_secret_hash TEXT NOT NULL,
    pending_secret_ref TEXT,
    account_id TEXT REFERENCES managed_account(id) ON DELETE SET NULL,
    safe_error_code TEXT,
    created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, expires_at INTEGER NOT NULL);
  CREATE UNIQUE INDEX IF NOT EXISTS add_account_session_open ON add_account_session(app_id) WHERE status='pending';
  CREATE INDEX IF NOT EXISTS add_account_session_account ON add_account_session(account_id);`);
}
