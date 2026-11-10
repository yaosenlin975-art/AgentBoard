/**
 * CLI-CLOSE：close / reopen 两条流转的服务端语义（真库 + 真 HTTP）。
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import type { AgentAdapter } from '@agentboard/adapters';
import { createTestDb, type TestDb, issuePayload } from './helpers.js';
import { FakeAdapter } from './fakeAdapter.js';
import { createApp } from '../src/index.js';
import { createWorkspace } from '../src/db/repos/workspace.js';
import { createWorkspaceStatus } from '../src/services/workspaceStatus.js';

describe('issue transitions (CLI-CLOSE)', () => {
  let t: TestDb;
  let app: Express;
  let dir: string;
  let ws: string;

  const mkIssue = async (title: string): Promise<string> => {
    const res = await request(app).post('/api/issues').send(issuePayload(ws, { title }));
    expect(res.status).toBe(200);
    return res.body.id as string;
  };
  const claim = async (id: string): Promise<void> => {
    expect((await request(app).post(`/api/issues/${id}/claim`).send({ agent_id: 'fake' })).status).toBe(200);
  };
  const done = async (id: string): Promise<void> => {
    expect((await request(app).post(`/api/issues/${id}/done`).send({ workspace_id: ws, agent_id: 'fake', notes: '' })).status).toBe(200);
  };
  const closeIssue = (id: string, key?: string) => {
    const req = request(app).post(`/api/issues/${id}/close`).send({ workspace_id: ws, agent_id: 'fake' });
    return key ? req.set('Idempotency-Key', key) : req;
  };
  const reopen = (id: string, status?: string, key?: string) => {
    const req = request(app).post(`/api/issues/${id}/reopen`).send({ workspace_id: ws, agent_id: 'fake', ...(status ? { status } : {}) });
    return key ? req.set('Idempotency-Key', key) : req;
  };

  beforeEach(async () => {
    t = createTestDb();
    dir = mkdtempSync(join(tmpdir(), 'agentboard-transitions-'));
    const adapter = new FakeAdapter();
    const created = await createApp({
      db: t.db,
      getAdapter: (): AgentAdapter => adapter,
      adapters: [adapter],
      refreshClisOnBoot: false,
    });
    app = created.app;
    ws = createWorkspace(t.db, { name: '流转空间', path: mkdtempSync(join(dir, 'ws-')) }).id;
  });
  afterEach(() => {
    t.cleanup();
    rmSync(dir, { recursive: true, force: true });
  });

  it('changelogGate：agent 入口（带 client）未声明 changelog_ack → 400 CHANGELOG_ACK_REQUIRED，状态不变', async () => {
    const id = await mkIssue('门禁卡');
    await claim(id);
    const res = await request(app).post(`/api/issues/${id}/done`)
      .send({ workspace_id: ws, agent_id: 'fake', notes: '', client: 'cli' });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('CHANGELOG_ACK_REQUIRED');
    expect(res.body.error.message).toContain('--no-changelog');
    expect(res.body.error.message).toContain('skip_changelog');
    const show = await request(app).get(`/api/issues/${id}`);
    expect(show.body.status).toBe('进行中');
  });

  it('changelogGate：changelog_ack=true 放行；REST 直调（不带 client）保持旧行为', async () => {
    const ack = await mkIssue('已写日志');
    await claim(ack);
    const ok = await request(app).post(`/api/issues/${ack}/done`)
      .send({ workspace_id: ws, agent_id: 'fake', notes: '', client: 'mcp', changelog_ack: true });
    expect(ok.status).toBe(200);
    expect(ok.body.status).toBe('待验收');

    const legacy = await mkIssue('REST 直调');
    await claim(legacy);
    const rest = await request(app).post(`/api/issues/${legacy}/done`)
      .send({ workspace_id: ws, agent_id: 'fake', notes: '' });
    expect(rest.status).toBe(200);
  });

  it('changelogGate：本卡 changelog（issue_id + claim 之后创建）放行普通 done', async () => {
    const id = await mkIssue('先写日志');
    await claim(id);
    const log = await request(app).post(`/api/workspaces/${ws}/changelog`)
      .send({ title: '修好了', body_md: '用户可见变化', change_type: '修复', actor: 'fake', issue_id: id });
    expect(log.status).toBe(201);

    const ok = await request(app).post(`/api/issues/${id}/done`)
      .send({ workspace_id: ws, agent_id: 'fake', notes: '', client: 'cli', changelog_ack: false });
    expect(ok.status).toBe(200);
    expect(ok.body.status).toBe('待验收');
  });

  it('changelogGate：claim 之前写的本卡日志不算，仍 400', async () => {
    const id = await mkIssue('旧日志');
    await request(app).post(`/api/workspaces/${ws}/changelog`)
      .send({ title: '上轮日志', body_md: '旧内容', change_type: '修复', actor: 'fake', issue_id: id });
    await claim(id);
    const res = await request(app).post(`/api/issues/${id}/done`)
      .send({ workspace_id: ws, agent_id: 'fake', notes: '', client: 'cli', changelog_ack: false });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('CHANGELOG_ACK_REQUIRED');
  });

  it('changelogGate：changelog_id 指向本工作区日志放行；不存在则 400 CHANGELOG_NOT_FOUND', async () => {
    const id = await mkIssue('按 id 引用');
    await claim(id);
    const log = await request(app).post(`/api/workspaces/${ws}/changelog`)
      .send({ title: '修好了', body_md: '内容', change_type: '修复', actor: 'fake' });
    const ok = await request(app).post(`/api/issues/${id}/done`)
      .send({ workspace_id: ws, agent_id: 'fake', notes: '', client: 'mcp', changelog_ack: false, changelog_id: log.body.id });
    expect(ok.status).toBe(200);

    const other = await mkIssue('错误引用');
    await claim(other);
    const bad = await request(app).post(`/api/issues/${other}/done`)
      .send({
        workspace_id: ws, agent_id: 'fake', notes: '', client: 'mcp', changelog_ack: false,
        changelog_id: '00000000-0000-4000-8000-000000000000',
      });
    expect(bad.status).toBe(400);
    expect(bad.body.error.code).toBe('CHANGELOG_NOT_FOUND');
  });

  it('closesOnly待验收AndReopensToDefault', async () => {
    const id = await mkIssue('链路卡');
    await claim(id);
    await done(id);
    const closed = await closeIssue(id);
    expect(closed.status).toBe(200);
    expect(closed.body.status).toBe('已关闭');

    const reopened = await reopen(id);
    expect(reopened.status).toBe(200);
    expect(reopened.body.status).toBe('待规划');
  });

  it('rejectsCloseWhenClaimedOrNotPendingReview', async () => {
    const claimed = await mkIssue('占用中');
    await claim(claimed);
    const claimedRes = await closeIssue(claimed);
    expect(claimedRes.status).toBe(409);
    expect(claimedRes.body.error.code).toBe('ISSUE_CLAIMED');
    expect(claimedRes.body.error.message).toContain('先 release');

    const fresh = await mkIssue('还没验收');
    const invalid = await closeIssue(fresh);
    expect(invalid.status).toBe(409);
    expect(invalid.body.error.code).toBe('INVALID_TRANSITION');
    expect(invalid.body.error.message).toContain('待验收');
  });

  it('reopenAcceptsCustomStatusAndRejectsUnknownTarget', async () => {
    createWorkspaceStatus(t.db, { workspace_id: ws, name: '返工中', kind: 'started' });
    const id = await mkIssue('自定义目标');
    await claim(id);
    await done(id);
    expect((await closeIssue(id)).status).toBe(200);

    const bad = await reopen(id, '没有这个状态');
    expect(bad.status).toBe(400);
    expect(bad.body.error.message).toContain('返工中');

    const ok = await reopen(id, '返工中');
    expect(ok.status).toBe(200);
    expect(ok.body.status).toBe('返工中');
  });

  it('reopenRejectsNonClosedAndReopensDeprecated', async () => {
    createWorkspaceStatus(t.db, { workspace_id: ws, name: '不做了', kind: 'deprecated' });
    const id = await mkIssue('废弃重开');
    expect((await reopen(id)).status).toBe(409); // 待规划不是关闭态

    expect((await request(app).patch(`/api/issues/${id}`).send({ status: '不做了' })).status).toBe(200);
    const reopened = await reopen(id);
    expect(reopened.status).toBe(200);
    expect(reopened.body.status).toBe('待规划');
  });

  it('replaysIdempotentlyWithSameRequestId', async () => {
    const id = await mkIssue('幂等卡');
    await claim(id);
    await done(id);
    const key = randomUUID();
    const first = await closeIssue(id, key);
    expect(first.status).toBe(200);
    const updatedAt = first.body.updated_at as number;
    const replay = await closeIssue(id, key);
    expect(replay.status).toBe(200);
    expect(replay.body.updated_at).toBe(updatedAt); // 重放不改库
  });
});
