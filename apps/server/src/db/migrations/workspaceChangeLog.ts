import type { Db } from '../connection.js';

/**
 * LOG01｜工作区变更日志表（设计 §4）。
 * 幂等 DDL：新库与重复启动得到一致 schema；不改既有表。
 * - workspace_id ON DELETE SET NULL：工作区移除后日志保留为归档，origin 快照不变；
 * - legacy_source_key 仅旧 CHANGELOG 导入写入，用于导入幂等与对账；
 * - updated_at 由触发器保证单调递增。
 */
export function migrateWorkspaceChangeLog(db: Db): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS workspace_change_log (
      id TEXT PRIMARY KEY,
      workspace_id TEXT REFERENCES workspace(id) ON DELETE SET NULL,
      origin_workspace_id TEXT NOT NULL,
      origin_workspace_name TEXT NOT NULL,
      origin_workspace_path TEXT NOT NULL,
      title TEXT NOT NULL,
      body_md TEXT NOT NULL,
      change_type TEXT NOT NULL CHECK(change_type IN ('新增','修复','调整','历史')),
      occurred_at INTEGER NOT NULL,
      created_by TEXT NOT NULL,
      updated_by TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      revision INTEGER NOT NULL DEFAULT 1 CHECK(revision>0),
      legacy_source_key TEXT UNIQUE,
      CHECK(workspace_id IS NULL OR workspace_id=origin_workspace_id),
      CHECK(length(title)>0 AND length(body_md)>0),
      CHECK(updated_at>=created_at)
    );
    CREATE INDEX IF NOT EXISTS changelog_active ON workspace_change_log(workspace_id, occurred_at DESC, id DESC);
    CREATE INDEX IF NOT EXISTS changelog_archived ON workspace_change_log(origin_workspace_id, occurred_at DESC, id DESC);
    CREATE TRIGGER IF NOT EXISTS changelog_monotonic_time AFTER UPDATE ON workspace_change_log
      WHEN new.updated_at <= old.updated_at BEGIN
        UPDATE workspace_change_log SET updated_at=old.updated_at+1 WHERE id=new.id;
      END;
    CREATE TABLE IF NOT EXISTS workspace_change_log_import (
      id TEXT PRIMARY KEY,
      source_path TEXT NOT NULL,
      origin_workspace_id TEXT NOT NULL,
      source_sha256 TEXT NOT NULL,
      entry_count INTEGER NOT NULL CHECK(entry_count>=0),
      imported_at INTEGER NOT NULL,
      UNIQUE(source_path, origin_workspace_id, source_sha256)
    );
  `);
}
