import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { WebSocket, type WebSocket as WsClient } from 'ws';
import type { Express } from 'express';
import type { AgentAdapter } from '@agentboard/adapters';
import type { WsEvent } from '@agentboard/shared';
import { createTestDb, type TestDb } from './helpers.js';
import { FakeAdapter, settle, type FakeTurnControl } from './fakeAdapter.js';
import { createApp, type CreatedApp } from '../src/index.js';
import { initSessionManager, resetSessionManager, setBroadcaster, setMaxConcurrentTurns } from '../src/services/sessionManager.js';

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
  spaceDir = mkdtempSync(join(tmpdir(), 'agentboard-space-'));
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

/** 建工作空间（合法目录），返回 id */
async function mkSpace(name = 'demo'): Promise<string> {
  const res = await request(app).post('/api/workspaces').send({ name, path: spaceDir });
  expect(res.status).toBe(200);
  return res.body.id as string;
}

async function mkIssue(workspaceId: string, title = '任务'): Promise<Record<string, unknown>> {
  const res = await request(app)
    .post('/api/issues')
    .send({ workspace_id: workspaceId, title, description: '描述', priority: '高', labels: ['p1'] });
  expect(res.status).toBe(200);
  return res.body as Record<string, unknown>;
}

/** 挂起首轮的派发：返回会话体（issue 已占用） */
async function dispatchHeld(workspaceId: string, issueId: string): Promise<Record<string, unknown>> {
  adapter.script = () => undefined; // 挂起
  const res = await request(app)
    .post('/api/sessions')
    .send({ cli: 'codebuddy', model: 'm1', issue_id: issueId });
  expect(res.status).toBe(200);
  return res.body as Record<string, unknown>;
}

describe('workspaces', () => {
  it('POST 建空间（目录存在）→ GET 列表 → DELETE → 级联清空', async () => {
    const res = await request(app).post('/api/workspaces').send({ name: 'demo', path: spaceDir });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ name: 'demo', path: spaceDir });
    expect(typeof res.body.id).toBe('string');
    expect(typeof res.body.created_at).toBe('number');

    const list = await request(app).get('/api/workspaces');
    expect(list.status).toBe(200);
    expect(list.body).toHaveLength(1);

    const del = await request(app).delete(`/api/workspaces/${res.body.id}`);
    expect(del.status).toBe(204);
    expect((await request(app).get('/api/workspaces')).body).toHaveLength(0);
  });

  it('POST path 不存在/不是目录 → 400；缺 name → 400', async () => {
    const bad = await request(app).post('/api/workspaces').send({ name: 'x', path: 'D:\\no\\such\\dir' });
    expect(bad.status).toBe(400);
    expect(bad.body.error.code).toBe('VALIDATION_ERROR');

    const missing = await request(app).post('/api/workspaces').send({ path: spaceDir });
    expect(missing.status).toBe(400);
  });

  it('name 留空 → 从 path basename 兜底：D:\\a\\b\\my-project → my-project', async () => {
    const parent = mkdtempSync(join(tmpdir(), 'agentboard-wsname-'));
    const dir = join(parent, 'my-project');
    mkdirSync(dir);
    try {
      const res = await request(app).post('/api/workspaces').send({ name: '', path: dir });
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ name: 'my-project', path: dir });
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  });

  it('name 留空且 path 带尾部反斜杠：D:\\a\\b\\my-project\\ → my-project', async () => {
    const parent = mkdtempSync(join(tmpdir(), 'agentboard-wsname-'));
    const dir = join(parent, 'my-project');
    mkdirSync(dir);
    try {
      const res = await request(app).post('/api/workspaces').send({ name: '', path: dir + '\\' });
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ name: 'my-project', path: dir + '\\' });
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  });

  it('DELETE 不存在 → 404', async () => {
    const res = await request(app).delete('/api/workspaces/nope');
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('NOT_FOUND');
  });
});

