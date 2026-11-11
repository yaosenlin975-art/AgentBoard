/**
 * 留言游标与 consume 恰好一次标注（issue 0afcf471）：
 * claim 建游标（领取输出视为已读）、consume 推进且重复调用为空、release/done 重置、绑定会话唤醒回归。
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import type { AgentAdapter } from '@agentboard/adapters';
import { createTestDb, type TestDb, issuePayload } from './helpers.js';
import { FakeAdapter, settle } from './fakeAdapter.js';
import { createApp, type CreatedApp } from '../src/index.js';
import { resetSessionManager } from '../src/services/sessionManager.js';

let t: TestDb;
let adapter: FakeAdapter;
let created: CreatedApp;
let app: Express;
let spaceDir: string;

function fakeResolver(id: string): AgentAdapter {
  if (id === 'fake' || id === 'codebuddy') return adapter;
  throw new Error(`未知适配器 id: ${id}`);
}

beforeEach(async () => {
  t = createTestDb();
  adapter = new FakeAdapter();
  spaceDir = mkdtempSync(join(tmpdir(), 'agentboard-consume-'));
  created = await createApp({
    db: t.db,
    getAdapter: fakeResolver,
    adapters: [adapter],
    maxConcurrentTurns: 3,
  });
  app = created.app;
  let clock = 1_000_000;
  vi.spyOn(Date, 'now').mockImplementation(() => ++clock);
});

afterEach(() => {
  vi.restoreAllMocks();
  resetSessionManager();
  t.cleanup();
  rmSync(spaceDir, { recursive: true, force: true });
});

async function mkSpace(): Promise<string> {
  const res = await request(app).post('/api/workspaces').send({ name: 'demo', path: spaceDir });
  expect(res.status).toBe(200);
  return res.body.id as string;
}

async function mkIssue(workspaceId: string): Promise<string> {
  const res = await request(app).post('/api/issues').send(issuePayload(workspaceId, { title: '任务' }));
  expect(res.status).toBe(200);
  return res.body.id as string;
}

async function kbClaim(issueId: string): Promise<void> {
  const res = await request(app).post(`/api/issues/${issueId}/claim`).send({ agent_id: 'kb-agent' });
  expect(res.status).toBe(200);
  expect(res.body).toMatchObject({ claimed_by: 'kb-agent', session_id: null });
}

async function userComment(issueId: string, content: string): Promise<{ id: string }> {
  const res = await request(app).post(`/api/issues/${issueId}/comments`).send({ content });
  expect(res.status).toBe(200);
  return res.body.comment as { id: string };
}

async function agentComment(issueId: string, content: string, agentId: string): Promise<{ id: string }> {
  const res = await request(app).post(`/api/issues/${issueId}/comments`).send({ content, agent_id: agentId });
  expect(res.status).toBe(200);
  return res.body.comment as { id: string };
}

async function consume(issueId: string): Promise<{
  comments: Array<{ id: string; content: string }>;
  new_comment_ids: string[];
}> {
  const res = await request(app).post(`/api/issues/${issueId}/comments/consume`);
  expect(res.status).toBe(200);
  return res.body;
}

/** 挂起首轮的派发：返回会话体（issue 已绑定会话占用） */
async function dispatchHeld(workspaceId: string, issueId: string): Promise<Record<string, unknown>> {
  adapter.script = () => undefined; // 挂起
  const res = await request(app)
    .post('/api/sessions')
    .send({ cli: 'codebuddy', model: 'm1', issue_id: issueId });
  expect(res.status).toBe(200);
  return res.body as Record<string, unknown>;
}

