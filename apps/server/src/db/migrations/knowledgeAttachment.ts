import type { Db } from '../connection.js';

/**
 * KB-IMG-1：知识页图片附件表（设计 §3）。
 *
 * - `storage_key` 只由服务端生成（`knowledge/<pageId>/<attachmentId>.<ext>`），不接受客户端文件名 → 防路径穿越。
 * - 删除知识页 → 行随 `ON DELETE CASCADE` 消失；文件由 `knowledgeImages` 的孤儿清理回收。
 *
 * 幂等：`CREATE TABLE/INDEX IF NOT EXISTS`。回滚：`DROP TABLE IF EXISTS knowledge_attachment;`
 */
export function migrateKnowledgeAttachment(db: Db): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS knowledge_attachment (
      id             TEXT PRIMARY KEY,
      page_id        TEXT NOT NULL REFERENCES knowledge_page(id) ON DELETE CASCADE,
      storage_key    TEXT NOT NULL,
      mime           TEXT NOT NULL,
      bytes          INTEGER NOT NULL,
      width          INTEGER,
      height         INTEGER,
      original_bytes INTEGER,
      created_by     TEXT NOT NULL,
      created_at     INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_knowledge_attachment_page ON knowledge_attachment(page_id);
  `);
}
