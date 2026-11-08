import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestDb, type TestDb } from './helpers.js';
import { initSchema } from '../src/db/schema.js';

/**
 * CR2-2：聊天热表索引迁移（message(session_id)、session(workspace_id)）。
 * 覆盖两件事：索引存在且迁移幂等、查询计划真的用上索引（不再 SCAN）。
 */
let t: TestDb;

beforeEach(() => {
  t = createTestDb();
});

afterEach(() => {
  t.cleanup();
});

function indexNames(table: string): string[] {
  return (t.db.prepare(`PRAGMA index_list(${table})`).all() as Array<{ name: string }>).map((r) => r.name);
}

describe('聊天热表索引', () => {
  it('initSchema 建出 idx_message_session / idx_session_workspace，重复执行结构不变（幂等）', () => {
    expect(indexNames('message')).toContain('idx_message_session');
    expect(indexNames('session')).toContain('idx_session_workspace');
    const before = t.db
      .prepare("SELECT sql FROM sqlite_master WHERE type='index' AND tbl_name IN ('message','session') ORDER BY name")
      .all();

    initSchema(t.db);
    initSchema(t.db);

    const after = t.db
      .prepare("SELECT sql FROM sqlite_master WHERE type='index' AND tbl_name IN ('message','session') ORDER BY name")
      .all();
    expect(after).toEqual(before);
    expect(indexNames('message').filter((n) => n === 'idx_message_session')).toHaveLength(1);
    expect(indexNames('session').filter((n) => n === 'idx_session_workspace')).toHaveLength(1);
  });

  it('message 按 session_id 查询走 idx_message_session（不再 SCAN message）', () => {
    const plan = t.db
      .prepare('EXPLAIN QUERY PLAN SELECT * FROM message WHERE session_id = ?')
      .all('x') as Array<{ detail: string }>;
    const detail = plan.map((r) => r.detail).join(' | ');
    expect(detail).toContain('idx_message_session');
    expect(detail).not.toMatch(/SCAN message/);
  });

  it('session 按 workspace_id 查询走 idx_session_workspace（不再 SCAN session）', () => {
    const plan = t.db
      .prepare('EXPLAIN QUERY PLAN SELECT * FROM session WHERE workspace_id = ?')
      .all('x') as Array<{ detail: string }>;
    const detail = plan.map((r) => r.detail).join(' | ');
    expect(detail).toContain('idx_session_workspace');
    expect(detail).not.toMatch(/SCAN session/);
  });
});
