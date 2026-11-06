import type { Db } from '../connection.js';
import { ensureColumn } from './column.js';

/**
 * DEP-1：任务依赖边表（blocked ← blocker）+ 同工作区/防环兜底触发器。
 * BORROW-2.1：依赖边带类型 relation ∈ blocks/related/duplicate——环检测只对 blocks 生效，
 * related/duplicate 是纯标注边，不参与 claim 门禁、计数与环判定。
 *
 * 幂等依据：`CREATE TABLE/INDEX IF NOT EXISTS` + ensureColumn 幂等加列 + 环检测触发器 DROP+CREATE
 * （可重复执行，老库每次收敛到最新定义；same_workspace 触发器定义未变，维持 IF NOT EXISTS）。
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
      relation TEXT NOT NULL DEFAULT 'blocks' CHECK (relation IN ('blocks','related','duplicate')),
      blocked_reason   TEXT,
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
  `);
  // BORROW-2.1：存量库补 relation 列（旧行统一 DEFAULT 'blocks'，数据等价迁移）
  ensureColumn(db, 'issue_dependency', 'relation', "relation TEXT NOT NULL DEFAULT 'blocks' CHECK (relation IN ('blocks','related','duplicate'))");
  // DEC-V4-API-DEP：存量库补 blocked_reason 列（可空，存量行保持 NULL；重复执行 no-op）
  ensureColumn(db, 'issue_dependency', 'blocked_reason', 'blocked_reason TEXT');
  // 环检测：只在插 blocks 边时触发，递归也只沿 blocks 边走（related/duplicate 不构成阻塞环）。
  // DROP+CREATE 而非 IF NOT EXISTS：老库里的旧定义（无 relation 过滤）必须被替换。
  db.exec(`
    DROP TRIGGER IF EXISTS issue_dependency_no_cycle;
    CREATE TRIGGER issue_dependency_no_cycle
      BEFORE INSERT ON issue_dependency
      WHEN new.relation = 'blocks' AND EXISTS (
        WITH RECURSIVE ancestors(id) AS (
          SELECT blocker_issue_id FROM issue_dependency WHERE blocked_issue_id = new.blocker_issue_id AND relation = 'blocks'
          UNION
          SELECT d.blocker_issue_id FROM issue_dependency d JOIN ancestors a ON d.blocked_issue_id = a.id
          WHERE d.relation = 'blocks'
        )
        SELECT 1 FROM ancestors WHERE id = new.blocked_issue_id
      )
      BEGIN SELECT RAISE(ABORT,'issue dependency cycle'); END;
  `);
}
