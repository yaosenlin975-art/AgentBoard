/**
 * CB-UTF8：中文 prompt 经 API 往返不得转码。
 *
 * 背景：曾有记录称「经 AgentBoard 发给 codebuddy 的中文 prompt 变成 ???」。实测用 PowerShell
 * `Invoke-WebRequest -Body <string>` 会把请求体按控制台码页发送，产生 ???（**测试脚本的问题**）；
 * 用严格 UTF-8 的 JSON 请求体时，落库/回读与原文逐字节一致。本用例钉住这条契约，
 * 防止将来有人在路由或仓储层做 latin1/ASCII 转码。
 */
import { beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import { createTestDb, type TestDb } from './helpers.js';
import { FakeAdapter } from './fakeAdapter.js';
import { createApp } from '../src/index.js';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const PROMPT = '请原样回显：中文测试';
const UTF8_HEX = 'e8afb7e58e9fe6a0b7e59b9ee698beefbc9ae4b8ade69687e6b58be8af95';

describe('中文 prompt UTF-8 往返（CB-UTF8）', () => {
  let t: TestDb;
  let app: Express;
  let workspaceId: string;

  beforeEach(async () => {
    t = createTestDb();
    const created = await createApp({ db: t.db, getAdapter: () => new FakeAdapter() });
    app = created.app;
    const wsDir = mkdtempSync(join(tmpdir(), 'ab-utf8-'));
    const ws = await request(app).post('/api/workspaces').send({ path: wsDir, name: 'utf8' });
    workspaceId = ws.body.id;
  });

  it('请求体 UTF-8：落库内容与原文逐字节一致，不出现 ???', async () => {
    const session = await request(app)
      .post('/api/sessions')
      .set('Content-Type', 'application/json; charset=utf-8')
      .send(JSON.stringify({ cli: 'codebuddy', workspace_id: workspaceId }));
    expect(session.status).toBe(200);

    const send = await request(app)
      .post(`/api/sessions/${session.body.id}/messages`)
      .set('Content-Type', 'application/json; charset=utf-8')
      .send(JSON.stringify({ text: PROMPT }));
    expect(send.status).toBe(200);

    const list = await request(app).get(`/api/sessions/${session.body.id}/messages`);
    const user = (list.body as Array<{ role: string; content: string }>).find((m) => m.role === 'user');
    expect(user?.content).toBe(PROMPT);
    expect(Buffer.from(user?.content ?? '', 'utf8').toString('hex')).toBe(UTF8_HEX);
    expect(user?.content).not.toContain('?');
  });
});
