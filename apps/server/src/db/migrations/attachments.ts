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
