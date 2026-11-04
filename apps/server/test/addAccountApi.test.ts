/**
 * ACC-KB-B2S：协议级加号的 API 契约测试。
 *
 * 断言三件事：
 * 1. 端点形状（发起/查询/轮询/放弃/能力列表）与脱敏（响应不含凭据或 vault 引用）；
 * 2. 授权成功后新账号**直接出现在 GET /api/managed-accounts 列表**（不依赖客户端在跑、不需重启）；
 * 3. 放弃后既没有账号，也没有残留的待激活凭据。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import express from 'express';
import type { Express } from 'express';
import { createTestDb, type TestDb } from './helpers.js';
import { createAccountRouter } from '../src/api/accountRoutes.js';
import { errorHandler } from '../src/api/routes.js';
import { ADD_ACCOUNT_CREDENTIAL_MARK, ADD_ACCOUNT_PENDING_MARK, FakeAddAccountProvider, FakeAddAccountVault } from './fakeAddAccountProvider.js';

describe('add account api', () => {
  let t: TestDb;
  let provider: FakeAddAccountProvider;
  let vault: FakeAddAccountVault;
  let app: Express;

  beforeEach(() => {
    t = createTestDb();
    provider = new FakeAddAccountProvider();
    vault = new FakeAddAccountVault();
    const scoped = express();
    scoped.use(express.json());
    scoped.use('/api', createAccountRouter({
      db: t.db,
      addAccountProviders: { minimax: provider },
      addAccountVault: vault,
    }));
    scoped.use(errorHandler);
    app = scoped;
  });
  afterEach(() => t.cleanup());

  it('addAccountStartReturnsAuthorizationUrlWithoutSecrets', async () => {
    const res = await request(app).post('/api/add-account-sessions').send({ app_id: 'minimax', region: 'cn' });
    expect(res.status).toBe(202);
    expect(res.body.session.status).toBe('pending');
    expect(res.body.session.authorization_url).toContain('https://');
    expect(res.body.session.user_code).toBe('ABCD-EFGH');
    const body = JSON.stringify(res.body);
    expect(body).not.toContain(ADD_ACCOUNT_PENDING_MARK);
    expect(body).not.toContain(ADD_ACCOUNT_CREDENTIAL_MARK);
    expect(body).not.toContain('pending_secret');
    // 发起阶段还没有账号
    expect((await request(app).get('/api/managed-accounts')).body).toHaveLength(0);
  });

  it('addAccountPollAddsAccountToManagedAccountsList', async () => {
    const started = await request(app).post('/api/add-account-sessions').send({ app_id: 'minimax' });
    const id = started.body.session.id as string;
    const polled = await request(app).post(`/api/add-account-sessions/${id}/poll`);
    expect(polled.status).toBe(200);
    expect(polled.body.session.status).toBe('authorized');
    expect(polled.body.account.app_id).toBe('minimax');
    const list = await request(app).get('/api/managed-accounts');
    expect(list.body).toHaveLength(1);
    expect(list.body[0].id).toBe(polled.body.account.id);
    // 列表与轮询响应都不含凭据原文
    expect(JSON.stringify(list.body)).not.toContain(ADD_ACCOUNT_CREDENTIAL_MARK);
    expect(JSON.stringify(polled.body)).not.toContain(ADD_ACCOUNT_CREDENTIAL_MARK);
  });

  it('addAccountCancelLeavesNoAccount', async () => {
    const started = await request(app).post('/api/add-account-sessions').send({ app_id: 'minimax' });
    const id = started.body.session.id as string;
    const cancelled = await request(app).delete(`/api/add-account-sessions/${id}`);
    expect(cancelled.status).toBe(200);
    expect(cancelled.body.session.status).toBe('cancelled');
    expect((await request(app).get('/api/managed-accounts')).body).toHaveLength(0);
    expect(vault.size).toBe(0);
  });

  it('addAccountGetSessionReturnsPublicViewOnly', async () => {
    const started = await request(app).post('/api/add-account-sessions').send({ app_id: 'minimax' });
    const id = started.body.session.id as string;
    const res = await request(app).get(`/api/add-account-sessions/${id}`);
    expect(res.status).toBe(200);
    expect(res.body.session.id).toBe(id);
    const body = JSON.stringify(res.body);
    expect(body).not.toContain('pending_secret');
    expect(body).not.toContain(ADD_ACCOUNT_PENDING_MARK);
  });

  it('addAccountProtocolsListSupportedPlatforms', async () => {
    const res = await request(app).get('/api/add-account-protocols');
    expect(res.status).toBe(200);
    expect(res.body.items).toHaveLength(1);
    expect(res.body.items[0]).toMatchObject({ app_id: 'minimax', protocol: 'minimax_device', requires_browser: true });
  });

  it('addAccountUnsupportedPlatformIsRejected', async () => {
    const res = await request(app).post('/api/add-account-sessions').send({ app_id: 'qoder_cn' });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('PROVIDER_UNVERIFIED');
  });

  it('addAccountInvalidBodyIsRejected', async () => {
    const res = await request(app).post('/api/add-account-sessions').send({ app_id: 'minimax', region: 'mars' });
    expect(res.status).toBe(400);
  });
});
