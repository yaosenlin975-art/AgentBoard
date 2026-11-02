import { randomUUID } from 'node:crypto';
import type { Workspace } from '@agentboard/shared';
import type { Db } from '../connection.js';
import { ApiError, NotFoundError } from '../../errors.js';
import type { PageResult } from '@agentboard/shared';
import { pageResult, validatePage } from '../pagination.js';

export interface CreateWorkspaceInput {
  name: string;
  path: string;
}

/** 移除空间前的阻塞项统计：保留历史 / 运行中会话 / 父子依赖 */
export interface WorkspaceDeleteBlockers {
  knowledgePages: number;
  knowledgeRevisions: number;
  runningSessions: number;
  childIssues: number;
}

/** workspace.path 有 UNIQUE 约束：同路径重复创建必须 409，不能让 SQLite 约束异常冒泡成 500 */
function isDuplicatePathError(error: unknown): boolean {
  const code = (error as { code?: string } | null)?.code ?? '';
  const message = (error as { message?: string } | null)?.message ?? '';
  return code.startsWith('SQLITE_CONSTRAINT') && /UNIQUE/i.test(message) && /workspace\.path/.test(message);
}

export function createWorkspace(db: Db, input: CreateWorkspaceInput): Workspace {
  const id = randomUUID();
  const created_at = Date.now();
  try {
    return insertWorkspace(db, id, created_at, input);
  } catch (error) {
    if (!isDuplicatePathError(error)) throw error;
    const existing = db.prepare('SELECT id,name,path FROM workspace WHERE path=?').get(input.path) as Pick<Workspace, 'id' | 'name' | 'path'> | undefined;
    throw new ApiError(
      409,
      'WORKSPACE_PATH_EXISTS',
      existing ? `该路径已存在工作空间：${existing.name}` : '该路径已存在工作空间',
      existing ? { id: existing.id, name: existing.name, path: existing.path } : { path: input.path },
    );
  }
}

function insertWorkspace(db: Db, id: string, created_at: number, input: CreateWorkspaceInput): Workspace {
  return db.transaction(() => {
    // 新空间追加到末尾（与既有「新空间排最后」的观感一致）
    const next = (db.prepare('SELECT COALESCE(MAX(sort_order) + 1, 0) AS next FROM workspace').get() as { next: number }).next;
    db.prepare('INSERT INTO workspace (id, name, path, created_at, sort_order) VALUES (?, ?, ?, ?, ?)').run(
      id,
      input.name,
      input.path,
      created_at,
      next,
    );
    return { id, name: input.name, path: input.path, created_at, sort_order: next };
  }).immediate();
}

/** 全部工作区 id（reorder 的集合校验用） */
export function listWorkspaceIds(db: Db): string[] {
  return (db.prepare('SELECT id FROM workspace').all() as Array<{ id: string }>).map(row => row.id);
}

/**
 * 批量重排（WS-REORDER）：单事务按 `orderedIds` 序号 0..n-1 全表重写。
 * 顺序冲突语义为 **LWW（后写覆盖）**：两人同时拖拽时最后提交的顺序生效，不做逐行 CAS；
 * 集合与当前库不一致由调用方（路由）先拒绝，避免按部分集合静默重排。
 */
export function reorderWorkspaces(db: Db, orderedIds: string[]): Workspace[] {
  return db.transaction(() => {
    const update = db.prepare('UPDATE workspace SET sort_order = ? WHERE id = ?');
    orderedIds.forEach((id, index) => {
      if (update.run(index, id).changes !== 1) throw new NotFoundError(`工作空间不存在: ${id}`);
    });
    return listWorkspaces(db);
  }).immediate();
}

/** 展示顺序：sort_order → created_at → id（与 `listWorkspacesPage` 必须一致，MCP 分页与 web 全量同序） */
export function listWorkspaces(db: Db): Workspace[] {
  return db.prepare('SELECT * FROM workspace ORDER BY sort_order, created_at, id').all() as Workspace[];
}
export function listWorkspacesPage(db: Db, limit: number, offset: number): PageResult<Workspace> {
  validatePage(limit, offset);
  return pageResult(db.prepare('SELECT * FROM workspace ORDER BY sort_order, created_at, id LIMIT ? OFFSET ?').all(limit + 1, offset) as Workspace[], limit, offset);
}

export function getWorkspace(db: Db, id: string): Workspace | null {
  return (db.prepare('SELECT * FROM workspace WHERE id = ?').get(id) as Workspace | undefined) ?? null;
}

/** 只读统计；不含改写，供删除路由在动数据前给出可操作拒绝原因 */
export function getWorkspaceDeleteBlockers(db: Db, id: string): WorkspaceDeleteBlockers {
  const count = (sql: string): number => (db.prepare(sql).get(id) as { n: number }).n;
  return {
    knowledgePages: count('SELECT COUNT(*) AS n FROM knowledge_page WHERE workspace_id = ?'),
    knowledgeRevisions: count(
      'SELECT COUNT(*) AS n FROM knowledge_revision r JOIN knowledge_page p ON p.id = r.page_id WHERE p.workspace_id = ?',
    ),
    runningSessions: count("SELECT COUNT(*) AS n FROM session WHERE workspace_id = ? AND status = '运行中'"),
    childIssues: count('SELECT COUNT(*) AS n FROM issue WHERE workspace_id = ? AND parent_issue_id IS NOT NULL'),
  };
}

/** 删空间行；issue/comment/session/message/attachment 由 FK CASCADE 连带（父子任务由路由前置拒绝，不改写层级） */
export function deleteWorkspace(db: Db, id: string): void {
  db.transaction(() => {
    const row = db.prepare('DELETE FROM workspace WHERE id = ?').run(id);
    if (row.changes !== 1) throw new NotFoundError('工作空间不存在');
  }).immediate();
}
