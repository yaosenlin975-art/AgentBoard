/**
 * P3-A：专家团 REST + 编排接线（createApp 真起 app，断言端点非 404 / WS 事件真发出 / 成员真起轮）。
 */
import { createServer } from 'node:http';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { WebSocket, type WebSocket as WsClient } from 'ws';
import type { Express } from 'express';
import type { AgentAdapter } from '@agentboard/adapters';
import type { ServerWsEvent } from '@agentboard/shared';
import { createTestDb, type TestDb } from './helpers.js';
import { FakeAdapter, settle } from './fakeAdapter.js';
import { createApp, type CreatedApp } from '../src/index.js';
import { resetSessionManager } from '../src/services/sessionManager.js';

let t: TestDb;
let adapter: FakeAdapter;
let created: CreatedApp;
let app: Express;
let spaceDir: string;

function fakeResolver(id: string): AgentAdapter {
  if (id === 'codebuddy') return adapter;
  throw new Error(`未知适配器 id: ${id}`);
}

beforeEach(async () => {
  t = createTestDb();
  adapter = new FakeAdapter();
  spaceDir = mkdtempSync(join(tmpdir(), 'agentboard-team-space-'));
  execFileSync('git', ['init', '-q'], { cwd: spaceDir, windowsHide: true });
  created = await createApp({ db: t.db, getAdapter: fakeResolver, adapters: [adapter], maxConcurrentTurns: 3 });
  app = created.app;
});

afterEach(() => {
  resetSessionManager();
  t.cleanup();
  rmSync(spaceDir, { recursive: true, force: true });
});

async function mkSpace(name = 'team-space'): Promise<string> {
  const res = await request(app).post('/api/workspaces').send({ name, path: spaceDir });
  expect(res.status).toBe(200);
  return (res.body as { id: string }).id;
}

/** 建空闲会话（不带 prompt，避免起轮） */
async function mkSession(workspaceId: string): Promise<string> {
  const res = await request(app).post('/api/sessions').send({ cli: 'codebuddy', workspace_id: workspaceId });
  expect(res.status).toBe(200);
  return (res.body as { id: string }).id;
}

async function mkTeam(workspaceId: string, leadSessionId: string, overrides: Record<string, unknown> = {}) {
  const res = await request(app)
    .post('/api/teams')
    .send({ workspace_id: workspaceId, name: '通用专家组', lead_session_id: leadSessionId, ...overrides });
  expect(res.status).toBe(201);
  return res.body as { id: string; members: Array<{ session_id: string; agent_name: string; status: string }> };
}

