/**
 * ACC-QUOTA-01：`GET /api/managed-account-quotas` 路由契约。
 * - 三来源逐项返回，单来源 unsupported 不影响 deepseek 的 ok；
 * - workspace_id 可选，非法值 400；
 * - 响应不含 token / 本机路径 / identity_hash；
 * - 缓存由 quotaService 负责（本文件只验路由装配与形状）。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import { randomUUID } from 'node:crypto';
import { createTestDb, type TestDb } from './helpers.js';
import { FakeAdapter } from './fakeAdapter.js';
import { createApp } from '../src/index.js';
import type { QuotaSnapshot } from '../src/services/quotas/quotaService.js';

const snapshot: QuotaSnapshot = {
  fetched_at: 1_700_000_000_000,
  items: [
    {
      source: 'deepseek', status: 'ok', balance: 38.42, unit: 'CNY', windows: [],
      fetched_at: 1_700_000_000_000, reason_code: null, detail: null,
    },
    {
      source: 'opencode_go', status: 'unsupported', balance: null, unit: null, windows: [],
      fetched_at: 1_700_000_000_000, reason_code: 'NO_PUBLIC_QUOTA_ENDPOINT', detail: 'OpenCode Go 没有公开的配额接口',
    },
    {
      source: 'codex', status: 'unsupported', balance: null, unit: null, windows: [],
      fetched_at: 1_700_000_000_000, reason_code: 'NO_PUBLIC_QUOTA_ENDPOINT', detail: 'Codex 额度窗口没有公开接口',
    },
  ],
};

describe('GET /api/managed-account-quotas', () => {
  let t: TestDb;
  let app: Express;
  let calls: number;

  beforeEach(async () => {
    t = createTestDb();
    calls = 0;
    const adapter = new FakeAdapter();
    const created = await createApp({
      db: t.db,
      getAdapter: (id: string) => {
        if (id === 'fake') return adapter;
        throw new Error(`未知适配器 id: ${id}`);
      },
      adapters: [adapter],
      refreshClisOnBoot: false,
      quotas: {
        get: async () => {
          calls += 1;
          return snapshot;
        },
      },
    });
    app = created.app;
  });

  afterEach(() => t.cleanup());

  it('返回三来源逐项结果（ok + unsupported 并存）', async () => {
    const res = await request(app).get('/api/managed-account-quotas').expect(200);
    expect(res.body.fetched_at).toBe(1_700_000_000_000);
    expect(res.body.items.map((item: { source: string }) => item.source)).toEqual(['deepseek', 'opencode_go', 'codex']);
    expect(res.body.items[0]).toMatchObject({ source: 'deepseek', status: 'ok', balance: 38.42, unit: 'CNY' });
    expect(res.body.items[1]).toMatchObject({ source: 'opencode_go', status: 'unsupported', reason_code: 'NO_PUBLIC_QUOTA_ENDPOINT' });
    expect(res.body.items[2].status).toBe('unsupported');
    expect(calls).toBe(1);
  });

  it('workspace_id 可选：合法值原样回显，非法值 400', async () => {
    const workspaceId = randomUUID();
    const ok = await request(app).get(`/api/managed-account-quotas?workspace_id=${workspaceId}`).expect(200);
    expect(ok.body.workspace_id).toBe(workspaceId);
    await request(app).get('/api/managed-account-quotas?workspace_id=not-a-uuid').expect(400);
  });

  it('响应不含 token / 本机路径 / identity_hash', async () => {
    const res = await request(app).get('/api/managed-account-quotas').expect(200);
    const text = JSON.stringify(res.body);
    expect(text).not.toMatch(/sk-[A-Za-z0-9]/);
    expect(text).not.toContain('api_key');
    expect(text).not.toContain('C:\\');
    expect(text).not.toContain('identity_hash');
  });
});
