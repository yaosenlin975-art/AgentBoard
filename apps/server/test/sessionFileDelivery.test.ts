/**
 * CHAT-ATTACH-ANY（卡 D）：聊天携带非图片附件的服务端投递。
 * 覆盖：文件不进 image 通道（无需 CLI 图片能力）、路径/元数据拼进 prompt、
 * 混合附件只把图片放进 attachments、投递状态推进 delivered、下载强制 attachment 且不越出存储根。
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
const PDF = Buffer.alloc(2048, 0x25);
const IMAGE_MODEL = 'minimax-m3.1-flash';

let t: TestDb;
let adapter: FakeAdapter;
let app: Express;
let spaceDirs: string[];
let storageRoot: string;
let storageDir: string;

beforeEach(async () => {
  t = createTestDb();
  adapter = new FakeAdapter();
  adapter.detectedVersion = '2.179.2';
  spaceDirs = [];
  storageRoot = mkdtempSync(join(tmpdir(), 'agentboard-session-file-'));
  storageDir = join(storageRoot, '.superpowers', 'attachments');
  mkdirSync(storageDir, { recursive: true });
  const fakeResolver = (id: string): AgentAdapter => {
    if (id === 'fake' || id === 'codebuddy') return adapter;
    throw new Error(`未知适配器 id: ${id}`);
  };
  const created: CreatedApp = await createApp({
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

async function mkWorkspace(): Promise<string> {
  const path = mkdtempSync(join(tmpdir(), 'agentboard-session-file-space-'));
  spaceDirs.push(path);
  const res = await request(app).post('/api/workspaces').send({ name: 'ws', path });
  expect(res.status).toBe(200);
  return res.body.id as string;
}

async function upload(workspaceId: string, mime: string, name: string, bytes: Buffer): Promise<string> {
  const res = await request(app)
    .post(`/api/workspaces/${workspaceId}/attachments`)
    .set('Content-Type', mime)
    .set('X-File-Name', name)
    .send(bytes);
  expect(res.status).toBe(201);
  return res.body.id as string;
}

async function mkChatSession(workspaceId: string, model: string | null): Promise<string> {
  const res = await request(app).post('/api/sessions').send({ cli: 'codebuddy', workspace_id: workspaceId, model });
  expect(res.status).toBe(200);
  return res.body.id as string;
}

function deliveryState(attachmentId: string): string | undefined {
  return (t.db.prepare('SELECT delivery_state FROM session_attachment WHERE attachment_id=?')
    .get(attachmentId) as { delivery_state: string } | undefined)?.delivery_state;
}

describe('聊天携带非图片附件（服务端投递）', () => {
  it('文件不进 image 通道：无需图片能力，路径与元数据进 prompt，状态推进 delivered', async () => {
    const wsId = await mkWorkspace();
    // model=null：图片通道会拒绝，但纯文件不应要求任何图片能力验证
    const sessionId = await mkChatSession(wsId, null);
    const fileId = await upload(wsId, 'application/pdf', 'report.pdf', PDF);

    const res = await request(app).post(`/api/sessions/${sessionId}/messages`)
      .send({ text: '看看附件', attachment_ids: [fileId] });
    expect(res.status).toBe(200);
    await settle();

    const call = adapter.calls[0];
    expect(call.attachments ?? []).toHaveLength(0);
    expect(call.prompt).toContain('看看附件');
    expect(call.prompt).toContain('## 随附文件（本轮）');
    expect(call.prompt).toContain('report.pdf');
    expect(call.prompt).toContain('application/pdf');
    expect(call.prompt).toContain('2.0 KB');
    // 投递路径必须在附件存储根内（拼的是 DB storage_key，不接受客户端文件名当路径）
    expect(call.prompt).toContain(storageDir);
    expect(call.prompt).not.toContain('..');
    expect(deliveryState(fileId)).toBe('delivered');
  });

  it('图片 + 文件混合：图片仍走 attachments，文件只进 prompt，两条都推进 delivered', async () => {
    const wsId = await mkWorkspace();
    const sessionId = await mkChatSession(wsId, IMAGE_MODEL);
    const imageId = await upload(wsId, 'image/png', 'shot.png', PNG);
    const fileId = await upload(wsId, 'application/pdf', 'report.pdf', PDF);

    const res = await request(app).post(`/api/sessions/${sessionId}/messages`)
      .send({ text: '一起看', attachment_ids: [imageId, fileId] });
    expect(res.status).toBe(200);
    await settle();

    const call = adapter.calls[0];
    expect(call.attachments).toHaveLength(1);
    expect(call.attachments?.[0]?.mimeType).toBe('image/png');
    expect(call.prompt).toContain('## 随附文件（本轮）');
    expect(call.prompt).toContain('report.pdf');
    expect(deliveryState(imageId)).toBe('delivered');
    expect(deliveryState(fileId)).toBe('delivered');
  });

  it('文件名做穿越/伪装处理：落库名不含路径段，下载强制 Content-Disposition: attachment', async () => {
    const wsId = await mkWorkspace();
    const sessionId = await mkChatSession(wsId, null);
    const fileId = await upload(wsId, 'text/html', '../../evil.html', Buffer.from('<script>alert(1)</script>'));

    const res = await request(app).post(`/api/sessions/${sessionId}/messages`)
      .send({ text: '看下', attachment_ids: [fileId] });
    expect(res.status).toBe(200);
    await settle();

    const prompt = adapter.calls[0].prompt;
    expect(prompt).not.toContain('..');
    expect(prompt).toContain('evil.html');

    const download = await request(app).get(`/api/workspaces/${wsId}/attachments/${fileId}`);
    expect(download.status).toBe(200);
    expect(String(download.headers['content-disposition'])).toMatch(/^attachment/);
  });
});