describe('POST /api/issues/:id/comments/consume', () => {
  it('claim 前已有评论：claim 后 consume new 为空（领取输出视为已读）', async () => {
    const wsId = await mkSpace();
    const id = await mkIssue(wsId);
    await userComment(id, '开工前补充约束');
    await kbClaim(id);

    const first = await consume(id);
    expect(first.new_comment_ids).toEqual([]);
    expect(first.comments).toHaveLength(1);
  });

  it('claim 后用户评论：第一次 consume 恰好标注新评论，第二次 new 为空（恰好一次）', async () => {
    const wsId = await mkSpace();
    const id = await mkIssue(wsId);
    await kbClaim(id);

    // 无评论时 consume：空数组且第二次仍为空
    const empty = await consume(id);
    expect(empty.comments).toEqual([]);
    expect(empty.new_comment_ids).toEqual([]);

    const c1 = await userComment(id, '补充要求一');
    const c2 = await userComment(id, '补充要求二');

    const first = await consume(id);
    expect(first.new_comment_ids).toEqual([c1.id, c2.id]); // 时间序
    expect(first.comments.map((c) => c.content)).toEqual(['补充要求一', '补充要求二']);

    const second = await consume(id);
    expect(second.new_comment_ids).toEqual([]);
  });

  it('占用者自身评论不标新（COMMENT-UNREAD 839cf942）：同一作者评论不进待读集合，他人评论照常标注', async () => {
    const wsId = await mkSpace();
    const id = await mkIssue(wsId);
    await kbClaim(id); // claimed_by = kb-agent

    await agentComment(id, '占用者进度留言', 'kb-agent');
    const first = await consume(id);
    expect(first.new_comment_ids).toEqual([]); // 自身评论不标新
    expect(first.comments.map((c) => c.content)).toEqual(['占用者进度留言']); // 评论仍在列表

    // 时间序在其后的用户评论照常标注，且自身评论不回涨
    const c2 = await userComment(id, '补充要求');
    const second = await consume(id);
    expect(second.new_comment_ids).toEqual([c2.id]);

    // 其他 agent 的评论不是「自身」，仍标新
    const other = await agentComment(id, '其他 agent 留言', 'other-agent');
    const third = await consume(id);
    expect(third.new_comment_ids).toEqual([other.id]);
  });

  it('未知 issue → 404', async () => {
    const res = await request(app).post('/api/issues/nope/comments/consume');
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('NOT_FOUND');
  });

  it('绑定会话占用：用户评论 woke=true 回归不破，consume 将该条标为待读', async () => {
    const wsId = await mkSpace();
    const id = await mkIssue(wsId);
    await dispatchHeld(wsId, id);

    const res = await request(app).post(`/api/issues/${id}/comments`).send({ content: '绑定会话留言' });
    expect(res.status).toBe(200);
    expect(res.body.woke).toBe(true);
    await settle();

    const result = await consume(id);
    expect(result.new_comment_ids).toEqual([(res.body.comment as { id: string }).id]);
  });

  it('release 重置游标：释放后重 claim，已消费评论不再标新', async () => {
    const wsId = await mkSpace();
    const id = await mkIssue(wsId);
    await kbClaim(id);
    const c1 = await userComment(id, '待读留言');
    expect((await consume(id)).new_comment_ids).toEqual([c1.id]);

    const release = await request(app).post(`/api/issues/${id}/release`);
    expect(release.status).toBe(200);
    await kbClaim(id);

    expect((await consume(id)).new_comment_ids).toEqual([]);
    const c2 = await userComment(id, '重占后新留言');
    expect((await consume(id)).new_comment_ids).toEqual([c2.id]);
  });

  it('done 重置游标：done 落 notes 评论后重 claim，notes 连同旧评论视为已读', async () => {
    const wsId = await mkSpace();
    const id = await mkIssue(wsId);
    await kbClaim(id);
    await userComment(id, '旧留言');
    await consume(id);

    const done = await request(app).post(`/api/issues/${id}/done`).send({ agent_id: 'kb-agent', notes: '完成' });
    expect(done.status).toBe(200);
    expect(done.body).toMatchObject({ status: '待验收', claimed_by: null });

    // 拖回待规划后重 claim
    await request(app).patch(`/api/issues/${id}`).send({ status: '待规划' });
    await kbClaim(id);
    expect((await consume(id)).new_comment_ids).toEqual([]);
  });
});
