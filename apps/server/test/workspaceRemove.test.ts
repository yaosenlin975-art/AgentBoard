/**
 * DELETE /api/workspaces/:id（WORKSPACE-REMOVE）：
 * - 无受保护关联数据（空空间 / 任务+评论+已结束会话+消息）→ 204，级联清空且无孤儿；
 * - 保留历史（**未软删**的知识页 + revision）→ 409，知识页与历史原样保留，拒绝原因点名剩余页 id；
 * - 知识页已全部软删 → 204（KB-DEL N-03：软删页与其 revision 不再计入占用，并在同一事务里硬删）；
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
import {
  createKnowledgePage,
  getWorkspaceKnowledgeOccupancy,
  reviseKnowledgePage,
  setKnowledgePageStatus,
} from '../src/db/repos/knowledge.js';

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
  domain: 'knowledge',
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
    // KB-DEL 验收 2：拒绝时点名剩余页 id，用户能直接去删/迁这几页
    expect(del.body.error.message).toContain(page.body.id as string);

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

/**
 * KB-DEL（N-03）：已软删（`status='deleted'`）的知识页不再阻断 delete-space。
 * 现场：技能审查里 `kb delete-space <页已全删的空间> --yes` exit 2，报「仍有 2 个知识页及 4 条历史 revision」。
 * 口径（唯一权威实现见 `repos/knowledge.ts` 的 `getWorkspaceKnowledgeOccupancy`）：
 * - `active` + `archived` 继续计入并阻断（archived 仍可 restore，是该空间的真实资产）；
 * - `deleted` 一律排除，页面行与其 revision 连 FTS 行在删除时一并硬删
 *   （`knowledge_page.workspace_id` 是 ON DELETE RESTRICT，光排除计数不硬删就只剩 500）；
 * - 硬删只在显式 `--yes` 的 DELETE 上发生，并把删掉的页/revision 数回显在 `X-Knowledge-Purged`。
 */
