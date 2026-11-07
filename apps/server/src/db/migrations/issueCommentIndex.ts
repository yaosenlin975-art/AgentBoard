import type { Db } from '../connection.js';

/**
 * PERF-5：`issue_comment(issue_id)` 索引。
 *
 * `GET /api/issues` 的 `comment_count` 是逐行相关子查询
 * `(SELECT COUNT(*) FROM issue_comment c WHERE c.issue_id = i.id)`；`issue_comment` 原先只有 `id` 主键，
 * 每行一次全表扫描 → 663 行实测 p50 401ms（加 comment_count 前 10–25ms）。
 * 补索引后查询计划由 `SCAN c` 变 `SEARCH c USING COVERING INDEX idx_issue_comment_issue`，p50 1.2ms。
 *
 * `CREATE INDEX IF NOT EXISTS` 幂等，新旧库收敛到同一结构；不改列定义、不重建表。
 * 回滚：DROP INDEX idx_issue_comment_issue（未删评论的场景下行为不变，仅退化为全表扫描）。
 */
export function migrateIssueCommentIndex(db: Db): void {
  db.exec('CREATE INDEX IF NOT EXISTS idx_issue_comment_issue ON issue_comment(issue_id)');
}
