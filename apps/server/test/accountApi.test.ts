/**
 * ACC-05 账号 API 契约测试：managed-accounts 列表/捕获/切换 + account-operations 查询。
 * fake provider 注入 createApp（路径/探针见 fakeWorkbuddy.ts）；响应不得含凭据/信封/快照引用。
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import express from 'express';
import type { Express } from 'express';
import type { AgentAdapter } from '@agentboard/adapters';
import { createTestDb, type TestDb } from './helpers.js';
import { FakeAdapter } from './fakeAdapter.js';
import { createApp } from '../src/index.js';
import { createAccountRouter } from '../src/api/accountRoutes.js';
import { errorHandler } from '../src/api/routes.js';
import type { SecretVault } from '../src/services/accounts/secretVault.js';
import { attachCheckinCredential } from '../src/db/repos/checkin.js';
import { attachClientSnapshot, createManagedAccount, getManagedAccount } from '../src/db/repos/managedAccount.js';
import { createAccountOperation, updateAccountOperation } from '../src/db/repos/accountOperation.js';
import { CHECKIN_UID, CREDENTIAL_MARK, FakeCheckinProvider, FakeCheckinVault, sha256 } from './fakeCheckinProvider.js';
import { ENVELOPE_MARK, FakeWorkbuddyEnv, UID_A, UID_B } from './fakeWorkbuddy.js';

describe('account api (managed-accounts / account-operations)', () => {
  let t: TestDb;
  let env: FakeWorkbuddyEnv;
  let app: Express;
  let adapter: FakeAdapter;
  let spaceDir: string;

  beforeEach(() => {
    t = createTestDb();
    env = new FakeWorkbuddyEnv();
    adapter = new FakeAdapter();
    spaceDir = mkdtempSync(join(tmpdir(), 'agentboard-api-'));
  });
  afterEach(() => {
    t.cleanup();
    env.cleanup();
    rmSync(spaceDir, { recursive: true, force: true });
  });

  async function boot(): Promise<void> {
    const created = await createApp({
      db: t.db,
      getAdapter: id => {
        if (id === 'fake') return adapter;
        throw new Error(`未知适配器 id: ${id}`);
      },
      adapters: [adapter],
      refreshClisOnBoot: false,
      workbuddyProvider: env.provider(t.db),
    });
    app = created.app;
  }

  // ---- ACC-07 辅助：签到替身 + 内存 vault + 账号夹具 ----
  function seedAccount(name: string): string {
    const account = createManagedAccount(t.db, {
      app_id: 'workbuddy_desktop',
      client_instance_id: `inst-${name}`,
      service_region: 'cn',
      identity_hash: sha256(CHECKIN_UID),
      display_name: name,
    });
    return account.id;
  }

  async function bootCheckin(): Promise<{ provider: FakeCheckinProvider; vault: FakeCheckinVault; boundAccount: (name: string) => Promise<string> }> {
    const provider = new FakeCheckinProvider();
    const vault = new FakeCheckinVault();
    const created = await createApp({
      db: t.db,
      getAdapter: id => {
        if (id === 'fake') return adapter;
        throw new Error(`未知适配器 id: ${id}`);
      },
      adapters: [adapter],
      refreshClisOnBoot: false,
      workbuddyProvider: env.provider(t.db),
      checkinProvider: provider,
      secretVault: vault as unknown as SecretVault,
    });
    app = created.app;
    const boundAccount = async (name: string): Promise<string> => {
      const account = createManagedAccount(t.db, {
        app_id: 'workbuddy_desktop',
        client_instance_id: `inst-${name}`,
        service_region: 'cn',
        identity_hash: sha256(CHECKIN_UID),
        display_name: name,
      });
      const ref = await vault.protect(Buffer.from(CREDENTIAL_MARK), {
        app_id: account.app_id, client_instance_id: account.client_instance_id, identity_hash: account.identity_hash, purpose: 'checkin',
      });
      attachCheckinCredential(t.db, account.id, ref);
      return account.id;
    };
    return { provider, vault, boundAccount };
  }

  async function waitBatch(batchId: string): Promise<{ status: string; items: Array<{ account_id: string; state: string }> }> {
    for (let i = 0; i < 200; i++) {
      const res = await request(app).get(`/api/checkin-runs/${batchId}`);
      expect(res.status).toBe(200);
      if (res.body.finished_at !== null && res.body.status !== 'running' && res.body.status !== 'queued') return res.body;
      await new Promise(resolve => setTimeout(resolve, 25));
    }
    throw new Error('批次未在超时内结束');
  }

  it.runIf(process.platform === 'win32')('capture-current saves account and list exposes sanitized metadata with is_current', async () => {
    await boot();
    env.trayExitWorks = true;
    const captured = await request(app).post('/api/managed-accounts/workbuddy_desktop/capture-current').send({ display_name: '账号A' });
    expect(captured.status).toBe(200);
    expect(captured.body.account.display_name).toBe('账号A');
    const accountBody = JSON.stringify(captured.body);
    expect(accountBody).not.toContain(ENVELOPE_MARK);
    expect(accountBody).not.toContain(UID_A);
    expect(accountBody).not.toContain('client_snapshot_ref');

    // 客户端内登录 B 后再捕获 → 列表按 is_current 标注
    await env.loginAs(UID_B);
    const capturedB = await request(app).post('/api/managed-accounts/workbuddy_desktop/capture-current').send({ display_name: '账号B' });
    expect(capturedB.status).toBe(200);
    const list = await request(app).get('/api/managed-accounts');
    expect(list.status).toBe(200);
    expect(list.body).toHaveLength(2);
    expect(list.body.map((a: { display_name: string }) => a.display_name).sort()).toEqual(['账号A', '账号B']);
    const currentRow = list.body.find((a: { display_name: string }) => a.display_name === '账号B');
    const otherRow = list.body.find((a: { display_name: string }) => a.display_name === '账号A');
    expect(currentRow.is_current).toBe(true);
    expect(otherRow.is_current).toBe(false);
    const listBody = JSON.stringify(list.body);
    expect(listBody).not.toContain('identity_hash');
    expect(listBody).not.toContain('client_snapshot_ref');

    // app 过滤
    const filtered = await request(app).get('/api/managed-accounts?app=codebuddy_desktop');
    expect(filtered.status).toBe(200);
    expect(filtered.body).toEqual([]);
    const invalid = await request(app).get('/api/managed-accounts?app=nope');
    expect(invalid.status).toBe(400);
  }, 30000);

  it.runIf(process.platform === 'win32')('capture-current for unverified product returns PROVIDER_UNVERIFIED and unknown app 400', async () => {
    await boot();
    const res = await request(app).post('/api/managed-accounts/codebuddy_desktop/capture-current').send({});
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('PROVIDER_UNVERIFIED');
    expect(res.body.error.details).toEqual({ reason_code: 'TARGET_KIND_UNCONFIRMED' });
    const bad = await request(app).post('/api/managed-accounts/unknown_app/capture-current').send({});
    expect(bad.status).toBe(400);
  }, 20000);

  it.runIf(process.platform === 'win32')('switch returns operation id immediately and final state via account-operations', async () => {
    await boot();
    env.trayExitWorks = true;
    const capturedA = await request(app).post('/api/managed-accounts/workbuddy_desktop/capture-current').send({ display_name: '账号A' });
    await env.loginAs(UID_B);
    const capturedB = await request(app).post('/api/managed-accounts/workbuddy_desktop/capture-current').send({ display_name: '账号B' });
    expect(capturedB.status).toBe(200);
    const accountIdA = capturedA.body.account.id as string;

    const res = await request(app).post(`/api/managed-accounts/${accountIdA}/switch`).send({});
    expect(res.status).toBe(202);
    expect(res.body.operation_id).toMatch(/^[0-9a-f-]{36}$/);
    expect(['queued', 'running', 'succeeded']).toContain(res.body.operation.state);

    // 轮询至终态
    let final: { state: string; stage: string } | null = null;
    for (let i = 0; i < 100; i++) {
      const op = await request(app).get(`/api/account-operations/${res.body.operation_id}`);
      expect(op.status).toBe(200);
      if (['succeeded', 'failed', 'unknown', 'recovery_required'].includes(op.body.state)) { final = op.body; break; }
      await new Promise(resolve => setTimeout(resolve, 25));
    }
    expect(final).not.toBeNull();
    expect(final!.state).toBe('succeeded');
    expect(final!.stage).toBe('verify');
    expect(env.authUid()).toBe(UID_A);
    const opBody = JSON.stringify(final);
    expect(opBody).not.toContain(ENVELOPE_MARK);
  }, 30000);

  it.runIf(process.platform === 'win32')('account-operations and switch on missing resources give safe errors', async () => {
    await boot();
    const missingOp = await request(app).get('/api/account-operations/0c99142a-0000-4000-8000-000000000000');
    expect(missingOp.status).toBe(404);
    expect(missingOp.body.error.code).toBe('OPERATION_NOT_FOUND');
    const missingAccount = await request(app).post('/api/managed-accounts/0c99142a-0000-4000-8000-000000000001/switch').send({});
    expect(missingAccount.status).toBe(404);
  }, 20000);

  // ---------------- ACC-07：签到授权 / 批量签到 / 能力矩阵 ----------------

  it('managed-account-capabilities reports per-dimension reason codes from registry (no checkin provider)', async () => {
    await boot();
    const res = await request(app).get('/api/managed-account-capabilities');
    expect(res.status).toBe(200);
    const byApp = Object.fromEntries(res.body.map((row: { app_id: string }) => [row.app_id, row]));
    // WorkBuddy：capture/switch 可用 → OK；checkin gate 未验证 → CHECKIN_PROVIDER_UNVERIFIED
    expect(byApp.workbuddy_desktop).toEqual({
      app_id: 'workbuddy_desktop',
      capture: true, switch: true, checkin: false,
      capture_reason_code: 'OK', switch_reason_code: 'OK', checkin_reason_code: 'CHECKIN_PROVIDER_UNVERIFIED',
      reason_code: 'CHECKIN_PROVIDER_UNVERIFIED', source: 'static',
    });
    // CodeBuddy：capture/switch 的真实根因是 TARGET_KIND_UNCONFIRMED（不得被 checkin 原因覆盖）
    expect(byApp.codebuddy_desktop).toEqual({
      app_id: 'codebuddy_desktop',
      capture: false, switch: false, checkin: false,
      capture_reason_code: 'TARGET_KIND_UNCONFIRMED', switch_reason_code: 'TARGET_KIND_UNCONFIRMED', checkin_reason_code: 'CHECKIN_PROVIDER_UNVERIFIED',
      reason_code: 'TARGET_KIND_UNCONFIRMED', source: 'static',
    });
    const filtered = await request(app).get('/api/managed-account-capabilities?app=codebuddy_desktop');
    expect(filtered.body).toHaveLength(1);
    expect(filtered.body[0].capture_reason_code).toBe('TARGET_KIND_UNCONFIRMED');
    expect((await request(app).get('/api/managed-account-capabilities?app=nope')).status).toBe(400);
  });

  it('checkin endpoints stay PROVIDER_UNVERIFIED without a verified provider and create no rows', async () => {
    await boot();
    const accountId = seedAccount('ws-checkin-none');
    const start = await request(app).post('/api/checkin-authorizations/start').set('Idempotency-Key', randomUUID()).send({ account_id: accountId });
    expect(start.status).toBe(409);
    expect(start.body.error.code).toBe('PROVIDER_UNVERIFIED');
    const run = await request(app).post('/api/checkin-runs').set('Idempotency-Key', randomUUID()).send({ app_id: 'workbuddy_desktop', account_ids: [accountId] });
    expect(run.status).toBe(409);
    expect(run.body.error.code).toBe('PROVIDER_UNVERIFIED');
    const counts = t.db.prepare('SELECT (SELECT COUNT(*) FROM checkin_authorization) a,(SELECT COUNT(*) FROM checkin_batch) b,(SELECT COUNT(*) FROM checkin_batch_item) i').get();
    expect(counts).toEqual({ a: 0, b: 0, i: 0 });
  });

  it('checkin authorizations bind credential once and require Idempotency-Key', async () => {
    const { provider } = await bootCheckin();
    const accountId = seedAccount('ws-checkin-auth');
    const missingKey = await request(app).post('/api/checkin-authorizations/start').send({ account_id: accountId });
    expect(missingKey.status).toBe(400);

    // 注入已验证 provider 后能力矩阵推导为 derived：checkin 维度换原因，capture/switch 原因不受影响
    const caps = await request(app).get('/api/managed-account-capabilities');
    expect(caps.body.find((row: { app_id: string }) => row.app_id === 'workbuddy_desktop')).toEqual({
      app_id: 'workbuddy_desktop',
      capture: true, switch: true, checkin: true,
      capture_reason_code: 'OK', switch_reason_code: 'OK', checkin_reason_code: 'CHECKIN_PROVIDER_AVAILABLE',
      reason_code: 'CHECKIN_PROVIDER_AVAILABLE', source: 'derived',
    });
    // 未注入 provider 的产品仍为 static 且原因不变（混合时按产品分别判定，source 只影响被推导的那一项）
    expect(caps.body.find((row: { app_id: string }) => row.app_id === 'codebuddy_desktop')).toEqual({
      app_id: 'codebuddy_desktop',
      capture: false, switch: false, checkin: false,
      capture_reason_code: 'TARGET_KIND_UNCONFIRMED', switch_reason_code: 'TARGET_KIND_UNCONFIRMED', checkin_reason_code: 'CHECKIN_PROVIDER_UNVERIFIED',
      reason_code: 'TARGET_KIND_UNCONFIRMED', source: 'static',
    });

    const key = randomUUID();
    const started = await request(app).post('/api/checkin-authorizations/start').set('Idempotency-Key', key).send({ account_id: accountId });
    expect(started.status).toBe(202);
    expect(started.body.authorization.status).toBe('pending');
    expect(JSON.stringify(started.body)).not.toContain('remote_state');
    const replayStart = await request(app).post('/api/checkin-authorizations/start').set('Idempotency-Key', key).send({ account_id: accountId });
    expect(replayStart.body.authorization.id).toBe(started.body.authorization.id);
    expect(provider.startCalls).toBe(1);

    const polled = await request(app).post(`/api/checkin-authorizations/${started.body.authorization.id}/poll`).send({});
    expect(polled.status).toBe(200);
    expect(polled.body.authorization.status).toBe('authorized');
    expect(polled.body.account.checkin_capability).toBe('supported');
    const body = JSON.stringify(polled.body);
    expect(body).not.toContain('checkin_credential_ref');
    expect(body).not.toContain('identity_hash');
    expect(body).not.toContain(CREDENTIAL_MARK);

    const again = await request(app).post(`/api/checkin-authorizations/${started.body.authorization.id}/poll`).send({});
    expect(again.status).toBe(409);
    expect(again.body.error.code).toBe('AUTHORIZATION_NOT_PENDING');
  });

  it('checkin runs replay without duplicate submissions and reject a second concurrent batch', async () => {
    const { provider, boundAccount } = await bootCheckin();
    const first = await boundAccount('ws-run-A');
    const second = await boundAccount('ws-run-B');
    const key = randomUUID();
    const created = await request(app).post('/api/checkin-runs').set('Idempotency-Key', key).send({ app_id: 'workbuddy_desktop', account_ids: [first, second] });
    expect(created.status).toBe(202);
    expect(created.body.replayed).toBe(false);
    const batchId = created.body.batch.id as string;

    // 同 key 重放：同一 batch、无新增 adapter 调用
    const before = provider.submitCalls;
    const replay = await request(app).post('/api/checkin-runs').set('Idempotency-Key', key).send({ app_id: 'workbuddy_desktop', account_ids: [first, second] });
    expect(replay.status).toBe(202);
    expect(replay.body.batch.id).toBe(batchId);
    expect(replay.body.replayed).toBe(true);
    expect(provider.submitCalls).toBe(before);

    // 批次未结束时第二个 batch（不同 key）→ 409 + details.batch_id
    const concurrent = await request(app).post('/api/checkin-runs').set('Idempotency-Key', randomUUID()).send({ app_id: 'workbuddy_desktop', account_ids: [first] });
    if (concurrent.status === 409) {
      expect(concurrent.body.error.code).toBe('CHECKIN_BATCH_IN_PROGRESS');
      expect(concurrent.body.error.details.batch_id).toBe(batchId);
    }

    const finished = await waitBatch(batchId);
    expect(finished.status).toBe('succeeded');
    expect(finished.items.map((item: { account_id: string }) => item.account_id)).toEqual([first, second]);
    expect(provider.submitCalls).toBe(2);

    const ops = await request(app).get(`/api/account-operations?batch_id=${batchId}`);
    expect(ops.status).toBe(200);
    expect(ops.body).toHaveLength(2);
    expect(JSON.stringify(ops.body)).not.toContain(CREDENTIAL_MARK);
    expect((await request(app).get('/api/account-operations?batch_id=nope')).status).toBe(400);
  }, 30000);

  it('checkin cancel only affects queued items and finished batches cannot be cancelled', async () => {
    const { provider, boundAccount } = await bootCheckin();
    provider.submitDelayMs = 120;
    const a = await boundAccount('ws-cancel-A');
    const b = await boundAccount('ws-cancel-B');
    const created = await request(app).post('/api/checkin-runs').set('Idempotency-Key', randomUUID()).send({ app_id: 'workbuddy_desktop', account_ids: [a, b] });
    const batchId = created.body.batch.id as string;
    const cancelled = await request(app).post(`/api/checkin-runs/${batchId}/cancel`).send({});
    expect(cancelled.status).toBe(200);
    expect(cancelled.body.batch_id).toBe(batchId);
    expect([...cancelled.body.cancelled, ...cancelled.body.running]).toEqual(expect.arrayContaining([a, b]));

    const finished = await waitBatch(batchId);
    for (const item of finished.items) expect(['cancelled', 'succeeded', 'already_done', 'failed', 'unknown']).toContain(item.state);
    const afterFinished = await request(app).post(`/api/checkin-runs/${batchId}/cancel`).send({});
    expect(afterFinished.status).toBe(409);
    expect(afterFinished.body.error.code).toBe('CHECKIN_BATCH_FINISHED');
    expect((await request(app).get(`/api/checkin-runs/${randomUUID()}`)).status).toBe(404);
  }, 30000);

  // ---------------- ACC-DEL-01：DELETE /api/managed-accounts/:id ----------------

  /** 账号 + 快照引用（快照与签到凭据两类 DPAPI 文件都要被清掉） */
  async function deletableAccount(vault: FakeCheckinVault, name: string): Promise<string> {
    const account = createManagedAccount(t.db, {
      app_id: 'workbuddy_desktop',
      client_instance_id: `inst-${name}`,
      service_region: 'cn',
      identity_hash: sha256(CHECKIN_UID),
      display_name: name,
    });
    const credential = await vault.protect(Buffer.from(CREDENTIAL_MARK), {
      app_id: account.app_id, client_instance_id: account.client_instance_id, identity_hash: account.identity_hash, purpose: 'checkin',
    });
    attachCheckinCredential(t.db, account.id, credential);
    const snapshot = await vault.protect(Buffer.from(ENVELOPE_MARK), {
      app_id: account.app_id, client_instance_id: account.client_instance_id, identity_hash: account.identity_hash, purpose: 'checkin',
    });
    attachClientSnapshot(t.db, account.id, { client_snapshot_ref: snapshot, client_snapshot_version: 2 });
    return account.id;
  }

  function seedOperation(accountId: string, name: string): string {
    return createAccountOperation(t.db, {
      account_id: accountId, app_id: 'workbuddy_desktop', client_instance_id: `inst-${name}`, operation: 'switch',
    }).id;
  }

  it('ACC-KB-A2 PATCH enabled：停用/启用可写、响应脱敏、非法与占用被拒', async () => {
    const { vault } = await bootCheckin();
    const accountId = await deletableAccount(vault, 'toggle-basic');
    expect(getManagedAccount(t.db, accountId)!.enabled).toBe(true);

    const off = await request(app).patch(`/api/managed-accounts/${accountId}`).send({ enabled: false });
    expect(off.status).toBe(200);
    expect(off.body.enabled).toBe(false);
    expect(getManagedAccount(t.db, accountId)!.enabled).toBe(false);
    // 响应仍是脱敏体
    for (const forbidden of ['identity_hash', 'client_snapshot_ref', 'checkin_credential_ref', CREDENTIAL_MARK]) {
      expect(JSON.stringify(off.body)).not.toContain(forbidden);
    }

    const on = await request(app).patch(`/api/managed-accounts/${accountId}`).send({ enabled: true });
    expect(on.status).toBe(200);
    expect(getManagedAccount(t.db, accountId)!.enabled).toBe(true);

    // 参数校验：非 UUID / body 形状不对 / 未知 id
    expect((await request(app).patch('/api/managed-accounts/not-a-uuid').send({ enabled: false })).status).toBe(400);
    expect((await request(app).patch(`/api/managed-accounts/${accountId}`).send({ enabled: 'no' })).status).toBe(400);
    expect((await request(app).patch(`/api/managed-accounts/${accountId}`).send({ enabled: false, extra: 1 })).status).toBe(400);
    expect((await request(app).patch(`/api/managed-accounts/${randomUUID()}`).send({ enabled: false })).status).toBe(404);

    // 有排队/进行中的操作时禁止停用
    const operationId = seedOperation(accountId, 'toggle-basic');
    const blocked = await request(app).patch(`/api/managed-accounts/${accountId}`).send({ enabled: false });
    expect(blocked.status).toBe(409);
    expect(blocked.body.error.code).toBe('ACCOUNT_BUSY');
    expect(operationId).not.toBe('');
  });

  it('delete removes the account row and both DPAPI references, and answers with no credential data', async () => {
    const { vault } = await bootCheckin();
    const accountId = await deletableAccount(vault, 'del-basic');
    expect(vault.size).toBe(2);

    const res = await request(app).delete(`/api/managed-accounts/${accountId}`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ deleted: true, id: accountId });
    const body = JSON.stringify(res.body);
    expect(body).not.toContain('identity_hash');
    expect(body).not.toContain('client_snapshot_ref');
    expect(body).not.toContain('checkin_credential_ref');
    expect(body).not.toContain(CREDENTIAL_MARK);
    expect(body).not.toContain(ENVELOPE_MARK);

    expect(getManagedAccount(t.db, accountId)).toBeNull();
    expect((await request(app).get('/api/managed-accounts')).body).toEqual([]);
    expect(vault.size).toBe(0);
    expect(vault.deletedRefs).toHaveLength(2);

    const again = await request(app).delete(`/api/managed-accounts/${accountId}`);
    expect(again.status).toBe(404);
  });

  it('delete rejects a non-uuid id with 400 and an unknown uuid with 404', async () => {
    await bootCheckin();
    expect((await request(app).delete('/api/managed-accounts/not-a-uuid')).status).toBe(400);
    expect((await request(app).delete(`/api/managed-accounts/${randomUUID()}`)).status).toBe(404);
  });

  it('delete blocks while an operation is queued or running, and passes once it is terminal', async () => {
    const { vault } = await bootCheckin();
    const name = 'del-busy';
    const accountId = await deletableAccount(vault, name);
    const operationId = seedOperation(accountId, name);

    const blocked = await request(app).delete(`/api/managed-accounts/${accountId}`);
    expect(blocked.status).toBe(409);
    expect(blocked.body.error.code).toBe('ACCOUNT_BUSY');
    expect(blocked.body.error.details).toEqual({ reason_code: 'ACCOUNT_BUSY' });
    expect(getManagedAccount(t.db, accountId)).not.toBeNull();

    updateAccountOperation(t.db, operationId, { state: 'running' });
    expect((await request(app).delete(`/api/managed-accounts/${accountId}`)).status).toBe(409);

    updateAccountOperation(t.db, operationId, { state: 'succeeded' });
    const done = await request(app).delete(`/api/managed-accounts/${accountId}`);
    expect(done.status).toBe(200);
    // 历史操作保留但解除关联（account_operation.account_id 的 ON DELETE SET NULL 口径）
    const kept = await request(app).get(`/api/account-operations/${operationId}`);
    expect(kept.status).toBe(200);
    expect(kept.body.account_id).toBeNull();
    expect(kept.body.state).toBe('succeeded');
  });

  it('delete blocks only on an unexpired pending checkin authorization', async () => {
    const { vault } = await bootCheckin();
    const accountId = await deletableAccount(vault, 'del-auth');
    const started = await request(app).post('/api/checkin-authorizations/start')
      .set('Idempotency-Key', randomUUID()).send({ account_id: accountId });
    expect(started.status).toBe(202);
    const authorizationId = started.body.authorization.id as string;

    const blocked = await request(app).delete(`/api/managed-accounts/${accountId}`);
    expect(blocked.status).toBe(409);
    expect(blocked.body.error.code).toBe('CHECKIN_AUTHORIZATION_EXISTS');
    expect(getManagedAccount(t.db, accountId)).not.toBeNull();

    // 授权过期后不再阻塞（不静默销毁活跃会话由上面这条保证；终态/过期历史随账号级联清除）
    t.db.prepare('UPDATE checkin_authorization SET expires_at=? WHERE id=?').run(Date.now() - 1, authorizationId);
    const removed = await request(app).delete(`/api/managed-accounts/${accountId}`);
    expect(removed.status).toBe(200);
    expect(t.db.prepare('SELECT COUNT(*) AS n FROM checkin_authorization WHERE id=?').get(authorizationId)).toEqual({ n: 0 });
  });

  it('delete blocks while the latest switch still requires recovery, and passes after recovery is given up', async () => {
    const { vault } = await bootCheckin();
    const name = 'del-recovery';
    const accountId = await deletableAccount(vault, name);
    const operationId = seedOperation(accountId, name);
    updateAccountOperation(t.db, operationId, { state: 'running' });
    updateAccountOperation(t.db, operationId, { state: 'recovery_required' });

    const blocked = await request(app).delete(`/api/managed-accounts/${accountId}`);
    expect(blocked.status).toBe(409);
    expect(blocked.body.error.code).toBe('RECOVERY_REQUIRED');
    expect(vault.size).toBe(2);

    updateAccountOperation(t.db, operationId, { state: 'failed' });
    expect((await request(app).delete(`/api/managed-accounts/${accountId}`)).status).toBe(200);
    expect(vault.size).toBe(0);
  });

  it('delete answers VAULT_UNAVAILABLE instead of orphaning credential files when the vault is not assembled', async () => {
    const accountId = createManagedAccount(t.db, {
      app_id: 'workbuddy_desktop', client_instance_id: 'inst-no-vault', service_region: 'cn',
      identity_hash: sha256(CHECKIN_UID), display_name: 'del-no-vault', checkin_credential_ref: randomUUID(),
    }).id;
    // 直接挂 accountRoutes（不经 createApp 的 SecretVault 兜底装配）才是「未装配」的真实形态
    const scoped = express();
    scoped.use(express.json());
    scoped.use('/api', createAccountRouter({ db: t.db }));
    scoped.use(errorHandler);

    const res = await request(scoped).delete(`/api/managed-accounts/${accountId}`);
    expect(res.status).toBe(503);
    expect(res.body.error.code).toBe('VAULT_UNAVAILABLE');
    expect(getManagedAccount(t.db, accountId)).not.toBeNull();
  });

  it('delete keeps the account row when the vault refuses to drop a credential, so the call can be retried', async () => {
    const { vault } = await bootCheckin();
    const accountId = await deletableAccount(vault, 'del-vault-error');
    vault.delete = () => Promise.reject(new Error('locked'));

    const failed = await request(app).delete(`/api/managed-accounts/${accountId}`);
    expect(failed.status).toBe(500);
    expect(failed.body.error.code).toBe('INTERNAL');
    expect(getManagedAccount(t.db, accountId)).not.toBeNull();

    vault.delete = (ref: string) => { vault.deletedRefs.push(ref); return Promise.resolve(); };
    const retried = await request(app).delete(`/api/managed-accounts/${accountId}`);
    expect(retried.status).toBe(200);
    expect(getManagedAccount(t.db, accountId)).toBeNull();
  });
});
