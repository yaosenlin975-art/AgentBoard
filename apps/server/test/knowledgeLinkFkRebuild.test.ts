/**
 * STORE-4c：knowledge_link.target_page_id 去外键（SQLite 表重建迁移）。
 *
 * 覆盖：老结构库重建（数据保全 + 索引重建 + 重建残留清理）、重入幂等、
 * 重建后跨库/悬空 target 可写（外键松绑的动机）、source 外键保留（级联仍生效）、
 * 新库直接落新结构。
 */
import { describe, expect, it } from 'vitest';
import { createTestDb, type TestDb } from './helpers.js';
import { createKnowledgePage } from '../src/db/repos/knowledge.js';
import { migrateKnowledgeLinks } from '../src/db/migrations/knowledgeLinks.js';

const OLD_DDL = `CREATE TABLE knowledge_link (
  id TEXT PRIMARY KEY,
  source_page_id TEXT NOT NULL REFERENCES knowledge_page(id) ON DELETE CASCADE,
  revision INTEGER NOT NULL,
  target_slug_norm TEXT NOT NULL,
  raw_target TEXT NOT NULL,
  alias TEXT,
  heading TEXT,
  target_page_id TEXT REFERENCES knowledge_page(id) ON DELETE SET NULL,
  resolved INTEGER NOT NULL CHECK(resolved IN (0,1)),
  weight INTEGER NOT NULL DEFAULT 1 CHECK(weight>0),
  created_at INTEGER NOT NULL)`;

