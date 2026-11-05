import type { Db } from '../connection.js';

/**
 * BORROW-4.1：幂等记录加工作区作用域与 effect_state。
 * - 主键 (workspace_id, request_id)：同一 Idempotency-Key 在不同工作区互不串号（各记各账）。
 * - effect_state：副作用阶段。'pending'=已记账、副作用未定稿（重放 409 OPERATION_UNKNOWN）；
 *   'applied'=副作用已生效（重放返回结果）。effect_pending 列保留为兼容派生列，与 effect_state 同步写。
 * - 旧行 workspace_id 回填 ''（空值=升级前的全局作用域）：带工作区的新查询查不到时回退旧行，保证旧重放仍命中。
 */
const IDEMPOTENCY_TABLE_DDL = `CREATE TABLE IF NOT EXISTS idempotency_record (
  workspace_id TEXT NOT NULL DEFAULT '',
  request_id TEXT NOT NULL, actor_id TEXT NOT NULL, action TEXT NOT NULL, resource TEXT NOT NULL,
  payload_hash TEXT NOT NULL, response_json TEXT NOT NULL, effect_pending INTEGER NOT NULL DEFAULT 0,
  effect_state TEXT NOT NULL DEFAULT 'applied',
  created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL,
  PRIMARY KEY (workspace_id, request_id));`;

interface TableInfoRow { name: string; pk: number }

const tableColumns = (db: Db): TableInfoRow[] =>
  db.prepare('PRAGMA table_info(idempotency_record)').all() as TableInfoRow[];

/** 旧表判据：主键首列仍是 request_id（新结构主键首列是 workspace_id）→ 需要重建 */
function needsWorkspaceScopeRebuild(db: Db): boolean {
  const pkColumns = tableColumns(db)
    .filter((column) => column.pk > 0)
    .sort((a, b) => a.pk - b.pk)
    .map((column) => column.name);
  return pkColumns[0] !== 'workspace_id';
}

export function migrateIdempotency(db: Db): void {
  db.exec(`${IDEMPOTENCY_TABLE_DDL}
    CREATE INDEX IF NOT EXISTS idempotency_expiry ON idempotency_record(expires_at);`);
  if (!needsWorkspaceScopeRebuild(db)) return;

  // 旧表升级（全新库走上面的 DDL 直接是新结构，不会进这里）：建新表 → 搬数据 → drop → rename，
  // 全程一个事务，失败整体回滚；重入判据是主键首列，重建完成后本迁移变为 no-op。
  const existingColumns = new Set(tableColumns(db).map((column) => column.name));
  const workspaceExpr = existingColumns.has('workspace_id') ? 'workspace_id' : `''`;
  db.transaction(() => {
    db.exec('DROP TABLE IF EXISTS idempotency_record_rebuild;');
    db.exec(`CREATE TABLE idempotency_record_rebuild (
      workspace_id TEXT NOT NULL DEFAULT '',
      request_id TEXT NOT NULL, actor_id TEXT NOT NULL, action TEXT NOT NULL, resource TEXT NOT NULL,
      payload_hash TEXT NOT NULL, response_json TEXT NOT NULL, effect_pending INTEGER NOT NULL DEFAULT 0,
      effect_state TEXT NOT NULL DEFAULT 'applied',
      created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL,
      PRIMARY KEY (workspace_id, request_id));`);
    // effect_state 从 effect_pending 派生（pending=1 → 'pending'，否则 'applied'），不信任半途残留列
    db.exec(`INSERT INTO idempotency_record_rebuild
      (workspace_id, request_id, actor_id, action, resource, payload_hash, response_json, effect_pending, effect_state, created_at, expires_at)
      SELECT ${workspaceExpr}, request_id, actor_id, action, resource, payload_hash, response_json, effect_pending,
             CASE WHEN effect_pending=1 THEN 'pending' ELSE 'applied' END, created_at, expires_at
      FROM idempotency_record`);
    db.exec('DROP TABLE idempotency_record;');
    db.exec('ALTER TABLE idempotency_record_rebuild RENAME TO idempotency_record;');
    db.exec('CREATE INDEX IF NOT EXISTS idempotency_expiry ON idempotency_record(expires_at);');
  })();
}
