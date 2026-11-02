import express, { type Express } from 'express';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTestDb, type TestDb } from './helpers.js';
import { createWorkspace } from '../src/db/repos/workspace.js';
import { createIssue, getIssue, updateIssue } from '../src/db/repos/issue.js';
import { claimIssue, doneIssue, releaseIssue, failIssue } from '../src/services/claim.js';
import { addComment } from '../src/services/comments.js';
import { createRouter, errorHandler } from '../src/api/routes.js';

describe('MCP task API contracts', () => {
  let t: TestDb; let a: string; let b: string; let app: Express;
  beforeEach(() => {
    t = createTestDb(); a = createWorkspace(t.db, { name: 'A', path: 'A' }).id; b = createWorkspace(t.db, { name: 'B', path: 'B' }).id;
    app = express(); app.use(express.json()); app.use('/api', createRouter({ db: t.db, getAdapter: () => { throw Error('unused'); }, broadcast: () => {} })); app.use(errorHandler);
  });
  afterEach(() => { vi.restoreAllMocks(); t.cleanup(); });
  it('getIssueInWrongWorkspaceReturns404 across ID endpoints', async () => {
    const issue = createIssue(t.db, { workspace_id: b, title: 'B private' });
    for (const suffix of ['', '/comments']) expect((await request(app).get(`/api/issues/${issue.id}${suffix}`).query({ workspace_id: a })).status).toBe(404);
    expect((await request(app).patch(`/api/issues/${issue.id}`).send({ workspace_id: a, title: 'bad' })).status).toBe(404);
    for (const action of ['claim', 'release', 'done', 'fail', 'comments']) expect((await request(app).post(`/api/issues/${issue.id}/${action}`).send({ workspace_id: a, agent_id: 'codex', reason: 'failed', content: 'bad' })).status).toBe(404);
    expect(getIssue(t.db, issue.id)?.title).toBe('B private');
  });
  it('doneIssueRejectsNonOwnerWith409 and atomic scoped release/fail', async () => {
    const issue = createIssue(t.db, { workspace_id: a, title: 'task' }); claimIssue(t.db, issue.id, 'codex', null);
    for (const action of ['release', 'done', 'fail']) {
      const result = await request(app).post(`/api/issues/${issue.id}/${action}`).send({ workspace_id: a, agent_id: 'dsh', reason: 'failed' });
      expect(result.status).toBe(409); expect(result.body.error.code).toBe('NOT_TASK_OWNER');
      expect(getIssue(t.db, issue.id)?.claimed_by).toBe('codex');
    }
    expect((await request(app).post(`/api/issues/${issue.id}/done`).send({ workspace_id: a, agent_id: 'codex', notes: 'verified' })).body.status).toBe('待验收');
    const legacy = createIssue(t.db, { workspace_id: a, title: 'legacy' }); claimIssue(t.db, legacy.id, 'codex', null);
    await expect(doneIssue(t.db, legacy.id, 'dsh')).rejects.toMatchObject({ status: 409 });
  });
  it('updatedAtAdvancesWithinSameMillisecond across mutation paths', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(1000);
    const issue = createIssue(t.db, { workspace_id: a, title: 'task' });
    let previous = issue.updated_at;
    const check = () => { const next = getIssue(t.db, issue.id)!.updated_at; expect(next).toBeGreaterThan(previous); previous = next; };
    updateIssue(t.db, issue.id, { title: 'edit' }); check();
    claimIssue(t.db, issue.id, 'codex', null); check();
    await addComment(t.db, issue.id, 'agent:codex', 'progress'); check();
    await releaseIssue(t.db, issue.id); check();
    claimIssue(t.db, issue.id, 'codex', null); check(); await failIssue(t.db, issue.id, 'codex', 'failed'); check();
    claimIssue(t.db, issue.id, 'codex', null); check(); await doneIssue(t.db, issue.id, 'codex'); check();
  });
  it('same timestamp CAS allows one write and reports current updated_at', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(1000);
    const issue = createIssue(t.db, { workspace_id: a, title: 'task' });
    const first = await request(app).patch(`/api/issues/${issue.id}`).send({ workspace_id: a, expected_updated_at: issue.updated_at, title: 'first' }); expect(first.status).toBe(200);
    const second = await request(app).patch(`/api/issues/${issue.id}`).send({ workspace_id: a, expected_updated_at: issue.updated_at, title: 'stale' });
    expect(second.status).toBe(409); expect(second.body.error.code).toBe('TASK_REVISION_CONFLICT');
    expect(getIssue(t.db, issue.id)?.title).toBe('first');
  });
});
