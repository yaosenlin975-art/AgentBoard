import { randomUUID } from 'node:crypto';
import type { Db } from '../connection.js';
import { NotFoundError } from '../../errors.js';

/** personas 行（P1-C；source 合法值 builtin/user/import，写入点保证） */
export interface PersonaRow {
  id: string;
  name: string;
  description: string;
  body_md: string;
  source: 'builtin' | 'user' | 'import';
  package_path: string | null;
  created_at: number;
}

export interface CreatePersonaInput {
  name: string;
  description?: string | null;
  body_md: string;
  source?: PersonaRow['source'];
  package_path?: string | null;
}

export function createPersona(db: Db, input: CreatePersonaInput): PersonaRow {
  const id = randomUUID();
  const created_at = Date.now();
  db.prepare(
    `INSERT INTO personas (id, name, description, body_md, source, package_path, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    input.name,
    input.description ?? '',
    input.body_md,
    input.source ?? 'user',
    input.package_path ?? null,
    created_at,
  );
  return getPersona(db, id)!;
}

/** 列表按 created_at 倒序（新建的在前） */
export function listPersonas(db: Db): PersonaRow[] {
  return db
    .prepare('SELECT * FROM personas ORDER BY created_at DESC, id DESC')
    .all() as PersonaRow[];
}

export function getPersona(db: Db, id: string): PersonaRow | null {
  return (db.prepare('SELECT * FROM personas WHERE id = ?').get(id) as PersonaRow | undefined) ?? null;
}

/** P3-C：按来源目录找导入生成的首个 persona（同一目录重复导入判重） */
export function findImportedPersonaByPackagePath(db: Db, packagePath: string): PersonaRow | null {
  return (
    (db
      .prepare("SELECT * FROM personas WHERE source = 'import' AND package_path = ? ORDER BY created_at, id LIMIT 1")
      .get(packagePath) as PersonaRow | undefined) ?? null
  );
}

export type PersonaPatch = Partial<{
  name: string;
  description: string | null;
  body_md: string;
}>;

export function updatePersona(db: Db, id: string, patch: PersonaPatch): PersonaRow {
  const sets: string[] = [];
  const params: unknown[] = [];
  if (patch.name !== undefined) {
    sets.push('name = ?');
    params.push(patch.name);
  }
  if (patch.description !== undefined) {
    sets.push('description = ?');
    params.push(patch.description ?? '');
  }
  if (patch.body_md !== undefined) {
    sets.push('body_md = ?');
    params.push(patch.body_md);
  }
  if (sets.length === 0) throw new NotFoundError('无可用更新字段');
  params.push(id);
  const row = db.prepare(`UPDATE personas SET ${sets.join(', ')} WHERE id = ?`).run(...params);
  if (row.changes !== 1) throw new NotFoundError('persona 不存在');
  return getPersona(db, id)!;
}

export function deletePersona(db: Db, id: string): void {
  const row = db.prepare('DELETE FROM personas WHERE id = ?').run(id);
  if (row.changes !== 1) throw new NotFoundError('persona 不存在');
}