describe('issues 全生命周期', () => {
  it('POST → GET 列表 → PATCH 字段 → DELETE', async () => {
    const wsId = await mkSpace();
    const issue = await mkIssue(wsId);
    expect(issue).toMatchObject({
      workspace_id: wsId,
      title: '任务',
      description: '描述',
      priority: '高',
      labels: ['p1'],
      status: '待规划',
      claimed_by: null,
      session_id: null,
    });

    const list = await request(app).get(`/api/issues?workspace=${wsId}`);
    expect(list.status).toBe(200);
    expect(list.body).toHaveLength(1);
    expect(list.body[0].id).toBe(issue.id);

    // GET /api/issues/:id（kb show 依赖）：返回单条完整字段；未知 id → 404
    const one = await request(app).get(`/api/issues/${issue.id}`);
    expect(one.status).toBe(200);
    expect(one.body).toMatchObject({ id: issue.id, workspace_id: wsId, title: '任务', priority: '高' });
    const missing = await request(app).get('/api/issues/no-such-id');
    expect(missing.status).toBe(404);
    expect(missing.body).toEqual({ error: { code: 'NOT_FOUND', message: '任务不存在' } });

    const patched = await request(app)
      .patch(`/api/issues/${issue.id}`)
      .send({ title: '改名', labels: ['a', 'b'], sort_order: 2 });
    expect(patched.status).toBe(200);
    expect(patched.body).toMatchObject({ title: '改名', labels: ['a', 'b'], sort_order: 2 });

    const del = await request(app).delete(`/api/issues/${issue.id}`);
    expect(del.status).toBe(204);
    expect((await request(app).get(`/api/issues?workspace=${wsId}`)).body).toHaveLength(0);
  });

  it('校验与 404：workspace 不存在 → 404；缺参数 → 400；PATCH 空体 → 400；未知 id → 404', async () => {
    const res = await request(app).post('/api/issues').send({ workspace_id: 'nope', title: 'x' });
    expect(res.status).toBe(404);

    const noQuery = await request(app).get('/api/issues');
    expect(noQuery.status).toBe(400);

    const badQuery = await request(app).get('/api/issues?workspace=nope');
    expect(badQuery.status).toBe(404);

    const wsId = await mkSpace();
    const issue = await mkIssue(wsId);
    const empty = await request(app).patch(`/api/issues/${issue.id}`).send({});
    expect(empty.status).toBe(400);

    const missing = await request(app).patch('/api/issues/nope').send({ title: 'x' });
    expect(missing.status).toBe(404);
  });

  it('claim：占用登记（session_id=null）→ 状态进行中；重复 claim 409；PATCH status 占用中 409、字段放行；release 回待规划 + system 评论', async () => {
    const wsId = await mkSpace();
    const issue = await mkIssue(wsId);
    const id = issue.id as string;

    const claim = await request(app).post(`/api/issues/${id}/claim`).send({ agent_id: 'kb-agent' });
    expect(claim.status).toBe(200);
    expect(claim.body).toMatchObject({ status: '进行中', claimed_by: 'kb-agent', session_id: null });

    const dup = await request(app).post(`/api/issues/${id}/claim`).send({ agent_id: 'another' });
    expect(dup.status).toBe(409);
    expect(dup.body.error).toMatchObject({ code: 'CONFLICT', message: '已被占用' });

    const patchStatus = await request(app).patch(`/api/issues/${id}`).send({ status: '待验收' });
    expect(patchStatus.status).toBe(409);
    const patchTitle = await request(app).patch(`/api/issues/${id}`).send({ title: '占用中改名' });
    expect(patchTitle.status).toBe(200);

    const release = await request(app).post(`/api/issues/${id}/release`);
    expect(release.status).toBe(200);
    expect(release.body).toMatchObject({ status: '待规划', claimed_by: null });
    const comments = await request(app).get(`/api/issues/${id}/comments`);
    expect(comments.body).toEqual([
      expect.objectContaining({ author: 'system', content: '用户强制释放' }),
    ]);
  });

  it('done：未占用 409；占用后 done → 待验收 + 释放 + notes 评论；fail → 待规划 + reason 评论', async () => {
    const wsId = await mkSpace();
    const id = (await mkIssue(wsId)).id as string;

    const doneFree = await request(app).post(`/api/issues/${id}/done`).send({ agent_id: 'a', notes: 'n' });
    expect(doneFree.status).toBe(409);

    await request(app).post(`/api/issues/${id}/claim`).send({ agent_id: 'a' });
    const done = await request(app)
      .post(`/api/issues/${id}/done`)
      .send({ agent_id: 'a', notes: '已完成主体' });
    expect(done.status).toBe(200);
    expect(done.body).toMatchObject({ status: '待验收', claimed_by: null });
    let comments = await (await request(app).get(`/api/issues/${id}/comments`)).body;
    expect(comments).toEqual([expect.objectContaining({ author: 'agent:a', content: '已完成主体' })]);

    // 拖回待规划后重新占用，再 fail
    await request(app).patch(`/api/issues/${id}`).send({ status: '待规划' });
    await request(app).post(`/api/issues/${id}/claim`).send({ agent_id: 'b' });
    const fail = await request(app).post(`/api/issues/${id}/fail`).send({ agent_id: 'b', reason: '依赖缺失' });
    expect(fail.status).toBe(200);
    expect(fail.body).toMatchObject({ status: '待规划', claimed_by: null });
    comments = await (await request(app).get(`/api/issues/${id}/comments`)).body;
    expect(comments[1]).toMatchObject({ author: 'agent:b', content: '依赖缺失' });

    const failNoReason = await request(app).post(`/api/issues/${id}/fail`).send({ agent_id: 'b' });
    expect(failNoReason.status).toBe(400);
  });

  it('done/fail/release 自动评论补 WS 推送：先 comment.added 后 issue.changed；done 无 notes 不广播 comment.added；响应 issue 字段 + comment 附加', async () => {
    const wsId = await mkSpace();
    const id = (await mkIssue(wsId)).id as string;

    // done 带 notes：广播 comment.added（内容=notes）+ issue.changed，顺序与手动评论端点一致
    await request(app).post(`/api/issues/${id}/claim`).send({ agent_id: 'a' });
    const spy = vi.spyOn(created.hub, 'broadcast');
    const done = await request(app)
      .post(`/api/issues/${id}/done`)
      .send({ agent_id: 'a', notes: '已完成主体' });
    expect(done.status).toBe(200);
    expect(done.body).toMatchObject({ status: '待验收', claimed_by: null });
    expect(done.body.comment).toMatchObject({ author: 'agent:a', content: '已完成主体' });
    const doneEvents = spy.mock.calls.map(([e]) => e);
    expect(doneEvents.map((e) => e.type)).toEqual(['comment.added', 'issue.changed']);
    expect(doneEvents[0]).toEqual({ type: 'comment.added', comment: done.body.comment });

    // done 无 notes：只广播 issue.changed，响应 comment 为 null
    await request(app).patch(`/api/issues/${id}`).send({ status: '待规划' });
    await request(app).post(`/api/issues/${id}/claim`).send({ agent_id: 'b' });
    spy.mockClear();
    const doneSilent = await request(app).post(`/api/issues/${id}/done`).send({ agent_id: 'b' });
    expect(doneSilent.status).toBe(200);
    expect(doneSilent.body.comment).toBeNull();
    expect(spy.mock.calls.map(([e]) => e.type)).toEqual(['issue.changed']);

    // fail：reason 评论广播
    await request(app).patch(`/api/issues/${id}`).send({ status: '待规划' });
    await request(app).post(`/api/issues/${id}/claim`).send({ agent_id: 'c' });
    spy.mockClear();
    const fail = await request(app).post(`/api/issues/${id}/fail`).send({ agent_id: 'c', reason: '依赖缺失' });
    expect(fail.status).toBe(200);
    expect(fail.body.comment).toMatchObject({ author: 'agent:c', content: '依赖缺失' });
    expect(spy.mock.calls.map(([e]) => e.type)).toEqual(['comment.added', 'issue.changed']);

    // release：system 评论广播
    await request(app).post(`/api/issues/${id}/claim`).send({ agent_id: 'd' });
    spy.mockClear();
    const release = await request(app).post(`/api/issues/${id}/release`);
    expect(release.status).toBe(200);
    expect(release.body.comment).toMatchObject({ author: 'system', content: '用户强制释放' });
    expect(spy.mock.calls.map(([e]) => e.type)).toEqual(['comment.added', 'issue.changed']);
  });

  it('DELETE 占用中 → 409', async () => {
    const wsId = await mkSpace();
    const id = (await mkIssue(wsId)).id as string;
    await request(app).post(`/api/issues/${id}/claim`).send({ agent_id: 'a' });
    const del = await request(app).delete(`/api/issues/${id}`);
    expect(del.status).toBe(409);
  });
});

