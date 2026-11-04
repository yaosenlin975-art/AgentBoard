import type { Db } from '../connection.js';

export function migrateKnowledge(db: Db): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS knowledge_page (
      id TEXT PRIMARY KEY, scope TEXT NOT NULL CHECK(scope IN ('workspace','common')),
      workspace_id TEXT REFERENCES workspace(id) ON DELETE RESTRICT,
      slug TEXT NOT NULL, title TEXT NOT NULL, body_md TEXT NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('active','archived','deleted')),
      revision INTEGER NOT NULL DEFAULT 1 CHECK(revision>0), expires_at INTEGER,
      created_by TEXT NOT NULL, updated_by TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
      CHECK((scope='common' AND workspace_id IS NULL) OR (scope='workspace' AND workspace_id IS NOT NULL)));
    CREATE UNIQUE INDEX IF NOT EXISTS knowledge_workspace_slug ON knowledge_page(workspace_id,slug) WHERE scope='workspace' AND status<>'deleted';
    CREATE UNIQUE INDEX IF NOT EXISTS knowledge_common_slug ON knowledge_page(slug) WHERE scope='common' AND status<>'deleted';
    CREATE INDEX IF NOT EXISTS knowledge_browse ON knowledge_page(scope,workspace_id,status,updated_at DESC);
    CREATE INDEX IF NOT EXISTS knowledge_expiry ON knowledge_page(expires_at) WHERE expires_at IS NOT NULL;
    CREATE TABLE IF NOT EXISTS knowledge_revision (
      id TEXT PRIMARY KEY, page_id TEXT NOT NULL REFERENCES knowledge_page(id) ON DELETE RESTRICT,
      revision INTEGER NOT NULL, title_snapshot TEXT NOT NULL, body_snapshot TEXT NOT NULL,
      sources_json TEXT NOT NULL, evidence_json TEXT NOT NULL,
      change_kind TEXT NOT NULL CHECK(change_kind IN ('create','update','archive','restore','delete')),
      status_snapshot TEXT NOT NULL CHECK(status_snapshot IN ('active','archived','deleted')),
      expires_at_snapshot INTEGER, change_note TEXT NOT NULL DEFAULT '', actor TEXT NOT NULL, created_at INTEGER NOT NULL,
      UNIQUE(page_id,revision));
    CREATE TRIGGER IF NOT EXISTS knowledge_revision_no_update BEFORE UPDATE ON knowledge_revision BEGIN SELECT RAISE(ABORT,'Knowledge history is immutable'); END;
    CREATE TRIGGER IF NOT EXISTS knowledge_revision_no_delete BEFORE DELETE ON knowledge_revision BEGIN SELECT RAISE(ABORT,'Knowledge history is immutable'); END;
    CREATE VIRTUAL TABLE IF NOT EXISTS knowledge_fts USING fts5(page_id UNINDEXED,title,body_md,tokenize='trigram');
    CREATE TRIGGER IF NOT EXISTS knowledge_fts_insert AFTER INSERT ON knowledge_page BEGIN
      INSERT INTO knowledge_fts(page_id,title,body_md) VALUES(new.id,new.title,new.body_md);
    END;
    CREATE TRIGGER IF NOT EXISTS knowledge_fts_update AFTER UPDATE ON knowledge_page BEGIN
      DELETE FROM knowledge_fts WHERE page_id=old.id;
      INSERT INTO knowledge_fts(page_id,title,body_md) VALUES(new.id,new.title,new.body_md);
    END;
    INSERT INTO knowledge_fts(page_id,title,body_md) SELECT id,title,body_md FROM knowledge_page p
      WHERE NOT EXISTS(SELECT 1 FROM knowledge_fts f WHERE f.page_id=p.id);
  `);
  // KB-MODEL：四类内容模型。幂等加列（PRAGMA 判断后 ALTER），只动 knowledge_page
  ensureColumn(db, 'knowledge_page', 'category', "category TEXT NOT NULL DEFAULT 'legacy' CHECK(category IN ('design','solved','pinned','open','legacy'))");
  ensureColumn(db, 'knowledge_page', 'landed', "landed TEXT CHECK(landed IS NULL OR landed IN ('landed','partial','proposed'))");
  db.exec("CREATE INDEX IF NOT EXISTS knowledge_category ON knowledge_page(category,status)");
  // KB-PAGE-3：域词表落到表字段（NULL = 未归类，不默认 legacy，也不加 CHECK——词表校验放服务层）
  ensureColumn(db, 'knowledge_page', 'domain', 'domain TEXT');
}

/**
 * KB-PAGE-3 的域词表（与仓库文档同一套词表）。校验在服务层做（不加 schema CHECK），
 * 这样后续扩展词表不需要重建表。
 */
export const KNOWLEDGE_DOMAINS = ['accounts', 'knowledge', 'board', 'chat', 'ui', 'infra'] as const;
export type KnowledgeDomain = (typeof KNOWLEDGE_DOMAINS)[number];

/** SQLite 的 ALTER TABLE ADD COLUMN 不可重复执行：先查 PRAGMA table_info 再决定是否加 */
function ensureColumn(db: Db, table: string, column: string, ddl: string): void {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  if (columns.some((item) => item.name === column)) return;
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${ddl}`);
}
