import type { Db } from '../connection.js';

/**
 * STATUS-1：`workspace_status` —— 每个工作区独立的状态字典（设计 §3.2）。
 *
 * - 内置五状态固定：待规划(open) / 进行中(started) / 待验收(review) / 已关闭(done) / 已废弃(deprecated)，
 *   `sort_order` 0/10/20/30/40（留空隙给自定义状态插队），`is_builtin=1`。
 * - `kind` 决定行为（关闭类 = done | deprecated），不靠名字；本卡的 DDL 建好 kind，行为切换在后续卡。
 * - 内置行 id 用确定性值 `builtin-<workspaceId>-<kind>`：种子天然幂等，重复执行不会重复插入。
 * - 新工作区在 `createWorkspace` 里同步种入（`seedWorkspaceStatus`），启动时对既有工作区补齐。
 *
 * 幂等依据：`CREATE TABLE/INDEX IF NOT EXISTS` + 种子 `INSERT OR IGNORE`。
 * 回滚：`DROP TABLE IF EXISTS workspace_status;`（只丢状态字典，issue.status 是纯文本列，不受影响）
 */
export interface BuiltinStatus {
  name: string;
  kind: 'open' | 'started' | 'review' | 'done' | 'deprecated';
  sort_order: number;
}

/** 内置状态种子顺序即看板列顺序（设计 §3.1） */
export const BUILTIN_STATUSES: readonly BuiltinStatus[] = [
  { name: '待规划', kind: 'open', sort_order: 0 },
  { name: '进行中', kind: 'started', sort_order: 10 },
  { name: '待验收', kind: 'review', sort_order: 20 },
  { name: '已关闭', kind: 'done', sort_order: 30 },
  { name: '已废弃', kind: 'deprecated', sort_order: 40 },
];

/** 关闭类 kind（父卡关闭校验、后代关闭计数、依赖解除判定都应以它为准） */
export const CLOSED_KINDS = ['done', 'deprecated'] as const;

export const builtinStatusId = (workspaceId: string, kind: BuiltinStatus['kind']): string => `builtin-${workspaceId}-${kind}`;

export function createWorkspaceStatusTable(db: Db): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS workspace_status (
      id          TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
      name        TEXT NOT NULL,
      kind        TEXT NOT NULL CHECK (kind IN ('open','started','review','done','deprecated')),
      sort_order  INTEGER NOT NULL DEFAULT 0,
      is_builtin  INTEGER NOT NULL DEFAULT 0,
      created_at  INTEGER NOT NULL,
      UNIQUE (workspace_id, name)
    );
    CREATE INDEX IF NOT EXISTS idx_workspace_status_ws_order ON workspace_status(workspace_id, sort_order, name);
  `);
}

/** 给一个工作区种入 5 条内置状态（幂等；已存在则不动） */
export function seedWorkspaceStatus(db: Db, workspaceId: string, now: number = Date.now()): void {
  const insert = db.prepare(`INSERT OR IGNORE INTO workspace_status
    (id, workspace_id, name, kind, sort_order, is_builtin, created_at) VALUES (?,?,?,?,?,1,?)`);
  for (const status of BUILTIN_STATUSES) {
    insert.run(builtinStatusId(workspaceId, status.kind), workspaceId, status.name, status.kind, status.sort_order, now);
  }
}

/** 为所有既有工作区补齐内置状态（启动时执行，覆盖升级前已存在的工作区） */
export function seedAllWorkspaceStatus(db: Db): number {
  const rows = db.prepare('SELECT id FROM workspace').all() as Array<{ id: string }>;
  for (const row of rows) seedWorkspaceStatus(db, row.id);
  return rows.length;
}

export function migrateWorkspaceStatus(db: Db): void {
  createWorkspaceStatusTable(db);
  seedAllWorkspaceStatus(db);
}
