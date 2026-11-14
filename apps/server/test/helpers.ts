import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import express, { type Express } from 'express';
import { openDb, type Db } from '../src/db/connection.js';
import { initSchema } from '../src/db/schema.js';
import { migrateKnowledge } from '../src/db/migrations/knowledge.js';
import { migrateKnowledgeLinks } from '../src/db/migrations/knowledgeLinks.js';
import { createRouter, errorHandler } from '../src/api/routes.js';
import { createWorkspace } from '../src/db/repos/workspace.js';
import { AttachmentStore } from '../src/services/attachments.js';

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

/**
 * 每个用例独立的临时文件库（WAL），结束自动关闭并删除。
 *
 * P2-01：initSchema 不再注册知识表迁移（知识页权威数据已迁 Docs/*.md）。
 * 测「旧库只读回退层」（repos/knowledge、repos/knowledgeSearch、knowledge_link 等）的用例
 * 传 `{ legacyKnowledge: true }` 显式建旧知识表结构——对应 P2-02 export-legacy 将要读取的库形态。
 */
export function createTestDb(options: { legacyKnowledge?: boolean } = {}): TestDb {
  const dir = mkdtempSync(join(tmpdir(), 'agentboard-test-'));
  const db = openDb(join(dir, 'test.db'));
  initSchema(db);
  if (options.legacyKnowledge === true) {
    migrateKnowledge(db);
    migrateKnowledgeLinks(db);
  }
  return {
    db,
    cleanup() {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

/** P2-01：知识 REST 用例的临时 Docs 目录（工作区 + 公共两目录都进同一临时根，结束清理） */
export function createKnowledgeDocsFixture(): { root: string; workspaceDocs: string; commonDocs: string; cleanup(): void } {
  const root = mkdtempSync(join(tmpdir(), 'agentboard-kb-docs-'));
  const workspaceDocs = join(root, 'workspace', '.agentboard', 'Docs');
  const commonDocs = join(root, 'common', '.agentboard', 'Docs');
  return {
    root,
    workspaceDocs,
    commonDocs,
    cleanup() {
      rmSync(root, { recursive: true, force: true });
    },
  };
}

/**
 * P2-01：知识 REST 用例夹具——真实 express app + 两个**绝对路径**工作区（文件事实源按注册表路径
 * 推导 `<工作区>/.agentboard/Docs`）+ 公共 Docs 注入临时目录（绝不写真实 ~/.agentboard）。
 */
export function createKnowledgeRestFixture(): {
  t: TestDb;
  app: Express;
  a: string;
  b: string;
  root: string;
  commonDocs: string;
  docsOf: (workspaceId: string) => string;
  cleanup(): void;
} {
  const t = createTestDb();
  const root = mkdtempSync(join(tmpdir(), 'agentboard-kb-rest-'));
  const wsA = join(root, 'ws-a');
  const wsB = join(root, 'ws-b');
  mkdirSync(wsA, { recursive: true });
  mkdirSync(wsB, { recursive: true });
  const commonDocs = join(root, 'common-docs');
  const a = createWorkspace(t.db, { name: 'A', path: wsA }).id;
  const b = createWorkspace(t.db, { name: 'B', path: wsB }).id;
  const app = express();
  app.use(express.json());
  app.use('/api', createRouter({
    db: t.db,
    getAdapter: () => { throw Error('unused'); },
    broadcast: () => {},
    attachments: new AttachmentStore(t.db, join(root, 'attachments')),
    knowledgeDocsPaths: { commonDocsDir: () => commonDocs },
  }));
  app.use(errorHandler);
  const docsOf = (workspaceId: string): string => {
    const row = (t.db.prepare('SELECT path FROM workspace WHERE id=?').get(workspaceId) as { path: string });
    return join(row.path, '.agentboard', 'Docs');
  };
  return {
    t, app, a, b, root, commonDocs, docsOf,
    cleanup() {
      t.cleanup();
      rmSync(root, { recursive: true, force: true });
    },
  };
}
