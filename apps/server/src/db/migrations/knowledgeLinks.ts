import type { Db } from '../connection.js';

/**
 * KB-GRAPH-V2-4：正文双链落地表（`knowledge_link`）。
 *
 * 幂等依据：表与索引全部 `IF NOT EXISTS`，`initSchema` 每次启动都调用，重复执行不改结构、不写数据。
 *
 * 回滚（按依赖顺序，事务外）：
 *   DROP TABLE IF EXISTS knowledge_link;
 * 该表只读派生数据（由 `body_md` 解析而来），删除后可用 `POST /api/knowledge/reparse` 重建；
 * 不影响 `knowledge_page` / `knowledge_revision` 的既有数据。
 */
export function migrateKnowledgeLinks(db: Db): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS knowledge_link (
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
      created_at INTEGER NOT NULL);
    CREATE INDEX IF NOT EXISTS knowledge_link_source ON knowledge_link(source_page_id, revision);
    CREATE INDEX IF NOT EXISTS knowledge_link_target ON knowledge_link(target_page_id) WHERE resolved=1;
    CREATE INDEX IF NOT EXISTS knowledge_link_unresolved ON knowledge_link(target_slug_norm) WHERE resolved=0;
  `);
}
