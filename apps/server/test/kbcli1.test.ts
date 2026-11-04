/**
 * KB-CLI-1：服务端标题 200 字上限（API 直调与 CLI 同受约束）+ 幂等重放响应头。
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import { createTestDb, type TestDb } from './helpers.js';
import { FakeAdapter } from './fakeAdapter.js';
import { createApp } from '../src/index.js';

let t: TestDb;
let app: Express;
let wsId: string;
let spaceDir: string;

beforeEach(async () => {
  t = createTestDb();
  const adapter = new FakeAdapter();
  const created = await createApp({ db: t.db, getAdapter: () => adapter, adapters: [adapter], refreshClisOnBoot: false });
  app = created.app;
  spaceDir = mkdtempSync(join(tmpdir(), 'agentboard-kbcli1-'));
  wsId = ((await request(app).post('/api/workspaces').send({ name: 'ws', path: spaceDir })).body as { id: string }).id;
});

afterEach(() => {
  t.cleanup();
  rmSync(spaceDir, { recursive: true, force: true });
});

describe('标题 200 字上限（KB-CLI-1）', () => {
  it('201 字 → 400 VALIDATION_ERROR；200 字 → 200', async () => {
    const tooLong = await request(app).post('/api/issues').send({ workspace_id: wsId, title: '长'.repeat(201) });
    expect(tooLong.status).toBe(400);
    expect(tooLong.body.error.code).toBe('VALIDATION_ERROR');
    expect(tooLong.body.error.message).toContain('200');

    const ok = await request(app).post('/api/issues').send({ workspace_id: wsId, title: '长'.repeat(200) });
    expect(ok.status).toBe(200);
  });

  it('同 request-id 重放：响应带 x-agentboard-replayed:1', async () => {
    const key = '11111111-1111-4111-8111-111111111111';
    const first = await request(app).post('/api/issues')
      .set('Idempotency-Key', key)
      .set('workspace_id', wsId)
      .send({ workspace_id: wsId, title: '幂等建卡' });
    expect(first.status).toBe(200);
    expect(first.headers['x-agentboard-replayed']).toBeUndefined();

    const replay = await request(app).post('/api/issues')
      .set('Idempotency-Key', key)
      .set('workspace_id', wsId)
      .send({ workspace_id: wsId, title: '幂等建卡' });
    expect(replay.status).toBe(200);
    expect(replay.headers['x-agentboard-replayed']).toBe('1');
    expect(replay.body.id).toBe(first.body.id);
  });
});
