import type { Db } from '../connection.js';

/** Private image metadata and cleanup ledger; the pinned base DDL remains unchanged. */
export function migrateAttachments(db: Db): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS attachment (
      id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
      storage_key TEXT NOT NULL UNIQUE,
      file_name TEXT NOT NULL,
      mime_type TEXT NOT NULL CHECK (mime_type IN ('image/png','image/jpeg','image/webp')),
      size_bytes INTEGER NOT NULL CHECK (size_bytes > 0),
      status TEXT NOT NULL CHECK (status IN ('staged','attached')),
      created_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS attachment_workspace_status
      ON attachment(workspace_id,status,expires_at);
    CREATE TABLE IF NOT EXISTS comment_attachment (
      comment_id TEXT NOT NULL REFERENCES issue_comment(id) ON DELETE CASCADE,
      attachment_id TEXT NOT NULL UNIQUE REFERENCES attachment(id) ON DELETE CASCADE,
      position INTEGER NOT NULL DEFAULT 0 CHECK (position >= 0),
      delivered_at INTEGER,
      delivery_state TEXT NOT NULL DEFAULT 'pending' CHECK (delivery_state IN ('pending','sending','unknown','delivered')),
      attempted_at INTEGER,
      PRIMARY KEY(comment_id,attachment_id),
      UNIQUE(comment_id,position)
    );
    CREATE TABLE IF NOT EXISTS attachment_cleanup (
      storage_key TEXT PRIMARY KEY,
      size_bytes INTEGER NOT NULL,
      queued_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS attachment_upload_reservation (
      storage_key TEXT PRIMARY KEY,
      size_bytes INTEGER NOT NULL,
      created_at INTEGER NOT NULL
    );
    CREATE TRIGGER IF NOT EXISTS attachment_queue_cleanup
      BEFORE DELETE ON attachment
      BEGIN
        INSERT OR IGNORE INTO attachment_cleanup(storage_key,size_bytes,queued_at)
        VALUES (old.storage_key,old.size_bytes,CAST(strftime('%s','now') AS INTEGER)*1000);
      END;
    CREATE TRIGGER IF NOT EXISTS comment_attachment_delete_image
      AFTER DELETE ON comment_attachment
      BEGIN
        DELETE FROM attachment WHERE id=old.attachment_id;
      END;
    -- CHAT-IMG-DELIVERY：会话级附件（自由聊天会话 issue_id=NULL 的图片投递记录），
    -- 状态机与 comment_attachment 平行（pending → sending → delivered/unknown）。
    CREATE TABLE IF NOT EXISTS session_attachment (
      session_id TEXT NOT NULL REFERENCES session(id) ON DELETE CASCADE,
      attachment_id TEXT NOT NULL UNIQUE REFERENCES attachment(id) ON DELETE CASCADE,
      position INTEGER NOT NULL DEFAULT 0 CHECK (position >= 0),
      delivered_at INTEGER,
      delivery_state TEXT NOT NULL DEFAULT 'pending' CHECK (delivery_state IN ('pending','sending','unknown','delivered')),
      attempted_at INTEGER,
      PRIMARY KEY(session_id,attachment_id),
      UNIQUE(session_id,position)
    );
    CREATE TRIGGER IF NOT EXISTS session_attachment_delete_image
      AFTER DELETE ON session_attachment
      BEGIN
        DELETE FROM attachment WHERE id=old.attachment_id;
      END;
  `);
  const columns = db.prepare('PRAGMA table_info(comment_attachment)').all() as Array<{ name: string }>;
  if (!columns.some((column) => column.name === 'delivered_at')) {
    db.exec('ALTER TABLE comment_attachment ADD COLUMN delivered_at INTEGER');
  }
  if (!columns.some((column) => column.name === 'delivery_state')) {
    db.exec("ALTER TABLE comment_attachment ADD COLUMN delivery_state TEXT NOT NULL DEFAULT 'pending' CHECK (delivery_state IN ('pending','sending','unknown','delivered'))");
  }
  if (!columns.some((column) => column.name === 'attempted_at')) {
    db.exec('ALTER TABLE comment_attachment ADD COLUMN attempted_at INTEGER');
  }
  db.exec(`
    UPDATE comment_attachment SET delivery_state='delivered' WHERE delivered_at IS NOT NULL;
    UPDATE comment_attachment SET delivery_state='unknown' WHERE delivery_state='sending';
  `);
}

/**
 * D7：附件从「图片专用」扩到「一切文件」——attachment 表加 kind 列（'image' | 'file'），
 * 并去掉 mime_type 上的三图片白名单 CHECK（通用文件的 MIME 不再受限）。
 *
 * SQLite 删不掉列上的 CHECK，加列必须整表重建：建新表 → 搬数据 → drop 旧表 → rename
 * （同 migrateIssueStatusModel 的做法）。存量行全部来自旧白名单，mime 三态显式写在 CASE 里、
 * 一律推导 kind='image'；新表 CHECK 仍兜底 kind 只取两值。
 *
 * 幂等判据：PRAGMA table_info(attachment) 已有 kind 列 → 直接返回（可重入）。
 * 事务：建表/搬数/删表/改名/重建索引与触发器在同一事务，失败整体回滚。
 * 触发器：DROP TABLE attachment 会带走其上的 attachment_queue_cleanup，由同一份 DDL 重建；
 * comment_attachment_delete_image / session_attachment_delete_image 虽建在别的表上，但正文引用
 * attachment，DROP 时会被 SQLite 重新解析而报 no such table——先在事务内摘掉、rename 完成后
 * 用原 SQL 原样装回，不手写它们的 DDL，避免与迁移实现漂移。
 */
export function migrateAttachmentKind(db: Db): void {
  const columns = db.prepare('PRAGMA table_info(attachment)').all() as Array<{ name: string }>;
  // 表还没建（理论上 initSchema 先跑 migrateAttachments，防御性兜底）或已迁移 → 无事可做
  if (columns.length === 0 || columns.some((column) => column.name === 'kind')) return;
  // PRAGMA foreign_keys 不能在事务内切换：先关（避免 drop/rename 期间子表 FK 报错），迁移完再开
  db.pragma('foreign_keys = OFF');
  try {
    db.transaction(() => {
      const dependentTriggers = db.prepare(`SELECT name, sql FROM sqlite_master
        WHERE type='trigger' AND tbl_name <> 'attachment' AND sql IS NOT NULL AND sql LIKE '%attachment%'`).all() as Array<{ name: string; sql: string }>;
      for (const trigger of dependentTriggers) db.exec(`DROP TRIGGER IF EXISTS "${trigger.name}"`);
      db.exec(`
        CREATE TABLE attachment_new (
          id TEXT PRIMARY KEY,
          workspace_id TEXT NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
          storage_key TEXT NOT NULL UNIQUE,
          file_name TEXT NOT NULL,
          mime_type TEXT NOT NULL,
          kind TEXT NOT NULL CHECK (kind IN ('image','file')),
          size_bytes INTEGER NOT NULL CHECK (size_bytes > 0),
          status TEXT NOT NULL CHECK (status IN ('staged','attached')),
          created_at INTEGER NOT NULL,
          expires_at INTEGER NOT NULL
        );
      `);
      db.exec(`INSERT INTO attachment_new(id,workspace_id,storage_key,file_name,mime_type,kind,size_bytes,status,created_at,expires_at)
        SELECT id,workspace_id,storage_key,file_name,mime_type,
          CASE WHEN mime_type IN ('image/png','image/jpeg','image/webp') THEN 'image' ELSE 'file' END,
          size_bytes,status,created_at,expires_at
        FROM attachment`);
      db.exec('DROP TABLE attachment');
      db.exec('ALTER TABLE attachment_new RENAME TO attachment');
      // 旧表上的索引与触发器随 DROP 一起消失，用同一份 DDL 重建
      db.exec(`
        CREATE INDEX IF NOT EXISTS attachment_workspace_status
          ON attachment(workspace_id,status,expires_at);
        CREATE TRIGGER IF NOT EXISTS attachment_queue_cleanup
          BEFORE DELETE ON attachment
          BEGIN
            INSERT OR IGNORE INTO attachment_cleanup(storage_key,size_bytes,queued_at)
            VALUES (old.storage_key,old.size_bytes,CAST(strftime('%s','now') AS INTEGER)*1000);
          END;
      `);
      for (const trigger of dependentTriggers) db.exec(trigger.sql);
    })();
  } finally {
    db.pragma('foreign_keys = ON');
  }
}
