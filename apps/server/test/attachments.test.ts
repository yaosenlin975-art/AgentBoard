import { mkdirSync, mkdtempSync, readdirSync, rmSync, rmdirSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import request from 'supertest';
import type { Express } from 'express';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/index.js';
import { resetSessionSender, setSessionSender } from '../src/services/comments.js';
import type { AttachmentStore } from '../src/services/attachments.js';
import { createTestDb, type TestDb } from './helpers.js';

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00]);
interface StagedAttachmentResponse {
  id: string;
  workspace_id: string;
  file_name: string;
  mime_type: string;
  size_bytes: number;
  status: 'staged';
  expires_at: number;
  download_url: string;
}

let t: TestDb;
let app: Express;
let attachmentStore: AttachmentStore;
let spaceDirs: string[];
let storageRoot: string;
let storageDir: string;

beforeEach(async () => {
  t = createTestDb();
  spaceDirs = [];
  storageRoot = mkdtempSync(join(tmpdir(), 'agentboard-image-store-'));
  storageDir = join(storageRoot, '.superpowers', 'attachments');
  mkdirSync(storageDir, { recursive: true });
  const created = await createApp({ db: t.db, refreshClisOnBoot: false, attachmentStorageDir: storageDir });
  app = created.app;
  attachmentStore = created.attachments;
});

afterEach(() => {
  resetSessionSender();
  t.cleanup();
  for (const dir of spaceDirs) rmSync(dir, { recursive: true, force: true });
  rmSync(storageRoot, { recursive: true, force: true });
});

async function createWorkspace(name: string): Promise<string> {
  const path = mkdtempSync(join(tmpdir(), 'agentboard-image-space-'));
  spaceDirs.push(path);
  const response = await request(app).post('/api/workspaces').send({ name, path });
  expect(response.status).toBe(200);
  return response.body.id as string;
}

async function createIssue(workspaceId: string, title = 'image issue'): Promise<string> {
  const response = await request(app).post('/api/issues').send({ workspace_id: workspaceId, title });
  expect(response.status).toBe(200);
  return response.body.id as string;
}

async function uploadImage(workspaceId: string, bytes = PNG): Promise<StagedAttachmentResponse> {
  const response = await request(app)
    .post(`/api/workspaces/${workspaceId}/attachments`)
    .set('Content-Type', 'image/png')
    .set('X-File-Name', 'screen.png')
    .send(bytes);
  expect(response.status).toBe(201);
  return response.body as StagedAttachmentResponse;
}