describe('comments', () => {
  it('未占用：woke=false；ts 升序返回', async () => {
    const wsId = await mkSpace();
    const id = (await mkIssue(wsId)).id as string;

    const first = await request(app).post(`/api/issues/${id}/comments`).send({ content: '第一条' });
    expect(first.status).toBe(200);
    expect(first.body.woke).toBe(false);
    expect(first.body.comment).toMatchObject({ author: 'user', content: '第一条' });

    await request(app).post(`/api/issues/${id}/comments`).send({ content: '第二条' });
    const list = await request(app).get(`/api/issues/${id}/comments`);
    expect(list.body.map((c: { content: string }) => c.content)).toEqual(['第一条', '第二条']);

    const missing = await request(app).post('/api/issues/nope/comments').send({ content: 'x' });
    expect(missing.status).toBe(404);
  });

  it('带 agent_id → author=agent:<agent_id>（agent 写评论身份）', async () => {
    const wsId = await mkSpace();
    const id = (await mkIssue(wsId)).id as string;

    const res = await request(app)
      .post(`/api/issues/${id}/comments`)
      .send({ content: 'agent 进展汇报', agent_id: 'coder-bot' });
    expect(res.status).toBe(200);
    expect(res.body.comment).toMatchObject({ author: 'agent:coder-bot', content: 'agent 进展汇报' });

    const list = await request(app).get(`/api/issues/${id}/comments`);
    expect(list.body).toEqual([expect.objectContaining({ author: 'agent:coder-bot' })]);
  });

  it('不带 agent_id → author=user（既有行为不变）；agent_id 空串 → 400', async () => {
    const wsId = await mkSpace();
    const id = (await mkIssue(wsId)).id as string;

    const res = await request(app).post(`/api/issues/${id}/comments`).send({ content: '用户留言' });
    expect(res.status).toBe(200);
    expect(res.body.comment).toMatchObject({ author: 'user', content: '用户留言' });

    const bad = await request(app)
      .post(`/api/issues/${id}/comments`)
      .send({ content: 'x', agent_id: '   ' });
    expect(bad.status).toBe(400);
  });

  it('占用中（session 绑定）：woke=true 且首轮收到唤醒文本（真实 sendToSession 全链路）', async () => {
    const wsId = await mkSpace();
    const id = (await mkIssue(wsId)).id as string;
    await dispatchHeld(wsId, id);

    const res = await request(app).post(`/api/issues/${id}/comments`).send({ content: '补充要求' });
    expect(res.status).toBe(200);
    expect(res.body.woke).toBe(true);
    await settle();

    // 唤醒消息落 user 行（运行中入队，首轮仍挂起未产生新 runTurn）
    const sessionId = (await request(app).get(`/api/sessions?workspace=${wsId}`)).body[0].id;
    const messages = await request(app).get(`/api/sessions/${sessionId}/messages`);
    const userTexts = (messages.body as Array<{ role: string; content: string }>)
      .filter((m) => m.role === 'user')
      .map((m) => m.content);
    expect(userTexts).toHaveLength(2); // 派发 prompt + 唤醒评论
    expect(userTexts[1]).toBe('补充要求');
  });
});

