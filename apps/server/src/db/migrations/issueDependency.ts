import type { Db } from '../connection.js';

/**
 * DEP-1：任务依赖边表（blocked ← blocker）+ 同工作区/防环兜底触发器。
 *
 * 幂等依据：`CREATE TABLE/INDEX/TRIGGER IF NOT EXISTS`，可重复执行。
 * 回滚（表内只有依赖数据，删除不影响其它表）：
 *   DROP TABLE IF EXISTS issue_dependency;  -- 索引与触发器随表删除
 * 口径：服务层先判错误码（400/404/409），触发器只兜底绕过服务层直接写库的路径。
 * 自环由 `CHECK` + 服务层 400 负责，不另建触发器。
 */
export function migrateIssueDependency(db: Db): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS issue_dependency (
      blocked_issue_id TEXT NOT NULL REFERENCES issue(id) ON DELETE CASCADE,
      blocker_issue_id TEXT NOT NULL REFERENCES issue(id) ON DELETE CASCADE,
      created_at       INTEGER NOT NULL,
      PRIMARY KEY (blocked_issue_id, blocker_issue_id),
      CHECK (blocked_issue_id <> blocker_issue_id)
    );
    CREATE INDEX IF NOT EXISTS idx_issue_dep_blocker ON issue_dependency(blocker_issue_id);

    CREATE TRIGGER IF NOT EXISTS issue_dependency_same_workspace
      BEFORE INSERT ON issue_dependency
      WHEN NOT EXISTS (
        SELECT 1 FROM issue blocked JOIN issue blocker ON blocker.id = new.blocker_issue_id
        WHERE blocked.id = new.blocked_issue_id AND blocked.workspace_id = blocker.workspace_id
      )
      BEGIN SELECT RAISE(ABORT,'issue dependency workspace mismatch'); END;

    CREATE TRIGGER IF NOT EXISTS issue_dependency_no_cycle
      BEFORE INSERT ON issue_dependency
      WHEN EXISTS (
        WITH RECURSIVE ancestors(id) AS (
          SELECT blocker_issue_id FROM issue_dependency WHERE blocked_issue_id = new.blocker_issue_id
          UNION
          SELECT d.blocker_issue_id FROM issue_dependency d JOIN ancestors a ON d.blocked_issue_id = a.id
        )
        SELECT 1 FROM ancestors WHERE id = new.blocked_issue_id
      )
      BEGIN SELECT RAISE(ABORT,'issue dependency cycle'); END;
  `);
}
