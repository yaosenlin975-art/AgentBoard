/**
 * STAT STATUS-1：状态写入的唯一校验入口（替代已删除的 DDL CHECK 枚举）。
 *
 * `issue.status` 落库是名字字符串；合法值 = 该任务所属工作区的 `workspace_status.name`
 * （内置五状态在每工作区建好，见 `migrations/workspaceStatus.ts`）。非法写入 → 400，文案列出可用状态。
 *
 * STATUS-2：自定义状态的增删（CRUD 的服务层），守卫与迁移规则：
 * - 内置状态（`is_builtin=1`）不可删除、不可改名（没有改名通道，名字只能新增后迁移）；
 * - 同工作区 name 唯一 → 409 `WORKSPACE_STATUS_EXISTS`；
 * - 删除必须带 `migrate_to`：同事务把该状态下的卡全部改成目标状态再删行，返回迁移条数；
 *   不带 → 400 `MIGRATION_TARGET_REQUIRED`；目标不存在或等于被删状态 → 400 `MIGRATION_TARGET_INVALID`。
 */
import { randomUUID } from 'node:crypto';
import type { Db } from '../db/connection.js';
import { ApiError, NotFoundError, ValidationError } from '../errors.js';
import { CLOSED_KINDS } from '../db/migrations/workspaceStatus.js';

export interface WorkspaceStatusRow {
  id: string;
  workspace_id: string;
  name: string;
  kind: 'open' | 'started' | 'review' | 'done' | 'deprecated';
  sort_order: number;
  is_builtin: number;
}

export const STATUS_KINDS = ['open', 'started', 'review', 'done', 'deprecated'] as const;

/** 该工作区可用状态名（sort_order 升序） */
export function listWorkspaceStatusNames(db: Db, workspaceId: string): string[] {
  return (db.prepare('SELECT name FROM workspace_status WHERE workspace_id=? ORDER BY sort_order, name')
    .all(workspaceId) as Array<{ name: string }>).map(row => row.name);
}

