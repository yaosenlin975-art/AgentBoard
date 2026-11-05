import { randomUUID } from 'node:crypto';
import express, { type Express } from 'express';
import request from 'supertest';
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { createTestDb, type TestDb } from './helpers.js';
import { initSchema } from '../src/db/schema.js';
import { migrateIdempotency } from '../src/db/migrations/idempotency.js';
import { getIdempotencyRecord } from '../src/db/repos/idempotency.js';
import { createWorkspace } from '../src/db/repos/workspace.js';
import { createIssue, listIssues } from '../src/db/repos/issue.js';
import { claimIssue } from '../src/services/claim.js';
import { setSessionSender, resetSessionSender } from '../src/services/comments.js';
import { finishIdempotentEffect, withIdempotency, withIdempotencyResult } from '../src/services/idempotency.js';
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
    const body = { domain: 'knowledge', scope: 'common', slug: 'cache', title: 'cache', body_md: 'body', actor: 'codex', sources: [{ source_id: 's', source_type: 'agent', locator: 'issue:1', captured_at: 1, content_hash: 'a'.repeat(64), snapshot: 'captured fixture evidence' }], evidence: [{ source_id: 's', locator: 'issue:1' }] };
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
  it('same key in different workspaces does not interfere (each workspace gets its own card)', async () => {
    const b = createWorkspace(t.db, { name: 'B', path: 'B' }).id;
    const key = randomUUID();
    const send = (workspaceId: string) => request(app).post('/api/issues').set('Idempotency-Key', key).send({ workspace_id: workspaceId, title: 'task', agent_id: 'codex' });
    const first = await send(a); const second = await send(b);
    expect(first.status).toBe(200); expect(second.status).toBe(200);
    expect(second.body.id).not.toBe(first.body.id);
    expect(listIssues(t.db, a)).toHaveLength(1); expect(listIssues(t.db, b)).toHaveLength(1);
    const rows = t.db.prepare('SELECT workspace_id, request_id FROM idempotency_record').all() as Array<{ workspace_id: string; request_id: string }>;
    expect(rows.map((row) => row.request_id)).toEqual([key, key]);
    expect(rows.map((row) => row.workspace_id).sort()).toEqual([a, b].sort());
    // 同工作区内重放语义不变：仍命中本工作区的记录
    const repeat = await send(a);
    expect(repeat.body).toEqual(first.body);
    expect(listIssues(t.db, a)).toHaveLength(1);
  });
  it('effect_state distinguishes pending vs applied and replay follows it', () => {
    const key = randomUUID();
    const input = (workspaceId: string) => ({ key, actorId: 'codex', action: 'test', resource: 'r', payloadHash: 'a'.repeat(64), workspaceId });
    const mutate = vi.fn(() => ({ saved: true }));
    withIdempotencyResult(t.db, input('w1'), mutate, true);
    expect(t.db.prepare('SELECT effect_state, effect_pending FROM idempotency_record WHERE request_id=?').get(key))
      .toEqual({ effect_state: 'pending', effect_pending: 1 });
    expect(() => withIdempotencyResult(t.db, input('w1'), mutate, true)).toThrowError(expect.objectContaining({ code: 'OPERATION_UNKNOWN' }));
    finishIdempotentEffect(t.db, key, { saved: true, woke: true });
    expect(t.db.prepare('SELECT effect_state, effect_pending FROM idempotency_record WHERE request_id=?').get(key))
      .toEqual({ effect_state: 'applied', effect_pending: 0 });
    expect(withIdempotencyResult(t.db, input('w1'), mutate, true).result).toEqual({ saved: true, woke: true });
    expect(mutate).toHaveBeenCalledTimes(1);
  });
  it('legacy rows backfilled with empty workspace still replay-hit and never create a second card', async () => {
    const key = randomUUID();
    const body = { workspace_id: a, title: 'legacy', agent_id: 'codex' };
    const first = await request(app).post('/api/issues').set('Idempotency-Key', key).send(body);
    expect(first.status).toBe(200);
    // 模拟迁移回填后的旧行：workspace_id 清成 ''（升级前全局作用域）
    t.db.prepare("UPDATE idempotency_record SET workspace_id='' WHERE request_id=?").run(key);
    const repeat = await request(app).post('/api/issues').set('Idempotency-Key', key).send(body);
    expect(repeat.body).toEqual(first.body);
    expect(listIssues(t.db, a)).toHaveLength(1);
    expect(t.db.prepare('SELECT COUNT(*) AS n FROM idempotency_record').get()).toEqual({ n: 1 });
  });
});
describe('idempotency workspace-scope migration', () => {
  it('re-running the migration is re-entrant and keeps existing records', () => {
    const t = createTestDb();
    try {
      const input = { key: randomUUID(), actorId: 'codex', action: 'test', resource: 'r', payloadHash: 'a'.repeat(64), workspaceId: 'w1' };
      withIdempotency(t.db, input, () => ({ n: 1 }));
      expect(() => initSchema(t.db)).not.toThrow();
      expect(t.db.prepare('SELECT COUNT(*) AS n FROM idempotency_record').get()).toEqual({ n: 1 });
      // 复合主键仍在：另一工作区同 key 可各自记账
      withIdempotency(t.db, { ...input, workspaceId: 'w2' }, () => ({ n: 2 }));
      expect(t.db.prepare('SELECT COUNT(*) AS n FROM idempotency_record').get()).toEqual({ n: 2 });
    } finally { t.cleanup(); }
  });
  it('legacy table upgrade backfills workspace_id empty and derives effect_state from effect_pending', () => {
    const t = createTestDb();
    try {
      // 重建升级前的旧表（request_id 单列主键、无 workspace_id/effect_state）
      t.db.exec(`
        DROP TABLE idempotency_record;
        CREATE TABLE idempotency_record (
          request_id TEXT PRIMARY KEY, actor_id TEXT NOT NULL, action TEXT NOT NULL, resource TEXT NOT NULL,
          payload_hash TEXT NOT NULL, response_json TEXT NOT NULL, effect_pending INTEGER NOT NULL DEFAULT 0,
          created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL);
        CREATE INDEX IF NOT EXISTS idempotency_expiry ON idempotency_record(expires_at);
        INSERT INTO idempotency_record(request_id,actor_id,action,resource,payload_hash,response_json,effect_pending,created_at,expires_at) VALUES
          ('11111111-1111-4111-8111-111111111111','codex','POST','/r','h1','{}',0,1,2),
          ('22222222-2222-4222-8222-222222222222','codex','POST','/r','h2','{}',1,1,2);
      `);
      migrateIdempotency(t.db);
      migrateIdempotency(t.db); // 重入：第二次为 no-op
      expect(t.db.prepare('SELECT workspace_id, request_id, effect_state, effect_pending FROM idempotency_record ORDER BY request_id').all()).toEqual([
        { workspace_id: '', request_id: '11111111-1111-4111-8111-111111111111', effect_state: 'applied', effect_pending: 0 },
        { workspace_id: '', request_id: '22222222-2222-4222-8222-222222222222', effect_state: 'pending', effect_pending: 1 },
      ]);
      // 带工作区查询回退命中旧行
      expect(getIdempotencyRecord(t.db, '11111111-1111-4111-8111-111111111111', 'any-ws')?.workspace_id).toBe('');
    } finally { t.cleanup(); }
  });
});
