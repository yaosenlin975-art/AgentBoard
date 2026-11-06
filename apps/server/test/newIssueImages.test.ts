/**
 * NEW-ISSUE-IMAGE｜新建任务附图：
 * - `POST /api/issues` 接受 `attachment_ids`（≤5），在创建事务内绑定到该任务的附件评论；
 * - 非法/重绑/过期附件整体回滚：任务不创建、附件仍 staged、不产生孤儿关联；
 * - 幂等重放只建一个任务与一组绑定；无 attachment_ids 时行为与既有完全一致（不产生评论）。
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import type { AgentAdapter } from '@agentboard/adapters';
import { createTestDb, type TestDb, issuePayload } from './helpers.js';
import { FakeAdapter } from './fakeAdapter.js';
import { createApp, type CreatedApp } from '../src/index.js';
import { resetSessionManager } from '../src/services/sessionManager.js';
import { getWorkspace } from '../src/db/repos/workspace.js';

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00]);
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00]);

let t: TestDb;
let adapter: FakeAdapter;
let created: CreatedApp;
let app: Express;
let spaceDir: string;
let spaceDirB: string;

function fakeResolver(id: string): AgentAdapter {
  if (id === 'fake') return adapter;
  throw new Error(`未知适配器 id: ${id}`);
}

beforeEach(async () => {
  t = createTestDb();
  adapter = new FakeAdapter();
  spaceDir = mkdtempSync(join(tmpdir(), 'agentboard-newissue-'));
  spaceDirB = mkdtempSync(join(tmpdir(), 'agentboard-newissue-b-'));
  created = await createApp({ db: t.db, getAdapter: fakeResolver, adapters: [adapter], maxConcurrentTurns: 3 });
  app = created.app;
  let clock = 1_000_000;
  vi.spyOn(Date, 'now').mockImplementation(() => ++clock);
});

afterEach(() => {
  vi.restoreAllMocks();
  resetSessionManager();
  t.cleanup();
  rmSync(spaceDir, { recursive: true, force: true });
  rmSync(spaceDirB, { recursive: true, force: true });
});

async function mkSpace(name: string, dir = spaceDir): Promise<string> {
  const res = await request(app).post('/api/workspaces').send({ name, path: dir });
  expect(res.status).toBe(200);
  return res.body.id as string;
}

async function uploadStaged(workspaceId: string, bytes = PNG, name = 'shot.png', mime = 'image/png'): Promise<string> {
  const res = await request(app)
    .post(`/api/workspaces/${workspaceId}/attachments`)
    .set('Content-Type', mime)
    .set('X-File-Name', name)
    .send(bytes);
  expect(res.status).toBe(201);
  return res.body.id as string;
}

const attachmentRow = (id: string) =>
  t.db.prepare('SELECT status,workspace_id FROM attachment WHERE id=?').get(id) as { status: string; workspace_id: string } | undefined;
const bindingCount = (issueId: string) =>
  (t.db
    .prepare('SELECT COUNT(*) AS n FROM comment_attachment ca JOIN issue_comment c ON c.id=ca.comment_id WHERE c.issue_id=?')
    .get(issueId) as { n: number }).n;
const commentCount = (issueId: string) =>
  (t.db.prepare('SELECT COUNT(*) AS n FROM issue_comment WHERE issue_id=?').get(issueId) as { n: number }).n;

describe('POST /api/issues 附图', () => {
  it('标题+描述+两张图：创建成功，附件在该任务下可私有下载，且不再 staged', async () => {
    const ws = await mkSpace('附图空间');
    const first = await uploadStaged(ws);
    const second = await uploadStaged(ws, JPEG, 'jpeg-shot.png', 'image/jpeg');

    const created = await request(app)
      .post('/api/issues')
      .send({ workspace_id: ws, title: '带图任务', description: '描述内容', attachment_ids: [first, second] });
    expect(created.status).toBe(200);
    expect(created.body).toMatchObject({ workspace_id: ws, title: '带图任务', comment_count: 1 });

    expect(bindingCount(created.body.id)).toBe(2);
    expect(attachmentRow(first)).toMatchObject({ status: 'attached', workspace_id: ws });
    expect(attachmentRow(second)).toMatchObject({ status: 'attached', workspace_id: ws });

    const download = await request(app).get(`/api/issues/${created.body.id}/attachments/${first}`);
    expect(download.status).toBe(200);
    expect(download.headers['content-type']).toMatch(/image\/png/);
    expect(Buffer.from(download.body)).toEqual(PNG);
  });

  it('仅图片任务：标题必填、描述可空，仍创建成功', async () => {
    const ws = await mkSpace('仅图片空间');
    const staged = await uploadStaged(ws);

    const missingTitle = await request(app).post('/api/issues').send(issuePayload(ws, { title: '', attachment_ids: [staged] }));
    expect(missingTitle.status).toBe(400);
    expect(missingTitle.body.error.code).toBe('VALIDATION_ERROR');

    const created = await request(app).post('/api/issues').send(issuePayload(ws, { title: '只有图片', attachment_ids: [staged] }));
    expect(created.status).toBe(200);
    expect(created.body.description).toBe('');
    expect(bindingCount(created.body.id)).toBe(1);
  });

  it('无 attachment_ids：行为不变，不产生评论', async () => {
    const ws = await mkSpace('无图空间');
    const created = await request(app).post('/api/issues').send({ workspace_id: ws, title: '纯文本任务', description: 'd' });
    expect(created.status).toBe(200);
    expect(created.body.comment_count).toBe(0);
    expect(commentCount(created.body.id)).toBe(0);
  });

  it('跨 workspace 附件：404 且任务与绑定都不落库', async () => {
    const wsA = await mkSpace('A 空间');
    const wsB = await mkSpace('B 空间', spaceDirB);
    const foreign = await uploadStaged(wsA);

    const res = await request(app).post('/api/issues').send(issuePayload(wsB, { title: '跨空间', attachment_ids: [foreign] }));
    expect(res.status).toBe(404);
    expect(t.db.prepare("SELECT COUNT(*) AS n FROM issue WHERE workspace_id=?").get(wsB)).toEqual({ n: 0 });
    expect(attachmentRow(foreign)).toMatchObject({ status: 'staged', workspace_id: wsA });
    expect(t.db.prepare('SELECT COUNT(*) AS n FROM comment_attachment').get()).toEqual({ n: 0 });
  });

  it('重复绑定已 attached 的附件：409 且新任务不创建', async () => {
    const ws = await mkSpace('重绑空间');
    const staged = await uploadStaged(ws);
    const firstIssue = await request(app).post('/api/issues').send(issuePayload(ws, { title: '先占用', attachment_ids: [staged] }));
    expect(firstIssue.status).toBe(200);

    const second = await request(app).post('/api/issues').send(issuePayload(ws, { title: '再次占用', attachment_ids: [staged] }));
    expect(second.status).toBe(409);
    expect(second.body.error.code).toBe('ATTACHMENT_ALREADY_BOUND');
    expect(t.db.prepare('SELECT COUNT(*) AS n FROM issue WHERE workspace_id=?').get(ws)).toEqual({ n: 1 });
    expect(bindingCount(firstIssue.body.id)).toBe(1);
  });

  it('过期 staged 附件：410 且任务不创建', async () => {
    const ws = await mkSpace('过期空间');
    const staged = await uploadStaged(ws);
    t.db.prepare('UPDATE attachment SET expires_at = 1 WHERE id=?').run(staged);

    const res = await request(app).post('/api/issues').send(issuePayload(ws, { title: '过期图', attachment_ids: [staged] }));
    expect(res.status).toBe(410);
    expect(res.body.error.code).toBe('ATTACHMENT_EXPIRED');
    expect(t.db.prepare('SELECT COUNT(*) AS n FROM issue WHERE workspace_id=?').get(ws)).toEqual({ n: 0 });
  });

  it('attachment_ids 超过 5 张或重复：400', async () => {
    const ws = await mkSpace('校验空间');
    const staged = await uploadStaged(ws);
    const many = await Promise.all([0, 1, 2, 3, 4].map((i) => uploadStaged(ws, PNG, `shot-${i}.png`)));

    expect((await request(app).post('/api/issues').send(issuePayload(ws, { title: '超量', attachment_ids: [...many, staged] }))).status).toBe(400);
    expect((await request(app).post('/api/issues').send(issuePayload(ws, { title: '重复', attachment_ids: [staged, staged] }))).status).toBe(400);
  });

  it('幂等重放：同 Idempotency-Key 只建一个任务、一组绑定', async () => {
    const ws = await mkSpace('幂等空间');
    const staged = await uploadStaged(ws);
    const key = '00000000-0000-4000-8000-0000000000aa';
    const payload = issuePayload(ws, { title: '幂等带图', attachment_ids: [staged] });

    const first = await request(app).post('/api/issues').set('Idempotency-Key', key).send(payload);
    const replay = await request(app).post('/api/issues').set('Idempotency-Key', key).send(payload);
    expect(first.status).toBe(200);
    expect(replay.status).toBe(200);
    expect(replay.body.id).toBe(first.body.id);
    expect(t.db.prepare('SELECT COUNT(*) AS n FROM issue WHERE workspace_id=?').get(ws)).toEqual({ n: 1 });
    expect(bindingCount(first.body.id)).toBe(1);
  });

  it('workspace 不存在：404 且不创建', async () => {
    const res = await request(app).post('/api/issues').send(issuePayload('nope', { title: '幽灵空间' }));
    expect(res.status).toBe(404);
    expect(getWorkspace(t.db, 'nope')).toBeNull();
  });
});