/** 该工作区完整状态字典（sort_order 升序，id 升序兜底） */
export function listWorkspaceStatuses(db: Db, workspaceId: string): WorkspaceStatusRow[] {
  return db.prepare(`SELECT id, workspace_id, name, kind, sort_order, is_builtin FROM workspace_status
    WHERE workspace_id=? ORDER BY sort_order, name, id`).all(workspaceId) as WorkspaceStatusRow[];
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

export interface CreateWorkspaceStatusInput {
  workspace_id: string;
  name: string;
  kind: WorkspaceStatusRow['kind'];
  sort_order?: number;
  now?: number;
}

/**
 * 新增自定义状态。`kind` 决定行为（关闭类 = done | deprecated），名字可自定义；
 * 重名（同工作区）→ 409。默认 `sort_order` 取当前最大值 +10（排在最后，便于后续插队）。
 */
export function createWorkspaceStatus(db: Db, input: CreateWorkspaceStatusInput): WorkspaceStatusRow {
  const name = input.name.trim();
  if (name === '') throw new ValidationError('状态名不能为空');
  if (!STATUS_KINDS.includes(input.kind)) throw new ValidationError(`kind 必须是 ${STATUS_KINDS.join(' / ')} 之一`);
  return db.transaction(() => {
    const exists = db.prepare('SELECT 1 FROM workspace_status WHERE workspace_id=? AND name=?').get(input.workspace_id, name);
    if (exists) throw new ApiError(409, 'WORKSPACE_STATUS_EXISTS', `该工作区已存在同名状态：${name}`);
    const next = input.sort_order ?? (db.prepare('SELECT COALESCE(MAX(sort_order), 0) + 10 AS next FROM workspace_status WHERE workspace_id=?')
      .get(input.workspace_id) as { next: number }).next;
    const row: WorkspaceStatusRow = {
      id: randomUUID(),
      workspace_id: input.workspace_id,
      name,
      kind: input.kind,
      sort_order: next,
      is_builtin: 0,
    };
    db.prepare(`INSERT INTO workspace_status (id, workspace_id, name, kind, sort_order, is_builtin, created_at)
      VALUES (?,?,?,?,?,0,?)`).run(row.id, row.workspace_id, row.name, row.kind, row.sort_order, input.now ?? Date.now());
    return row;
  }).immediate();
}

export interface RemoveWorkspaceStatusInput {
  workspace_id: string;
  status_id: string;
  /** 该状态下卡全部迁往的目标状态名（必填，设计 D3） */
  migrate_to?: string;
  now?: number;
}

export interface RemoveWorkspaceStatusResult {
  removed: WorkspaceStatusRow;
  migrate_to: string;
  migrated_issue_count: number;
}

/**
 * STATUS-MIGRATE-COUNT：迁移计数守卫。
 *
 * `migrated_issue_count` 必须是**实际被迁移的卡数**：先数该状态下的卡，再执行 UPDATE，
 * 两者不一致说明统计口径坏了（触发器改写 changes()、并发写入等），此时宁可 500 回滚，
 * 也不能回一个「0」让用户以为数据没迁（会把「本来没卡」和「统计失败」混为一谈）。
 */
export function assertMigrationCount(preCount: number, changed: number, statusName: string): number {
  if (preCount !== changed) {
    throw new ApiError(
      500,
      'MIGRATION_COUNT_MISMATCH',
      `迁移计数不一致：应迁 ${preCount} 张，实际 ${changed} 张（状态 ${statusName}），本次已回滚、状态未删除`,
    );
  }
  return changed;
}

/**
 * 删除自定义状态：必须带 `migrate_to`，同事务把该状态下的卡全部迁移后删行。
 * 内置状态直接拒绝（改名前请先新增同名自定义状态再迁移）。
 */
export function removeWorkspaceStatus(db: Db, input: RemoveWorkspaceStatusInput): RemoveWorkspaceStatusResult {
  const migrateTo = input.migrate_to?.trim() ?? '';
  return db.transaction(() => {
    const target = db.prepare('SELECT id, workspace_id, name, kind, sort_order, is_builtin FROM workspace_status WHERE id=? AND workspace_id=?')
      .get(input.status_id, input.workspace_id) as WorkspaceStatusRow | undefined;
    if (!target) throw new NotFoundError('状态不存在');
    if (target.is_builtin === 1) {
      throw new ApiError(409, 'WORKSPACE_STATUS_BUILTIN', `内置状态不可删除：${target.name}`);
    }
    if (migrateTo === '') {
      throw new ApiError(400, 'MIGRATION_TARGET_REQUIRED', `删除状态 ${target.name} 前必须指定迁移目标（migrate_to），该状态下的卡会迁到目标状态`);
    }
    if (migrateTo === target.name) {
      throw new ApiError(400, 'MIGRATION_TARGET_INVALID', '迁移目标不能是被删除的状态本身');
    }
    const targetRow = db.prepare('SELECT 1 FROM workspace_status WHERE workspace_id=? AND name=?').get(input.workspace_id, migrateTo);
    if (!targetRow) {
      throw new ApiError(400, 'MIGRATION_TARGET_INVALID', `迁移目标状态不存在：${migrateTo}（可用：${listWorkspaceStatusNames(db, input.workspace_id).join(' / ')}）`);
    }
    const preCount = (db.prepare('SELECT COUNT(*) AS n FROM issue WHERE workspace_id=? AND status=?')
      .get(input.workspace_id, target.name) as { n: number }).n;
    const migrated = db.prepare('UPDATE issue SET status=?, updated_at=MAX(?,updated_at+1) WHERE workspace_id=? AND status=?')
      .run(migrateTo, input.now ?? Date.now(), input.workspace_id, target.name).changes;
    assertMigrationCount(preCount, migrated, target.name);
    db.prepare('DELETE FROM workspace_status WHERE id=? AND workspace_id=?').run(input.status_id, input.workspace_id);
    return { removed: target, migrate_to: migrateTo, migrated_issue_count: migrated };
  }).immediate();
}


/**
 * STATUS-3：kind 语义的**唯一权威**。
 *
 * - `isClosedKind`：「关闭类」判定（`done` | `deprecated`）。后代替关闭计数、父卡关闭校验、
 *   详情里的关闭阻塞判断都只认它，**不再比较状态名字符串**。
 * - `isBlockerResolvedKind`：依赖解除判定 = 关闭类 ∪ `review`（待验收也放行，避免人工验收堵死流水线 §5-D2）。
 * - `CLOSED_KIND_SQL` / `RESOLVED_KIND_SQL`：同样的清单给 SQL 用，保证 TS 与 SQL 不会各写一份。
 */
export function isClosedKind(kind: string | null | undefined): boolean {
  return kind !== null && kind !== undefined && (CLOSED_KINDS as readonly string[]).includes(kind);
}

export function isBlockerResolvedKind(kind: string | null | undefined): boolean {
  return kind === 'review' || isClosedKind(kind);
}

const quoteKinds = (kinds: readonly string[]): string => kinds.map(kind => `'${kind}'`).join(',');
export const CLOSED_KIND_SQL = quoteKinds(CLOSED_KINDS);
export const RESOLVED_KIND_SQL = quoteKinds(['review', ...CLOSED_KINDS]);

/** 该工作区里属于关闭类的状态名（按 kind 反查，供按名字判断的调用点使用） */
export function closedStatusNames(db: Db, workspaceId: string): string[] {
  return (db.prepare(`SELECT name FROM workspace_status WHERE workspace_id=? AND kind IN (${CLOSED_KIND_SQL}) ORDER BY sort_order, name`)
    .all(workspaceId) as Array<{ name: string }>).map(row => row.name);
}

/** 单个状态名是否关闭类（走 kind 反查，名字可自定义） */
export function isClosedStatusName(db: Db, workspaceId: string, status: string | null | undefined): boolean {
  if (!status) return false;
  return isClosedKind(workspaceStatusKind(db, workspaceId, status));
}

/** 单个状态名是否满足「依赖已解除」（关闭类 ∪ 待验收对应 kind） */
export function isBlockerResolvedStatusName(db: Db, workspaceId: string, status: string | null | undefined): boolean {
  if (!status) return false;
  return isBlockerResolvedKind(workspaceStatusKind(db, workspaceId, status));
}
