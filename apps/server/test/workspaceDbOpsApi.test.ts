/**
 * STORE-3a：工作区库操作 REST（真 HTTP + 真临时库，不碰 8787）。
 *
 * - GET /api/workspaces/:id/db：center/localized/failed/disabled 四种形态的状态汇总；
 * - POST .../db/localize（resume）+ POST .../db/localize/{cleanup,revert}：jobId 模型、409 拒绝、
 *   未知工作区 404、非法 body 400；
 * - 闸门生命周期：job 终态后写请求不再 409（resume 完成后 PATCH 放行；cleanup 后 PATCH 放行）。
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
import { readLocalizeState, writeLocalizeState } from '../src/services/workspaceLocalize.js';
import { closeWorkspaceDbs, resetResolverState, workspaceDbPath, workspaceStateDir } from '../src/db/resolver.js';

interface JobBody {
  jobId: string;
  kind?: string;
  status: string;
  stage: string | null;
  counts: Record<string, number>;
  result: string | null;
  lastError: string | null;
  errorCode?: string | null;
  backupPath: string | null;
}

describe('STORE-3a 工作区库 REST（status / resume / cleanup / revert）', () => {
  let t: TestDb;
  let app: Express;
  let root: string;
  let wsPath: string;
  let ws: string;

  const mkIssue = async (title: string): Promise<string> => {
    const res = await request(app).post('/api/issues').send(issuePayload(ws, { title }));
    expect(res.status).toBe(200);
    return res.body.id as string;
  };
  const getStatus = () => request(app).get(`/api/workspaces/${ws}/db`);
  const postLocalize = (body: Record<string, unknown>) => request(app).post(`/api/workspaces/${ws}/db/localize`).send(body);
  const postOp = (op: 'cleanup' | 'revert', body: Record<string, unknown> = {}) => request(app).post(`/api/workspaces/${ws}/db/localize/${op}`).send(body);
  const waitSettled = async (jobId: string): Promise<JobBody> => {
    for (let i = 0; i < 200; i += 1) {
      const res = await request(app).get(`/api/workspaces/${ws}/db/localize/${jobId}`);
      expect(res.status).toBe(200);
      if (res.body.status !== 'running') return res.body as JobBody;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new Error('任务未在期限内结束');
  };
  const runToDone = async (body: Record<string, unknown> = {}): Promise<JobBody> => {
    const created = await postLocalize(body);
    expect(created.status).toBe(202);
    return waitSettled(created.body.jobId);
  };

  beforeEach(async () => {
    resetLocalizeJobs();
    t = createTestDb();
    root = mkdtempSync(join(tmpdir(), 'agentboard-store3api-'));
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
    ws = createWorkspace(t.db, { name: 'REST 区', path: wsPath }).id;
    await mkIssue('卡一');
    await mkIssue('卡二');
  });
  afterEach(() => {
    resetLocalizeJobs();
    // STORE-4a：REST 读写会打开工作区库句柄，先关闭再删目录（Windows 文件占用）
    closeWorkspaceDbs('store3api-cleanup');
    resetResolverState();
    t.cleanup();
    rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  });

  it('status：center 形态（行数走中心库、快照落后 null、闸门 open）', async () => {
    const res = await getStatus();
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      workspaceId: ws,
      dbMode: 'center',
      writeGate: 'open',
      disabled: false,
      needsRevert: false,
      workspaceDbExists: false,
      snapshotLagRows: null,
      error: null,
    });
    expect(res.body.counts.issue).toBe(2);
    expect(res.body.counts.rows_total).toBeGreaterThan(0);
    expect(res.body.centerDbPath).toBe(t.db.name);
    expect(res.body.effectiveDbPath).toBe(t.db.name);
  });

  it('status：localized 形态（数据归属工作区库、快照落后 0、写闸门 open）', async () => {
    const job = await runToDone();
    expect(job.result).toBe('localized');
    expect(job.errorCode).toBeNull();
    expect(job.counts.rows_total).toBeGreaterThan(0); // STORE-4e：迁移终态键集与 dry-run 统一
    const res = await getStatus();
    expect(res.body).toMatchObject({ dbMode: 'localized', writeGate: 'open', workspaceDbExists: true, snapshotLagRows: 0 });
    expect(res.body.counts.issue).toBe(2);
    expect(res.body.effectiveDbPath).toBe(workspaceDbPath(wsPath));
    // localize.json 停在 finalize（2a 语义保留），status 透出中间态
    expect(res.body.localizeState).not.toBeNull();
    expect(res.body.localizeState.stage).toBe('finalize');
    expect(res.body.localizeState.backupPath).toBe(job.backupPath);
  });

  it('status：failed + localize.json 阶段透出（kill 后排障形态）', async () => {
    const id = await mkIssue('迁移期卡');
    t.db.prepare("UPDATE workspace SET db_mode = 'failed' WHERE id = ?").run(ws);
    writeLocalizeState(wsPath, {
      migration_id: 'mig-rest', workspace_id: ws, stage: 'copy', center_db: t.db.name,
      backup_path: null, started_at: 1, counts: { issue: 2 }, last_error: '进程被 kill',
    });
    const res = await getStatus();
    expect(res.body).toMatchObject({ dbMode: 'failed', writeGate: 'frozen' });
    expect(res.body.localizeState).toMatchObject({ stage: 'copy', lastError: '进程被 kill', migrationId: 'mig-rest' });
    // failed 读走中心库（行还在），写 409
    const read = await request(app).get(`/api/issues/${id}`);
    expect(read.status).toBe(200);
    const patched = await request(app).patch(`/api/issues/${id}`).send({ title: '不许改' });
    expect(patched.status).toBe(409);
    expect(patched.body.error.code).toBe('WORKSPACE_DB_MIGRATING');
  });

  it('resume REST：从 localize.json 续跑完成，行数守恒、闸门释放（终态后写不再 409）', async () => {
    await mkIssue('续跑卡');
    // 手工造 copy 阶段中断现场（等价 kill@copy 后的跨进程事实源）
    t.db.prepare("UPDATE workspace SET db_mode = 'failed' WHERE id = ?").run(ws);
    writeLocalizeState(wsPath, {
      migration_id: 'mig-resume', workspace_id: ws, stage: 'copy', center_db: t.db.name,
      backup_path: null, started_at: 1, counts: {}, last_error: '进程被 kill',
    });
    const created = await postLocalize({ resume: true });
    expect(created.status).toBe(202);
    expect(created.body.kind).toBe('localize');
    const job = await waitSettled(created.body.jobId);
    expect(job).toMatchObject({ status: 'done', result: 'localized', stage: 'finalize' });
    expect(job.counts.issue).toBe(3);
    expect((t.db.prepare('SELECT db_mode FROM workspace WHERE id = ?').get(ws) as { db_mode: string }).db_mode).toBe('localized');

    // job 终态后写请求不再 409（STORE-4a：新写落工作区库 → 中心无残留行，快照不落后；归属侧计数 +1）
    const write = await request(app).post('/api/issues').send(issuePayload(ws, { title: '终态后新建' }));
    expect(write.status).toBe(200);
    const status = await getStatus();
    expect(status.body.snapshotLagRows).toBe(0);
    expect(status.body.counts.issue).toBe(4);
  });

  it('resume 无中间态 / 非法 body / 未知工作区 / 未知 jobId → 明确 4xx', async () => {
    const created = await postLocalize({ resume: true });
    expect(created.status).toBe(202);
    const job = await waitSettled(created.body.jobId);
    expect(job.status).toBe('failed');
    expect(job.lastError).toContain('没有可恢复的迁移中间态');
    expect(job.errorCode).toBe('NO_LOCALIZE_STATE'); // STORE-4e：errorCode 全链路透传

    expect((await postLocalize({ resume: 'yes' })).status).toBe(400);
    expect((await request(app).post('/api/workspaces/ws-none/db/localize').send({ resume: true })).status).toBe(404);
    expect((await request(app).get('/api/workspaces/ws-none/db')).status).toBe(404);
    expect((await request(app).get(`/api/workspaces/${ws}/db/localize/loc-none`)).status).toBe(404);
  });

  it('cleanup REST：半成品删除、闸门释放、重跑 409 NOTHING_TO_CLEAN', async () => {
    const id = await mkIssue('清理期卡');
    t.db.prepare("UPDATE workspace SET db_mode = 'failed' WHERE id = ?").run(ws);
    writeLocalizeState(wsPath, {
      migration_id: 'mig-clean', workspace_id: ws, stage: 'copy', center_db: t.db.name,
      backup_path: null, started_at: 1, counts: {}, last_error: null,
    });
    mkdirSync(workspaceStateDir(wsPath), { recursive: true });
    const { writeFileSync } = await import('node:fs');
    writeFileSync(workspaceDbPath(wsPath), 'half-built', 'utf8');

    const created = await postOp('cleanup');
    expect(created.status).toBe(202);
    expect(created.body.kind).toBe('cleanup');
    const job = await waitSettled(created.body.jobId);
    expect(job).toMatchObject({ status: 'done', result: 'cleaned', stage: null });
    expect(job.counts.center_rows_before).toBeGreaterThan(0);
    expect(existsSync(workspaceDbPath(wsPath))).toBe(false);
    expect(readLocalizeState(wsPath)).toBeNull();
    expect((t.db.prepare('SELECT db_mode FROM workspace WHERE id = ?').get(ws) as { db_mode: string }).db_mode).toBe('center');

    // 闸门释放：写回 center，PATCH 放行
    expect((await request(app).patch(`/api/issues/${id}`).send({ title: '清理后改名' })).status).toBe(200);
    // 再清：无可清理物 → job failed NOTHING_TO_CLEAN（STORE-4e：机器可读码透传，CLI 按码判定）
    const again = await postOp('cleanup');
    expect(again.status).toBe(202);
    const againJob = await waitSettled(again.body.jobId);
    expect(againJob.status).toBe('failed');
    expect(againJob.lastError).toContain('没有可清理的迁移半成品');
    expect(againJob.errorCode).toBe('WORKSPACE_DB_NOTHING_TO_CLEAN');
  });

  it('cleanup 拒绝活库：localized 时 job failed CLEANUP_NOT_ALLOWED，中心数据不动', async () => {
    await runToDone();
    const created = await postOp('cleanup');
    const job = await waitSettled(created.body.jobId);
    expect(job.status).toBe('failed');
    expect(job.lastError).toContain('已正常下沉');
    expect(job.errorCode).toBe('WORKSPACE_DB_CLEANUP_NOT_ALLOWED');
    expect(existsSync(workspaceDbPath(wsPath))).toBe(true);
    // 中心数据未动：迁移后该区行已搬进工作区库（中心 issue=0），活库仍在
    expect((t.db.prepare('SELECT COUNT(*) AS n FROM issue').get() as { n: number }).n).toBe(0);
  });

  it('revert REST：全链路回迁（中心行数还原、db_mode=center、工作区库入 backup）', async () => {
    await runToDone();
    expect((t.db.prepare('SELECT COUNT(*) AS n FROM issue WHERE workspace_id = ?').get(ws) as { n: number }).n).toBe(0);

    const created = await postOp('revert');
    expect(created.status).toBe(202);
    expect(created.body.kind).toBe('revert');
    const job = await waitSettled(created.body.jobId);
    expect(job).toMatchObject({ status: 'done', result: 'reverted', stage: 'finalize' });
    expect(job.counts.issue).toBe(2);
    // STORE-4e 快照生命周期：revert 收尾一并清理前向迁移的 center-backup 快照
    expect(job.counts.removed_center_backups).toBeGreaterThanOrEqual(1);
    expect(job.backupPath).toContain(join('.agentboard', 'backup'));
    expect((t.db.prepare('SELECT db_mode FROM workspace WHERE id = ?').get(ws) as { db_mode: string }).db_mode).toBe('center');
    expect((t.db.prepare('SELECT COUNT(*) AS n FROM issue WHERE workspace_id = ?').get(ws) as { n: number }).n).toBe(2);
    expect(existsSync(workspaceDbPath(wsPath))).toBe(false);
    const status = await getStatus();
    expect(status.body).toMatchObject({ dbMode: 'center', workspaceDbExists: false, snapshotLagRows: null });
    expect(status.body.counts.issue).toBe(2);
  });

  it('revert 拒绝分叉：中心库出现该区行（disabled 期回写等分叉形态）→ job failed CENTER_ROWS，中心行保留', async () => {
    await runToDone();
    // STORE-4a 后 REST 写按判定落工作区库，不再自然产生中心分叉；分叉用直插中心库模拟（与 disabled 期回写等价）
    createIssue(t.db, { workspace_id: ws, title: '分叉卡', description: '', priority: '中', labels: [] } as never);
    const created = await postOp('revert');
    const job = await waitSettled(created.body.jobId);
    expect(job.status).toBe('failed');
    expect(job.lastError).toContain('无法安全回迁');
    expect(job.errorCode).toBe('WORKSPACE_DB_REVERT_CENTER_ROWS');
    expect((t.db.prepare('SELECT COUNT(*) AS n FROM issue WHERE workspace_id = ?').get(ws) as { n: number }).n).toBe(1);
    expect(existsSync(workspaceDbPath(wsPath))).toBe(true);
  });

  it('job 终态可见性：running 窗口透出 activeJob、终态后为 null（服务层确定性窗口）', async () => {
    const { startLocalizeJob, getActiveWorkspaceDbJob } = await import('../src/services/workspaceLocalizeJob.js');
    // startLocalizeJob 返回时 runner 停在 preflight 的 await（statfs 让出事件循环），同步检查即 running 窗口
    const job = startLocalizeJob(t.db, { workspaceId: ws, dryRun: true, overwrite: false, resume: false, attachmentsDir: join(root, 'attachments') });
    expect(getActiveWorkspaceDbJob(ws)?.jobId).toBe(job.jobId);
    // 等它落终态
    for (let i = 0; i < 200; i += 1) {
      const res = await request(app).get(`/api/workspaces/${ws}/db/localize/${job.jobId}`);
      if (res.body.status !== 'running') break;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    const statusAfter = await getStatus();
    expect(statusAfter.body.activeJob).toBeNull();
  });
});

describe('STORE-3a disabled 紧急开关（REST，env 隔离）', () => {
  let t: TestDb;
  let app: Express;
  let root: string;
  let wsPath: string;
  let ws: string;

  beforeEach(async () => {
    resetLocalizeJobs();
    process.env.AGENTBOARD_WORKSPACE_DB = 'disabled';
    t = createTestDb();
    root = mkdtempSync(join(tmpdir(), 'agentboard-store3dis-'));
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
    ws = createWorkspace(t.db, { name: '禁用区', path: wsPath }).id;
    createIssue(t.db, { workspace_id: ws, title: '禁用卡', description: '', priority: '中', labels: [] } as never);
  });
  afterEach(() => {
    delete process.env.AGENTBOARD_WORKSPACE_DB;
    resetLocalizeJobs();
    t.cleanup();
    rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  });

  it('disabled + localized：status 需 revert、已下沉区不静默回退（分叉写入可见）', async () => {
    // disabled 生效下迁移本身照常可跑（判定层只影响打开路径）
    const created = await request(app).post(`/api/workspaces/${ws}/db/localize`).send({});
    expect(created.status).toBe(202);
    for (let i = 0; i < 200; i += 1) {
      const job = await request(app).get(`/api/workspaces/${ws}/db/localize/${created.body.jobId}`);
      if (job.body.status !== 'running') {
        expect(job.body.result).toBe('localized');
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }

    const status = await request(app).get(`/api/workspaces/${ws}/db`);
    expect(status.body).toMatchObject({
      dbMode: 'localized',
      disabled: true,
      needsRevert: true,
      writeGate: 'open',
      error: null,
    });
    expect(status.body.reason).toContain('AGENTBOARD_WORKSPACE_DB=disabled');
    expect(status.body.effectiveDbPath).toBe(t.db.name);
    expect(status.body.counts.issue).toBe(1); // 数据归属工作区库
    // 不静默回退的可见性：disabled 期间写落中心库 → 快照落后 +1，status 立刻显形
    const write = await request(app).post('/api/issues').send(issuePayload(ws, { title: 'disabled 期写入' }));
    expect(write.status).toBe(200);
    const after = await request(app).get(`/api/workspaces/${ws}/db`);
    expect(after.body.snapshotLagRows).toBe(1);
    expect(after.body.counts.issue).toBe(1);
  });
});