describe('sessions', () => {
  it('POST 绑 issue：自动 claim + 派发渲染 prompt + 起轮；消息列表可查', async () => {
    const wsId = await mkSpace();
    const id = (await mkIssue(wsId)).id as string;

    const res = await request(app)
      .post('/api/sessions')
      .send({ cli: 'codebuddy', model: 'm1', issue_id: id });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ cli: 'codebuddy', model: 'm1', issue_id: id, status: '运行中' });

    await settle();
    const issueRes = await request(app).get(`/api/issues?workspace=${wsId}`);
    expect(issueRes.body[0]).toMatchObject({ status: '进行中', claimed_by: 'codebuddy' });

    expect(adapter.calls).toHaveLength(1);
    expect(adapter.calls[0]!.prompt).toContain(`任务 ID：${id}`);
    expect(adapter.calls[0]!.prompt).not.toContain('## 历史备注');

    const messages = await request(app).get(`/api/sessions/${res.body.id}/messages`);
    expect(messages.body[0]).toMatchObject({ role: 'user' });
    expect((messages.body[0] as { content: string }).content).toContain('你是任务看板的执行 agent。');
  });

  it('POST 绑 issue：占用中 → 409 且不残留会话', async () => {
    const wsId = await mkSpace();
    const id = (await mkIssue(wsId)).id as string;
    await dispatchHeld(wsId, id);

    const res = await request(app)
      .post('/api/sessions')
      .send({ cli: 'codebuddy', model: 'm1', issue_id: id });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('CONFLICT');
    const sessions = await request(app).get(`/api/sessions?workspace=${wsId}`);
    expect(sessions.body).toHaveLength(1); // 仅最初那个派发会话
  });

  it('POST 自由会话：workspace_id 必填（契约修订）→ 400；给了就建会话起轮', async () => {
    const noWs = await request(app).post('/api/sessions').send({ cli: 'codebuddy', prompt: '闲聊' });
    expect(noWs.status).toBe(400);
    expect(noWs.body.error.message).toContain('workspace_id');

    const wsId = await mkSpace();
    const ok = await request(app)
      .post('/api/sessions')
      .send({ cli: 'codebuddy', workspace_id: wsId, prompt: '自由指令' });
    expect(ok.status).toBe(200);
    expect(ok.body).toMatchObject({ issue_id: null, workspace_id: wsId, status: '运行中' });
    await settle();
    expect(adapter.calls[0]!.prompt).toBe('自由指令');
  });

  it('POST 自由会话不接受 issue-scoped selected_attachment_ids', async () => {
    const wsId = await mkSpace();
    const response = await request(app).post('/api/sessions').send({
      cli: 'codebuddy', workspace_id: wsId, prompt: '自由指令',
      selected_attachment_ids: ['00000000-0000-4000-8000-000000000001'],
    });

    expect(response.status).toBe(400);
    expect(response.body.error.message).toContain('issue_id');
    expect((await request(app).get(`/api/sessions?workspace=${wsId}`)).body).toEqual([]);
    expect(adapter.calls).toHaveLength(0);
  });

  it('GET /api/sessions/:id 返回完整会话', async () => {
    const wsId = await mkSpace();
    const created = await request(app)
      .post('/api/sessions')
      .send({ cli: 'codebuddy', model: 'm1', workspace_id: wsId, prompt: '恢复用' });
    expect(created.status).toBe(200);
    await settle();

    const one = await request(app).get(`/api/sessions/${created.body.id}`);
    expect(one.status).toBe(200);
    expect(one.body).toMatchObject({
      id: created.body.id,
      workspace_id: wsId,
      cli: 'codebuddy',
      model: 'm1',
    });
  });

  it('GET /api/sessions/:id 未知 id → 404', async () => {
    const missing = await request(app).get('/api/sessions/no-such-session');
    expect(missing.status).toBe(404);
    expect(missing.body).toEqual({ error: { code: 'NOT_FOUND', message: '会话不存在' } });
  });

  it('GET /api/sessions?workspace= 列表；messages after 过滤；未知会话 404', async () => {
    const wsId = await mkSpace();
    await request(app).post('/api/sessions').send({ cli: 'codebuddy', workspace_id: wsId, prompt: '一轮' });
    await settle();

    const list = await request(app).get(`/api/sessions?workspace=${wsId}`);
    expect(list.status).toBe(200);
    expect(list.body).toHaveLength(1);

    const sessionId = list.body[0].id;
    const all = await request(app).get(`/api/sessions/${sessionId}/messages`);
    expect(all.body.length).toBeGreaterThanOrEqual(2);
    const mid = (all.body[0] as { ts: number }).ts + 1;
    const after = await request(app).get(`/api/sessions/${sessionId}/messages?after=${mid}`);
    expect((after.body as Array<{ ts: number }>).every((m) => m.ts > mid)).toBe(true);

    const missing = await request(app).get('/api/sessions/nope/messages');
    expect(missing.status).toBe(404);
  });

  it('运行中 POST messages → queued=true 合并下一轮；stop → 已结束', async () => {
    const wsId = await mkSpace();
    const id = (await mkIssue(wsId)).id as string;
    const session = await dispatchHeld(wsId, id);

    const send = await request(app)
      .post(`/api/sessions/${session.id}/messages`)
      .send({ text: '排队消息' });
    expect(send.status).toBe(200);
    expect(send.body).toEqual({ queued: true });

    const stop = await request(app).post(`/api/sessions/${session.id}/stop`);
    expect(stop.status).toBe(200);
    expect(stop.body.status).toBe('已结束');

    const unknown = await request(app).post('/api/sessions/nope/stop');
    expect(unknown.status).toBe(404);
  });
});

