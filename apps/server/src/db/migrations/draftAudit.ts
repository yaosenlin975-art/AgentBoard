import type { Db } from '../connection.js';

/**
 * SMART-CREATE：草稿生成审计（设计 §4）。
 *
 * 只记结构性字段：adapter / 耗时 / 成败 / warning 数 / 错误码。
 * **不记录需求原文**（可能含敏感信息），也不记录模型输出正文。
 *
 * 幂等依据：`CREATE TABLE IF NOT EXISTS`；回滚：`DROP TABLE IF EXISTS issue_draft_audit;`
 */
export function migrateDraftAudit(db: Db): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS issue_draft_audit (
      id            TEXT PRIMARY KEY,
      workspace_id  TEXT NOT NULL,
      adapter       TEXT NOT NULL,
      duration_ms   INTEGER NOT NULL,
      ok            INTEGER NOT NULL,
      warning_count INTEGER NOT NULL,
      error_code    TEXT,
      created_at    INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_issue_draft_audit_created ON issue_draft_audit(created_at);
  `);
}