describe('专家团 REST（P3-A）', () => {
  it('建团 → 列表 → 详情：路由真实可调（非 404），lead 归属校验生效', async () => {
    const wsId = await mkSpace();
    const leadId = await mkSession(wsId);

    const bad = await request(app)
      .post('/api/teams')
      .send({ workspace_id: wsId, name: '越界组', lead_session_id: '00000000-0000-4000-8000-000000000000' });
    expect(bad.status).toBe(400);

    const team = await mkTeam(wsId, leadId, { max_turns_per_member: 3, budget_tokens: 50_000 });
    expect(team.members).toEqual([]);

    const list = await request(app).get(`/api/teams?workspace=${wsId}`);
    expect(list.status).toBe(200);
    expect((list.body as Array<{ id: string }>).map((row) => row.id)).toEqual([team.id]);

    const detail = await request(app).get(`/api/teams/${team.id}`);
    expect(detail.status).toBe(200);
    expect(detail.body).toMatchObject({ id: team.id, lead_session_id: leadId, status: 'active', max_turns_per_member: 3 });

    expect((await request(app).get('/api/teams/no-such-team')).status).toBe(404);
  });

  it('加成员：服务端建成员会话、绑定 persona；删除成员只解绑不删会话', async () => {
    const wsId = await mkSpace();
    const leadId = await mkSession(wsId);
    const team = await mkTeam(wsId, leadId);

    const persona = await request(app).post('/api/personas').send({ name: '架构师', description: '', body_md: '你是架构师' });
    expect(persona.status).toBe(200);

    const added = await request(app)
      .post(`/api/teams/${team.id}/members`)
      .send({ cli: 'codebuddy', role: '架构', agent_name: 'Alice', persona_id: persona.body.id });
    expect(added.status).toBe(201);
    const member = (added.body as { members: Array<{ session_id: string; usage: { turns: number } }> }).members[0]!;
    expect(member.usage.turns).toBe(0);

    const session = await request(app).get(`/api/sessions/${member.session_id}`);
    expect(session.body).toMatchObject({ workspace_id: wsId, persona_id: persona.body.id, issue_id: null });

    const removed = await request(app).delete(`/api/teams/${team.id}/members/${member.session_id}`);
    expect(removed.status).toBe(200);
    expect((removed.body as { members: unknown[] }).members).toEqual([]);
    // 会话仍在（成员解除绑定不删历史）
    expect((await request(app).get(`/api/sessions/${member.session_id}`)).status).toBe(200);
  });

  it('lead 每轮注入名册；@成员 派活起来成员轮次，WS 发 team_update，成员结果回传 lead', async () => {
    const wsId = await mkSpace();
    const leadId = await mkSession(wsId);
    const team = await mkTeam(wsId, leadId);
    const added = await request(app)
      .post(`/api/teams/${team.id}/members`)
      .send({ cli: 'codebuddy', role: '调研', agent_name: 'Bob' });
    const memberId = (added.body as { members: Array<{ session_id: string }> }).members[0]!.session_id;

    const server = createServer(app);
    created.hub.attach(server);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as AddressInfo).port;
    const ws: WsClient = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    await new Promise<void>((resolve, reject) => {
      ws.once('open', () => resolve());
      ws.once('error', reject);
    });
    const events: ServerWsEvent[] = [];
    ws.on('message', (data) => events.push(JSON.parse(data.toString()) as ServerWsEvent));

    const sent = await request(app)
      .post(`/api/sessions/${leadId}/messages`)
      .send({ text: '先看下现状\n@Bob: 分析登录模块' });
    expect(sent.status).toBe(200);

    // lead 第一轮：名册前缀已注入
    expect(adapter.calls[0]!.prompt).toContain('## 专家团「通用专家组」');
    expect(adapter.calls[0]!.prompt).toContain('@Bob: 分析登录模块');

    // 成员被派活：多起一轮，正文就是任务内容
    await vi.waitFor(async () => {
      const detail = await request(app).get(`/api/sessions/${memberId}`);
      expect((detail.body as { turns: Array<{ state: string }> }).turns).toHaveLength(1);
      expect((detail.body as { turns: Array<{ state: string }> }).turns[0]!.state).toBe('done');
    });
    expect(adapter.calls[1]!.prompt).toBe('分析登录模块');

    // 成员结果回传 lead（lead 再起一轮，正文含成员回报）
    await vi.waitFor(() => {
      expect(adapter.calls.some((call) => call.prompt.includes('## 成员回报（调研「Bob」）'))).toBe(true);
    });

    // WS：派活与成员收口都广播 team_update
    await vi.waitFor(() => {
      expect(events.some((event) => event.type === 'team_update')).toBe(true);
    });
    const teamEvents = events.filter((event) => event.type === 'team_update');
    expect(teamEvents.some((event) => 'team_id' in event && event.team_id === team.id)).toBe(true);
    expect(teamEvents.some((event) => 'reason' in event && event.reason === 'member_done')).toBe(true);

    ws.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it('成本护栏：成员轮次上限 → 409；团队停止后派活 → 409', async () => {
    const wsId = await mkSpace();
    const leadId = await mkSession(wsId);
    const team = await mkTeam(wsId, leadId, { max_turns_per_member: 1 });
    const added = await request(app)
      .post(`/api/teams/${team.id}/members`)
      .send({ cli: 'codebuddy', role: '实现', agent_name: 'Carol' });
    const memberId = (added.body as { members: Array<{ session_id: string }> }).members[0]!.session_id;

    const first = await request(app).post(`/api/teams/${team.id}/dispatch`).send({ session_id: memberId, prompt: '第一步' });
    expect(first.status).toBe(202);
    await settle();

    const overLimit = await request(app)
      .post(`/api/teams/${team.id}/dispatch`)
      .send({ session_id: memberId, prompt: '第二步' });
    expect(overLimit.status).toBe(409);
    expect((overLimit.body as { error: { message: string } }).error.message).toContain('上限');

    const stopped = await request(app).post(`/api/teams/${team.id}/stop`);
    expect(stopped.status).toBe(200);
    expect((stopped.body as { status: string }).status).toBe('stopped');
    const afterStop = await request(app)
      .post(`/api/teams/${team.id}/dispatch`)
      .send({ session_id: memberId, prompt: '第三步' });
    expect(afterStop.status).toBe(409);
    expect((afterStop.body as { error: { message: string } }).error.message).toContain('已停止');
  });
});
