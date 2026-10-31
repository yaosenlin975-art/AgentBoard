import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb, type Db } from '../src/db/connection.js';
import { initSchema } from '../src/db/schema.js';

export interface TestDb {
  db: Db;
  cleanup(): void;
}

/** 每个用例独立的临时文件库（WAL），结束自动关闭并删除 */
export function createTestDb(): TestDb {
  const dir = mkdtempSync(join(tmpdir(), 'agentboard-test-'));
  const db = openDb(join(dir, 'test.db'));
  initSchema(db);
  return {
    db,
    cleanup() {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
