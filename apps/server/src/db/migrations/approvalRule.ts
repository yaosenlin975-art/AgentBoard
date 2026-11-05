import type { Db } from '../connection.js';

/**
 * CHAT-APP1（契约 #9）：三档确认的规则表。
 *
 * 口径：
 * - `scope` 只存落库的两档（`task` / `workspace`）；`once` 只批当前请求，不写规则；
 * - `issue_id` 由 `task` 档写入、`workspace` 档恒 NULL；`session_id` / `turn_id` 仅记录规则来源；
 * - 唯一索引只约束**未撤销**规则：`(scope, workspace_id, COALESCE(issue_id,''), tool_name, match_key)`。
 *   `COALESCE` 让 `issue_id IS NULL` 的工作区档同键也受约束（SQLite 唯一索引里 NULL 互不相等）；
 *   部分索引 `WHERE revoked_at IS NULL` 让撤销后同键可以再建，历史行保留作审计。
 *
 * 幂等：`CREATE TABLE/INDEX IF NOT EXISTS`，可重复执行；本表只增不改，无回填。
 */
export function migrateApprovalRule(db: Db): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS approval_rule (
      id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
      issue_id TEXT REFERENCES issue(id) ON DELETE CASCADE,
      session_id TEXT REFERENCES session(id) ON DELETE SET NULL,
      turn_id TEXT REFERENCES session_turn(id) ON DELETE SET NULL,
      tool_name TEXT NOT NULL,
      match_key TEXT NOT NULL,
      scope TEXT NOT NULL CHECK (scope IN ('task','workspace')),
      created_at INTEGER NOT NULL,
      created_by TEXT NOT NULL,
      revoked_at INTEGER);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_approval_rule_active
      ON approval_rule(scope, workspace_id, COALESCE(issue_id, ''), tool_name, match_key)
      WHERE revoked_at IS NULL;
  `);
}
