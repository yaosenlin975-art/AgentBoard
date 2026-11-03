import { randomUUID } from 'node:crypto';
import express, { type Express } from 'express';
import request from 'supertest';
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { createTestDb, type TestDb } from './helpers.js';
import { createWorkspace } from '../src/db/repos/workspace.js';
import { createIssue, listIssues } from '../src/db/repos/issue.js';
import { claimIssue } from '../src/services/claim.js';
import { setSessionSender, resetSessionSender } from '../src/services/comments.js';
import { withIdempotency, withIdempotencyResult } from '../src/services/idempotency.js';
import { createRouter, errorHandler } from '../src/api/routes.js';
describe('idempotent mutations', () => {
  let t: TestDb; let a: string; let app: Express;
  beforeEach(() => { t = createTestDb(); a = createWorkspace(t.db, { name: 'A', path: 'A' }).id; app = express(); app.use(express.json()); app.use('/api', createRouter({ db: t.db, getAdapter: () => { throw Error('unused'); }, broadcast: () => {} })); app.use(errorHandler); });
  afterEach(() => { resetSessionSender(); t.cleanup(); });
  it('sameIdempotencyKeyReplaysSameResponse and body key order is stable', async () => {
    const key = randomUUID();
    const first = await request(app).post('/api/issues').set('Idempotency-Key', key).send({ workspace_id: a, title: 'task', agent_id: 'codex' });
    const repeat = await request(app).post('/api/issues').set('Idempotency-Key', key).send({ agent_id: 'codex', title: 'task', workspace_id: a });
    expect(repeat.body).toEqual(first.body); expect(listIssues(t.db, a)).toHaveLength(1);
  });
  it('sameKeyDifferentPayloadReturns409 and actor/action are part of identity', async () => {
    const key = randomUUID(); const body = { workspace_id: a, title: 'task', agent_id: 'codex' };
    await request(app).post('/api/issues').set('Idempotency-Key', key).send(body);
    for (const patch of [{ title: 'other' }, { agent_id: 'dsh' }]) {
      const res = await request(app).post('/api/issues').set('Idempotency-Key', key).send({ ...body, ...patch }); expect(res.status).toBe(409); expect(res.body.error.code).toBe('IDEMPOTENCY_KEY_REUSED');
    }
  });
  it('mutation and ledger roll back together', () => {
    const input = { key: randomUUID(), actorId: 'codex', action: 'create', resource: a, payloadHash: 'a'.repeat(64) };
    expect(() => withIdempotency(t.db, input, () => { createIssue(t.db, { workspace_id: a, title: 'rollback' }); throw Error('rollback'); })).toThrow('rollback');
    expect(listIssues(t.db, a)).toHaveLength(0);
    expect(t.db.prepare('SELECT count(*) AS n FROM idempotency_record').get()).toEqual({ n: 0 });
    const mutate = vi.fn(() => ({ saved: true }));
    expect(withIdempotency(t.db, input, mutate)).toEqual({ saved: true }); expect(withIdempotency(t.db, input, mutate)).toEqual({ saved: true }); expect(mutate).toHaveBeenCalledTimes(1);
  });
  it('commentReplayDoesNotWakeTwice', async () => {
    const issue = createIssue(t.db, { workspace_id: a, title: 'comment' });
    t.db.prepare('INSERT INTO session(id,workspace_id,cli,created_at) VALUES(?,?,?,?)').run('session', a, 'fake', 1); claimIssue(t.db, issue.id, 'codex', 'session');
    const wake = vi.fn(async () => ({ queued: false })); setSessionSender(wake);
    const key = randomUUID(); const body = { workspace_id: a, content: 'user progress' };
    const first = await request(app).post(`/api/issues/${issue.id}/comments`).set('Idempotency-Key', key).send(body);
    const repeat = await request(app).post(`/api/issues/${issue.id}/comments`).set('Idempotency-Key', key).send(body);
    expect(first.status).toBe(200); expect(first.body.woke).toBe(true); expect(repeat.body).toEqual(first.body); expect(wake).toHaveBeenCalledTimes(1);
    expect(t.db.prepare('SELECT COUNT(*) AS n FROM issue_comment WHERE issue_id=?').get(issue.id)).toEqual({ n: 1 });
  });
  it('knowledge create/revise replays without a duplicate revision', async () => {
    const body = { scope: 'common', slug: 'cache', title: 'cache', body_md: 'body', actor: 'codex', sources: [{ source_id: 's', source_type: 'agent', locator: 'issue:1', captured_at: 1, content_hash: 'a'.repeat(64), snapshot: 'captured fixture evidence' }], evidence: [{ source_id: 's', locator: 'issue:1' }] };
    const key = randomUUID(); const create = () => request(app).post('/api/knowledge/pages').set('Idempotency-Key', key).send(body);
    const first = await create(); expect(first.status).toBe(200); expect((await create()).body).toEqual(first.body);
    const editKey = randomUUID(); const edit = () => request(app).put(`/api/knowledge/pages/${first.body.id}`).set('Idempotency-Key', editKey).send({ scope: 'common', expected_revision: 1, actor: 'codex', title: 'changed' });
    const edited = await edit(); expect(edited.body.revision).toBe(2); expect((await edit()).body).toEqual(edited.body);
    expect(t.db.prepare('SELECT count(*) AS n FROM knowledge_revision').get()).toEqual({ n: 2 });
  });
  it('claim and CAS and owner completion replay the original result', async () => {
    const issue = createIssue(t.db, { workspace_id: a, title: 'task' });
    const editKey = randomUUID(); const edit = () => request(app).patch(`/api/issues/${issue.id}`).set('Idempotency-Key', editKey).send({ workspace_id: a, expected_updated_at: issue.updated_at, title: 'changed', agent_id: 'codex' });
    const edited = await edit(); expect(edited.status).toBe(200); expect((await edit()).body).toEqual(edited.body);
    const key = randomUUID(); const claim = () => request(app).post(`/api/issues/${issue.id}/claim`).set('Idempotency-Key', key).send({ workspace_id: a, agent_id: 'codex' });
    const claimed = await claim(); expect(claimed.status).toBe(200); expect((await claim()).body).toEqual(claimed.body);
    const doneKey = randomUUID(); const done = () => request(app).post(`/api/issues/${issue.id}/done`).set('Idempotency-Key', doneKey).send({ workspace_id: a, agent_id: 'codex', notes: 'done' });
    const completed = await done(); expect(completed.status).toBe(200); expect((await done()).body).toEqual(completed.body);
    // notes 评论 1 条 + GIT-ON-DONE 非 git 工作区跳过提示 1 条；幂等重放不重复写
    expect(t.db.prepare("SELECT COUNT(*) AS n FROM issue_comment WHERE issue_id=? AND content='done'").get(issue.id)).toEqual({ n: 1 });
    expect(t.db.prepare("SELECT COUNT(*) AS n FROM issue_comment WHERE issue_id=? AND content LIKE '跳过自动提交%'").get(issue.id)).toEqual({ n: 1 });
  });
  it('retains results for 24h and reclaims expired records', () => {
    vi.spyOn(Date, 'now').mockReturnValue(1000);
    const input = { key: randomUUID(), actorId: 'codex', action: 'test', resource: 'r', payloadHash: 'a'.repeat(64) };
    const mutate = vi.fn(() => ({ n: 1 })); withIdempotency(t.db, input, mutate);
    vi.mocked(Date.now).mockReturnValue(1000 + 24 * 60 * 60 * 1000); withIdempotency(t.db, input, mutate); expect(mutate).toHaveBeenCalledTimes(1);
    vi.mocked(Date.now).mockReturnValue(1001 + 24 * 60 * 60 * 1000); withIdempotency(t.db, input, mutate); expect(mutate).toHaveBeenCalledTimes(2); vi.restoreAllMocks();
  });
  it('pending post-commit wake is unknown and never repeated after interruption', () => {
    const input = { key: randomUUID(), actorId: 'codex', action: 'comment', resource: 'r', payloadHash: 'a'.repeat(64) };
    const mutate = vi.fn(() => ({ saved: true, woke: false })); withIdempotencyResult(t.db, input, mutate, true);
    expect(() => withIdempotencyResult(t.db, input, mutate, true)).toThrowError(expect.objectContaining({ code: 'OPERATION_UNKNOWN' })); expect(mutate).toHaveBeenCalledTimes(1);
  });
  it('unresolved pending wake survives past 24h without repeating the mutation', () => {
    vi.spyOn(Date, 'now').mockReturnValue(1000);
    const input = { key: randomUUID(), actorId: 'codex', action: 'comment', resource: 'r', payloadHash: 'a'.repeat(64) };
    const mutate = vi.fn(() => ({ saved: true })); withIdempotencyResult(t.db, input, mutate, true);
    vi.mocked(Date.now).mockReturnValue(1001 + 24 * 60 * 60 * 1000);
    expect(() => withIdempotencyResult(t.db, input, mutate, true)).toThrowError(expect.objectContaining({ code: 'OPERATION_UNKNOWN' })); expect(mutate).toHaveBeenCalledTimes(1);
    vi.restoreAllMocks();
  });
});
