import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import { createApp } from '../src/index.js';
import { createTestDb, type TestDb, issuePayload } from './helpers.js';
import { FakeAdapter, settle, type FakeTurnControl } from './fakeAdapter.js';
import { getIssue } from '../src/db/repos/issue.js';
import { listCommentsByIssue } from '../src/db/repos/comment.js';
import { consumeComments } from '../src/services/comments.js';
import { createSession, getSessionRuntime, resetSessionManager, setMaxConcurrentTurns } from '../src/services/sessionManager.js';
import { migrateAttachments } from '../src/db/migrations/attachments.js';
import { claimIssue } from '../src/services/claim.js';

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const VERIFIED_MODEL = 'minimax-m3.1-flash';
const VERIFIED_CLI_VERSION = '2.179.2';

let t: TestDb;
let app: Express;
let adapter: FakeAdapter;
let workspacePath: string;
let storageRoot: string;

beforeEach(async () => {
  t = createTestDb();
  adapter = new FakeAdapter();
  adapter.detectedVersion = VERIFIED_CLI_VERSION;
  workspacePath = mkdtempSync(join(tmpdir(), 'agentboard-image-delivery-ws-'));
  storageRoot = mkdtempSync(join(tmpdir(), 'agentboard-image-delivery-store-'));
  const created = await createApp({
    db: t.db,
    getAdapter: (id) => {
      if (id === 'fake' || id === 'codebuddy') return adapter;
      throw new Error(`unknown adapter: ${id}`);
    },
    adapters: [adapter],
    refreshClisOnBoot: false,
    attachmentStorageDir: join(storageRoot, 'attachments'),
  });
  app = created.app;
});

afterEach(() => {
  resetSessionManager();
  t.cleanup();
  rmSync(workspacePath, { recursive: true, force: true });
  rmSync(storageRoot, { recursive: true, force: true });
});

async function createWorkspace(): Promise<string> {
  const response = await request(app).post('/api/workspaces').send({ name: 'image-delivery', path: workspacePath });
  expect(response.status).toBe(200);
  return response.body.id as string;
}

async function createIssue(workspaceId: string): Promise<string> {
  const response = await request(app).post('/api/issues').send(issuePayload(workspaceId, { title: '合成图验证' }));
  expect(response.status).toBe(200);
  return response.body.id as string;
}

async function uploadImage(workspaceId: string): Promise<string> {
  const response = await request(app)
    .post(`/api/workspaces/${workspaceId}/attachments`)
    .set('Content-Type', 'image/png')
    .set('X-File-Name', 'synthetic.png')
    .send(PNG);
  expect(response.status).toBe(201);
  return response.body.id as string;
}

async function addImageComment(issueId: string, workspaceId: string): Promise<{ id: string }> {
  const attachmentId = await uploadImage(workspaceId);
  const response = await request(app)
    .post(`/api/issues/${issueId}/comments`)
    .send({ workspace_id: workspaceId, content: '识别这张合成图', attachment_ids: [attachmentId] });
  expect(response.status).toBe(200);
  return response.body.comment as { id: string };
}

async function dispatch(issueId: string, model: string, retryUnknownImages = false) {
  const candidates = await request(app).get(`/api/issues/${issueId}/pending-attachments?limit=100`);
  expect(candidates.status).toBe(200);
  const selectedAttachmentIds = (candidates.body.items as Array<{ id: string }>).slice(0, 5).map((item) => item.id);
  return request(app).post('/api/sessions').send({
    cli: 'codebuddy', model, issue_id: issueId,
    selected_attachment_ids: selectedAttachmentIds,
    ...(retryUnknownImages ? { retry_unknown_images: true } : {}),
  });
}

async function dispatchSelected(issueId: string, ids: string[], retryUnknownImages = false, reuseSession?: 'last' | 'new', idempotencyKey?: string) {
  const req = request(app).post('/api/sessions');
  if (idempotencyKey) req.set('Idempotency-Key', idempotencyKey);
  return req.send({
    cli: 'codebuddy', model: VERIFIED_MODEL, issue_id: issueId,
    selected_attachment_ids: ids,
    ...(reuseSession ? { reuse_session: reuseSession } : {}),
    ...(retryUnknownImages ? { retry_unknown_images: true } : {}),
  });
}

