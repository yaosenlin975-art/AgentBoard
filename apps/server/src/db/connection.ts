import Database from 'better-sqlite3';

export type Db = Database.Database;

/** 打开 SQLite 连接：WAL + busy_timeout=5000 + 外键级联启用 */
export function openDb(dbPath: string): Db {
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('busy_timeout = 5000');
  db.pragma('foreign_keys = ON');
  return db;
}
