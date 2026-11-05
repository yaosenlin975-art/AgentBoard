import type { Db } from '../connection.js';

/**
 * KB-GRAPH-V2-4：正文双链落地表（`knowledge_link`）。
 *
 * STORE-4c：`target_page_id` **不再带 REFERENCES**——分库后链接目标可能落在另一个库
 * （工作区页双链到中心 common 页），同库外键既挡住跨库写入、又挡住 localize 的行拷贝
 * （defer_foreign_keys 提交校验同样会拒）。目标页真删时靠读时解析兜底（图端点只保留
 * 两端都在已加载集合里的边），不靠外键置 NULL。`source_page_id` 外键保留（源页与链接行同库）。
 *
 * 幂等依据：
 * - 新库直接按新结构 `IF NOT EXISTS` 建表；
 * - 旧库（sqlite_master 里 target_page_id 带 REFERENCES）走表重建：建新表→拷数据→删旧表→改名→重建索引，
 *   单事务完成，重复执行第二次检测到新结构即跳过（可重入）。
 *
 * 回滚（按依赖顺序，事务外）：
 *   DROP TABLE IF EXISTS knowledge_link;
 * 该表只读派生数据（由 `body_md` 解析而来），删除后可用 `POST /api/knowledge/reparse` 重建；
 * 不影响 `knowledge_page` / `knowledge_revision` 的既有数据。
 */

const KNOWLEDGE_LINK_DDL = `CREATE TABLE IF NOT EXISTS knowledge_link (
      id TEXT PRIMARY KEY,
      source_page_id TEXT NOT NULL REFERENCES knowledge_page(id) ON DELETE CASCADE,
      revision INTEGER NOT NULL,
      target_slug_norm TEXT NOT NULL,
      raw_target TEXT NOT NULL,
      alias TEXT,
      heading TEXT,
      target_page_id TEXT,
      resolved INTEGER NOT NULL CHECK(resolved IN (0,1)),
      weight INTEGER NOT NULL DEFAULT 1 CHECK(weight>0),
      created_at INTEGER NOT NULL)`;

const KNOWLEDGE_LINK_INDEXES = `
    CREATE INDEX IF NOT EXISTS knowledge_link_source ON knowledge_link(source_page_id, revision);
    CREATE INDEX IF NOT EXISTS knowledge_link_target ON knowledge_link(target_page_id) WHERE resolved=1;
    CREATE INDEX IF NOT EXISTS knowledge_link_unresolved ON knowledge_link(target_slug_norm) WHERE resolved=0;`;

/** 旧结构判定：target_page_id 列定义里带 REFERENCES（source 列的外键不在本列，不误判） */
function needsFkRebuild(tableSql: string): boolean {
  return /target_page_id\s+TEXT\s+REFERENCES/i.test(tableSql);
}

export function migrateKnowledgeLinks(db: Db): void {
  const existing = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='knowledge_link'").get() as { sql: string } | undefined;
  if (existing === undefined) {
    db.exec(`${KNOWLEDGE_LINK_DDL};${KNOWLEDGE_LINK_INDEXES}`);
    return;
  }
  if (!needsFkRebuild(existing.sql ?? '')) return;
  // STORE-4c 表重建：单事务（DDL 在 SQLite 事务内原子），拷贝按列名对齐。
  db.transaction(() => {
    db.exec(`
      DROP TABLE IF EXISTS knowledge_link_fk_rebuild;
      CREATE TABLE knowledge_link_fk_rebuild (
        id TEXT PRIMARY KEY,
        source_page_id TEXT NOT NULL REFERENCES knowledge_page(id) ON DELETE CASCADE,
        revision INTEGER NOT NULL,
        target_slug_norm TEXT NOT NULL,
        raw_target TEXT NOT NULL,
        alias TEXT,
        heading TEXT,
        target_page_id TEXT,
        resolved INTEGER NOT NULL CHECK(resolved IN (0,1)),
        weight INTEGER NOT NULL DEFAULT 1 CHECK(weight>0),
        created_at INTEGER NOT NULL);
      INSERT INTO knowledge_link_fk_rebuild
        (id, source_page_id, revision, target_slug_norm, raw_target, alias, heading, target_page_id, resolved, weight, created_at)
      SELECT id, source_page_id, revision, target_slug_norm, raw_target, alias, heading, target_page_id, resolved, weight, created_at
        FROM knowledge_link;
      DROP TABLE knowledge_link;
      ALTER TABLE knowledge_link_fk_rebuild RENAME TO knowledge_link;
    `);
    db.exec(KNOWLEDGE_LINK_INDEXES);
  })();
}
