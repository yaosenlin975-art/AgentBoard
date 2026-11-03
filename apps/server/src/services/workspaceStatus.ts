/**
 * STATUS-1：状态写入的唯一校验入口（替代已删除的 DDL CHECK 枚举）。
 *
 * `issue.status` 落库是名字字符串；合法值 = 该任务所属工作区的 `workspace_status.name`
 * （内置五状态在每工作区建好，见 `migrations/workspaceStatus.ts`）。非法写入 → 400，文案列出可用状态。
 */
import type { Db } from '../db/connection.js';
import { ValidationError } from '../errors.js';

export interface WorkspaceStatusRow {
  id: string;
  workspace_id: string;
  name: string;
  kind: 'open' | 'started' | 'review' | 'done' | 'deprecated';
  sort_order: number;
  is_builtin: number;
}

/** 该工作区可用状态名（sort_order 升序） */
export function listWorkspaceStatusNames(db: Db, workspaceId: string): string[] {
  return (db.prepare('SELECT name FROM workspace_status WHERE workspace_id=? ORDER BY sort_order, name')
    .all(workspaceId) as Array<{ name: string }>).map(row => row.name);
}

/**
 * 校验 status 命中本工作区状态字典；未命中抛 400（文案含可用值）。
 * 内置状态由迁移/建工作区种子保证存在，所以正常路径不会因「字典为空」误伤。
 */
export function requireWorkspaceStatus(db: Db, workspaceId: string, status: string): string {
  const trimmed = status.trim();
  if (trimmed === '') throw new ValidationError('status 不能为空');
  const allowed = listWorkspaceStatusNames(db, workspaceId);
  if (allowed.includes(trimmed)) return trimmed;
  throw new ValidationError(
    allowed.length > 0
      ? `status 必须是本工作区已定义的状态：${allowed.join(' / ')}（收到 "${trimmed}"）`
      : `工作区 ${workspaceId} 还没有定义任何状态`,
  );
}

/** 状态名 → kind（关闭类判定等行为用；不存在返回 null） */
export function workspaceStatusKind(db: Db, workspaceId: string, status: string): WorkspaceStatusRow['kind'] | null {
  const row = db.prepare('SELECT kind FROM workspace_status WHERE workspace_id=? AND name=?')
    .get(workspaceId, status) as { kind: WorkspaceStatusRow['kind'] } | undefined;
  return row?.kind ?? null;
}
