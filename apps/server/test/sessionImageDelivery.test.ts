/**
 * CHAT-IMG-DELIVERY-A：聊天发消息携带附件的会话级投递（session_attachment）。
 * 覆盖：绑定与投递状态推进（delivered/unknown）、纯文本不受影响、错误分支
 * （不存在/跨工作区/重复/超5/同空/已绑定/过期/CLI 不支持）、attached 后 workspace URL 仍可读。
 */
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import request from 'supertest';
import type { Express } from 'express';
import type { AgentAdapter } from '@agentboard/adapters';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestDb, type TestDb } from './helpers.js';
import { FakeAdapter, settle } from './fakeAdapter.js';
import { createApp, type CreatedApp } from '../src/index.js';

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00]);
/** FakeAdapter 图片输入白名单：model=minimax-m3.1-flash + cliVersion=2.179.2 */
const IMAGE_MODEL = 'minimax-m3.1-flash';

let t: TestDb;
let adapter: FakeAdapter;
let created: CreatedApp;
let app: Express;
let spaceDirs: string[];
let storageRoot: string;

beforeEach(async () => {
  t = createTestDb();
  adapter = new FakeAdapter();
  adapter.detectedVersion = '2.179.2';
  spaceDirs = [];
  storageRoot = mkdtempSync(join(tmpdir(), 'agentboard-session-img-'));
  const storageDir = join(storageRoot, '.superpowers', 'attachments');
  mkdirSync(storageDir, { recursive: true });
  const fakeResolver = (id: string): AgentAdapter => {
    if (id === 'fake' || id === 'codebuddy') return adapter;
    throw new Error(`未知适配器 id: ${id}`);
  };
  created = await createApp({
    db: t.db,
    getAdapter: fakeResolver,
    adapters: [adapter],
    maxConcurrentTurns: 3,
    attachmentStorageDir: storageDir,
  });
  app = created.app;
});

afterEach(() => {
  t.cleanup();
  for (const dir of spaceDirs) rmSync(dir, { recursive: true, force: true });
  rmSync(storageRoot, { recursive: true, force: true });
});

async function mkWorkspace(name = 'ws'): Promise<string> {
  const path = mkdtempSync(join(tmpdir(), 'agentboard-session-img-space-'));
  spaceDirs.push(path);
  const res = await request(app).post('/api/workspaces').send({ name, path });
  expect(res.status).toBe(200);
  return res.body.id as string;
}

async function uploadImage(workspaceId: string): Promise<string> {
  const res = await request(app)
    .post(`/api/workspaces/${workspaceId}/attachments`)
    .set('Content-Type', 'image/png')
    .set('X-File-Name', 'shot.png')
    .send(PNG);
  expect(res.status).toBe(201);
  return res.body.id as string;
}

/** 建自由聊天会话（issue_id=NULL）；model 传 null 时 CLI 不支持图片输入 */
async function mkChatSession(workspaceId: string, model: string | null = IMAGE_MODEL): Promise<string> {
  const res = await request(app).post('/api/sessions').send({ cli: 'codebuddy', workspace_id: workspaceId, model });
  expect(res.status).toBe(200);
  return res.body.id as string;
}

interface SessionAttachmentRow {
  delivery_state: 'pending' | 'sending' | 'unknown' | 'delivered';
  delivered_at: number | null;
}

function sessionAttachmentRow(attachmentId: string): SessionAttachmentRow | undefined {
  return t.db.prepare('SELECT delivery_state,delivered_at FROM session_attachment WHERE attachment_id=?')
    .get(attachmentId) as SessionAttachmentRow | undefined;
}

