import type { Db } from '../connection.js';

/**
 * WS-REORDER：workspace 增加展示顺序列。
 *
 * 幂等依据：先 `PRAGMA table_info(workspace)` 判列；列已存在 → 整段跳过（不重复回填，用户拖拽顺序不被迁移覆盖）。
 * 缺列时在同一事务内加列并按 `(created_at, id)` 升序回填 `0..n-1`，避免「列已加、回填未完成」的中断态。
 *
 * 回滚（单列、无索引/外键依赖，SQLite ≥ 3.35 支持 DROP COLUMN）：
 *   ALTER TABLE workspace DROP COLUMN sort_order;
 */
export function migrateWorkspaceOrder(db: Db): void {
  const columns = db.prepare('PRAGMA table_info(workspace)').all() as Array<{ name: string }>;
  if (columns.some(column => column.name === 'sort_order')) return;
  db.transaction(() => {
    db.exec('ALTER TABLE workspace ADD COLUMN sort_order INTEGER NOT NULL DEFAULT 0');
    db.exec(`WITH ordered AS (SELECT id, ROW_NUMBER() OVER (ORDER BY created_at, id) - 1 AS rn FROM workspace)
      UPDATE workspace SET sort_order=(SELECT rn FROM ordered WHERE ordered.id = workspace.id)`);
  }).immediate();
}