describe('session 运行时态（队列长度/等待槽位）', () => {
  it('GET /sessions 与 /sessions/:id 合并 queued_count/waiting_slot；入队广播 session.runtime；/queue 返回排队文本', async () => {
    const wsId = await mkSpace();
    const id = (await mkIssue(wsId)).id as string;
    const session = await dispatchHeld(wsId, id);

    // sessionManager 广播经 setBroadcaster 捕获（hub.broadcast 在装配时按值注入，spy hub 拦不到）
    const runtimeEvents: WsEvent[] = [];
    const original = created.hub.broadcast.bind(created.hub);
    setBroadcaster((e) => {
      runtimeEvents.push(e);
      original(e);
    });
    const send = await request(app)
      .post(`/api/sessions/${session.id}/messages`)
      .send({ text: '排队消息' });
    expect(send.status).toBe(200);
    expect(send.body).toEqual({ queued: true });

    expect(runtimeEvents.filter((e) => e.type === 'session.runtime')).toEqual([
      { type: 'session.runtime', session_id: session.id, queued_count: 1, waiting_slot: false },
    ]);

    const list = await request(app).get(`/api/sessions?workspace=${wsId}`);
    expect(list.status).toBe(200);
    expect((list.body as Array<Record<string, unknown>>)[0]).toMatchObject({
      id: session.id,
      queued_count: 1,
      waiting_slot: false,
    });

    const one = await request(app).get(`/api/sessions/${session.id}`);
    expect(one.status).toBe(200);
    expect(one.body).toMatchObject({ id: session.id, queued_count: 1, waiting_slot: false });

    const queue = await request(app).get(`/api/sessions/${session.id}/queue`);
    expect(queue.status).toBe(200);
    expect(queue.body).toEqual({ texts: ['排队消息'] });
    expect((await request(app).get('/api/sessions/nope/queue')).status).toBe(404);
  });

  it('maxConcurrentTurns=1：等槽位轮次 waiting_slot=true（响应字段可见），槽位释放后 false', async () => {
    const wsId = await mkSpace();
    setMaxConcurrentTurns(1);
    const held: FakeTurnControl[] = [];
    adapter.script = (control) => {
      held.push(control); // 全部挂起：A 占住唯一槽位，B 等待
    };

    const id = (await mkIssue(wsId)).id as string;
    const resA = await request(app).post('/api/sessions').send({ cli: 'codebuddy', issue_id: id });
    expect(resA.status).toBe(200);
    await settle();
    const resB = await request(app)
      .post('/api/sessions')
      .send({ cli: 'codebuddy', workspace_id: wsId, prompt: 'B 轮' });
    expect(resB.status).toBe(200);
    const b = resB.body as Record<string, unknown>;
    await settle();

    const waiting = await request(app).get(`/api/sessions/${b.id}`);
    expect(waiting.body).toMatchObject({ waiting_slot: true, queued_count: 0 });

    // A 释放槽位：B 的轮次进入运行，等待标志复位
    held[0]!.finish(0, 'as-a');
    await settle();
    const running = await request(app).get(`/api/sessions/${b.id}`);
    expect(running.body).toMatchObject({ waiting_slot: false, queued_count: 0 });
  });
});