const tableSql = (db: TestDb['db']): string =>
  ((db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='knowledge_link'").get() as { sql: string }).sql);

const indexNames = (db: TestDb['db']): string[] =>
  (db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND name LIKE 'knowledge_link_%' ORDER BY name").all() as Array<{ name: string }>).map(row => row.name);

const sources = [{ source_id: 's', source_type: 'agent' as const, locator: 'issue:1', captured_at: 1, content_hash: 'a'.repeat(64), snapshot: 'verified' }];
const evidence = [{ source_id: 's', locator: 'issue:1' }];

describe('knowledge_link 外键松绑迁移（STORE-4c）', () => {
  it('newDbCreatesRelaxedSchemaDirectly and rerun is no-op', () => {
    const t = createTestDb();
    try {
      expect(tableSql(t.db)).not.toMatch(/target_page_id\s+TEXT\s+REFERENCES/i);
      expect(tableSql(t.db)).toMatch(/source_page_id TEXT NOT NULL REFERENCES/);
      expect(indexNames(t.db)).toEqual(expect.arrayContaining(['knowledge_link_source', 'knowledge_link_target', 'knowledge_link_unresolved']));
      const before = tableSql(t.db);
      migrateKnowledgeLinks(t.db);
      expect(tableSql(t.db)).toBe(before);
    } finally { t.cleanup(); }
  });

  it('rebuildsLegacyTablePreservingRows and removes target fk', () => {
    const t = createTestDb();
    try {
      const page = createKnowledgePage(t.db, { domain: 'knowledge', scope: 'common', slug: 'src', title: '源页', body_md: '正文', actor: 'tester', sources, evidence });
      const target = createKnowledgePage(t.db, { domain: 'knowledge', scope: 'common', slug: 'tgt', title: '目标页', body_md: '正文', actor: 'tester', sources, evidence });
      // 模拟升级前的老结构库
      t.db.exec('DROP TABLE knowledge_link');
      t.db.exec(OLD_DDL);
      t.db.exec(`
        CREATE INDEX knowledge_link_source ON knowledge_link(source_page_id, revision);
        CREATE INDEX knowledge_link_target ON knowledge_link(target_page_id) WHERE resolved=1;
        CREATE INDEX knowledge_link_unresolved ON knowledge_link(target_slug_norm) WHERE resolved=0;`);
      const now = Date.now();
      t.db.prepare(`INSERT INTO knowledge_link (id, source_page_id, revision, target_slug_norm, raw_target, alias, heading, target_page_id, resolved, weight, created_at)
        VALUES ('l1', ?, 1, 'tgt', 'tgt', NULL, NULL, ?, 1, 1, ?)`).run(page.id, target.id, now);
      t.db.prepare(`INSERT INTO knowledge_link (id, source_page_id, revision, target_slug_norm, raw_target, alias, heading, target_page_id, resolved, weight, created_at)
        VALUES ('l2', ?, 1, 'ghost', 'ghost', NULL, NULL, NULL, 0, 2, ?)`).run(page.id, now);

      migrateKnowledgeLinks(t.db);

      expect(tableSql(t.db)).not.toMatch(/target_page_id\s+TEXT\s+REFERENCES/i);
      expect(tableSql(t.db)).toMatch(/source_page_id TEXT NOT NULL REFERENCES/);
      expect(indexNames(t.db)).toEqual(expect.arrayContaining(['knowledge_link_source', 'knowledge_link_target', 'knowledge_link_unresolved']));
      expect(t.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='knowledge_link_fk_rebuild'").get()).toBeUndefined();
      const rows = t.db.prepare('SELECT id, source_page_id, revision, target_slug_norm, target_page_id, resolved, weight FROM knowledge_link ORDER BY id').all() as Array<Record<string, unknown>>;
      expect(rows).toEqual([
        { id: 'l1', source_page_id: page.id, revision: 1, target_slug_norm: 'tgt', target_page_id: target.id, resolved: 1, weight: 1 },
        { id: 'l2', source_page_id: page.id, revision: 1, target_slug_norm: 'ghost', target_page_id: null, resolved: 0, weight: 2 },
      ]);

      // 重入：第二次执行不动结构、不丢数据
      migrateKnowledgeLinks(t.db);
      expect((t.db.prepare('SELECT COUNT(*) AS n FROM knowledge_link').get() as { n: number }).n).toBe(2);
      expect(tableSql(t.db)).not.toMatch(/target_page_id\s+TEXT\s+REFERENCES/i);
    } finally { t.cleanup(); }
  });

  it('relaxedSchemaAcceptsCrossDbDanglingTarget while source fk and cascade remain', () => {
    const t = createTestDb();
    try {
      const page = createKnowledgePage(t.db, { domain: 'knowledge', scope: 'common', slug: 'src', title: '源页', body_md: '正文', actor: 'tester', sources, evidence });
      // 目标 id 属于另一个库（本库无此页）——老外键会拒，松绑后允许（读时解析兜底）
      t.db.prepare(`INSERT INTO knowledge_link (id, source_page_id, revision, target_slug_norm, raw_target, alias, heading, target_page_id, resolved, weight, created_at)
        VALUES ('x1', ?, 1, 'elsewhere', 'elsewhere', NULL, NULL, 'ffffffff-ffff-ffff-ffff-ffffffffffff', 1, 1, ?)`)
        .run(page.id, Date.now());
      expect((t.db.prepare('SELECT resolved FROM knowledge_link WHERE id=?').get('x1') as { resolved: number }).resolved).toBe(1);
      // source 外键保留：源 id 不存在仍拒绝
      expect(() => t.db.prepare(`INSERT INTO knowledge_link (id, source_page_id, revision, target_slug_norm, raw_target, alias, heading, target_page_id, resolved, weight, created_at)
        VALUES ('x2', 'no-such-page', 1, 'x', 'x', NULL, NULL, NULL, 0, 1, ?)`).run(Date.now())).toThrow();
      // 源页硬删仍级联清链接行（历史不可变触发器先摘后还原，同 workspaceLocalizeRun 的硬删口径）
      const triggers = t.db.prepare("SELECT name, sql FROM sqlite_master WHERE type='trigger' AND name IN ('knowledge_revision_no_update','knowledge_revision_no_delete') AND sql IS NOT NULL").all() as Array<{ name: string; sql: string }>;
      for (const trigger of triggers) t.db.exec(`DROP TRIGGER ${trigger.name}`);
      try {
        t.db.prepare('DELETE FROM knowledge_revision WHERE page_id=?').run(page.id);
        t.db.prepare('DELETE FROM knowledge_page WHERE id=?').run(page.id);
      } finally {
        for (const trigger of triggers) t.db.exec(trigger.sql);
      }
      expect((t.db.prepare('SELECT COUNT(*) AS n FROM knowledge_link').get() as { n: number }).n).toBe(0);
    } finally { t.cleanup(); }
  });
});
