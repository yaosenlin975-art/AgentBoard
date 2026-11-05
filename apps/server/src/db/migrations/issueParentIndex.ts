import type { Db } from '../connection.js';

/**
 * STORE-3a：issue 自引用外键 `parent_issue_id`（ON DELETE RESTRICT）补子列索引。
 *
 * 没有它，SQLite 删任何父任务都要全表扫描 issue 找子行（FK RESTRICT 的存在性检查没有索引可用），
 * 删除代价 O(n²)：万卡 15s、十万卡分钟级——localize switch / revert copy_back 的整仓清场、
 * 以及普通的删卡操作全部踩中。`CREATE INDEX IF NOT EXISTS` 幂等，新旧库收敛到同一结构。
 *
 * 回滚：DROP INDEX idx_issue_parent（恢复无索引；删除重新退化为 O(n²)）。
 */
export function migrateIssueParentIndex(db: Db): void {
  db.exec('CREATE INDEX IF NOT EXISTS idx_issue_parent ON issue(parent_issue_id)');
}
