import type { Db } from '../connection.js';
import { ensureOwner } from '../repos/workspaceMember.js';

/**
 * PERM-1：`workspace_member` 成员表 + 既有工作区 owner 回填。
 * 设计：`knowledge:41cc78e5-946e-4b03-a79c-0a93f13aad12（知识卡：跨工作区决策权限：最小可行方案（路线 A））` §3「数据模型（路线 A）」。
 *
 * - 纯追加表，不改 `workspace` / `issue` / `issue_decision` 任何列，不重建表。
 * - 幂等：`CREATE TABLE/INDEX IF NOT EXISTS` + `INSERT OR IGNORE`（唯一索引
 *   `ux_workspace_member(workspace_id, actor_id)`），重复执行不报错、不重复插行。
 * - 迁移期每个既有工作区补一条 `('user', 'owner')`：`user` 是当前唯一人类身份，
 *   单机现有行为因此完全不变。
 * - 删除工作区时成员行随 `ON DELETE CASCADE` 一起消失。
 *
 * 回滚：`DROP TABLE IF EXISTS workspace_member;`（只丢成员事实，不影响工作区与任务）
 */
export function createWorkspaceMemberTable(db: Db): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS workspace_member (
      id           TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
      actor_id     TEXT NOT NULL,
      role         TEXT NOT NULL CHECK (role IN ('owner','member','viewer')),
      created_at   INTEGER NOT NULL,
      updated_at   INTEGER NOT NULL
    );
    CREATE UNIQUE INDEX IF NOT EXISTS ux_workspace_member
      ON workspace_member(workspace_id, actor_id);
  `);
}

/** 为所有既有工作区补 owner（升级前已存在的工作区；已存在的行不动） */
export function seedAllWorkspaceOwners(db: Db): number {
  const rows = db.prepare('SELECT id FROM workspace').all() as Array<{ id: string }>;
  for (const row of rows) ensureOwner(db, row.id);
  return rows.length;
}

export function migrateWorkspaceMember(db: Db): void {
  createWorkspaceMemberTable(db);
  seedAllWorkspaceOwners(db);
}
