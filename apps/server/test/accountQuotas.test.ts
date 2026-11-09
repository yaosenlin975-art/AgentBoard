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
import { createQuotaService, type QuotaSnapshot } from '../src/services/quotas/quotaService.js';
import { CLI_CLIENT_INSTANCE_ID, cliIdentityHash } from '../src/services/accounts/cliAccounts.js';
import type { SecretVault } from '../src/services/accounts/secretVault.js';
import { resolveCliAccountQuotaCredential } from '../src/services/quotas/platformQuotaCredentials.js';
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

const commandCodeSnapshot: QuotaSnapshot = {
  fetched_at: 1_700_000_000_000,
  items: [{ source: 'commandcode', status: 'ok', balance: 2, unit: 'USD', windows: [], fetched_at: 1_700_000_000_000, reason_code: null, detail: null }],
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
          return (selection as { source?: string } | undefined)?.source === 'commandcode' ? commandCodeSnapshot : snapshot;
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

  it('Command Code 路由要求指定账号，只接受对应 cli_account 且不触发捕获更新', async () => {
    await request(app).get('/api/cli-account-quotas').expect(400);
    await request(app).get('/api/cli-account-quotas?account_id=bad').expect(400);
    await request(app).get(`/api/cli-account-quotas?account_id=${randomUUID()}`).expect(404);
    const wrongId = randomUUID();
    t.db.prepare('INSERT INTO cli_account (id,app_id,identity_hash,credential_ref,created_at,last_seen_at) VALUES (?,?,?,?,?,?)')
      .run(wrongId, 'codex', createHash('sha256').update(wrongId).digest('hex'), null, 1, 2);
    await request(app).get(`/api/cli-account-quotas?account_id=${wrongId}`).expect(404);
    expect(calls).toBe(0);

    const accountId = randomUUID();
    const lastSeen = 123;
    t.db.prepare('INSERT INTO cli_account (id,app_id,identity_hash,credential_ref,created_at,last_seen_at) VALUES (?,?,?,?,?,?)')
      .run(accountId, 'commandcode', createHash('sha256').update(accountId).digest('hex'), null, 1, lastSeen);
    const response = await request(app).get(`/api/cli-account-quotas?account_id=${accountId}`).expect(200);
    expect(response.body).toEqual(commandCodeSnapshot);
    expect(response.body.items).toHaveLength(1);
    expect(response.body.items[0].source).toBe('commandcode');
    expect(quotaSelections).toEqual([{ accountId, source: 'commandcode' }]);
    expect((t.db.prepare('SELECT last_seen_at FROM cli_account WHERE id=?').get(accountId) as { last_seen_at: number }).last_seen_at).toBe(lastSeen);
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

describe('Command Code import cache invalidation', () => {
  it('createApp 缓存无凭据结果后导入 key，下一次额度读取即请求上游', async () => {
    const t = createTestDb();
    const credential = 'command-code-key-0001';
    const accountId = randomUUID();
    const identityHash = cliIdentityHash('commandcode', credential);
    t.db.prepare('INSERT INTO cli_account (id,app_id,identity_hash,credential_ref,created_at,last_seen_at) VALUES (?,?,?,?,?,?)')
      .run(accountId, 'commandcode', identityHash, null, 1, 2);
    const entries = new Map<string, { data: Buffer; scope: string }>();
    const vault = {
      async protect(data: Buffer, scope: unknown): Promise<string> {
        const ref = randomUUID();
        entries.set(ref, { data, scope: JSON.stringify(scope) });
        return ref;
      },
      async unprotect(ref: string, scope: unknown): Promise<Buffer> {
        const entry = entries.get(ref);
        if (!entry || entry.scope !== JSON.stringify(scope)) throw new Error('scope mismatch');
        return entry.data;
      },
      async delete(ref: string): Promise<void> { entries.delete(ref); },
    } as unknown as SecretVault;
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => new Response(JSON.stringify(
      String(input).includes('/whoami') ? { org: { id: 'org-test' } } : {
        credits: { monthlyCredits: 3, purchasedCredits: 1, freeCredits: 0 },
        windowLimits: { fiveHour: { used: 1, cap: 5, resetAt: 0 }, weekly: { used: 1, cap: 10, resetAt: 1_800_000_000_000 } },
      },
    ), { status: 200 }));
    const quotaService = createQuotaService({
      fetchImpl: fetchImpl as unknown as typeof fetch,
      commandCodeCredential: id => resolveCliAccountQuotaCredential({ db: t.db, vault, accountId: id, clientInstanceId: CLI_CLIENT_INSTANCE_ID }),
    });
    try {
      const adapter = new FakeAdapter();
      const app = (await createApp({ db: t.db, secretVault: vault, quotas: quotaService, getAdapter: () => adapter, adapters: [adapter], refreshClisOnBoot: false })).app;
      const before = await request(app).get(`/api/cli-account-quotas?account_id=${accountId}`).expect(200);
      expect(before.body.items[0]).toMatchObject({ status: 'unsupported', reason_code: 'CREDENTIAL_MISSING', balance: null });
      expect(fetchImpl).not.toHaveBeenCalled();

      await request(app).post('/api/cli-accounts/import').send({ app_id: 'commandcode', credential }).expect(200);
      const after = await request(app).get(`/api/cli-account-quotas?account_id=${accountId}`).expect(200);
      expect(after.body.items).toHaveLength(1);
      expect(after.body.items[0]).toMatchObject({ status: 'ok', source: 'commandcode', balance: 4, unit: 'USD' });
      expect(fetchImpl).toHaveBeenCalledTimes(2);
      expect(JSON.stringify([before.body, after.body])).not.toContain(credential);
    } finally { t.cleanup(); }
  });
});