describe('comment image attachment API', () => {
  it('uploads a raw image to private staged storage and serves it only within its workspace', async () => {
    const workspaceId = await createWorkspace('image-test');
    const uploaded = await request(app)
      .post(`/api/workspaces/${workspaceId}/attachments`)
      .set('Content-Type', 'image/png')
      .set('X-File-Name', 'C:\\Users\\private\\screen.png')
      .send(PNG);

    expect(uploaded.status).toBe(201);
    expect(uploaded.body).toMatchObject({
      workspace_id: workspaceId,
      file_name: 'screen.png',
      mime_type: 'image/png',
      size_bytes: PNG.length,
      status: 'staged',
    });
    expect(uploaded.body.storage_key).toBeUndefined();
    expect(uploaded.body.path).toBeUndefined();

    const stagedDownload = await request(app).get(`/api/workspaces/${workspaceId}/attachments/${uploaded.body.id}`);
    expect(stagedDownload.status).toBe(200);
    expect(stagedDownload.headers['content-type']).toMatch(/image\/png/);
    expect(Buffer.from(stagedDownload.body)).toEqual(PNG);

    const wrongWorkspace = await request(app)
      .get(`/api/workspaces/not-${workspaceId}/attachments/${uploaded.body.id}`);
    expect(wrongWorkspace.status).toBe(404);
  });

  it('rejects a declared image MIME type when file magic does not match', async () => {
    const workspaceId = await createWorkspace('bad-image');
    const response = await request(app)
      .post(`/api/workspaces/${workspaceId}/attachments`)
      .set('Content-Type', 'image/png')
      .set('X-File-Name', 'fake.png')
      .send(Buffer.from('not a PNG'));

    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe('ATTACHMENT_INVALID_IMAGE');
  });

  it('rejects uploads larger than 10 MiB before writing storage', async () => {
    const workspaceId = await createWorkspace('too-large');
    const bytes = Buffer.alloc(10 * 1024 * 1024 + 1);
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(bytes);
    const response = await request(app)
      .post(`/api/workspaces/${workspaceId}/attachments`)
      .set('Content-Type', 'image/png')
      .send(bytes);
    expect(response.status).toBe(413);
    expect(response.body.error.code).toBe('ATTACHMENT_TOO_LARGE');
    expect(readdirSync(storageDir)).toHaveLength(0);
  }, 30000);

  it('attaches staged image in the comment transaction, replays idempotently, and returns metadata in reads', async () => {
    const workspaceId = await createWorkspace('image-comment');
    const issueId = await createIssue(workspaceId);
    const staged = await uploadImage(workspaceId);
    const body = { workspace_id: workspaceId, content: '', attachment_ids: [staged.id] };

    const first = await request(app)
      .post(`/api/issues/${issueId}/comments`)
      .set('Idempotency-Key', '22222222-2222-4222-8222-222222222222')
      .send(body);
    expect(first.status).toBe(200);
    expect(first.body.comment.content).toBe('');
    expect(first.body.comment.attachments).toHaveLength(1);
    expect(first.body.warning).toBe('IMAGE_DELIVERY_UNVERIFIED');
    expect(first.body.comment.attachments[0]).toMatchObject({
      id: staged.id,
      file_name: 'screen.png',
      mime_type: 'image/png',
      size_bytes: PNG.length,
      url: `/api/issues/${issueId}/attachments/${staged.id}`,
    });

    const replay = await request(app)
      .post(`/api/issues/${issueId}/comments`)
      .set('Idempotency-Key', '22222222-2222-4222-8222-222222222222')
      .send(body);
    expect(replay.body.comment.id).toBe(first.body.comment.id);
    expect(replay.body.warning).toBe('IMAGE_DELIVERY_UNVERIFIED');
    expect(t.db.prepare('SELECT COUNT(*) AS count FROM comment_attachment').get()).toMatchObject({ count: 1 });
    expect(t.db.prepare('SELECT effect_pending FROM idempotency_record WHERE request_id=?').get('22222222-2222-4222-8222-222222222222')).toMatchObject({ effect_pending: 0 });
    expect((await request(app).get(`/api/issues/${issueId}/comments`)).body[0].attachments).toHaveLength(1);
    expect((await request(app).get(`/api/issues/${issueId}/comments?limit=10`)).body.items[0].attachments).toHaveLength(1);
    expect((await request(app).get(`/api/issues/${issueId}/comments/${first.body.comment.id}`)).body.attachments).toHaveLength(1);
    const consumed = await request(app).post(`/api/issues/${issueId}/comments/consume`);
    expect(consumed.body.comments[0].attachments).toHaveLength(1);
    expect(consumed.body.new_comment_ids).toEqual([]); // no verified image delivery: leave the unread cursor before it
    await request(app).post(`/api/issues/${issueId}/comments`).send({ workspace_id: workspaceId, content: 'later text' });
    expect((await request(app).post(`/api/issues/${issueId}/comments/consume`)).body.new_comment_ids).toEqual([]);

    const attached = await request(app).get(`/api/issues/${issueId}/attachments/${staged.id}`);
    expect(attached.status).toBe(200);
    expect(attached.headers['content-type']).toMatch(/image\/png/);
    const secondWorkspaceId = await createWorkspace('other-workspace');
    const secondIssueId = await createIssue(secondWorkspaceId, 'other issue');
    expect((await request(app).get(`/api/issues/${secondIssueId}/attachments/${staged.id}`)).status).toBe(404);
  });

  it('rejects cross-workspace and already bound staged attachments without partially inserting a comment', async () => {
    const workspaceId = await createWorkspace('owner');
    const otherWorkspaceId = await createWorkspace('other');
    const issueId = await createIssue(workspaceId);
    const otherIssueId = await createIssue(otherWorkspaceId, 'other issue');
    const staged = await uploadImage(workspaceId);
    const crossWorkspace = await request(app)
      .post(`/api/issues/${otherIssueId}/comments`)
      .send({ workspace_id: otherWorkspaceId, content: '', attachment_ids: [staged.id] });
    expect(crossWorkspace.status).toBe(404);

    const first = await request(app)
      .post(`/api/issues/${issueId}/comments`)
      .send({ workspace_id: workspaceId, content: '', attachment_ids: [staged.id] });
    expect(first.status).toBe(200);
    const duplicate = await request(app)
      .post(`/api/issues/${issueId}/comments`)
      .send({ workspace_id: workspaceId, content: 'again', attachment_ids: [staged.id] });
    expect(duplicate.status).toBe(409);
    expect(duplicate.body.error.code).toBe('ATTACHMENT_ALREADY_BOUND');
    expect(t.db.prepare('SELECT COUNT(*) AS count FROM issue_comment').get()).toMatchObject({ count: 1 });
  });

  it('rejects expired staging and prevents a text-only wake for image comments on an active session', async () => {
    const workspaceId = await createWorkspace('image-active');
    const issueId = await createIssue(workspaceId);
    const expired = await uploadImage(workspaceId);
    t.db.prepare('UPDATE attachment SET expires_at=? WHERE id=?').run(Date.now() - 1, expired.id);
    const expiredComment = await request(app)
      .post(`/api/issues/${issueId}/comments`)
      .send({ workspace_id: workspaceId, content: '', attachment_ids: [expired.id] });
    expect(expiredComment.status).toBe(410);
    expect(expiredComment.body.error.code).toBe('ATTACHMENT_EXPIRED');
    await attachmentStore.processCleanup();
    expect(t.db.prepare('SELECT COUNT(*) AS count FROM attachment').get()).toMatchObject({ count: 0 });
    expect(t.db.prepare('SELECT COUNT(*) AS count FROM attachment_cleanup').get()).toMatchObject({ count: 0 });
    expect(readdirSync(storageDir)).toHaveLength(0);

    const staged = await uploadImage(workspaceId);
    t.db.prepare("UPDATE issue SET claimed_by='agent:codex',session_id='session-active' WHERE id=?").run(issueId);
    const wakes: Array<{ sessionId: string; text: string }> = [];
    setSessionSender(async (sessionId, text) => { wakes.push({ sessionId, text }); return {}; });
    const attached = await request(app)
      .post(`/api/issues/${issueId}/comments`)
      .set('Idempotency-Key', '33333333-3333-4333-8333-333333333333')
      .send({ workspace_id: workspaceId, content: 'caption', attachment_ids: [staged.id] });
    expect(attached.body).toMatchObject({ woke: false, warning: 'IMAGE_DELIVERY_UNVERIFIED' });
    expect(wakes).toEqual([]);
  });

  it('keeps an image comment unread across a later claim and subsequent text comments', async () => {
    const workspaceId = await createWorkspace('claim-image-cursor');
    const issueId = await createIssue(workspaceId);
    const staged = await uploadImage(workspaceId);
    const imageComment = await request(app)
      .post(`/api/issues/${issueId}/comments`)
      .send({ workspace_id: workspaceId, content: '', attachment_ids: [staged.id] });
    expect(imageComment.status).toBe(200);

    expect((await request(app).post(`/api/issues/${issueId}/claim`).send({ agent_id: 'agent:codex' })).status).toBe(200);
    await request(app).post(`/api/issues/${issueId}/comments`).send({ workspace_id: workspaceId, content: 'later text' });
    const consumed = await request(app).post(`/api/issues/${issueId}/comments/consume`);
    expect(consumed.body.new_comment_ids).toEqual([]);
    expect(consumed.body.comments.find((comment: { id: string }) => comment.id === imageComment.body.comment.id).attachments).toHaveLength(1);
  });

  it('does not unlink a queued cleanup file while the attachment remains referenced in the database', async () => {
    const workspaceId = await createWorkspace('cleanup-reference');
    const staged = await uploadImage(workspaceId);
    const storageKey = (t.db.prepare('SELECT storage_key FROM attachment WHERE id=?').get(staged.id) as { storage_key: string }).storage_key;
    t.db.prepare('INSERT INTO attachment_cleanup(storage_key,size_bytes,queued_at) VALUES (?,?,?)').run(storageKey, PNG.length, Date.now());

    await attachmentStore.processCleanup();
    expect(t.db.prepare('SELECT COUNT(*) AS count FROM attachment WHERE id=?').get(staged.id)).toMatchObject({ count: 1 });
    expect(t.db.prepare('SELECT COUNT(*) AS count FROM attachment_cleanup WHERE storage_key=?').get(storageKey)).toMatchObject({ count: 1 });
    expect(readdirSync(storageDir)).toHaveLength(1);
  });

  it('recovers abandoned upload reservations and retries a failed file cleanup', async () => {
    const orphanKey = randomUUID();
    writeFileSync(join(storageDir, orphanKey), PNG);
    t.db.prepare('INSERT INTO attachment_upload_reservation(storage_key,size_bytes,created_at) VALUES (?,?,?)')
      .run(orphanKey, PNG.length, Date.now() - 2 * 60 * 60 * 1000);
    await attachmentStore.processCleanup();
    expect(t.db.prepare('SELECT COUNT(*) AS count FROM attachment_upload_reservation').get()).toMatchObject({ count: 0 });
    expect(readdirSync(storageDir)).toHaveLength(0);

    const blockedKey = randomUUID();
    mkdirSync(join(storageDir, blockedKey));
    t.db.prepare('INSERT INTO attachment_cleanup(storage_key,size_bytes,queued_at) VALUES (?,?,?)')
      .run(blockedKey, PNG.length, Date.now());
    await attachmentStore.processCleanup();
    expect(t.db.prepare('SELECT COUNT(*) AS count FROM attachment_cleanup WHERE storage_key=?').get(blockedKey)).toMatchObject({ count: 1 });

    rmdirSync(join(storageDir, blockedKey));
    await attachmentStore.processCleanup();
    expect(t.db.prepare('SELECT COUNT(*) AS count FROM attachment_cleanup WHERE storage_key=?').get(blockedKey)).toMatchObject({ count: 0 });
  });

  it('preserves files on comment transaction rollback and deletes them only after issue deletion commits', async () => {
    const workspaceId = await createWorkspace('rollback');
    const issueId = await createIssue(workspaceId);
    const staged = await uploadImage(workspaceId);
    t.db.exec(`CREATE TRIGGER reject_comment_attachment BEFORE INSERT ON comment_attachment
      BEGIN SELECT RAISE(ABORT, 'test rollback'); END;`);
    const failed = await request(app)
      .post(`/api/issues/${issueId}/comments`)
      .send({ workspace_id: workspaceId, content: '', attachment_ids: [staged.id] });
    expect(failed.status).toBe(500);
    expect(t.db.prepare('SELECT COUNT(*) AS count FROM issue_comment').get()).toMatchObject({ count: 0 });
    expect(t.db.prepare('SELECT status FROM attachment WHERE id=?').get(staged.id)).toMatchObject({ status: 'staged' });
    expect(readdirSync(storageDir)).toHaveLength(1);

    t.db.exec('DROP TRIGGER reject_comment_attachment');
    const attached = await request(app)
      .post(`/api/issues/${issueId}/comments`)
      .send({ workspace_id: workspaceId, content: '', attachment_ids: [staged.id] });
    expect(attached.status).toBe(200);
    t.db.exec("CREATE TRIGGER reject_issue_delete BEFORE DELETE ON issue BEGIN SELECT RAISE(ABORT, 'delete rollback'); END;");
    expect((await request(app).delete(`/api/issues/${issueId}`)).status).toBe(500);
    expect(readdirSync(storageDir)).toHaveLength(1);
    expect(t.db.prepare('SELECT COUNT(*) AS count FROM attachment_cleanup').get()).toMatchObject({ count: 0 });
    t.db.exec('DROP TRIGGER reject_issue_delete');
    const deleted = await request(app).delete(`/api/issues/${issueId}`);
    expect(deleted.status).toBe(204);
    expect(readdirSync(storageDir)).toHaveLength(0);
    expect(t.db.prepare('SELECT COUNT(*) AS count FROM attachment_cleanup').get()).toMatchObject({ count: 0 });
  });

  it('queues attachment cleanup when its workspace is deleted', async () => {
    const workspaceId = await createWorkspace('workspace-cleanup');
    const issueId = await createIssue(workspaceId);
    const staged = await uploadImage(workspaceId);
    const attached = await request(app)
      .post(`/api/issues/${issueId}/comments`)
      .send({ workspace_id: workspaceId, content: '', attachment_ids: [staged.id] });
    expect(attached.status).toBe(200);

    expect((await request(app).delete(`/api/workspaces/${workspaceId}`)).status).toBe(204);
    expect(readdirSync(storageDir)).toHaveLength(0);
    expect(t.db.prepare('SELECT COUNT(*) AS count FROM attachment_cleanup').get()).toMatchObject({ count: 0 });
  });

  it('reserves quota atomically across concurrent uploads and releases it only after cleanup', async () => {
    const workspaceId = await createWorkspace('quota');
    const issueId = await createIssue(workspaceId);
    const created = await createApp({
      db: t.db,
      refreshClisOnBoot: false,
      attachmentStorageDir: storageDir,
      attachmentQuotaBytes: PNG.length,
    });
    app = created.app;
    const upload = () => request(app)
      .post(`/api/workspaces/${workspaceId}/attachments`)
      .set('Content-Type', 'image/png')
      .send(PNG);
    const [first, second] = await Promise.all([upload(), upload()]);
    expect([first.status, second.status].sort()).toEqual([201, 413]);
    expect(t.db.prepare('SELECT COUNT(*) AS count FROM attachment').get()).toMatchObject({ count: 1 });
    expect(t.db.prepare('SELECT COUNT(*) AS count FROM attachment_upload_reservation').get()).toMatchObject({ count: 0 });

    const uploaded = first.status === 201 ? first.body as StagedAttachmentResponse : second.body as StagedAttachmentResponse;
    const attached = await request(app)
      .post(`/api/issues/${issueId}/comments`)
      .send({ workspace_id: workspaceId, content: '', attachment_ids: [uploaded.id] });
    expect(attached.status).toBe(200);
    expect((await request(app).delete(`/api/issues/${issueId}`)).status).toBe(204);
    expect(readdirSync(storageDir)).toHaveLength(0);
    expect((await upload()).status).toBe(201);
  });
});