describe('PATCH /api/sessions/:id {model}', () => {
  /** 建一个自由会话并等首轮结束 */
  async function mkFreeSession(wsId: string): Promise<Record<string, unknown>> {
    const res = await request(app)
      .post('/api/sessions')
      .send({ cli: 'codebuddy', model: 'm1', workspace_id: wsId, prompt: 'hi' });
    expect(res.status).toBe(200);
    await settle();
    return res.body as Record<string, unknown>;
  }

  it('PATCH {model} → 更新 model 字段且列表可见；null 清空；未知 id → 404', async () => {
    const wsId = await mkSpace();
    const session = await mkFreeSession(wsId);

    const patched = await request(app)
      .patch(`/api/sessions/${session.id}`)
      .send({ model: 'm2' });
    expect(patched.status).toBe(200);
    expect(patched.body).toMatchObject({ id: session.id, model: 'm2' });

    const list = await request(app).get(`/api/sessions?workspace=${wsId}`);
    expect((list.body as Array<{ id: string; model: string }>)[0]).toMatchObject({
      id: session.id,
      model: 'm2',
    });

    // 清空模型（null 合法）
    const cleared = await request(app)
      .patch(`/api/sessions/${session.id}`)
      .send({ model: null });
    expect(cleared.status).toBe(200);
    expect(cleared.body.model).toBeNull();

    const missing = await request(app).patch('/api/sessions/nope').send({ model: 'm2' });
    expect(missing.status).toBe(404);
    expect(missing.body.error.code).toBe('NOT_FOUND');
  });

  it('缺 model / 空串 → 400（只允许改 model 字段）', async () => {
    const wsId = await mkSpace();
    const session = await mkFreeSession(wsId);

    const empty = await request(app).patch(`/api/sessions/${session.id}`).send({});
    expect(empty.status).toBe(400);
    expect(empty.body.error.code).toBe('VALIDATION_ERROR');

    const blank = await request(app).patch(`/api/sessions/${session.id}`).send({ model: '  ' });
    expect(blank.status).toBe(400);
  });
});

