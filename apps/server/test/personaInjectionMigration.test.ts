import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestDb, type TestDb } from './helpers.js';
import { initSchema } from '../src/db/schema.js';

/**
 * P1-C：persona 注入迁移（personas 表 + session 四列）。
 * 覆盖：表/列存在、迁移幂等（重复 initSchema 结构不变）、列类型与默认值口径。
 */
let t: TestDb;

beforeEach(() => {
  t = createTestDb();
});

afterEach(() => {
  t.cleanup();
});

function columnNames(table: string): string[] {
  return (t.db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((c) => c.name);
}

describe('persona 注入迁移', () => {
  it('initSchema 建出 personas 表与 session 四列，重复执行结构不变（幂等）', () => {
    expect(columnNames('personas')).toEqual(
      expect.arrayContaining(['id', 'name', 'description', 'body_md', 'source', 'package_path', 'created_at']),
    );
    expect(columnNames('session')).toEqual(
      expect.arrayContaining(['persona_id', 'tool_policy', 'skill_policy', 'persona_injection']),
    );
    const before = t.db
      .prepare("SELECT sql FROM sqlite_master WHERE type IN ('table','index') AND tbl_name IN ('personas','session') ORDER BY name")
      .all();

    initSchema(t.db);
    initSchema(t.db);

    const after = t.db
      .prepare("SELECT sql FROM sqlite_master WHERE type IN ('table','index') AND tbl_name IN ('personas','session') ORDER BY name")
      .all();
    expect(after).toEqual(before);
  });

  it('personas 列默认值：description 默认空串、source 默认 user、package_path 可空', () => {
    t.db.prepare('INSERT INTO personas (id, name, body_md, created_at) VALUES (?, ?, ?, ?)').run('p1', 'n', 'b', 1);
    const row = t.db.prepare('SELECT * FROM personas WHERE id = ?').get('p1') as Record<string, unknown>;
    expect(row).toMatchObject({ description: '', source: 'user', package_path: null });
  });

  it('session 四列存量行为 NULL（纯加列不回填）', () => {
    t.db.prepare('INSERT INTO workspace (id, name, path, created_at) VALUES (?, ?, ?, ?)').run('w1', 'ws', 'D:\\ws\\x', 1);
    t.db
      .prepare("INSERT INTO session (id, workspace_id, cli, status, created_at) VALUES ('s1', 'w1', 'fake', '已结束', 1)")
      .run();
    const row = t.db.prepare('SELECT persona_id, tool_policy, skill_policy, persona_injection FROM session WHERE id = ?').get('s1') as Record<string, unknown>;
    expect(row).toEqual({ persona_id: null, tool_policy: null, skill_policy: null, persona_injection: null });
  });
});
