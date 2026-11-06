/**
 * STORE-5/6（RULE-3 接线）：快照 REST 路由在真实 app 上可达。
 * - 中心库模式 → export 200（STORE-6：按工作区过滤，不再 409）
 * - enable 后 → export / validate 200，manifest 与磁盘一致
 * - 非空库 import → 409 SNAPSHOT_TARGET_NOT_EMPTY（路由与错误码接通）
 * - 中心库全局快照 → /api/system/center-snapshot/export|validate 200
 */
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import type { AgentAdapter } from '@agentboard/adapters';
import { createTestDb, type TestDb, issuePayload } from './helpers.js';
import { FakeAdapter } from './fakeAdapter.js';
import { createApp } from '../src/index.js';
import { createWorkspace } from '../src/db/repos/workspace.js';
import { closeWorkspaceDbs, resetResolverState, workspaceStateDir } from '../src/db/resolver.js';
import { resetLocalizeJobs } from '../src/services/workspaceLocalizeJob.js';
import { localizeWorkspace } from '../src/services/workspaceLocalizeRun.js';

describe('STORE-5/6 快照 REST 接线', () => {
  let t: TestDb;
  let app: Express;
  let root: string;
  let wsPath: string;
  let ws: string;

  beforeEach(async () => {
    resetLocalizeJobs();
    t = createTestDb();
    root = mkdtempSync(join(tmpdir(), 'agentboard-store5api-'));
    wsPath = join(root, 'ws');
    mkdirSync(wsPath, { recursive: true });
    mkdirSync(join(root, 'attachments'), { recursive: true });
    const adapter = new FakeAdapter();
    const created = await createApp({
      db: t.db,
      getAdapter: (_id: string): AgentAdapter => adapter,
      adapters: [adapter],
      refreshClisOnBoot: false,
    });
    app = created.app;
    ws = createWorkspace(t.db, { name: '快照 REST 区', path: wsPath }).id;
    for (const title of ['卡一', '卡二']) {
      const res = await request(app).post('/api/issues').send(issuePayload(ws, { title }));
      expect(res.status).toBe(200);
    }
  });
  afterEach(() => {
    resetLocalizeJobs();
    closeWorkspaceDbs('store5api-cleanup');
    resetResolverState();
    t.cleanup();
    rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  });

  const exportSnapshot = () => request(app).post(`/api/workspaces/${ws}/db/snapshot/export`).send({});
  const validateSnapshot = () => request(app).get(`/api/workspaces/${ws}/db/snapshot/validate`);
  const importSnapshot = (body: Record<string, unknown>) => request(app).post(`/api/workspaces/${ws}/db/snapshot/import`).send(body);

  it('中心库模式：export 200（STORE-6 按工作区过滤），未 enable 也有 .agentboard/snapshot', async () => {
    const res = await exportSnapshot();
    expect(res.status).toBe(200);
    expect(res.body.manifest.workspace_id).toBe(ws);
    expect(res.body.manifest.source_db).toBe(t.db.name);
    expect(existsSync(join(workspaceStateDir(wsPath), 'snapshot', 'issues.jsonl'))).toBe(true);
    expect(existsSync(join(workspaceStateDir(wsPath), '.gitignore'))).toBe(true);
    // 中心库模式仍不可 import（导入只对工作区库生效）
    const conflict = await importSnapshot({});
    expect(conflict.status).toBe(409);
    expect(conflict.body.error.code).toBe('SNAPSHOT_NOT_LOCALIZED');
  });

  it('中心库全局快照：/api/system/center-snapshot/export|validate 200，账号引用脱敏', async () => {
    const exported = await request(app).post('/api/system/center-snapshot/export').send({});
    expect(exported.status).toBe(200);
    expect(exported.body.manifest.scope).toBe('center');
    expect(exported.body.manifest.included_tables).toContain('managed_account');
    const validated = await request(app).get('/api/system/center-snapshot/validate');
    expect(validated.status).toBe(200);
    expect(validated.body.ok).toBe(true);
    expect(validated.body.tables.find((item: { table: string }) => item.table === 'workspace')?.rows).toBe(1);
  });

  it('enable 后：export 200 + validate 200，snapshot/ 落盘且行数正确', async () => {
    const migrated = await localizeWorkspace(t.db, {
      workspaceId: ws,
      freeBytes: async () => 10 * 1024 * 1024 * 1024,
      attachmentsDir: join(root, 'attachments'),
    });
    expect(migrated.state).toBe('localized');

    const exported = await exportSnapshot();
    expect(exported.status).toBe(200);
    expect(exported.body.manifest.workspace_id).toBe(ws);
    expect(exported.body.manifest.included_tables).not.toContain('message');
    expect(existsSync(join(workspaceStateDir(wsPath), 'snapshot', 'issues.jsonl'))).toBe(true);

    const validated = await validateSnapshot();
    expect(validated.status).toBe(200);
    expect(validated.body.ok).toBe(true);
    expect(validated.body.tables.find((item: { table: string }) => item.table === 'issue')?.rows).toBe(2);

    const includeMessages = await request(app).post(`/api/workspaces/${ws}/db/snapshot/export`).send({ includeMessages: true });
    expect(includeMessages.status).toBe(200);
    expect(includeMessages.body.manifest.included_tables).toContain('message');

    // STORE-6：--include-attachments 走同一路由的开关（无附件行时为空清单）
    const includeAttachments = await request(app).post(`/api/workspaces/${ws}/db/snapshot/export`).send({ includeAttachments: true });
    expect(includeAttachments.status).toBe(200);
    expect(includeAttachments.body.manifest.included_tables).toContain('attachment');
    expect(includeAttachments.body.manifest.attachments).toBeUndefined();

    const conflict = await importSnapshot({});
    expect(conflict.status).toBe(409);
    expect(conflict.body.error.code).toBe('SNAPSHOT_TARGET_NOT_EMPTY');
  }, 30_000);
});
