import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb, type Db } from '../src/db/connection.js';
import { initSchema } from '../src/db/schema.js';

export interface TestDb {
  db: Db;
  cleanup(): void;
}

/**
 * CARD-FACE 夹具建卡载荷：测试夹具不承载真实验收面，默认走服务端 allow_empty 逃生口。
 * 需要显式验证「空描述被拒」的用例不要用本 helper，直接调 POST 保持原语义。
 */
export function issuePayload(workspaceId: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { workspace_id: workspaceId, allow_empty: true, ...overrides };
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
