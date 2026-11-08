import { randomUUID } from 'node:crypto';
import type { Workspace } from '@agentboard/shared';
import type { Db } from '../connection.js';

/**
 * PERM-1：工作区成员表仓储（权限方案路线 A，`knowledge:41cc78e5-946e-4b03-a79c-0a93f13aad12（知识卡：跨工作区决策权限：最小可行方案（路线 A））` §2/§3）。
 *
 * 本轮只落「身份 + 角色」的存储事实，不做请求身份解析与鉴权（那是 PERM-2）：
 * 单机迁移后 `user` 是全部工作区的 owner，因此既有行为零变化。
 */
export type WorkspaceRole = 'owner' | 'member' | 'viewer';

/** 当前唯一人类身份（`services/decision.ts` 的 `answered_by ?? 'user'` 同口径） */
export const DEFAULT_OWNER_ACTOR = 'user';

export interface WorkspaceMemberRow {
  id: string;
  workspace_id: string;
  actor_id: string;
  role: WorkspaceRole;
  created_at: number;
  updated_at: number;
}

/** 无成员记录返回 null（匿名），由调用方决定 403 */
export function getRole(db: Db, workspaceId: string, actorId: string): WorkspaceRole | null {
  const row = db
    .prepare('SELECT role FROM workspace_member WHERE workspace_id = ? AND actor_id = ?')
    .get(workspaceId, actorId) as { role: WorkspaceRole } | undefined;
  return row?.role ?? null;
}

/** 「所有工作区」视图的数据源：只返回调用者有成员关系的区，排序与 `listWorkspaces` 一致 */
export function listWorkspacesForActor(db: Db, actorId: string): Workspace[] {
  return db
    .prepare(
      `SELECT w.* FROM workspace w
         JOIN workspace_member m ON m.workspace_id = w.id
        WHERE m.actor_id = ?
        ORDER BY w.sort_order, w.created_at, w.id`,
    )
    .all(actorId) as Workspace[];
}

/**
 * 幂等写入 owner：唯一索引 `ux_workspace_member(workspace_id, actor_id)` 兜底，
 * 迁移回填与新工作区创建共用这一条 SQL（不在迁移里再写一套）。
 */
export function ensureOwner(
  db: Db,
  workspaceId: string,
  actorId: string = DEFAULT_OWNER_ACTOR,
  now: number = Date.now(),
): void {
  db.prepare(
    `INSERT OR IGNORE INTO workspace_member (id, workspace_id, actor_id, role, created_at, updated_at)
     VALUES (?, ?, ?, 'owner', ?, ?)`,
  ).run(randomUUID(), workspaceId, actorId, now, now);
}
