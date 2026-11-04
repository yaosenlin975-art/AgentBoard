import type { Db } from '../connection.js';

/** SQLite 的 ALTER TABLE ADD COLUMN 不可重复执行：先查 PRAGMA table_info 再决定是否加 */
export function ensureColumn(db: Db, table: string, column: string, ddl: string): void {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  if (columns.some((item) => item.name === column)) return;
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${ddl}`);
}
