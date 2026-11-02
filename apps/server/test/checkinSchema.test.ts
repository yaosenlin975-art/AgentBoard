/**
 * ACC-07 迁移幂等与回滚：新库结构 == 重复启动结构；回滚 DDL 后可重建。
 * 断言只看结构（sqlite_master 的 type/name/sql），不比较数据。
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { openDb, type Db } from '../src/db/connection.js';
import { initSchema } from '../src/db/schema.js';

const CHECKIN_TABLES = ['checkin_authorization', 'checkin_batch', 'checkin_batch_item'];

function structure(db: Db): Array<{ type: string; name: string; sql: string | null }> {
  return db.prepare("SELECT type,name,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name").all() as Array<{ type: string; name: string; sql: string | null }>;
}

describe('checkin schema migration', () => {
  const dirs: string[] = [];
  const fresh = (): { db: Db; dir: string } => {
    const dir = mkdtempSync(join(tmpdir(), 'agentboard-checkin-schema-'));
    dirs.push(dir);
    const db = openDb(join(dir, 'schema.db'));
    initSchema(db);
    return { db, dir };
  };
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  it('checkinTablesExistWithExpectedColumns', () => {
    const { db } = fresh();
    const names = structure(db).filter(row => row.type === 'table').map(row => row.name);
    for (const table of CHECKIN_TABLES) expect(names).toContain(table);
    const columns = (table: string) => (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map(row => row.name);
    expect(columns('checkin_authorization')).toEqual(['id', 'account_id', 'app_id', 'status', 'remote_state_hash', 'remote_state_ref', 'authorization_url', 'safe_error_code', 'created_at', 'updated_at', 'expires_at']);
    expect(columns('checkin_batch')).toEqual(['id', 'app_id', 'status', 'total', 'profile_local_day', 'created_at', 'finished_at']);
    expect(columns('checkin_batch_item')).toEqual(['batch_id', 'account_id', 'seq', 'state', 'operation_id', 'safe_error_code', 'updated_at']);
    db.close();
  });

  it('repeatInitProducesIdenticalStructure', () => {
    const { db } = fresh();
    const first = structure(db);
    initSchema(db);
    initSchema(db);
    expect(structure(db)).toEqual(first);
    db.close();
  });

  it('freshSchemaMatchesReinitialisedSchema', () => {
    const a = fresh();
    const b = fresh();
    initSchema(b.db);
    expect(structure(b.db)).toEqual(structure(a.db));
    a.db.close();
    b.db.close();
  });

  it('rollbackDdlThenReinitRestoresSameStructure', () => {
    const { db } = fresh();
    const before = structure(db);
    // 迁移文件头部记录的回滚步骤
    db.exec('DROP TABLE IF EXISTS checkin_batch_item; DROP TABLE IF EXISTS checkin_batch; DROP TABLE IF EXISTS checkin_authorization;');
    const afterDrop = structure(db).filter(row => row.type === 'table').map(row => row.name);
    for (const table of CHECKIN_TABLES) expect(afterDrop).not.toContain(table);
    initSchema(db);
    expect(structure(db)).toEqual(before);
    db.close();
  });
});
