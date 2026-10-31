import { randomUUID } from 'node:crypto';
import type { Workspace } from '@agentboard/shared';
import type { Db } from '../connection.js';
import { NotFoundError } from '../../errors.js';

export interface CreateWorkspaceInput {
  name: string;
  path: string;
}

export function createWorkspace(db: Db, input: CreateWorkspaceInput): Workspace {
  const id = randomUUID();
  const created_at = Date.now();
  db.prepare('INSERT INTO workspace (id, name, path, created_at) VALUES (?, ?, ?, ?)').run(
    id,
    input.name,
    input.path,
    created_at,
  );
  return { id, name: input.name, path: input.path, created_at };
}

export function listWorkspaces(db: Db): Workspace[] {
  return db.prepare('SELECT * FROM workspace ORDER BY created_at, id').all() as Workspace[];
}

export function getWorkspace(db: Db, id: string): Workspace | null {
  return (db.prepare('SELECT * FROM workspace WHERE id = ?').get(id) as Workspace | undefined) ?? null;
}

export function deleteWorkspace(db: Db, id: string): void {
  const row = db.prepare('DELETE FROM workspace WHERE id = ?').run(id);
  if (row.changes !== 1) throw new NotFoundError('工作空间不存在');
}
