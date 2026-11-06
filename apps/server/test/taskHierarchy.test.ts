import express, { type Express } from 'express';
import request from 'supertest';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createTestDb, type TestDb, issuePayload } from './helpers.js';
import { initSchema } from '../src/db/schema.js';
import { createWorkspace, deleteWorkspace } from '../src/db/repos/workspace.js';
import { createIssue, listIssues, updateIssue } from '../src/db/repos/issue.js';
import { updateIssueGuarded, updateIssueWithCAS } from '../src/services/claim.js';
import { createRouter, errorHandler } from '../src/api/routes.js';

describe('incremental task hierarchy migration', () => {
  it('adds nullable parent relation idempotently and restricts deleting parents with children', () => {
    const dir = mkdtempSync(join(tmpdir(), 'agentboard-legacy-'));
    const db = new Database(join(dir, 'legacy.db'));
    try {
      db.pragma('foreign_keys = ON');
      db.exec(
        "CREATE TABLE workspace (id TEXT PRIMARY KEY, name TEXT NOT NULL, path TEXT NOT NULL UNIQUE, created_at INTEGER NOT NULL);" +
          "CREATE TABLE issue (id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL REFERENCES workspace(id) ON DELETE CASCADE, " +
          "title TEXT NOT NULL, description TEXT NOT NULL DEFAULT '', priority TEXT NOT NULL DEFAULT '中' CHECK(priority IN ('低','中','高')), " +
          "labels TEXT NOT NULL DEFAULT '[]', status TEXT NOT NULL DEFAULT '待规划' CHECK(status IN ('待规划','进行中','待验收','已关闭')), " +
          "sort_order INTEGER NOT NULL DEFAULT 0, claimed_by TEXT, claimed_at INTEGER, session_id TEXT, last_seen_comment_id TEXT, " +
          'created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);' +
          "INSERT INTO workspace VALUES ('w1','one','one',1);" +
          "INSERT INTO issue (id,workspace_id,title,created_at,updated_at) VALUES ('old','w1','legacy',1,1);",
      );

      initSchema(db as never);
      initSchema(db as never);

      const columns = db.prepare('PRAGMA table_info(issue)').all() as Array<{ name: string; notnull: number }>;
      const parentColumn = columns.find((column) => column.name === 'parent_issue_id');
      expect(parentColumn).toMatchObject({ name: 'parent_issue_id', notnull: 0 });
      expect(db.prepare('SELECT parent_issue_id FROM issue WHERE id=?').get('old')).toEqual({ parent_issue_id: null });
      const fk = db.prepare('PRAGMA foreign_key_list(issue)').all() as Array<{ from: string; table: string; on_delete: string }>;
      expect(fk).toContainEqual(expect.objectContaining({ from: 'parent_issue_id', table: 'issue', on_delete: 'RESTRICT' }));
      const index = db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND name='issue_parent_order'").get();
      expect(index).toBeTruthy();

      db.prepare("INSERT INTO issue (id,workspace_id,parent_issue_id,title,created_at,updated_at) VALUES ('child','w1','old','child',2,2)").run();
      expect(() => db.prepare("DELETE FROM issue WHERE id='old'").run()).toThrow(/FOREIGN KEY constraint failed/);
    } finally {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('task hierarchy REST contract', () => {
  let t: TestDb;
  let workspaceId: string;
  let otherWorkspaceId: string;
  let app: Express;

  beforeEach(() => {
    t = createTestDb();
    workspaceId = createWorkspace(t.db, { name: 'one', path: 'D:\\one' }).id;
    otherWorkspaceId = createWorkspace(t.db, { name: 'two', path: 'D:\\two' }).id;
    app = express();
    app.use(express.json());
    app.use('/api', createRouter({ db: t.db, getAdapter: () => { throw new Error('unused'); }, broadcast: () => {} }));
    app.use(errorHandler);
  });

  afterEach(() => t.cleanup());

  async function postIssue(title: string, parent_issue_id?: string) {
    return request(app).post('/api/issues').send(issuePayload(workspaceId, { title, parent_issue_id }));
  }

  it('persists parent IDs in create, patch, detail, and legacy flat-list responses', async () => {
    const root = await postIssue('root');
    expect(root.status).toBe(200);
    expect(root.body.parent_issue_id).toBeNull();
    const child = await postIssue('child', root.body.id);
    expect(child.status).toBe(200);
    expect(child.body.parent_issue_id).toBe(root.body.id);
    const grandchild = await postIssue('grandchild', child.body.id);
    expect(grandchild.body.parent_issue_id).toBe(child.body.id);

    const detail = await request(app).get('/api/issues/' + child.body.id);
    expect(detail.body.parent_issue_id).toBe(root.body.id);
    const flat = await request(app).get('/api/issues').query({ workspace: workspaceId });
    expect(flat.body.map((item: { id: string; parent_issue_id: string | null }) => [item.id, item.parent_issue_id])).toEqual([
      [root.body.id, null], [child.body.id, root.body.id], [grandchild.body.id, child.body.id],
    ]);
  });

  it('keeps hierarchy creates idempotent when the same request key is replayed', async () => {
    const root = await postIssue('root');
    const requestId = '00000000-0000-4000-8000-000000000181';
    const first = await request(app).post('/api/issues').set('Idempotency-Key', requestId)
      .send(issuePayload(workspaceId, { title: 'child', parent_issue_id: root.body.id }));
    const replay = await request(app).post('/api/issues').set('Idempotency-Key', requestId)
      .send(issuePayload(workspaceId, { title: 'child', parent_issue_id: root.body.id }));
    expect(first.body.id).toBe(replay.body.id);
    expect(listIssues(t.db, workspaceId)).toHaveLength(2);
  });

  it('rejects missing/cross-workspace/self/indirect-cycle parents and allows moving to root', async () => {
    const root = await postIssue('root');
    const child = await postIssue('child', root.body.id);
    const grandchild = await postIssue('grandchild', child.body.id);
    const foreign = await request(app).post('/api/issues').send(issuePayload(otherWorkspaceId, { title: 'foreign' }));

    expect((await postIssue('missing-parent', 'missing')).status).toBe(404);
    expect((await request(app).patch('/api/issues/' + child.body.id).send({ parent_issue_id: foreign.body.id })).status).toBe(400);
    expect((await request(app).patch('/api/issues/' + child.body.id).send({ parent_issue_id: child.body.id })).status).toBe(400);
    expect((await request(app).patch('/api/issues/' + root.body.id).send({ parent_issue_id: grandchild.body.id })).status).toBe(400);
    const moved = await request(app).patch('/api/issues/' + grandchild.body.id).send({ parent_issue_id: null });
    expect(moved.status).toBe(200);
    expect(moved.body.parent_issue_id).toBeNull();
  });

  it('paginates direct children deterministically with ancestor context and rejects a cursor for changed filters', async () => {
    const root = await postIssue('root');
    const parent = await postIssue('parent', root.body.id);
    const a = await postIssue('a', parent.body.id);
    const b = await postIssue('b', parent.body.id);
    const c = await postIssue('c', parent.body.id);
    updateIssue(t.db, a.body.id, { sort_order: 1 });
    updateIssue(t.db, b.body.id, { sort_order: 2 });
    updateIssue(t.db, c.body.id, { sort_order: 3 });
    updateIssue(t.db, b.body.id, { status: '进行中' });

    const first = await request(app).get('/api/issues/tree').query({ workspace: workspaceId, parent_issue_id: parent.body.id, limit: 2 });
    expect(first.status).toBe(200);
    expect(first.body.ancestors.map((item: { id: string }) => item.id)).toEqual([root.body.id, parent.body.id]);
    expect(first.body.items.map((item: { title: string }) => item.title)).toEqual(['a', 'b']);
    expect(first.body.items[0]).toMatchObject({ child_count: 0, descendant_count: 0, descendants_closed_count: 0 });
    expect(first.body.next_cursor).toEqual(expect.any(String));

    const second = await request(app).get('/api/issues/tree').query({
      workspace: workspaceId, parent_issue_id: parent.body.id, limit: 2, cursor: first.body.next_cursor,
    });
    expect(second.status).toBe(200);
    expect(second.body.items.map((item: { title: string }) => item.title)).toEqual(['c']);
    expect(second.body.next_cursor).toBeNull();
    expect((await request(app).get('/api/issues/tree').query({ workspace: workspaceId, parent_issue_id: root.body.id, limit: 2, cursor: first.body.next_cursor })).status).toBe(400);
    const filtered = await request(app).get('/api/issues/tree').query({ workspace: workspaceId, parent_issue_id: parent.body.id, status: '进行中', limit: 2 });
    expect(filtered.body.ancestors.map((item: { id: string }) => item.id)).toEqual([root.body.id, parent.body.id]);
    expect(filtered.body.items.map((item: { title: string }) => item.title)).toEqual(['b']);
    expect((await request(app).get('/api/issues/tree').query({
      workspace: workspaceId, parent_issue_id: parent.body.id, status: '待规划', limit: 2, cursor: first.body.next_cursor,
    })).status).toBe(400);
  });

  it('blocks closing a parent through REST and direct service until every descendant is closed', async () => {
    const root = await postIssue('root');
    const child = await postIssue('child', root.body.id);
    const grandchild = await postIssue('grandchild', child.body.id);

    const initialTree = await request(app).get('/api/issues/tree').query({ workspace: workspaceId, limit: 10 });
    expect(initialTree.body.items[0]).toMatchObject({ child_count: 1, descendant_count: 2, descendants_closed_count: 0 });
    expect((await request(app).patch('/api/issues/' + root.body.id).send({ status: '已关闭' })).status).toBe(409);
    expect((await request(app).patch('/api/issues/' + root.body.id).send({
      workspace_id: workspaceId, expected_updated_at: root.body.updated_at, status: '已关闭',
    })).status).toBe(409);
    expect(() => updateIssueGuarded(t.db, root.body.id, { status: '已关闭' })).toThrow();
    expect(() => updateIssueWithCAS(t.db, root.body.id, workspaceId, root.body.updated_at, { status: '已关闭' })).toThrow();
    expect((await request(app).patch('/api/issues/' + child.body.id).send({ status: '已关闭' })).status).toBe(409);

    expect((await request(app).patch('/api/issues/' + grandchild.body.id).send({ status: '已关闭' })).status).toBe(200);
    expect((await request(app).patch('/api/issues/' + child.body.id).send({ status: '已关闭' })).status).toBe(200);
    expect((await request(app).patch('/api/issues/' + root.body.id).send({ status: '已关闭' })).status).toBe(200);
  });

  it('returns conflict when deleting a node with children and refuses to remove the workspace hierarchy', async () => {
    const root = await postIssue('root');
    await postIssue('child', root.body.id);
    expect((await request(app).delete('/api/issues/' + root.body.id)).status).toBe(409);
    // 移除工作空间：父子依赖按缺陷修复要求安全拒绝，且不改写 parent_issue_id 去绕过 RESTRICT
    const del = await request(app).delete('/api/workspaces/' + workspaceId);
    expect(del.status).toBe(409);
    expect(del.body.error).toMatchObject({ code: 'CONFLICT' });
    expect(del.body.error.message).toContain('子任务');
    expect(() => deleteWorkspace(t.db, workspaceId)).toThrow(/FOREIGN KEY constraint failed/);
  });

  it('CHILD-PROGRESS：详情与整区列表都投影 children_total / children_closed', async () => {
    const root = await postIssue('root');
    const closedChild = await postIssue('closed-child', root.body.id);
    const openChild = await postIssue('open-child', root.body.id);
    t.db.prepare("UPDATE issue SET status='已关闭' WHERE id=?").run(closedChild.body.id);

    const detail = await request(app).get('/api/issues/' + root.body.id);
    expect(detail.status).toBe(200);
    expect(detail.body).toMatchObject({ children_total: 2, children_closed: 1 });

    const list = await request(app).get('/api/issues?workspace=' + workspaceId);
    expect(list.status).toBe(200);
    const rows = list.body as Array<{ id: string; children_total: number; children_closed: number }>;
    expect(rows.find((row) => row.id === root.body.id)).toMatchObject({ children_total: 2, children_closed: 1 });
    // 叶子卡同样带这两个字段（统一 0/0，不做「有值才带」的分裂形状）
    expect(rows.find((row) => row.id === openChild.body.id)).toMatchObject({ children_total: 0, children_closed: 0 });
  });
});
