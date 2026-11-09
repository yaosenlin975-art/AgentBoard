/**
 * ACC-QUOTA-01：`GET /api/managed-account-quotas` 路由契约。
 * - 三来源逐项返回，单来源 unsupported 不影响 deepseek 的 ok；
 * - workspace_id 可选，非法值 400；
 * - 响应不含 token / 本机路径 / identity_hash；
 * - 缓存由 quotaService 负责（本文件只验路由装配与形状）。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import express from 'express';
import type { Express } from 'express';
import { createHash, randomUUID } from 'node:crypto';
import { createTestDb, type TestDb } from './helpers.js';
import { FakeAdapter } from './fakeAdapter.js';
import { createApp } from '../src/index.js';
import { createAccountRouter } from '../src/api/accountRoutes.js';
import { errorHandler } from '../src/api/routes.js';
import { createManagedAccount } from '../src/db/repos/managedAccount.js';
import { attachCheckinCredential } from '../src/db/repos/checkin.js';
import type { QuotaSnapshot } from '../src/services/quotas/quotaService.js';
import { FakeCheckinVault } from './fakeCheckinProvider.js';

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
  let quotaSelections: unknown[];

  beforeEach(async () => {
    t = createTestDb();
    calls = 0;
    quotaSelections = [];
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
        get: async (selection?: unknown) => {
          calls += 1;
          quotaSelections.push(selection);
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

  it('account_id 校验、找不到账号和不支持平台均不触发额度读取', async () => {
    await request(app).get('/api/managed-account-quotas?account_id=not-a-uuid').expect(400);
    await request(app).get(`/api/managed-account-quotas?account_id=${randomUUID()}`).expect(404);
    const unsupported = createManagedAccount(t.db, {
      app_id: 'codebuddy_desktop',
      client_instance_id: `quota-${randomUUID()}`,
      service_region: 'cn',
      identity_hash: createHash('sha256').update(randomUUID()).digest('hex'),
      display_name: 'unsupported-quota-source',
    });
    await request(app).get(`/api/managed-account-quotas?account_id=${unsupported.id}`).expect(400);
    expect(calls).toBe(0);
  });

  it('account_id 映射为对应平台来源并传给额度服务；无参数聚合仍不变', async () => {
    const account = createManagedAccount(t.db, {
      app_id: 'workbuddy_desktop',
      client_instance_id: `quota-${randomUUID()}`,
      service_region: 'cn',
      identity_hash: createHash('sha256').update(randomUUID()).digest('hex'),
      display_name: 'workbuddy-quota-account',
    });
    await request(app).get(`/api/managed-account-quotas?account_id=${account.id}`).expect(200);
    expect(quotaSelections).toEqual([{ accountId: account.id, source: 'workbuddy' }]);
    await request(app).get('/api/managed-account-quotas').expect(200);
    expect(quotaSelections[1]).toBeUndefined();
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

describe('GET /api/managed-account-quotas account scope integration', () => {
  it('真实 account router 通过目标账号凭据返回各自 WorkBuddy 结果', async () => {
    const t = createTestDb();
    const vault = new FakeCheckinVault();
    let fetchCalls = 0;
    try {
      const createAccount = async (name: string, credential: string): Promise<string> => {
        const account = createManagedAccount(t.db, {
          app_id: 'workbuddy_desktop',
          client_instance_id: `quota-${name}`,
          service_region: 'cn',
          identity_hash: createHash('sha256').update(name).digest('hex'),
          display_name: name,
        });
        const ref = await vault.protect(Buffer.from(credential), {
          app_id: account.app_id,
          client_instance_id: account.client_instance_id,
          identity_hash: account.identity_hash,
          purpose: 'checkin',
        });
        attachCheckinCredential(t.db, account.id, ref);
        return account.id;
      };
      const accountA = await createAccount('quota-a', 'account-a-secret');
      const accountB = await createAccount('quota-b', 'account-b-secret');
      const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
        fetchCalls += 1;
        const authorization = new Headers(init?.headers).get('authorization');
        const totalCredits = authorization === 'Bearer account-a-secret' ? '111.5' : '222.75';
        return new Response(JSON.stringify({ data: { TotalCredits: totalCredits } }), { status: 200 });
      });
      vi.stubGlobal('fetch', fetchMock);
      const app = express();
      app.use('/api', createAccountRouter({ db: t.db, vault }));
      app.use(errorHandler);

      const [a, b] = await Promise.all([
        request(app).get(`/api/managed-account-quotas?account_id=${accountA}`).expect(200),
        request(app).get(`/api/managed-account-quotas?account_id=${accountB}`).expect(200),
      ]);
      expect(a.body.items).toHaveLength(1);
      expect(a.body.items[0]).toMatchObject({ source: 'workbuddy', status: 'ok', balance: 111.5, unit: '积分' });
      expect(b.body.items).toHaveLength(1);
      expect(b.body.items[0]).toMatchObject({ source: 'workbuddy', status: 'ok', balance: 222.75, unit: '积分' });
      expect(fetchCalls).toBe(2);
      await request(app).get(`/api/managed-account-quotas?account_id=${accountA}`).expect(200);
      expect(fetchCalls).toBe(2);
      const responseText = JSON.stringify([a.body, b.body]);
      expect(responseText).not.toContain('account-a-secret');
      expect(responseText).not.toContain('account-b-secret');
      expect(responseText).not.toContain('identity_hash');
    } finally {
      vi.unstubAllGlobals();
      t.cleanup();
    }
  });
});