describe('verified image delivery', () => {
  it('rejects dispatch with historical images when the selected model is unverified', async () => {
    const workspaceId = await createWorkspace();
    const issueId = await createIssue(workspaceId);
    await addImageComment(issueId, workspaceId);

    const response = await dispatch(issueId, 'glm-5.3');

    expect(response.status).toBe(400);
    expect(response.body.error.message).toContain('IMAGE_DELIVERY_UNVERIFIED');
    expect(getIssue(t.db, issueId)).toMatchObject({ claimed_by: null, session_id: null });
    expect(t.db.prepare('SELECT COUNT(*) AS count FROM session').get()).toMatchObject({ count: 0 });
    expect(consumeComments(t.db, issueId).new_comment_ids).toEqual([]);
  });

  it.each([
    ['different CLI version', '2.179.3'],
    ['missing CLI version', null],
  ])('rejects image dispatch when CodeBuddy detection reports %s before claim or adapter invocation', async (_label, version) => {
    const workspaceId = await createWorkspace();
    const issueId = await createIssue(workspaceId);
    await addImageComment(issueId, workspaceId);
    adapter.detectedVersion = version;

    const response = await dispatch(issueId, VERIFIED_MODEL);

    expect(response.status).toBe(400);
    expect(response.body.error.message).toContain('IMAGE_DELIVERY_UNVERIFIED');
    expect(getIssue(t.db, issueId)).toMatchObject({ claimed_by: null, session_id: null });
    expect(t.db.prepare('SELECT COUNT(*) AS count FROM session').get()).toMatchObject({ count: 0 });
    expect(adapter.calls).toHaveLength(0);
  });

  it('does not auto-retry a duplicate queued image after the first attempt becomes unknown', async () => {
    setMaxConcurrentTurns(1);
    let slotHolder: FakeTurnControl | undefined;
    let firstImageAttempt: FakeTurnControl | undefined;
    adapter.script = (control) => {
      if (control.callIndex === 0) slotHolder = control;
      else if (control.callIndex === 1) firstImageAttempt = control;
      else control.finish(0, `fake-as-${control.callIndex}`);
    };

    const workspaceId = await createWorkspace();
    const blocker = await request(app).post('/api/sessions').send({
      cli: 'codebuddy', model: VERIFIED_MODEL, workspace_id: workspaceId, prompt: '占用全局槽位',
    });
    expect(blocker.status).toBe(200);
    await settle();
    expect(adapter.calls).toHaveLength(1);
    expect(slotHolder).toBeDefined();

    const issueId = await createIssue(workspaceId);
    const session = await createSession({ cli: 'codebuddy', model: VERIFIED_MODEL, issue_id: issueId });
    claimIssue(t.db, issueId, 'codebuddy', session.id);
    const attachmentId = await uploadImage(workspaceId);
    const comment = await request(app).post(`/api/issues/${issueId}/comments`).send({
      workspace_id: workspaceId,
      content: '排队时重复选择同一张图',
      attachment_ids: [attachmentId],
      agent_id: 'fixture',
    });
    expect(comment.status).toBe(200);

    const body = {
      cli: 'codebuddy', model: VERIFIED_MODEL, issue_id: issueId, reuse_session: 'last',
      selected_attachment_ids: [attachmentId],
    };
    const first = await request(app).post('/api/sessions')
      .set('Idempotency-Key', 'a1111111-1111-4111-8111-111111111111').send(body);
    const second = await request(app).post('/api/sessions')
      .set('Idempotency-Key', 'b2222222-2222-4222-8222-222222222222').send(body);
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(getSessionRuntime(session.id)).toMatchObject({ queuedCount: 1, waitingSlot: true });
    expect(adapter.calls).toHaveLength(1);

    slotHolder!.finish(0, 'fake-as-slot-holder');
    await settle();
    expect(adapter.calls).toHaveLength(2);
    expect(adapter.calls[1]!.attachments).toHaveLength(1);
    expect(firstImageAttempt).toBeDefined();

    firstImageAttempt!.finish(1, null);
    await settle();
    expect(adapter.calls).toHaveLength(2);
    expect(t.db.prepare('SELECT delivery_state FROM comment_attachment WHERE attachment_id=?').get(attachmentId))
      .toMatchObject({ delivery_state: 'unknown' });
    expect(t.db.prepare("SELECT content FROM message WHERE session_id=? AND role='error'").all(session.id))
      .toEqual(expect.arrayContaining([expect.objectContaining({ content: expect.stringContaining('IMAGE_DELIVERY_UNKNOWN_RETRY_REQUIRED') })]));
  });

  it('delivers historical images on the verified first turn and advances consume only after success', async () => {
    const workspaceId = await createWorkspace();
    const issueId = await createIssue(workspaceId);
    const comment = await addImageComment(issueId, workspaceId);

    const response = await dispatch(issueId, VERIFIED_MODEL);
    expect(response.status).toBe(200);
    await settle();

    expect(adapter.calls[0]!.attachments).toHaveLength(1);
    expect(adapter.calls[0]!.attachments![0]!.mimeType).toBe('image/png');
    expect(adapter.calls[0]!.attachments![0]!.path).toContain('attachments');
    expect(adapter.calls[0]!.prompt).toContain('## 本批随附图片评论引用\n- [user] 识别这张合成图');
    expect(t.db.prepare('SELECT delivered_at FROM comment_attachment').get()).toMatchObject({ delivered_at: expect.any(Number) });
    const history = await request(app).get(`/api/issues/${issueId}/comments`);
    expect(history.body.find((row: { id: string }) => row.id === comment.id).attachments[0].delivery_state).toBe('delivered');
    expect(consumeComments(t.db, issueId).new_comment_ids).toContain(comment.id);
    expect(consumeComments(t.db, issueId).new_comment_ids).toEqual([]);
  });

  it('keeps a failed live image wake unread and retries the same comment through dispatch', async () => {
    const workspaceId = await createWorkspace();
    const issueId = await createIssue(workspaceId);
    const first = await dispatch(issueId, VERIFIED_MODEL);
    expect(first.status).toBe(200);
    await settle();

    adapter.script = (control) => control.finish(1, null);
    const comment = await addImageComment(issueId, workspaceId);
    await settle();

    expect(adapter.calls[1]!.attachments).toHaveLength(1);
    expect(consumeComments(t.db, issueId).new_comment_ids).toEqual([]);
    expect(t.db.prepare('SELECT delivered_at FROM comment_attachment').get()).toMatchObject({ delivered_at: null });

    adapter.script = (control) => control.finish(0, `fake-as-${control.callIndex}`);
    const retry = await dispatch(issueId, VERIFIED_MODEL, true);
    expect(retry.status).toBe(200);
    await settle();

    expect(adapter.calls[2]!.attachments).toHaveLength(1);
    expect(consumeComments(t.db, issueId).new_comment_ids).toContain(comment.id);
    expect(listCommentsByIssue(t.db, issueId).filter((item) => item.id === comment.id)).toHaveLength(1);
    expect(t.db.prepare('SELECT COUNT(*) AS count FROM comment_attachment').get()).toMatchObject({ count: 1 });
  });

  it('carries queued image attachments into the next resumed turn', async () => {
    let firstTurn: FakeTurnControl | undefined;
    adapter.script = (control) => {
      if (control.callIndex === 0) firstTurn = control;
      else control.finish(0, `fake-as-${control.callIndex}`);
    };
    const workspaceId = await createWorkspace();
    const issueId = await createIssue(workspaceId);
    const first = await dispatch(issueId, VERIFIED_MODEL);
    expect(first.status).toBe(200);
    await settle();
    expect(firstTurn).toBeDefined();

    const comment = await addImageComment(issueId, workspaceId);
    expect(adapter.calls).toHaveLength(1);
    firstTurn!.finish(0, 'fake-as-first');
    await settle();

    expect(adapter.calls).toHaveLength(2);
    expect(adapter.calls[1]!.adapterSessionId).toBe('fake-as-first');
    expect(adapter.calls[1]!.attachments).toHaveLength(1);
    expect(consumeComments(t.db, issueId).new_comment_ids).toContain(comment.id);
  });

  it('does not redeliver an idempotent image comment request', async () => {
    const workspaceId = await createWorkspace();
    const issueId = await createIssue(workspaceId);
    const first = await dispatch(issueId, VERIFIED_MODEL);
    expect(first.status).toBe(200);
    await settle();
    const attachmentId = await uploadImage(workspaceId);
    const body = { workspace_id: workspaceId, content: '识别这张合成图', attachment_ids: [attachmentId] };

    const posted = await request(app)
      .post(`/api/issues/${issueId}/comments`)
      .set('Idempotency-Key', 'a64b3ea2-9a82-4fae-8a3b-f6647e73e609')
      .send(body);
    expect(posted.status).toBe(200);
    expect(posted.body.woke).toBe(true);
    await settle();
    const callCount = adapter.calls.length;

    const replay = await request(app)
      .post(`/api/issues/${issueId}/comments`)
      .set('Idempotency-Key', 'a64b3ea2-9a82-4fae-8a3b-f6647e73e609')
      .send(body);

    expect(replay.status).toBe(200);
    expect(replay.body.comment.id).toBe(posted.body.comment.id);
    expect(adapter.calls).toHaveLength(callCount);
    expect(t.db.prepare('SELECT COUNT(*) AS count FROM comment_attachment').get()).toMatchObject({ count: 1 });
  });

  it('stores but does not wake an unsupported active model for an image comment', async () => {
    const workspaceId = await createWorkspace();
    const issueId = await createIssue(workspaceId);
    const first = await dispatch(issueId, 'glm-5.3');
    expect(first.status).toBe(200);
    await settle();
    const callsBefore = adapter.calls.length;

    const comment = await addImageComment(issueId, workspaceId);

    expect(adapter.calls).toHaveLength(callsBefore);
    expect(consumeComments(t.db, issueId).new_comment_ids).toEqual([]);
    expect(listCommentsByIssue(t.db, issueId).some((item) => item.id === comment.id)).toBe(true);
  });

  it('persists an unknown delivery state after an attempted image turn fails, without retrying it', async () => {
    const workspaceId = await createWorkspace();
    const issueId = await createIssue(workspaceId);
    const first = await dispatch(issueId, VERIFIED_MODEL);
    expect(first.status).toBe(200);
    await settle();

    let failAttempt: (() => void) | undefined;
    adapter.script = (control) => { failAttempt = () => control.finish(1, null); };
    const comment = await addImageComment(issueId, workspaceId);
    await settle();
    expect(adapter.calls).toHaveLength(2);

    const attempted = await request(app).get(`/api/issues/${issueId}/comments`);
    expect(attempted.body.find((row: { id: string }) => row.id === comment.id).attachments[0].delivery_state).toBe('sending');
    expect(consumeComments(t.db, issueId).new_comment_ids).toEqual([]);

    failAttempt?.();
    await settle();
    const failed = await request(app).get(`/api/issues/${issueId}/comments`);
    expect(failed.body.find((row: { id: string }) => row.id === comment.id).attachments[0].delivery_state).toBe('unknown');
    expect(consumeComments(t.db, issueId).new_comment_ids).toEqual([]);
    expect(adapter.calls).toHaveLength(2);
  });

  it('marks a sending image as unknown after restart migration', async () => {
    const workspaceId = await createWorkspace();
    const issueId = await createIssue(workspaceId);
    const comment = await addImageComment(issueId, workspaceId);
    expect(listCommentsByIssue(t.db, issueId).find((item) => item.id === comment.id)?.attachments?.[0]?.delivery_state).toBe('pending');
    t.db.prepare("UPDATE comment_attachment SET delivery_state='sending', attempted_at=1 WHERE comment_id=?").run(comment.id);

    const sendingRow = t.db.prepare('SELECT attachment_id FROM comment_attachment WHERE comment_id=?').get(comment.id) as { attachment_id: string };
    const duringSend = await dispatchSelected(issueId, [sendingRow.attachment_id], true);
    expect(duringSend.status).toBe(400);
    expect(duringSend.body.error.message).toContain('IMAGE_DELIVERY_IN_PROGRESS');

    migrateAttachments(t.db);

    expect(t.db.prepare('SELECT delivery_state FROM comment_attachment WHERE comment_id=?').get(comment.id))
      .toMatchObject({ delivery_state: 'unknown' });
    expect(consumeComments(t.db, issueId).new_comment_ids).toEqual([]);
  });

  it('requires explicit confirmation before retrying an unknown image on a new dispatch', async () => {
    const workspaceId = await createWorkspace();
    const issueId = await createIssue(workspaceId);
    const first = await dispatch(issueId, VERIFIED_MODEL);
    expect(first.status).toBe(200);
    await settle();

    adapter.script = (control) => control.finish(1, null);
    const comment = await addImageComment(issueId, workspaceId);
    await settle();
    const callsBeforeRetry = adapter.calls.length;
    const sessionsBeforeRetry = t.db.prepare('SELECT COUNT(*) AS count FROM session').get() as { count: number };

    const blocked = await dispatch(issueId, VERIFIED_MODEL);

    expect(blocked.status).toBe(400);
    expect(blocked.body.error.message).toContain('IMAGE_DELIVERY_UNKNOWN_RETRY_REQUIRED');
    expect(adapter.calls).toHaveLength(callsBeforeRetry);
    expect(t.db.prepare('SELECT COUNT(*) AS count FROM session').get()).toMatchObject(sessionsBeforeRetry);
    expect(listCommentsByIssue(t.db, issueId).find((item) => item.id === comment.id)?.attachments?.[0]?.delivery_state).toBe('unknown');

    adapter.script = (control) => control.finish(0, `fake-as-${control.callIndex}`);
    const confirmed = await dispatch(issueId, VERIFIED_MODEL, true);
    expect(confirmed.status).toBe(200);
    await settle();
    expect(adapter.calls).toHaveLength(callsBeforeRetry + 1);
    expect(listCommentsByIssue(t.db, issueId).find((item) => item.id === comment.id)?.attachments?.[0]?.delivery_state).toBe('delivered');
  });

  it('lists an oldest pending image even when it is the 11th historical comment, with bounded ordered pages', async () => {
    const workspaceId = await createWorkspace();
    const issueId = await createIssue(workspaceId);
    const oldImage = await addImageComment(issueId, workspaceId);
    t.db.prepare('UPDATE issue_comment SET ts=1 WHERE id=?').run(oldImage.id);
    t.db.prepare('UPDATE issue_comment SET content=? WHERE id=?').run('😀'.repeat(600), oldImage.id);
    for (let index = 0; index < 10; index += 1) {
      const text = await request(app).post(`/api/issues/${issueId}/comments`).send({ workspace_id: workspaceId, content: `后续评论 ${index}` });
      expect(text.status).toBe(200);
      t.db.prepare('UPDATE issue_comment SET ts=? WHERE id=?').run(index + 2, text.body.comment.id);
    }

    const firstPage = await request(app).get(`/api/issues/${issueId}/pending-attachments?limit=1`);
    const nextPage = await request(app).get(`/api/issues/${issueId}/pending-attachments?limit=1&offset=1`);

    expect(firstPage.status).toBe(200);
    expect(firstPage.body).toMatchObject({ next_offset: null });
    expect(firstPage.body.items).toHaveLength(1);
    expect(firstPage.body.items[0]).toMatchObject({ id: expect.any(String), comment_id: oldImage.id, delivery_state: 'pending' });
    expect([...firstPage.body.items[0].snippet].length).toBe(500);
    expect(firstPage.body.items[0]).not.toHaveProperty('storage_key');
    expect(nextPage.body.items).toEqual([]);
  });

  it('requires retry confirmation only for selected unknown images and delivers only selected IDs', async () => {
    const workspaceId = await createWorkspace();
    const issueId = await createIssue(workspaceId);
    const pending = await addImageComment(issueId, workspaceId);
    const unknown = await addImageComment(issueId, workspaceId);
    const ids = t.db.prepare('SELECT comment_id,attachment_id FROM comment_attachment ORDER BY rowid').all() as Array<{ comment_id: string; attachment_id: string }>;
    const pendingId = ids.find((row) => row.comment_id === pending.id)!.attachment_id;
    const unknownId = ids.find((row) => row.comment_id === unknown.id)!.attachment_id;
    t.db.prepare("UPDATE comment_attachment SET delivery_state='unknown',attempted_at=1 WHERE attachment_id=?").run(unknownId);

    const pendingOnly = await dispatchSelected(issueId, [pendingId]);
    expect(pendingOnly.status).toBe(200);
    await settle();
    expect(adapter.calls.at(-1)!.attachments).toHaveLength(1);
    expect(t.db.prepare('SELECT delivery_state FROM comment_attachment WHERE attachment_id=?').get(pendingId)).toMatchObject({ delivery_state: 'delivered' });
    expect(t.db.prepare('SELECT delivery_state FROM comment_attachment WHERE attachment_id=?').get(unknownId)).toMatchObject({ delivery_state: 'unknown' });

    const unconfirmed = await dispatchSelected(issueId, [unknownId]);
    expect(unconfirmed.status).toBe(400);
    expect(unconfirmed.body.error.message).toContain('IMAGE_DELIVERY_UNKNOWN_RETRY_REQUIRED');
    const confirmed = await dispatchSelected(issueId, [unknownId], true, 'last');
    expect(confirmed.status).toBe(200);
    await settle();
    expect(adapter.calls.at(-1)!.attachments).toHaveLength(1);
    expect(t.db.prepare('SELECT delivery_state FROM comment_attachment WHERE attachment_id=?').get(unknownId)).toMatchObject({ delivery_state: 'delivered' });
  });

  it('truncates count overflow to the oldest five and reports the unread remainder', async () => {
    const workspaceId = await createWorkspace();
    const issueId = await createIssue(workspaceId);
    const ids: string[] = [];
    for (let index = 0; index < 6; index += 1) {
      const comment = await addImageComment(issueId, workspaceId);
      const row = t.db.prepare('SELECT attachment_id FROM comment_attachment WHERE comment_id=?').get(comment.id) as { attachment_id: string };
      ids.push(row.attachment_id);
    }
    t.db.prepare("UPDATE comment_attachment SET delivery_state='unknown',attempted_at=1 WHERE attachment_id=?").run(ids[5]);

    const response = await dispatchSelected(issueId, [...ids].reverse());
    expect(response.status).toBe(200);
    expect(response.body.remaining_attachment_count).toBe(1);
    await settle();

    expect(adapter.calls[0]!.attachments).toHaveLength(5);
    expect(adapter.calls[0]!.prompt).toContain('另有 1 张未附');
    const states = t.db.prepare('SELECT attachment_id,delivery_state FROM comment_attachment ORDER BY rowid').all() as Array<{ attachment_id: string; delivery_state: string }>;
    expect(states.filter((row) => row.delivery_state === 'delivered').map((row) => row.attachment_id)).toEqual(ids.slice(0, 5));
    expect(states.find((row) => row.attachment_id === ids[5])?.delivery_state).toBe('unknown');
  });

  it('truncates a selected batch at the byte budget and leaves the over-budget suffix unread', async () => {
    const workspaceId = await createWorkspace();
    const issueId = await createIssue(workspaceId);
    const ids: string[] = [];
    for (let index = 0; index < 2; index += 1) {
      const comment = await addImageComment(issueId, workspaceId);
      const row = t.db.prepare('SELECT attachment_id FROM comment_attachment WHERE comment_id=?').get(comment.id) as { attachment_id: string };
      ids.push(row.attachment_id);
    }
    t.db.prepare('UPDATE attachment SET size_bytes=? WHERE id=?').run(12 * 1024 * 1024, ids[0]);
    t.db.prepare('UPDATE attachment SET size_bytes=? WHERE id=?').run(12 * 1024 * 1024, ids[1]);

    const response = await dispatchSelected(issueId, ids);

    expect(response.status).toBe(200);
    expect(response.body.remaining_attachment_count).toBe(1);
    await settle();
    expect(adapter.calls[0]!.attachments).toHaveLength(1);
    expect(adapter.calls[0]!.prompt).toContain('另有 1 张未附');
    expect(t.db.prepare('SELECT delivery_state FROM comment_attachment WHERE attachment_id=?').get(ids[0])).toMatchObject({ delivery_state: 'delivered' });
    expect(t.db.prepare('SELECT delivery_state FROM comment_attachment WHERE attachment_id=?').get(ids[1])).toMatchObject({ delivery_state: 'pending' });
  });

  it('does not fail text dispatch when a selected image alone exceeds the byte budget', async () => {
    const workspaceId = await createWorkspace();
    const issueId = await createIssue(workspaceId);
    const comment = await addImageComment(issueId, workspaceId);
    const row = t.db.prepare('SELECT attachment_id FROM comment_attachment WHERE comment_id=?').get(comment.id) as { attachment_id: string };
    t.db.prepare('UPDATE attachment SET size_bytes=? WHERE id=?').run(20 * 1024 * 1024 + 1, row.attachment_id);

    const response = await dispatchSelected(issueId, [row.attachment_id]);

    expect(response.status).toBe(200);
    expect(response.body.remaining_attachment_count).toBe(1);
    await settle();
    expect(adapter.calls[0]!.attachments).toBeUndefined();
    expect(adapter.calls[0]!.prompt).toContain('另有 1 张未附');
    expect(t.db.prepare('SELECT delivery_state FROM comment_attachment WHERE attachment_id=?').get(row.attachment_id)).toMatchObject({ delivery_state: 'pending' });
  });

  it('does not expose or dispatch an attachment bound to a different workspace issue', async () => {
    const workspaceId = await createWorkspace();
    const issueId = await createIssue(workspaceId);
    const otherWorkspacePath = mkdtempSync(join(tmpdir(), 'agentboard-image-other-ws-'));
    try {
      const otherWorkspace = await request(app).post('/api/workspaces').send({ name: 'other', path: otherWorkspacePath });
      expect(otherWorkspace.status).toBe(200);
      const otherIssueId = await createIssue(otherWorkspace.body.id as string);
      const foreignComment = await addImageComment(otherIssueId, otherWorkspace.body.id as string);
      const foreign = t.db.prepare('SELECT attachment_id FROM comment_attachment WHERE comment_id=?').get(foreignComment.id) as { attachment_id: string };
      const ownIds: string[] = [];
      for (let index = 0; index < 5; index += 1) {
        const ownComment = await addImageComment(issueId, workspaceId);
        ownIds.push((t.db.prepare('SELECT attachment_id FROM comment_attachment WHERE comment_id=?').get(ownComment.id) as { attachment_id: string }).attachment_id);
      }

      const listed = await request(app).get(`/api/issues/${issueId}/pending-attachments`);
      expect(listed.status).toBe(200);
      expect(listed.body.items).toHaveLength(5);
      const dispatched = await dispatchSelected(issueId, [...ownIds, foreign.attachment_id]);
      expect(dispatched.status).toBe(404);
      expect(t.db.prepare('SELECT COUNT(*) AS count FROM session').get()).toMatchObject({ count: 0 });
      expect(getIssue(t.db, issueId)).toMatchObject({ claimed_by: null, session_id: null });
    } finally {
      rmSync(otherWorkspacePath, { recursive: true, force: true });
    }
  });

  it('refuses last-session image reuse if its owner or issue binding has changed', async () => {
    const workspaceId = await createWorkspace();
    const issueId = await createIssue(workspaceId);
    const comment = await addImageComment(issueId, workspaceId);
    const attachment = t.db.prepare('SELECT attachment_id FROM comment_attachment WHERE comment_id=?').get(comment.id) as { attachment_id: string };
    const first = await dispatchSelected(issueId, [attachment.attachment_id]);
    expect(first.status).toBe(200);
    await settle();
    const callsBefore = adapter.calls.length;
    t.db.prepare("UPDATE comment_attachment SET delivery_state='pending',delivered_at=NULL,attempted_at=NULL WHERE attachment_id=?").run(attachment.attachment_id);

    t.db.prepare("UPDATE issue SET claimed_by='someone-else' WHERE id=?").run(issueId);
    const rejected = await dispatchSelected(issueId, [attachment.attachment_id], false, 'last');

    expect(rejected.status).toBe(409);
    expect(adapter.calls).toHaveLength(callsBefore);
    expect(t.db.prepare('SELECT COUNT(*) AS count FROM session').get()).toMatchObject({ count: 1 });

    const otherIssueId = await createIssue(workspaceId);
    t.db.prepare('UPDATE issue SET claimed_by=? WHERE id=?').run('codebuddy', issueId);
    t.db.prepare('UPDATE session SET issue_id=? WHERE id=?').run(otherIssueId, first.body.id as string);
    const misbound = await dispatchSelected(issueId, [attachment.attachment_id], false, 'last');
    expect(misbound.status).toBe(409);
    expect(adapter.calls).toHaveLength(callsBefore);
    expect(t.db.prepare('SELECT COUNT(*) AS count FROM session').get()).toMatchObject({ count: 1 });
  });

  it('delivers chronological batches without skipping the next pending page', async () => {
    const workspaceId = await createWorkspace();
    const issueId = await createIssue(workspaceId);
    const allIds: string[] = [];
    for (let index = 0; index < 11; index += 1) {
      const comment = await addImageComment(issueId, workspaceId);
      t.db.prepare('UPDATE issue_comment SET ts=? WHERE id=?').run(index + 1, comment.id);
      const row = t.db.prepare('SELECT attachment_id FROM comment_attachment WHERE comment_id=?').get(comment.id) as { attachment_id: string };
      allIds.push(row.attachment_id);
    }

    const firstPage = await request(app).get(`/api/issues/${issueId}/pending-attachments?limit=5`);
    const secondPage = await request(app).get(`/api/issues/${issueId}/pending-attachments?limit=5&offset=5`);
    expect(firstPage.body.items.map((row: { id: string }) => row.id)).toEqual(allIds.slice(0, 5));
    expect(firstPage.body.next_offset).toBe(5);
    expect(secondPage.body.items.map((row: { id: string }) => row.id)).toEqual(allIds.slice(5, 10));
    expect(secondPage.body.next_offset).toBe(10);

    const firstBatch = await dispatchSelected(issueId, firstPage.body.items.map((row: { id: string }) => row.id));
    expect(firstBatch.status).toBe(200);
    expect(firstBatch.body.remaining_attachment_count).toBe(6);
    await settle();
    const refreshed = await request(app).get(`/api/issues/${issueId}/pending-attachments?limit=5`);
    expect(refreshed.body.items.map((row: { id: string }) => row.id)).toEqual(allIds.slice(5, 10));

    const secondBatchIds = refreshed.body.items.map((row: { id: string }) => row.id);
    const batchKey = 'f94cf739-0bb5-417b-b62f-0cc6e73dc212';
    const secondBatch = await dispatchSelected(issueId, secondBatchIds, false, 'last', batchKey);
    expect(secondBatch.status).toBe(200);
    expect(secondBatch.body.remaining_attachment_count).toBe(1);
    await settle();
    const callsAfterSecondBatch = adapter.calls.length;
    const replay = await dispatchSelected(issueId, secondBatchIds, false, 'last', batchKey);
    expect(replay.status).toBe(200);
    expect(replay.body.remaining_attachment_count).toBe(1);
    expect(adapter.calls).toHaveLength(callsAfterSecondBatch);
    const last = await request(app).get(`/api/issues/${issueId}/pending-attachments?limit=5`);
    expect(last.body.items.map((row: { id: string }) => row.id)).toEqual(allIds.slice(10));
    expect(t.db.prepare("SELECT COUNT(*) AS count FROM comment_attachment WHERE delivery_state='delivered'").get()).toMatchObject({ count: 10 });
  });
});
