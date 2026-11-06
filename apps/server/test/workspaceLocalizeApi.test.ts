/**
 * STORE-2a：localize REST 端点（真 HTTP + 真临时库，不碰 8787）。
 *
 * 覆盖：POST dry-run / 真实迁移统一 jobId 模型；GET 阶段/计数/last_error；
 * already_localized 幂等；未知工作区 / 未知 jobId / 跨区读 job 一律 404（含 D7：未知工作区
 * 显式拒绝，不再靠 `path ?? ''` 落 cwd 相对路径）；中心 db_mode=localizing 期间该区写
 * 409 WORKSPACE_DB_MIGRATING、读继续、其它工作区无感。
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
import { createIssue } from '../src/db/repos/issue.js';
import { resetLocalizeJobs } from '../src/services/workspaceLocalizeJob.js';
import { readLocalizeState } from '../src/services/workspaceLocalize.js';
import { workspaceDbPath } from '../src/db/resolver.js';

describe('STORE-2a localize REST', () => {
  let t: TestDb;
  let app: Express;
  let root: string;
  let wsPath: string;
  let ws: string;
  let otherWs: string;

  const mkIssue = async (workspaceId: string, title: string): Promise<string> => {
    const res = await request(app).post('/api/issues').send(issuePayload(workspaceId, { title }));
    expect(res.status).toBe(200);
    return res.body.id as string;
  };
  const postLocalize = (body: Record<string, unknown> = {}, id: string = ws) =>
    request(app).post(`/api/workspaces/${id}/db/localize`).send(body);
  const getJob = (jobId: string, id: string = ws) => request(app).get(`/api/workspaces/${id}/db/localize/${jobId}`);
  const waitSettled = async (jobId: string): Promise<{ status: string; stage: string | null; counts: Record<string, number>; result: string | null; lastError: string | null; errorCode: string | null }> => {
    for (let i = 0; i < 200; i += 1) {
      const res = await getJob(jobId);
      expect(res.status).toBe(200);
      if (res.body.status !== 'running') return res.body;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new Error('localize 任务未在期限内结束');
  };

  beforeEach(async () => {
    resetLocalizeJobs();
    t = createTestDb();
    root = mkdtempSync(join(tmpdir(), 'agentboard-store2api-'));
    wsPath = join(root, 'ws');
    mkdirSync(wsPath, { recursive: true });
    const adapter = new FakeAdapter();
    const created = await createApp({
      db: t.db,
      getAdapter: (_id: string): AgentAdapter => adapter,
      adapters: [adapter],
      refreshClisOnBoot: false,
    });
    app = created.app;
    ws = createWorkspace(t.db, { name: '下沉区', path: wsPath }).id;
    const otherPath = join(root, 'other');
    mkdirSync(otherPath, { recursive: true });
    otherWs = createWorkspace(t.db, { name: '别区', path: otherPath }).id;
    createIssue(t.db, { workspace_id: ws, title: '卡一', description: '', priority: '中', labels: [] } as never);
    createIssue(t.db, { workspace_id: ws, title: '卡二', description: '', priority: '中', labels: [] } as never);
  });
  afterEach(() => {
    resetLocalizeJobs();
    t.cleanup();
    rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  });

  it('dry-run：统一 jobId 模型 → done + counts；不产生库文件、不落 localize.json、中心库 mode 不变', async () => {
    const created = await postLocalize({ dryRun: true });
    expect(created.status).toBe(202);
    expect(created.body.jobId).toBeTypeOf('string');
    expect(created.body.workspaceId).toBe(ws);
    const job = await waitSettled(created.body.jobId);
    expect(job).toMatchObject({ dryRun: true, status: 'done', result: 'dry_run', stage: null, lastError: null, errorCode: null });
    expect(job.counts.issue).toBe(2);
    expect(job.counts.rows_total).toBeGreaterThan(0); // STORE-4e：dry-run 键集与真实迁移终态统一
    expect(job.targetDbPath).toBe(workspaceDbPath(wsPath));

    expect(existsSync(workspaceDbPath(wsPath))).toBe(false);
    expect(readLocalizeState(wsPath)).toBeNull();
    expect((t.db.prepare('SELECT db_mode FROM workspace WHERE id = ?').get(ws) as { db_mode: string }).db_mode).toBe('center');
  });

  it('真实迁移：202 jobId → done/finalize，中心 db_mode=localized、scoped 行清空；再跑 already_localized', async () => {
    const created = await postLocalize({});
    expect(created.status).toBe(202);
    expect(created.body.status).toBe('running');
    const job = await waitSettled(created.body.jobId);
    expect(job.status).toBe('done');
    expect(job.result).toBe('localized');
    expect(job.stage).toBe('finalize');
    expect(job.counts.issue).toBe(2);
    expect(job.counts.rows_total).toBeGreaterThan(0); // STORE-4e：终态键集与 dry-run 统一（聚合键齐备）
    expect(job.errorCode).toBeNull();
    expect(job.targetDbPath).toBe(workspaceDbPath(wsPath));

    expect((t.db.prepare('SELECT db_mode FROM workspace WHERE id = ?').get(ws) as { db_mode: string }).db_mode).toBe('localized');
    expect((t.db.prepare('SELECT COUNT(*) AS n FROM issue WHERE workspace_id = ?').get(ws) as { n: number }).n).toBe(0);

    const again = await postLocalize({});
    expect(again.status).toBe(202);
    const job2 = await waitSettled(again.body.jobId);
    expect(job2.status).toBe('already_localized');
    expect(job2.result).toBe('already_localized');
    expect(job2.stage).toBeNull();
  });

  it('迁移进行中（db_mode=localizing）：该区写 409 WORKSPACE_DB_MIGRATING、读继续、其它工作区无感', async () => {
    const id = await mkIssue(ws, '迁移期卡');
    const otherId = await mkIssue(otherWs, '别区卡');
    // 模拟真实迁移进行中（REST 真跑的 localizing 窗口太短，直接置中心状态位验证闸门语义）
    t.db.prepare("UPDATE workspace SET db_mode = 'localizing' WHERE id = ?").run(ws);

    const patched = await request(app).patch(`/api/issues/${id}`).send({ title: '不许改' });
    expect(patched.status).toBe(409);
    expect(patched.body.error.code).toBe('WORKSPACE_DB_MIGRATING');

    const created = await request(app).post('/api/issues').send(issuePayload(ws, { title: '不许建' }));
    expect(created.status).toBe(409);
    expect(created.body.error.code).toBe('WORKSPACE_DB_MIGRATING');

    // 读继续（走中心库）
    const read = await request(app).get(`/api/issues/${id}`);
    expect(read.status).toBe(200);
    expect(read.body.title).toBe('迁移期卡');

    // 其它工作区无感
    const otherPatch = await request(app).patch(`/api/issues/${otherId}`).send({ title: '别区改名' });
    expect(otherPatch.status).toBe(200);
  });

  it('未知工作区 404（D7 显式拒绝）、未知 jobId 404、jobId 跨区不可读、非法 body 400', async () => {
    const missing = await postLocalize({}, 'ws-nonexistent');
    expect(missing.status).toBe(404);
    expect(missing.body.error.code).toBe('NOT_FOUND');

    const badJob = await getJob('loc-none');
    expect(badJob.status).toBe(404);

    const created = await postLocalize({ dryRun: true });
    const job = await waitSettled(created.body.jobId);
    const cross = await getJob(job.jobId, otherWs);
    expect(cross.status).toBe(404);

    const badBody = await postLocalize({ dryRun: 'yes' });
    expect(badBody.status).toBe(400);
  });
});
