/**
 * STORE-7（M5）：中心库归档记录（纯追加表，幂等）。
 *
 * 已下沉工作区被移除时，库文件（含 -wal/-shm）与附件目录移到
 * `<中心库目录>/archive/<workspaceId>/`，本表落一条记录；归档列表
 * （`GET /api/changelog/archived-workspaces`）按「归档记录 + legacy 中心日志行」合并读取。
 * 表里不存外键——工作区注册行已被删除，记录本身就是唯一索引。
 */
import type { Db } from '../connection.js';

const DDL = `
CREATE TABLE IF NOT EXISTS workspace_archive (
  workspace_id     TEXT PRIMARY KEY,
  workspace_name   TEXT NOT NULL,
  origin_path      TEXT NOT NULL,
  archive_dir      TEXT NOT NULL,
  archived_at      INTEGER NOT NULL,
  db_bytes         INTEGER NOT NULL DEFAULT 0,
  attachment_files INTEGER NOT NULL DEFAULT 0);
CREATE INDEX IF NOT EXISTS idx_workspace_archive_at ON workspace_archive(archived_at);
`;

export function migrateWorkspaceArchive(db: Db): void {
  db.exec(DDL);
}
