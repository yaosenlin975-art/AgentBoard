import type { Db } from '../connection.js';

/**
 * GIT-ON-DONE：claim 时记一份 git 基线快照（path → 内容指纹），done 时 diff 出本任务改动并只提交这些文件。
 *
 * 幂等依据：`CREATE TABLE / INDEX IF NOT EXISTS`，可重复执行。
 * 回滚（表内只有本功能数据，删除不影响其它表，`issue` 删除靠 CASCADE 已先行）：
 *   DROP INDEX IF EXISTS idx_issue_git_baseline_ws;
 *   DROP TABLE IF EXISTS issue_git_baseline;
 */
export function migrateIssueGitBaseline(db: Db): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS issue_git_baseline (
      issue_id     TEXT PRIMARY KEY REFERENCES issue(id) ON DELETE CASCADE,
      workspace_id TEXT NOT NULL,
      head_sha     TEXT,
      paths_json   TEXT NOT NULL,
      file_count   INTEGER NOT NULL,
      captured_at  INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_issue_git_baseline_ws ON issue_git_baseline(workspace_id);
  `);
}

/**
 * 启动清理：issue 已不存在、或已不在「进行中」的基线行没有复用价值，直接删。
 * 返回删除行数（启动日志与用例都用得上）。
 */
export function pruneIssueGitBaselines(db: Db): number {
  return db.prepare(`DELETE FROM issue_git_baseline
    WHERE issue_id NOT IN (SELECT id FROM issue WHERE status='进行中')`).run().changes;
}
