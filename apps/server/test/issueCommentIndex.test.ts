import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { createTestDb, type TestDb } from './helpers.js';
import { initSchema } from '../src/db/schema.js';
import { createIssue } from '../src/db/repos/issue.js';
import { createApp, type CreatedApp } from '../src/index.js';

/**
 * PERF-5：issue_comment(issue_id) 索引迁移。
 * 覆盖三件事：索引存在且迁移幂等、查询计划真的用上索引、真实 createApp 下 comment_count 与逐卡 count 一致。
 */
let t: TestDb;
let created: CreatedApp;
let spaceDir: string;

beforeEach(async () => {
  t = createTestDb();
  spaceDir = mkdtempSync(join(tmpdir(), 'agentboard-perf5-'));
  created = await createApp({ db: t.db, refreshClisOnBoot: false });
});

afterEach(() => {
  t.cleanup();
  rmSync(spaceDir, { recursive: true, force: true });
});

function indexNames(): string[] {
  return (t.db.prepare('PRAGMA index_list(issue_comment)').all() as Array<{ name: string }>).map((r) => r.name);
}

describe('issue_comment(issue_id) 索引', () => {
  it('initSchema 建出 idx_issue_comment_issue，重复执行结构不变（幂等）', () => {
    expect(indexNames()).toContain('idx_issue_comment_issue');
    const before = t.db.prepare("SELECT sql FROM sqlite_master WHERE type='index' AND tbl_name='issue_comment' ORDER BY name").all();

    initSchema(t.db);
    initSchema(t.db);

    const after = t.db.prepare("SELECT sql FROM sqlite_master WHERE type='index' AND tbl_name='issue_comment' ORDER BY name").all();
    expect(after).toEqual(before);
    expect(indexNames().filter((n) => n === 'idx_issue_comment_issue')).toHaveLength(1);
  });

  it('comment_count 相关子查询走索引（不再是 SCAN issue_comment）', () => {
    const plan = t.db
      .prepare('EXPLAIN QUERY PLAN SELECT COUNT(*) FROM issue_comment c WHERE c.issue_id = ?')
      .all('x') as Array<{ detail: string }>;
    const detail = plan.map((r) => r.detail).join(' | ');
    expect(detail).toContain('idx_issue_comment_issue');
    expect(detail).not.toMatch(/SCAN issue_comment/);
  });

  it('真实 createApp 下 GET /api/issues 的 comment_count 与逐卡 count 一致', async () => {
    const ws = await request(created.app).post('/api/workspaces').send({ name: 'perf5', path: spaceDir });
    expect(ws.status).toBe(200);
    const workspaceId = ws.body.id as string;

    const ids = ['a', 'b', 'c'].map((n) => createIssue(t.db, { workspace_id: workspaceId, title: `任务${n}` }).id);
    const insert = t.db.prepare('INSERT INTO issue_comment (id, issue_id, author, content, ts) VALUES (?, ?, ?, ?, ?)');
    // a: 3 条, b: 1 条, c: 0 条
    for (let i = 0; i < 3; i++) insert.run(`ca${i}`, ids[0], 'user', `评论${i}`, 1000 + i);
    insert.run('cb0', ids[1], 'user', '评论', 2000);

    const res = await request(created.app).get(`/api/issues?workspace_id=${workspaceId}`);
    expect(res.status).toBe(200);
    const rows = res.body as Array<{ id: string; comment_count: number }>;
    expect(rows).toHaveLength(3);

    const count = t.db.prepare('SELECT COUNT(*) AS c FROM issue_comment WHERE issue_id=?');
    for (const row of rows) {
      expect(row.comment_count).toBe((count.get(row.id) as { c: number }).c);
    }
    expect(rows.find((r) => r.id === ids[0])!.comment_count).toBe(3);
    expect(rows.find((r) => r.id === ids[2])!.comment_count).toBe(0);
  });
});
