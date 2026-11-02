import express, { type Express } from 'express';
import request from 'supertest';
import { beforeEach, afterEach, describe, expect, it } from 'vitest';
import { createTestDb, type TestDb } from './helpers.js';
import { createWorkspace } from '../src/db/repos/workspace.js';
import { createIssue } from '../src/db/repos/issue.js';
import { addComment } from '../src/db/repos/comment.js';
import { createRouter, errorHandler } from '../src/api/routes.js';
describe('bounded pagination', () => {
  let t: TestDb; let a: string; let b: string; let app: Express;
  beforeEach(() => { t = createTestDb(); a = createWorkspace(t.db, { name: 'A', path: 'A' }).id; b = createWorkspace(t.db, { name: 'B', path: 'B' }).id; app = express(); app.use(express.json()); app.use('/api', createRouter({ db: t.db, getAdapter: () => { throw Error('unused'); }, broadcast: () => {} })); app.use(errorHandler); });
  afterEach(() => t.cleanup());
  it('listIssuesPageUsesStableIdOrder and legacy endpoints stay arrays', async () => {
    const ids = [0, 1, 2].map(i => createIssue(t.db, { workspace_id: a, title: String(i), description: '长'.repeat(13000) }).id).sort();
    createIssue(t.db, { workspace_id: b, title: 'secret' });
    const first = await request(app).get('/api/issues').query({ workspace: a, limit: 2, offset: 0 });
    expect(first.body.items.map((r: { id: string }) => r.id)).toEqual(ids.slice(0, 2)); expect(first.body.next_offset).toBe(2);
    expect(first.body.items[0].description.length).toBeLessThanOrEqual(12000); expect(first.body.items[0].description_truncated).toBe(true);
    const last = await request(app).get('/api/issues').query({ workspace: a, limit: 2, offset: 2 }); expect(last.body.items.map((r: { id: string }) => r.id)).toEqual(ids.slice(2)); expect(last.body.next_offset).toBeNull();
    expect(Array.isArray((await request(app).get('/api/issues').query({ workspace: a })).body)).toBe(true);
    expect((await request(app).get('/api/workspaces').query({ limit: 1 })).body.next_offset).toBe(1);
    for (const limit of [0, -1, 101, 'x']) expect((await request(app).get('/api/issues').query({ workspace: a, limit })).status).toBe(400);
  });
  it('getTaskDescriptionOffsetResumes without splitting Unicode or NUL text', async () => {
    const description = 'A😀中\0XYZ'; const issue = createIssue(t.db, { workspace_id: a, title: 'body', description });
    let offset = 0; let text = '';
    for (let i = 0; i < 10; i++) {
      const res = await request(app).get(`/api/issues/${issue.id}`).query({ workspace_id: a, description_offset_chars: offset, description_max_chars: 2 });
      expect(res.status).toBe(200); text += res.body.description;
      expect(Array.from(res.body.description).length).toBeLessThanOrEqual(2);
      if (!res.body.description_truncated) break;
      expect(res.body.next_description_offset_chars).toBeGreaterThan(offset); offset = res.body.next_description_offset_chars;
    }
    expect(text).toBe(description);
    expect((await request(app).get(`/api/issues/${issue.id}`).query({ workspace_id: b, description_max_chars: 2 })).status).toBe(404);
    expect((await request(app).get(`/api/issues/${issue.id}`).query({ workspace_id: a, description_max_chars: 40001 })).status).toBe(400);
  });
  it('getCommentContentOffsetResumes; list snippets bounded and cursor untouched', async () => {
    const issue = createIssue(t.db, { workspace_id: a, title: 'comments' });
    const comment = addComment(t.db, { issue_id: issue.id, author: 'user', content: '😀缓存\0'.repeat(180) });
    const empty = addComment(t.db, { issue_id: issue.id, author: 'system', content: '' });
    const list = await request(app).get(`/api/issues/${issue.id}/comments`).query({ workspace_id: a, limit: 50 });
    expect(list.body.items).toHaveLength(2); expect(list.body.items.find((r: { id: string }) => r.id === comment.id).has_more).toBe(true);
    expect(Array.from(list.body.items.find((r: { id: string }) => r.id === comment.id).snippet).length).toBeLessThanOrEqual(500);
    let offset = 0; let text = '';
    for (let i = 0; i < 10; i++) {
      const res = await request(app).get(`/api/issues/${issue.id}/comments/${comment.id}`).query({ workspace_id: a, content_offset_chars: offset, content_max_chars: 200 });
      expect(res.status).toBe(200); text += res.body.content; if (!res.body.truncated) break; offset = res.body.next_content_offset_chars;
    }
    expect(text).toBe(comment.content);
    expect((await request(app).get(`/api/issues/${issue.id}/comments/${empty.id}`).query({ workspace_id: a })).body).toMatchObject({ content: '', truncated: false, next_content_offset_chars: null });
    expect((await request(app).get(`/api/issues/${issue.id}/comments/${comment.id}`).query({ workspace_id: b })).status).toBe(404);
    expect(t.db.prepare('SELECT last_seen_comment_id AS cursor FROM issue WHERE id=?').get(issue.id)).toEqual({ cursor: null });
  });
});