describe('聊天发消息携带附件（会话级投递）', () => {
  it('绑定 session_attachment 并以图片字节投递：runTurn 收到 attachments，状态推进 delivered，workspace URL 仍可读', async () => {
    const wsId = await mkWorkspace();
    const sessionId = await mkChatSession(wsId);
    const attachmentId = await uploadImage(wsId);

    const send = await request(app)
      .post(`/api/sessions/${sessionId}/messages`)
      .send({ text: '看图', attachment_ids: [attachmentId] });
    expect(send.status).toBe(200);
    expect(send.body).toEqual({ queued: false });
    await settle();

    // adapter 收到图片字节投递（既有 RunTurnOptions.attachments 通道复用）
    expect(adapter.calls).toHaveLength(1);
    const turn = adapter.calls[0]!;
    expect(turn.attachments).toHaveLength(1);
    expect(turn.attachments![0]!.mimeType).toBe('image/png');
    expect(turn.attachments![0]!.path).toContain(join(storageRoot, '.superpowers', 'attachments'));

    // 投递状态：staged → attached + session_attachment delivery_state=delivered
    expect(sessionAttachmentRow(attachmentId)).toMatchObject({ delivery_state: 'delivered', delivered_at: expect.any(Number) });
    const status = t.db.prepare('SELECT status FROM attachment WHERE id=?').get(attachmentId) as { status: string };
    expect(status.status).toBe('attached');

    // 消息气泡里的 markdown URL 绑定后仍可读（attached 不再 404）
    const download = await request(app).get(`/api/workspaces/${wsId}/attachments/${attachmentId}`);
    expect(download.status).toBe(200);
  });

  it('多图顺序稳定：attachment_ids 顺序即投递顺序', async () => {
    const wsId = await mkWorkspace();
    const sessionId = await mkChatSession(wsId);
    const first = await uploadImage(wsId);
    const second = await uploadImage(wsId);

    const send = await request(app)
      .post(`/api/sessions/${sessionId}/messages`)
      .send({ text: '两张', attachment_ids: [second, first] });
    expect(send.status).toBe(200);
    await settle();

    expect(adapter.calls[0]!.attachments!.map((item) => item.path)).toEqual([
      turn0Path(second),
      turn0Path(first),
    ]);
    function turn0Path(id: string): string {
      const row = t.db.prepare('SELECT storage_key FROM attachment WHERE id=?').get(id) as { storage_key: string };
      return join(storageRoot, '.superpowers', 'attachments', row.storage_key);
    }
  });

  it('runTurn 非零退出 → delivery_state=unknown', async () => {
    adapter.script = (control) => {
      control.emit({ type: 'text', delta: '失败回复' });
      control.finish(1);
    };
    const wsId = await mkWorkspace();
    const sessionId = await mkChatSession(wsId);
    const attachmentId = await uploadImage(wsId);

    const send = await request(app)
      .post(`/api/sessions/${sessionId}/messages`)
      .send({ text: '会失败的', attachment_ids: [attachmentId] });
    expect(send.status).toBe(200);
    await settle();

    expect(sessionAttachmentRow(attachmentId)).toMatchObject({ delivery_state: 'unknown', delivered_at: null });
  });

  it('只发图不写字 → 允许（文字与图片至少一项非空）', async () => {
    const wsId = await mkWorkspace();
    const sessionId = await mkChatSession(wsId);
    const attachmentId = await uploadImage(wsId);

    const send = await request(app)
      .post(`/api/sessions/${sessionId}/messages`)
      .send({ attachment_ids: [attachmentId] });
    expect(send.status).toBe(200);
    await settle();
    expect(adapter.calls[0]!.attachments).toHaveLength(1);
    expect(sessionAttachmentRow(attachmentId)?.delivery_state).toBe('delivered');
  });

  it('纯文本消息不带 attachment_ids：行为不变', async () => {
    const wsId = await mkWorkspace();
    const sessionId = await mkChatSession(wsId);

    const send = await request(app)
      .post(`/api/sessions/${sessionId}/messages`)
      .send({ text: '纯文本' });
    expect(send.status).toBe(200);
    await settle();
    expect(adapter.calls[0]!.attachments ?? []).toHaveLength(0);
    expect(t.db.prepare('SELECT COUNT(*) AS n FROM session_attachment').get()).toEqual({ n: 0 });
  });

  it('附件不存在或跨工作区 → 404 图片不存在', async () => {
    const wsA = await mkWorkspace('a');
    const wsB = await mkWorkspace('b');
    const sessionId = await mkChatSession(wsA);
    const foreign = await uploadImage(wsB);

    const missing = await request(app)
      .post(`/api/sessions/${sessionId}/messages`)
      .send({ text: 'x', attachment_ids: ['0d0f8f31-9b0e-4a1a-8d1a-6f0c3a2b1c11'] });
    expect(missing.status).toBe(404);

    const cross = await request(app)
      .post(`/api/sessions/${sessionId}/messages`)
      .send({ text: 'x', attachment_ids: [foreign] });
    expect(cross.status).toBe(404);
  });

  it('重复 id / 超过 5 张 / 文字与图片同时为空 → 400', async () => {
    const wsId = await mkWorkspace();
    const sessionId = await mkChatSession(wsId);
    const attachmentId = await uploadImage(wsId);

    const dup = await request(app)
      .post(`/api/sessions/${sessionId}/messages`)
      .send({ text: 'x', attachment_ids: [attachmentId, attachmentId] });
    expect(dup.status).toBe(400);

    const ids = [await uploadImage(wsId), await uploadImage(wsId), await uploadImage(wsId), await uploadImage(wsId), await uploadImage(wsId), await uploadImage(wsId)];
    const tooMany = await request(app)
      .post(`/api/sessions/${sessionId}/messages`)
      .send({ text: 'x', attachment_ids: ids });
    expect(tooMany.status).toBe(400);

    const empty = await request(app)
      .post(`/api/sessions/${sessionId}/messages`)
      .send({ text: '' });
    expect(empty.status).toBe(400);
  });

  it('已绑定的附件再次发送 → 409 图片已关联', async () => {
    const wsId = await mkWorkspace();
    const sessionId = await mkChatSession(wsId);
    const attachmentId = await uploadImage(wsId);

    const first = await request(app)
      .post(`/api/sessions/${sessionId}/messages`)
      .send({ text: '第一次', attachment_ids: [attachmentId] });
    expect(first.status).toBe(200);
    await settle();

    const second = await request(app)
      .post(`/api/sessions/${sessionId}/messages`)
      .send({ text: '第二次', attachment_ids: [attachmentId] });
    expect(second.status).toBe(409);
  });

  it('staged 过期 → 410 请重新上传', async () => {
    const wsId = await mkWorkspace();
    const sessionId = await mkChatSession(wsId);
    const attachmentId = await uploadImage(wsId);
    t.db.prepare('UPDATE attachment SET expires_at=1 WHERE id=?').run(attachmentId);

    const send = await request(app)
      .post(`/api/sessions/${sessionId}/messages`)
      .send({ text: '过期图', attachment_ids: [attachmentId] });
    expect(send.status).toBe(410);
  });

  it('CLI/model 不支持图片输入 → 400 IMAGE_DELIVERY_UNVERIFIED 且附件保持 staged（可换模型重发）', async () => {
    const wsId = await mkWorkspace();
    const sessionId = await mkChatSession(wsId, null); // model=null → FakeAdapter 不支持图片
    const attachmentId = await uploadImage(wsId);

    const send = await request(app)
      .post(`/api/sessions/${sessionId}/messages`)
      .send({ text: '不支持图片的组合', attachment_ids: [attachmentId] });
    expect(send.status).toBe(400);
    expect(send.body.error.message).toContain('IMAGE_DELIVERY_UNVERIFIED');

    const status = t.db.prepare('SELECT status FROM attachment WHERE id=?').get(attachmentId) as { status: string };
    expect(status.status).toBe('staged');
    expect(sessionAttachmentRow(attachmentId)).toBeUndefined();
  });
});
