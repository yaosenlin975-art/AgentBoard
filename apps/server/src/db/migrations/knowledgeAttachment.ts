import type { Db } from '../connection.js';

/**
 * KB-IMG-1：知识页图片附件表（设计 §3）。
 *
 * - `storage_key` 只由服务端生成（`knowledge/<pageId>/<attachmentId>.<ext>`），不接受客户端文件名 → 防路径穿越。
 * - 删除知识页 → 行随 `ON DELETE CASCADE` 消失；文件由 `knowledgeImages` 的孤儿清理回收。
 *
 * 幂等：`CREATE TABLE/INDEX IF NOT EXISTS`。回滚：`DROP TABLE IF EXISTS knowledge_attachment;`
 *
 * P2-01：`REFERENCES knowledge_page` 外键**从建表语句中移除**——knowledge_page 已退出 initSchema
 * （知识页权威数据在 Docs/*.md），带外键的 INSERT 会因父表缺失直接失败（`no such table: main.knowledge_page`）。
 * 页面可见性由路由层文件索引（requireVisiblePage）校验；旧库已有带外键的表不受影响（IF NOT EXISTS 原样保留）。
 */
export function migrateKnowledgeAttachment(db: Db): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS knowledge_attachment (
      id             TEXT PRIMARY KEY,
      page_id        TEXT NOT NULL,
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
