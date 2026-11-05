import type { Db } from '../connection.js';

/**
 * ACC-CLI-MULTI（口径 A）：CLI 额度来源的本机凭据登记表。
 *
 * 为什么独立于 `managed_account`：后者 `app_id` 的 CHECK 只允许 6 个桌面平台，且身份/快照/签到
 * 语义都绑在桌面客户端登录态上；复用会要求重建表并污染这两套语义。
 *
 * ACC-CC-3：`app_id` 增 `commandcode`。SQLite 改不了 CHECK，只能重建表：
 * - 幂等：先看 `sqlite_master` 里的现有 SQL，已含 `'commandcode'` 直接返回（连跑多次结果一致）；
 * - 不丢行：重建前记录行数，INSERT 后比对，不一致直接抛错（事务自动回滚）；
 * - 旧行原样搬移（同列同序），只在 CHECK 上放宽一个枚举值。
 */
const CLI_APP_ID_VALUES = "'deepseek','opencode_go','codex','commandcode'";

export function migrateCliAccounts(db: Db): void {
  db.exec(`
CREATE TABLE IF NOT EXISTS cli_account (
  id TEXT PRIMARY KEY,
  app_id TEXT NOT NULL CHECK (app_id IN (${CLI_APP_ID_VALUES})),
  identity_hash TEXT NOT NULL,
  credential_ref TEXT,
  created_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL);
CREATE UNIQUE INDEX IF NOT EXISTS cli_account_identity ON cli_account(app_id, identity_hash);
`);

  const existing = db
    .prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='cli_account'")
    .get() as { sql: string | null } | undefined;
  const sql = existing?.sql ?? '';
  // 新库由上面的 DDL 直接建成最新结构；老库（CHECK 只有三值）走重建。
  if (sql.includes("'commandcode'")) return;
  if (sql.length === 0) return;

  const countRows = (): number =>
    (db.prepare('SELECT COUNT(*) AS n FROM cli_account').get() as { n: number }).n;
  const before = countRows();

  db.transaction(() => {
    db.exec(`
CREATE TABLE cli_account_next (
  id TEXT PRIMARY KEY,
  app_id TEXT NOT NULL CHECK (app_id IN (${CLI_APP_ID_VALUES})),
  identity_hash TEXT NOT NULL,
  credential_ref TEXT,
  created_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL);
INSERT INTO cli_account_next (id,app_id,identity_hash,credential_ref,created_at,last_seen_at)
  SELECT id,app_id,identity_hash,credential_ref,created_at,last_seen_at FROM cli_account;
`);
    const copied = (db.prepare('SELECT COUNT(*) AS n FROM cli_account_next').get() as { n: number }).n;
    if (copied !== before) {
      throw new Error(`cli_account 重建中止：行数不一致（重建前 ${before}，拷贝后 ${copied}）`);
    }
    db.exec(`
DROP TABLE cli_account;
ALTER TABLE cli_account_next RENAME TO cli_account;
CREATE UNIQUE INDEX IF NOT EXISTS cli_account_identity ON cli_account(app_id, identity_hash);
`);
  })();
}
