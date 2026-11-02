/**
 * DELETE /api/workspaces/:id（WORKSPACE-REMOVE）：
 * - 无受保护关联数据（空空间 / 任务+评论+已结束会话+消息）→ 204，级联清空且无孤儿；
 * - 保留历史（知识页 + revision）→ 409，知识页与历史原样保留；
 * - 运行中会话 → 409，会话存活、轮次不被 kill；
 * - 父子依赖 → 409，父子关系不被改写（旧实现把 parent_issue_id 置 NULL 以绕过 RESTRICT）。
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import type { AgentAdapter } from '@agentboard/adapters';
import { createTestDb, type TestDb } from './helpers.js';
import { FakeAdapter, settle, type FakeTurnControl } from './fakeAdapter.js';
import { createApp, type CreatedApp } from '../src/index.js';
import { resetSessionManager } from '../src/services/sessionManager.js';
import { addMessage } from '../src/db/repos/message.js';
import { createSession } from '../src/db/repos/session.js';
import { getIssue } from '../src/db/repos/issue.js';
import { createWorkspace, getWorkspace } from '../src/db/repos/workspace.js';

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

afterEach(async () => {
  await settle();
  vi.restoreAllMocks();
  resetSessionManager();
  t.cleanup();
  rmSync(spaceDir, { recursive: true, force: true });
});

async function mkSpace(name: string): Promise<string> {
  const res = await request(app).post('/api/workspaces').send({ name, path: spaceDir });
  expect(res.status).toBe(200);
  return res.body.id as string;
}

async function mkIssue(workspaceId: string, title: string, parentIssueId?: string): Promise<string> {
  const body: Record<string, unknown> = { workspace_id: workspaceId, title };
  if (parentIssueId !== undefined) body.parent_issue_id = parentIssueId;
  const res = await request(app).post('/api/issues').send(body);
  expect(res.status).toBe(200);
  return res.body.id as string;
}

function counts(workspaceId: string) {
  const n = (sql: string): number => (t.db.prepare(sql).get(workspaceId) as { n: number }).n;
  return {
    issues: n('SELECT COUNT(*) AS n FROM issue WHERE workspace_id = ?'),
    sessions: n('SELECT COUNT(*) AS n FROM session WHERE workspace_id = ?'),
    messages: n('SELECT COUNT(*) AS n FROM message m JOIN session s ON s.id = m.session_id WHERE s.workspace_id = ?'),
    comments: n('SELECT COUNT(*) AS n FROM issue_comment c JOIN issue i ON i.id = c.issue_id WHERE i.workspace_id = ?'),
  };
}

const knowledgeBody = (workspaceId: string) => ({
  scope: 'workspace',
  workspace_id: workspaceId,
  slug: 'cache',
  title: '缓存知识',
  body_md: '缓存失效后 WAL',
  actor: 'codex',
  sources: [{ source_id: 's', source_type: 'agent', locator: 'issue:1', captured_at: 1, content_hash: 'a'.repeat(64), snapshot: 'verified' }],
  evidence: [{ source_id: 's', locator: 'issue:1' }],
});

describe('DELETE /api/workspaces/:id 移除工作空间', () => {
  it('空空间 → 204，列表移除且无孤儿', async () => {
    const wsId = await mkSpace('empty');
    const other = createWorkspace(t.db, { name: 'other', path: `${spaceDir}-other` }).id;

    const del = await request(app).delete(`/api/workspaces/${wsId}`);
    expect(del.status).toBe(204);
    expect(getWorkspace(t.db, wsId)).toBeNull();
    expect(counts(wsId)).toEqual({ issues: 0, sessions: 0, messages: 0, comments: 0 });
    // 未涉及的空间不受影响
    expect(getWorkspace(t.db, other)).not.toBeNull();
    expect((await request(app).get('/api/workspaces')).body.map((w: { id: string }) => w.id)).toEqual([other]);
  });

  it('任务+评论+已结束会话+消息 → 204，级联清空且无孤儿', async () => {
    const wsId = await mkSpace('withdata');
    const issueId = await mkIssue(wsId, '任务A');
    await mkIssue(wsId, '任务B');
    expect((await request(app).post(`/api/issues/${issueId}/comments`).send({ author: 'user', content: '评论' })).status).toBe(200);
    const session = createSession(t.db, { workspace_id: wsId, issue_id: issueId, cli: 'fake', status: '已结束' });
    addMessage(t.db, { session_id: session.id, role: 'user', content: 'hi' });
    addMessage(t.db, { session_id: session.id, role: 'assistant', content: 'yo' });
    expect(counts(wsId)).toEqual({ issues: 2, sessions: 1, messages: 2, comments: 1 });

    const del = await request(app).delete(`/api/workspaces/${wsId}`);
    expect(del.status).toBe(204);
    expect(getWorkspace(t.db, wsId)).toBeNull();
    expect(counts(wsId)).toEqual({ issues: 0, sessions: 0, messages: 0, comments: 0 });
    expect((await request(app).get('/api/issues').query({ workspace: wsId })).status).toBe(404);
  });

  it('父子任务 → 409，父子关系与空间都不被改写', async () => {
    const wsId = await mkSpace('hierarchy');
    const parentId = await mkIssue(wsId, '父任务');
    const childId = await mkIssue(wsId, '子任务', parentId);

    const del = await request(app).delete(`/api/workspaces/${wsId}`);
    expect(del.status).toBe(409);
    expect(del.body.error.code).toBe('CONFLICT');
    expect(del.body.error.message).toContain('1 个子任务');
    expect(del.body.error.message).toContain('解除关联');

    expect(getWorkspace(t.db, wsId)).not.toBeNull();
    expect(getIssue(t.db, parentId)).not.toBeNull();
    expect(getIssue(t.db, childId)?.parent_issue_id).toBe(parentId);
  });

  it('运行中会话 → 409，会话存活且轮次不被 kill', async () => {
    const wsId = await mkSpace('running');
    const issueId = await mkIssue(wsId, '运行中任务');
    const held: FakeTurnControl[] = [];
    adapter.script = (control) => {
      held.push(control);
    };
    const dispatch = await request(app).post('/api/sessions').send({ cli: 'fake', model: 'm1', issue_id: issueId });
    expect(dispatch.status).toBe(200);
    const sessionId = dispatch.body.id as string;
    await settle();
    expect(held).toHaveLength(1);

    const del = await request(app).delete(`/api/workspaces/${wsId}`);
    expect(del.status).toBe(409);
    expect(del.body.error.code).toBe('CONFLICT');
    expect(del.body.error.message).toContain('1 个运行中会话');
    expect(del.body.error.message).toContain('结束会话');

    expect(getWorkspace(t.db, wsId)).not.toBeNull();
    expect(t.db.prepare('SELECT status FROM session WHERE id = ?').get(sessionId)).toEqual({ status: '运行中' });
    expect(held[0]!.killed).toBe(false);
  });

  it('知识页与历史 revision → 409，知识页与历史原样保留', async () => {
    const wsId = await mkSpace('knowledge');
    const page = await request(app).post('/api/knowledge/pages').send(knowledgeBody(wsId));
    expect(page.status).toBe(200);
    expect(
      (await request(app)
        .put(`/api/knowledge/pages/${page.body.id}`)
        .send({ scope: 'workspace', workspace_id: wsId, expected_revision: 1, body_md: '第二版', actor: 'dsh' })).status,
    ).toBe(200);
    const revisionsBefore = t.db.prepare('SELECT COUNT(*) AS n FROM knowledge_revision r JOIN knowledge_page p ON p.id = r.page_id WHERE p.workspace_id = ?').get(wsId);

    const del = await request(app).delete(`/api/workspaces/${wsId}`);
    expect(del.status).toBe(409);
    expect(del.body.error.code).toBe('CONFLICT');
    expect(del.body.error.message).toContain('1 个知识页');
    expect(del.body.error.message).toContain('2 条历史 revision');
    expect(del.body.error.message).toContain('迁移知识页');

    expect(getWorkspace(t.db, wsId)).not.toBeNull();
    expect(t.db.prepare('SELECT COUNT(*) AS n FROM knowledge_page WHERE workspace_id = ?').get(wsId)).toEqual({ n: 1 });
    expect(t.db.prepare('SELECT COUNT(*) AS n FROM knowledge_revision r JOIN knowledge_page p ON p.id = r.page_id WHERE p.workspace_id = ?').get(wsId)).toEqual(revisionsBefore);
  });

  it('拒绝时无部分删除：三类阻塞并存也只报第一条且数据全留', async () => {
    const wsId = createWorkspace(t.db, { name: 'all', path: spaceDir }).id;
    const parentId = await mkIssue(wsId, '父任务');
    await mkIssue(wsId, '子任务', parentId);
    createSession(t.db, { workspace_id: wsId, issue_id: null, cli: 'fake', status: '运行中' });
    await request(app).post('/api/knowledge/pages').send(knowledgeBody(wsId));

    const del = await request(app).delete(`/api/workspaces/${wsId}`);
    expect(del.status).toBe(409);
    expect(del.body.error.message).toContain('知识页');
    expect(getWorkspace(t.db, wsId)).not.toBeNull();
    expect(counts(wsId)).toMatchObject({ issues: 2, sessions: 1 });
    expect(getIssue(t.db, parentId)).not.toBeNull();
  });
});