describe('DELETE /api/workspaces/:id 知识页软删口径（KB-DEL N-03）', () => {
  const countIn = (sql: string, ...params: unknown[]): number => (t.db.prepare(sql).get(...params) as { n: number }).n;
  const state = (workspaceId: string) => ({
    pages: countIn('SELECT COUNT(*) AS n FROM knowledge_page WHERE workspace_id = ?', workspaceId),
    deletedPages: countIn("SELECT COUNT(*) AS n FROM knowledge_page WHERE workspace_id = ? AND status='deleted'", workspaceId),
    revisions: countIn(
      'SELECT COUNT(*) AS n FROM knowledge_revision r JOIN knowledge_page p ON p.id = r.page_id WHERE p.workspace_id = ?',
      workspaceId,
    ),
  });
  const ftsRows = (pageId: string) => countIn('SELECT COUNT(*) AS n FROM knowledge_fts WHERE page_id = ?', pageId);

  /** 建页 → 软删（走真实 HTTP，revision 递增与历史追加都按线上路径） */
  async function mkPage(workspaceId: string, slug: string): Promise<string> {
    const res = await request(app).post('/api/knowledge/pages').send({ ...knowledgeBody(workspaceId), slug, title: `页 ${slug}` });
    expect(res.status).toBe(200);
    return res.body.id as string;
  }
  async function softDeletePage(workspaceId: string, pageId: string, expectedRevision: number): Promise<void> {
    const res = await request(app).post(`/api/knowledge/pages/${pageId}/actions`).send({
      scope: 'workspace', workspace_id: workspaceId, expected_revision: expectedRevision, action: 'delete', actor: 'user',
    });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('deleted');
  }

  it('占用口径单测：软删前计入，软删后页与其 revision 归零（行数不变、只改口径）', () => {
    const wsId = createWorkspace(t.db, { name: 'occupancy', path: spaceDir }).id;
    // 直建页必须逐字段内联：sources.source_type 靠上下文类型收窄成枚举，抽成公共常量会被推宽成 string
    const mkRepoPage = (slug: string) => createKnowledgePage(t.db, {
      scope: 'workspace',
      workspace_id: wsId,
      slug,
      title: `页 ${slug}`,
      body_md: '第一版',
      domain: 'knowledge',
      category: 'solved',
      actor: 'user',
      sources: [{ source_id: 's', source_type: 'agent', locator: 'issue:1', captured_at: 1, content_hash: 'a'.repeat(64), snapshot: 'verified' }],
      evidence: [{ source_id: 's', locator: 'issue:1' }],
    });
    const kept = mkRepoPage('kept');
    const doomed = mkRepoPage('doomed');
    reviseKnowledgePage(t.db, doomed.id, { scope: 'workspace', workspace_id: wsId }, 1, { body_md: '第二版', actor: 'user' });

    // 软删前：2 页 / 3 revision（kept 1 条 + doomed 2 条），两页 id 都点名
    const before = getWorkspaceKnowledgeOccupancy(t.db, wsId);
    expect(before.pages).toBe(2);
    expect(before.revisions).toBe(3);
    expect([...before.pageIds].sort()).toEqual([kept.id, doomed.id].sort());

    setKnowledgePageStatus(t.db, doomed.id, { scope: 'workspace', workspace_id: wsId }, 2, 'delete', 'user');

    // 软删后：只剩 kept 的 1 页 1 revision；doomed 的 3 条历史不再计入占用，也不再被点名
    const after = getWorkspaceKnowledgeOccupancy(t.db, wsId);
    expect(after).toEqual({ pages: 1, revisions: 1, pageIds: [kept.id] });
    // 口径变了但数据没动：软删页与其 revision 仍在库里，只有 delete-space 才硬删
    expect(state(wsId)).toEqual({ pages: 2, deletedPages: 1, revisions: 4 });
  });

  it('知识页已软删 → 204，页与 revision、FTS 幽灵行一并清除，历史不可变触发器原样复原', async () => {
    const wsId = await mkSpace('purged');
    const pageId = await mkPage(wsId, 'cache');
    await softDeletePage(wsId, pageId, 1);
    expect(state(wsId)).toEqual({ pages: 1, deletedPages: 1, revisions: 2 });

    const del = await request(app).delete(`/api/workspaces/${wsId}`);
    expect(del.status).toBe(204);
    // 将删除的计数必须可见（硬删不可逆；CLI 缺 --yes 根本不发这个请求）
    expect(del.headers['x-knowledge-purged']).toBe('pages=1; revisions=2');

    expect(getWorkspace(t.db, wsId)).toBeNull();
    expect(state(wsId)).toEqual({ pages: 0, deletedPages: 0, revisions: 0 });
    expect(ftsRows(pageId)).toBe(0);
    // 触发器是按 sqlite_master 原文建回的，历史保护仍然生效
    expect(
      t.db.prepare("SELECT name FROM sqlite_master WHERE type='trigger' AND name IN ('knowledge_revision_no_update','knowledge_revision_no_delete') ORDER BY name")
        .all(),
    ).toEqual([{ name: 'knowledge_revision_no_delete' }, { name: 'knowledge_revision_no_update' }]);
    const other = createWorkspace(t.db, { name: 'other', path: `${spaceDir}-other` }).id;
    const otherPage = await mkPage(other, 'other-page');
    expect(() => t.db.prepare('DELETE FROM knowledge_revision WHERE page_id = ?').run(otherPage)).toThrow(/immutable/i);
  });

  it('有效页 + 软删页并存 → 仍 409，只点名有效页，软删页也不被部分删除', async () => {
    const wsId = await mkSpace('mixed');
    const keptId = await mkPage(wsId, 'kept');
    const doomedId = await mkPage(wsId, 'doomed');
    await softDeletePage(wsId, doomedId, 1);

    const del = await request(app).delete(`/api/workspaces/${wsId}`);
    expect(del.status).toBe(409);
    expect(del.body.error.message).toContain('1 个知识页');
    expect(del.body.error.message).toContain(keptId);
    expect(del.body.error.message).not.toContain(doomedId);
    expect(del.headers['x-knowledge-purged']).toBeUndefined();

    expect(getWorkspace(t.db, wsId)).not.toBeNull();
    expect(state(wsId)).toEqual({ pages: 2, deletedPages: 1, revisions: 3 });
    expect(ftsRows(doomedId)).toBe(1);
  });

  it('归档页仍计入占用 → 409（只有 status=deleted 被排除）', async () => {
    const wsId = await mkSpace('archived');
    const pageId = await mkPage(wsId, 'archived-page');
    const res = await request(app).post(`/api/knowledge/pages/${pageId}/actions`).send({
      scope: 'workspace', workspace_id: wsId, expected_revision: 1, action: 'archive', actor: 'user',
    });
    expect(res.status).toBe(200);
    // archive 会追加一条 change_kind='archive' 的历史，所以是 1 页 / 2 revision，且仍被点名
    expect(getWorkspaceKnowledgeOccupancy(t.db, wsId)).toMatchObject({ pages: 1, revisions: 2, pageIds: [pageId] });

    expect((await request(app).delete(`/api/workspaces/${wsId}`)).status).toBe(409);
    expect(getWorkspace(t.db, wsId)).not.toBeNull();
  });
});