describe('clis', () => {
  it('GET /api/clis 来自启动探测缓存；models 端点；未知 CLI 404', async () => {
    const res = await request(app).get('/api/clis');
    expect(res.status).toBe(200);
    expect(res.body).toEqual([
      {
        id: 'codebuddy',
        displayName: 'Fake CLI',
        installed: true,
        version: 'fake-1.0',
        supportsModelSelection: true,
      },
    ]);

    const models = await request(app).get('/api/clis/codebuddy/models');
    expect(models.status).toBe(200);
    expect(models.body).toEqual([]);

    const unknown = await request(app).get('/api/clis/nope/models');
    expect(unknown.status).toBe(404);
  });
});

describe('错误响应统一', () => {
  it('未知 /api 路由 → 404 JSON；非法 JSON 体 → 400 INVALID_JSON', async () => {
    const nf = await request(app).get('/api/definitely-not-here');
    expect(nf.status).toBe(404);
    expect(nf.body.error).toMatchObject({ code: 'NOT_FOUND' });

    const bad = await request(app)
      .post('/api/workspaces')
      .set('Content-Type', 'application/json')
      .send('{not json');
    expect(bad.status).toBe(400);
    expect(bad.body.error.code).toBe('INVALID_JSON');
  });
});

describe('WS', () => {
  it('客户端连上 /ws 后，REST 变更推送 issue.changed', async () => {
    const server = createServer(app);
    created.hub.attach(server);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as AddressInfo).port;

    const ws: WsClient = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    await new Promise<void>((resolve, reject) => {
      ws.once('open', () => resolve());
      ws.once('error', reject);
    });
    const events: WsEvent[] = [];
    ws.on('message', (data) => events.push(JSON.parse(data.toString()) as WsEvent));

    const wsId = await mkSpace('ws-ws');
    await mkIssue(wsId, 'WS 推送任务');
    await vi.waitFor(() => {
      expect(events.some((e) => e.type === 'issue.changed')).toBe(true);
    });

    const issueEvents = events.filter((e) => e.type === 'issue.changed');
    expect((issueEvents[0] as { issue: { title: string } }).issue.title).toBe('WS 推送任务');
    // 非 /ws 升级路径应被拒
    ws.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
});
