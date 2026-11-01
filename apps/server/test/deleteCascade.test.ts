/**
 * 删除 issue 级联清理（设计 §7.4）：
 * - 未占用删除：绑定会话与消息一并删（显式 DELETE，事务内），无关会话不受影响，广播 issue.deleted + session.deleted；
 * - 占用中 → 409 且不删；
 * - 运行中绑定会话：先 stopSession 停轮（kill）再删，消息无残留。
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import type { AgentAdapter } from '@agentboard/adapters';
import type { WsEvent } from '@agentboard/shared';
import { createTestDb, type TestDb } from './helpers.js';
import { FakeAdapter, settle, type FakeTurnControl } from './fakeAdapter.js';
import { createApp, type CreatedApp } from '../src/index.js';
import { resetSessionManager } from '../src/services/sessionManager.js';
import { addMessage, listMessagesBySession } from '../src/db/repos/message.js';
import { createSession, getSession, listSessionsByWorkspace } from '../src/db/repos/session.js';
import { getIssue } from '../src/db/repos/issue.js';
import { addComment } from '../src/services/comments.js';

let t: TestDb;
let adapter: FakeAdapter;
let created: CreatedApp;
let app: Express;
let spaceDir: string;

function fakeResolver(id: string): AgentAdapter {
  if (id === 'fake') return adapter;
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

async function mkSpace(): Promise<string> {
  const res = await request(app).post('/api/workspaces').send({ name: 'demo', path: spaceDir });
  expect(res.status).toBe(200);
  return res.body.id as string;
}

async function mkIssue(workspaceId: string): Promise<Record<string, unknown>> {
  const res = await request(app)
    .post('/api/issues')
    .send({ workspace_id: workspaceId, title: '待删任务' });
  expect(res.status).toBe(200);
  return res.body as Record<string, unknown>;
}

/** repo 直建绑定会话（不起轮）并落数条消息，返回 session id */
function mkBoundSession(wsId: string, issueId: string, cli = 'fake'): string {
  const session = createSession(t.db, { workspace_id: wsId, issue_id: issueId, cli, status: '已结束' });
  addMessage(t.db, { session_id: session.id, role: 'user', content: `${cli} 指令` });
  addMessage(t.db, { session_id: session.id, role: 'assistant', content: `${cli} 回复` });
  return session.id;
}

describe('DELETE /api/issues/:id 级联清理', () => {
  it('未占用：2 个绑定会话与消息一并删除，无关会话保留；广播 issue.deleted + session.deleted', async () => {
    const wsId = await mkSpace();
    const issue = await mkIssue(wsId);
    const sidA = mkBoundSession(wsId, issue.id as string, 'fake');
    const sidB = mkBoundSession(wsId, issue.id as string, 'codebuddy');
    addComment(t.db, issue.id as string, 'user', '留言'); // DB 段同步完成，无需 await
    // 无关自由会话：不受级联影响
    const other = createSession(t.db, { workspace_id: wsId, issue_id: null, cli: 'fake', status: '已结束' });
    addMessage(t.db, { session_id: other.id, role: 'user', content: '无关消息' });

    const spy = vi.spyOn(created.hub, 'broadcast');
    const del = await request(app).delete(`/api/issues/${issue.id}`);
    expect(del.status).toBe(204);

    expect(getIssue(t.db, issue.id as string)).toBeNull();
    expect(getSession(t.db, sidA)).toBeNull();
    expect(getSession(t.db, sidB)).toBeNull();
    expect(listMessagesBySession(t.db, sidA)).toEqual([]);
    expect(listMessagesBySession(t.db, sidB)).toEqual([]);

    // 无关会话与消息原样保留
    expect(getSession(t.db, other.id)).not.toBeNull();
    expect(listMessagesBySession(t.db, other.id)).toHaveLength(1);

    // 广播：issue.deleted 一条 + 每个被删会话一条 session.deleted（载荷核对）
    const types = spy.mock.calls.map(([e]) => e.type);
    expect(types).toContain('issue.deleted');
    expect(types.filter((x) => x === 'session.deleted')).toHaveLength(2);
    const deleted = spy.mock.calls.map(([e]) => e) as Extract<
      WsEvent,
      { type: 'issue.deleted' | 'session.deleted' }
    >[];
    expect(deleted.find((e) => e.type === 'issue.deleted')).toEqual({
      type: 'issue.deleted',
      issue_id: issue.id,
      workspace_id: wsId,
    });
    const deletedSessions = deleted
      .filter((e): e is Extract<WsEvent, { type: 'session.deleted' }> => e.type === 'session.deleted')
      .map((e) => e.session_id)
      .sort();
    expect(deletedSessions).toEqual([sidA, sidB].sort());
  });

  it('占用中 → 409 且 issue/会话/消息都不删', async () => {
    const wsId = await mkSpace();
    const issue = await mkIssue(wsId);
    const sid = mkBoundSession(wsId, issue.id as string);

    await request(app).post(`/api/issues/${issue.id}/claim`).send({ agent_id: 'kb-agent' });
    const del = await request(app).delete(`/api/issues/${issue.id}`);
    expect(del.status).toBe(409);
    expect(del.body.error).toMatchObject({ code: 'CONFLICT' });

    expect(getIssue(t.db, issue.id as string)).not.toBeNull();
    expect(getSession(t.db, sid)).not.toBeNull();
    expect(listMessagesBySession(t.db, sid)).toHaveLength(2);
  });

  it('运行中绑定会话：先停轮（kill）再删，会话与消息无残留', async () => {
    const wsId = await mkSpace();
    const issue = await mkIssue(wsId);
    // 派发（自动 claim）挂起轮次 → 强制释放（issue 回未占用，会话仍绑定且运行中）
    const held: FakeTurnControl[] = [];
    adapter.script = (control) => {
      held.push(control);
    };
    const dispatch = await request(app)
      .post('/api/sessions')
      .send({ cli: 'fake', model: 'm1', issue_id: issue.id });
    expect(dispatch.status).toBe(200);
    const sid = dispatch.body.id as string;
    await settle();
    expect(held).toHaveLength(1);

    const release = await request(app).post(`/api/issues/${issue.id}/release`);
    expect(release.status).toBe(200);
    expect((release.body as { claimed_by: string | null }).claimed_by).toBeNull();

    const del = await request(app).delete(`/api/issues/${issue.id}`);
    expect(del.status).toBe(204);
    await settle();

    expect(held[0]!.killed).toBe(true); // 先停后删：运行中轮次被 stopSession kill
    expect(getIssue(t.db, issue.id as string)).toBeNull();
    expect(getSession(t.db, sid)).toBeNull();
    expect(listMessagesBySession(t.db, sid)).toEqual([]);
    expect(listSessionsByWorkspace(t.db, wsId)).toEqual([]);
  });
});
