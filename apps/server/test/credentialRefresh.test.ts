/**
 * ACC-TOKEN-2：凭据状态推导 + refresh-credential 端点。
 * 覆盖：迁移（纯加法+默认值+幂等）、状态判定（expiring 阈值/即时修正）、refresh_method 静态表、
 * 写入点（导入线/签到续期线）、refresh-credential 三分派（refresh_token 成功/invalid_grant/失败、
 * recapture 转发、relogin 409）与幂等重放。fake 注入沿用 FakeCheckinVault / FakeCheckinProvider 既有模式。
 */
import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import express, { type Express } from 'express';
import type { ManagedAccount } from '@agentboard/shared';
import { createTestDb, type TestDb } from './helpers.js';
import { ApiError } from '../src/errors.js';
import { errorHandler } from '../src/api/routes.js';
import { createAccountRouter, type AccountRouterDeps } from '../src/api/accountRoutes.js';
import { migrateCredentialExpiry } from '../src/db/migrations/credentialExpiry.js';
import {
  CREDENTIAL_EXPIRING_WINDOW_MS,
  createManagedAccount,
  credentialRefreshMethodFor,
  deriveCredentialStatus,
  markCredentialRefreshed,
  parseCredentialExpiry,
} from '../src/db/repos/managedAccount.js';
import { attachCheckinCredential, createCheckinBatch } from '../src/db/repos/checkin.js';
import { createCredentialImporter } from '../src/services/accounts/credentialImport.js';
import { refreshAccountCredential, type CredentialCaptureProvider } from '../src/services/accounts/credentialRefresh.js';
import { attemptMinimaxRefresh, createMinimaxCheckinProvider, parseTraeCredential } from '../src/services/accounts/httpCheckinProviders.js';
import { runCheckinBatch } from '../src/services/accounts/checkinRunner.js';
import { profileLocalDay } from '../src/services/accounts/checkinAuthorization.js';
import { FakeCheckinProvider, FakeCheckinVault, CREDENTIAL_MARK, sha256 } from './fakeCheckinProvider.js';

const HOUR = 60 * 60 * 1000;
/** 写入点用例的基准时间：真实 now（模块加载时刻），保证与 deriveCredentialStatus 的默认时钟一致 */
const NOW = Date.now();

function makeAccount(db: TestDb['db'], over: Partial<Parameters<typeof createManagedAccount>[1]> = {}): ManagedAccount {
  return createManagedAccount(db, {
    app_id: 'minimax',
    client_instance_id: 'protocol',
    service_region: 'cn',
    identity_hash: sha256(`mm-${randomUUID()}`),
    display_name: 'MiniMax 测试账号',
    ...over,
  } as never);
}

describe('credential expiry migration (ACC-TOKEN-2)', () => {
  let t: TestDb;
  beforeEach(() => { t = createTestDb(); });
  afterEach(() => { t.cleanup(); });

  const columns = (): string[] =>
    (t.db.prepare('PRAGMA table_info(managed_account)').all() as Array<{ name: string }>).map(row => row.name);

  it('initSchema 后四列存在（纯加法，无重建）', () => {
    expect(columns()).toEqual(expect.arrayContaining([
      'credential_expires_at', 'credential_status', 'credential_refresh_method', 'credential_invalid_at',
    ]));
    expect(columns().filter(name => name === 'credential_expires_at')).toHaveLength(1);
  });

  it('幂等：重复迁移结构不变', () => {
    migrateCredentialExpiry(t.db);
    const first = columns();
    migrateCredentialExpiry(t.db);
    expect(columns()).toEqual(first);
  });

  it('老库（列缺失）补回后默认值：expires/refresh_method/invalid_at 为 NULL，status 为 unknown', () => {
    t.db.exec('ALTER TABLE managed_account DROP COLUMN credential_expires_at');
    t.db.exec('ALTER TABLE managed_account DROP COLUMN credential_status');
    t.db.exec('ALTER TABLE managed_account DROP COLUMN credential_refresh_method');
    t.db.exec('ALTER TABLE managed_account DROP COLUMN credential_invalid_at');
    migrateCredentialExpiry(t.db);
    t.db.prepare(`INSERT INTO managed_account (id, app_id, client_instance_id, service_region, identity_hash, display_name, created_at, updated_at)
      VALUES ('old1','minimax','protocol','cn','hash-old1','旧账号',1,1)`).run();
    const row = t.db.prepare('SELECT * FROM managed_account WHERE id=?').get('old1') as Record<string, unknown>;
    expect(row.credential_expires_at).toBeNull();
    expect(row.credential_status).toBe('unknown');
    expect(row.credential_refresh_method).toBeNull();
    expect(row.credential_invalid_at).toBeNull();
  });
});

describe('credential status derivation (ACC-TOKEN-2)', () => {
  it('invalid_at 非空 → invalid（无论 stored/到期）', () => {
    expect(deriveCredentialStatus({ expiresAt: NOW + HOUR, invalidAt: NOW - HOUR, stored: 'valid', now: NOW })).toBe('invalid');
  });

  it('已到点 → expired；24h 内（含边界）→ expiring；充裕 → valid', () => {
    expect(deriveCredentialStatus({ expiresAt: NOW - 1, invalidAt: null, now: NOW })).toBe('expired');
    expect(deriveCredentialStatus({ expiresAt: NOW, invalidAt: null, now: NOW })).toBe('expired');
    expect(deriveCredentialStatus({ expiresAt: NOW + CREDENTIAL_EXPIRING_WINDOW_MS, invalidAt: null, now: NOW })).toBe('expiring');
    expect(deriveCredentialStatus({ expiresAt: NOW + CREDENTIAL_EXPIRING_WINDOW_MS + 1, invalidAt: null, now: NOW })).toBe('valid');
    expect(deriveCredentialStatus({ expiresAt: NOW + 5 * HOUR, invalidAt: null, now: NOW })).toBe('expiring');
  });

  it('无到期且无失效 → 落库基准值（默认 unknown）', () => {
    expect(deriveCredentialStatus({ expiresAt: null, invalidAt: null, stored: 'unknown', now: NOW })).toBe('unknown');
    expect(deriveCredentialStatus({ expiresAt: null, invalidAt: null, stored: 'valid', now: NOW })).toBe('valid');
    expect(deriveCredentialStatus({ expiresAt: null, invalidAt: null, now: NOW })).toBe('unknown');
  });

  it('parseCredentialExpiry：秒级(JWT exp)/毫秒级(workbuddy 明文)/ISO 字符串归一化为 ms', () => {
    expect(parseCredentialExpiry(1_800_000_000)).toBe(1_800_000_000_000); // 秒
    expect(parseCredentialExpiry('1796606419025')).toBe(1_796_606_419_025); // workbuddy 明文毫秒（本机实测 G2）
    expect(parseCredentialExpiry('2026-11-18T00:00:00.000Z')).toBe(Date.parse('2026-11-18T00:00:00.000Z'));
    expect(parseCredentialExpiry(null)).toBeNull();
    expect(parseCredentialExpiry('not-a-date')).toBeNull();
    expect(parseCredentialExpiry(0)).toBeNull();
  });

  it('refresh_method 静态表 ⊕ 载荷能力', () => {
    expect(credentialRefreshMethodFor('minimax', true)).toBe('refresh_token');
    expect(credentialRefreshMethodFor('minimax', false)).toBe('recapture');
    expect(credentialRefreshMethodFor('workbuddy_desktop')).toBe('recapture');
    expect(credentialRefreshMethodFor('trae')).toBe('recapture');
    expect(credentialRefreshMethodFor('qoder_cn')).toBe('relogin');
    expect(credentialRefreshMethodFor('zcode')).toBe('relogin');
    expect(credentialRefreshMethodFor('codebuddy_desktop')).toBeNull();
  });
});

describe('GET managed-accounts 即时修正 (ACC-TOKEN-2)', () => {
  let t: TestDb;
  beforeEach(() => { t = createTestDb(); });
  afterEach(() => { t.cleanup(); });

  function bootRouter(): Express {
    const app = express();
    app.use(express.json());
    app.use('/api', createAccountRouter({ db: t.db, vault: new FakeCheckinVault() }));
    app.use(errorHandler);
    return app;
  }

  it('落库 valid 但已过期 → 列表判 expired；未到点 24h 内 → expiring；无列 → unknown；不暴露 credential_invalid_at', async () => {
    const expiredAccount = makeAccount(t.db, { client_instance_id: 'p1', identity_hash: sha256(`a-${randomUUID()}`) });
    t.db.prepare("UPDATE managed_account SET credential_expires_at=?, credential_status='valid', credential_refresh_method='refresh_token' WHERE id=?")
      .run(NOW - HOUR, expiredAccount.id);
    const expiringAccount = makeAccount(t.db, { client_instance_id: 'p2', identity_hash: sha256(`b-${randomUUID()}`) });
    t.db.prepare("UPDATE managed_account SET credential_expires_at=?, credential_status='valid', credential_refresh_method='recapture' WHERE id=?")
      .run(NOW + 5 * HOUR, expiringAccount.id);
    const unknownAccount = makeAccount(t.db, { client_instance_id: 'p3', identity_hash: sha256(`c-${randomUUID()}`) });
    const app = bootRouter();
    const list = await request(app).get('/api/managed-accounts');
    expect(list.status).toBe(200);
    const byId = new Map((list.body as Array<Record<string, unknown>>).map(item => [item.id as string, item]));
    expect(byId.get(expiredAccount.id)).toMatchObject({ credential_status: 'expired', credential_expires_at: NOW - HOUR, refresh_method: 'refresh_token' });
    expect(byId.get(expiringAccount.id)).toMatchObject({ credential_status: 'expiring', refresh_method: 'recapture' });
    expect(byId.get(unknownAccount.id)).toMatchObject({ credential_status: 'unknown', credential_expires_at: null, refresh_method: null });
    expect(byId.get(expiredAccount.id)).not.toHaveProperty('credential_invalid_at');
    expect(byId.get(expiredAccount.id)).not.toHaveProperty('credential_refresh_method');
    expect(byId.get(expiredAccount.id)).not.toHaveProperty('checkin_credential_ref');
  });
});

describe('import write point (ACC-TOKEN-2)', () => {
  let t: TestDb;
  beforeEach(() => { t = createTestDb(); });
  afterEach(() => { t.cleanup(); });

  function importer(vault: FakeCheckinVault, stdout: string) {
    return createCredentialImporter({
      db: t.db,
      vault,
      runExport: () => Promise.resolve({ stdout, stderr: '', durationMs: 1 }),
      onAudit: () => undefined,
    });
  }

  it('minimax 带 refresh_token/expires_at → 三列落 refresh_token + 到期推导状态', async () => {
    const vault = new FakeCheckinVault();
    const stdout = JSON.stringify([{
      platform: 'minimax', account_key: 'uid-mm', display_hint: 'MM', token: 'mmoat_aaa', refresh_token: 'mmort_bbb', expires_at: NOW + 5 * HOUR,
    }]);
    const result = await importer(vault, stdout).importCredentials({ actor: 'test' });
    expect(result.accounts).toHaveLength(1);
    const row = t.db.prepare('SELECT * FROM managed_account').get() as Record<string, unknown>;
    expect(row.credential_expires_at).toBe(NOW + 5 * HOUR);
    expect(row.credential_status).toBe('expiring');
    expect(row.credential_refresh_method).toBe('refresh_token');
    // 载荷为 JSON（401 自愈续期依赖）
    expect(JSON.parse(vault.values()[0]!.toString('utf8'))).toMatchObject({ access_token: 'mmoat_aaa', refresh_token: 'mmort_bbb' });
  });

  it('workbuddy 导入无 expires → recapture + unknown', async () => {
    const vault = new FakeCheckinVault();
    const stdout = JSON.stringify([{ platform: 'workbuddy', account_key: 'uid-wb', token: 'jwt-token-value' }]);
    await importer(vault, stdout).importCredentials({ actor: 'test' });
    const row = t.db.prepare('SELECT * FROM managed_account').get() as Record<string, unknown>;
    expect(row.credential_refresh_method).toBe('recapture');
    expect(row.credential_expires_at).toBeNull();
    expect(row.credential_status).toBe('unknown');
  });

  it('导入过期凭据 → status=expired（按到期推导，不伪造 valid）', async () => {
    const vault = new FakeCheckinVault();
    const stdout = JSON.stringify([{
      platform: 'minimax', account_key: 'uid-mm2', token: 'mmoat_ccc', refresh_token: 'mmort_ddd', expires_at: NOW - HOUR,
    }]);
    await importer(vault, stdout).importCredentials({ actor: 'test' });
    const row = t.db.prepare('SELECT * FROM managed_account').get() as Record<string, unknown>;
    expect(row.credential_status).toBe('expired');
  });
});

describe('refresh-credential dispatch (ACC-TOKEN-2)', () => {
  let t: TestDb;
  let vault: FakeCheckinVault;
  beforeEach(() => {
    t = createTestDb();
    vault = new FakeCheckinVault();
  });
  afterEach(() => { t.cleanup(); });

  function bootRouter(): Express {
    const app = express();
    app.use(express.json());
    app.use('/api', createAccountRouter({
      db: t.db,
      vault,
      secretVault: vault as unknown as AccountRouterDeps['secretVault'],
    } as AccountRouterDeps));
    app.use(errorHandler);
    return app;
  }

  async function seedMinimax(credentialPayload: string, over: Partial<Parameters<typeof createManagedAccount>[1]> = {}): Promise<ManagedAccount> {
    const created = makeAccount(t.db, over);
    const ref = await vault.protect(Buffer.from(credentialPayload, 'utf8'), {
      app_id: created.app_id, client_instance_id: created.client_instance_id, identity_hash: created.identity_hash, purpose: 'checkin',
    });
    attachCheckinCredential(t.db, created.id, ref);
    t.db.prepare("UPDATE managed_account SET credential_refresh_method='refresh_token' WHERE id=?").run(created.id);
    return (t.db.prepare('SELECT * FROM managed_account WHERE id=?').get(created.id) as ManagedAccount);
  }

  const keyHeader = () => ({ 'Idempotency-Key': randomUUID() });

  it('refresh_token 成功：新载荷写回 + 到期列 valid + 旧 ref 删除 + grant 只发一次', async () => {
    const account = await seedMinimax(JSON.stringify({ access_token: 'mmoat_old', refresh_token: 'mmort_old', expires_at: NOW - HOUR }));
    const oldRef = account.checkin_credential_ref!;
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({
      access_token: 'mmoat_new', refresh_token: 'mmort_new', token_type: 'bearer', expires_in: 21600,
    }), { status: 200 }));
    const result = await refreshAccountCredential(
      { db: t.db, vault, resolveCapture: async () => { throw new Error('不应走 recapture'); }, fetchImpl: fetchMock },
      account,
    );
    expect(result.refreshed).toBe(true);
    expect(result.method).toBe('refresh_token');
    const row = t.db.prepare('SELECT * FROM managed_account WHERE id=?').get(account.id) as Record<string, unknown>;
    expect(row.checkin_credential_ref).not.toBe(oldRef);
    expect(row.credential_status).toBe('valid');
    expect(row.credential_invalid_at).toBeNull();
    const newPayload = JSON.parse(vault.values().find(bytes => bytes.toString('utf8').includes('mmoat_new'))!.toString('utf8'));
    expect(newPayload).toMatchObject({ access_token: 'mmoat_new', refresh_token: 'mmort_new' });
    expect(typeof newPayload.expires_at).toBe('number');
    expect(vault.deletedRefs).toContain(oldRef);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0]![0])).toContain('/oauth2/token');
  });

  it('HTTP 端点 refresh_token：202 带 account/refreshed/method；同 Idempotency-Key 重放返回首次结果且不再发 grant', async () => {
    const account = await seedMinimax(JSON.stringify({ access_token: 'mmoat_old', refresh_token: 'mmort_old', expires_at: null }));
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({
      access_token: 'mmoat_new2', refresh_token: 'mmort_new2', expires_in: 7200,
    }), { status: 200 }));
    const app = bootRouter();
    vi.stubGlobal('fetch', fetchMock);
    try {
      const key = randomUUID();
      const first = await request(app)
        .post(`/api/managed-accounts/${account.id}/refresh-credential`)
        .set('Idempotency-Key', key)
        .send({});
      expect(first.status).toBe(202);
      expect(first.body.refreshed).toBe(true);
      expect(first.body.method).toBe('refresh_token');
      // 落库写 'valid'；expires_in=7200 < 24h → 读取时即时修正为 'expiring'（设计页 §3 判定规则 2）
      expect(first.body.account.credential_status).toBe('expiring');
      expect(first.body.account.refresh_method).toBe('refresh_token');
      expect(first.body.account.credential_expires_at).toBeGreaterThan(Date.now());
      expect(first.body.account).not.toHaveProperty('checkin_credential_ref');
      expect(first.body.account).not.toHaveProperty('credential_invalid_at');
      const replay = await request(app)
        .post(`/api/managed-accounts/${account.id}/refresh-credential`)
        .set('Idempotency-Key', key)
        .send({});
      expect(replay.status).toBe(202);
      expect(replay.body).toEqual(first.body);
      expect(fetchMock).toHaveBeenCalledTimes(1);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('invalid_grant → 409 CREDENTIAL_RELOGIN_REQUIRED（body 带 reason_code/app_id）+ 行记 invalid + 列表判 invalid', async () => {
    const account = await seedMinimax(JSON.stringify({ access_token: 'mmoat_old', refresh_token: 'mmort_rot' }));
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({ error: 'invalid_grant' }), { status: 400 }));
    await expect(refreshAccountCredential(
      { db: t.db, vault, resolveCapture: async () => { throw new Error('不应走 recapture'); }, fetchImpl: fetchMock },
      account,
    )).rejects.toMatchObject({ status: 409, code: 'CREDENTIAL_RELOGIN_REQUIRED', details: { reason_code: 'CREDENTIAL_INVALID_GRANT', app_id: 'minimax' } });
    const row = t.db.prepare('SELECT * FROM managed_account WHERE id=?').get(account.id) as Record<string, unknown>;
    expect(row.credential_status).toBe('invalid');
    expect(row.credential_invalid_at).toBeGreaterThan(0);
    const app = bootRouter();
    const list = await request(app).get('/api/managed-accounts');
    const item = (list.body as Array<Record<string, unknown>>).find(entry => entry.id === account.id)!;
    expect(item.credential_status).toBe('invalid');
    expect(item.refresh_method).toBe('refresh_token');
  });

  it('grant 非法响应（非 2xx/缺字段/网络失败）→ 409 CREDENTIAL_REFRESH_FAILED，不改失效列', async () => {
    for (const fetchMock of [
      vi.fn<typeof fetch>().mockResolvedValue(new Response('boom', { status: 500 })),
      vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({ error: 'invalid_request' }), { status: 400 })),
      vi.fn<typeof fetch>().mockRejectedValue(new Error('offline')),
    ]) {
      const account = await seedMinimax(JSON.stringify({ access_token: 'mmoat_old', refresh_token: 'mmort_ok' }));
      await expect(refreshAccountCredential(
        { db: t.db, vault, resolveCapture: async () => { throw new Error('不应走 recapture'); }, fetchImpl: fetchMock },
        account,
      )).rejects.toMatchObject({ status: 409, code: 'CREDENTIAL_REFRESH_FAILED' });
      const row = t.db.prepare('SELECT credential_status, credential_invalid_at FROM managed_account WHERE id=?').get(account.id) as Record<string, unknown>;
      expect(row.credential_status).toBe('unknown');
      expect(row.credential_invalid_at).toBeNull();
    }
  });

  it('minimax 旧裸串载荷 → 降级 recapture（转发 captureCurrent）', async () => {
    const account = await seedMinimax('mmoat_bare_token');
    const captureCalls: string[] = [];
    const fakeCapture: CredentialCaptureProvider = {
      captureCurrent: async () => {
        captureCalls.push('capture');
        t.db.prepare("UPDATE managed_account SET credential_status='valid', credential_expires_at=?, credential_refresh_method='recapture' WHERE id=?")
          .run(Date.now() + 21600_000, account.id);
        return (t.db.prepare('SELECT * FROM managed_account WHERE id=?').get(account.id) as ManagedAccount);
      },
    };
    const result = await refreshAccountCredential({ db: t.db, vault, resolveCapture: async () => fakeCapture }, account);
    expect(result.method).toBe('recapture');
    expect(captureCalls).toEqual(['capture']);
    const row = t.db.prepare('SELECT credential_status FROM managed_account WHERE id=?').get(account.id) as Record<string, unknown>;
    expect(row.credential_status).toBe('valid');
  });

  it('recapture 平台转发 captureCurrent；失败透传原码（TRAE_STORAGE_MISSING）', async () => {
    const account = makeAccount(t.db, { app_id: 'trae', client_instance_id: 'trae-desktop', service_region: 'unknown' });
    t.db.prepare("UPDATE managed_account SET credential_refresh_method='recapture' WHERE id=?").run(account.id);
    const captureCalls: string[] = [];
    const okCapture: CredentialCaptureProvider = {
      captureCurrent: async () => { captureCalls.push('capture'); return account; },
    };
    const result = await refreshAccountCredential({ db: t.db, vault, resolveCapture: async () => okCapture }, account);
    expect(result.method).toBe('recapture');
    expect(captureCalls).toEqual(['capture']);

    const failing: CredentialCaptureProvider = {
      captureCurrent: async () => {
        throw Object.assign(new ApiError(409, 'TRAE_STORAGE_MISSING', '未找到 Trae 凭据文件'), {});
      },
    };
    await expect(refreshAccountCredential({ db: t.db, vault, resolveCapture: async () => failing }, account))
      .rejects.toMatchObject({ code: 'TRAE_STORAGE_MISSING' });
  });

  it('workbuddy recapture：客户端未跑（CLIENT_NOT_RUNNING）时先走插件线 backfill', async () => {
    const account = makeAccount(t.db, { app_id: 'workbuddy_desktop', client_instance_id: 'inst-wb' });
    t.db.prepare("UPDATE managed_account SET credential_refresh_method='recapture' WHERE id=?").run(account.id);
    const calls: string[] = [];
    const provider: CredentialCaptureProvider = {
      captureCurrent: async () => {
        calls.push('capture');
        throw new ApiError(409, 'CLIENT_NOT_RUNNING', 'WorkBuddy 未在运行');
      },
      backfillCheckinCredentialFromPlugin: async () => {
        calls.push('backfill');
        return account;
      },
    };
    const result = await refreshAccountCredential({ db: t.db, vault, resolveCapture: async () => provider }, account);
    expect(result.refreshed).toBe(true);
    expect(calls).toEqual(['capture', 'backfill']);
  });

  it('relogin / null → 409 CREDENTIAL_RELOGIN_REQUIRED，不发平台请求、不建 operation；409 body 带 app_id', async () => {
    const reloginAccount = makeAccount(t.db, { client_instance_id: 'protocol-r', identity_hash: sha256(`r-${randomUUID()}`) });
    t.db.prepare("UPDATE managed_account SET credential_refresh_method='relogin' WHERE id=?").run(reloginAccount.id);
    const nullAccount = makeAccount(t.db, { client_instance_id: 'protocol-n', identity_hash: sha256(`n-${randomUUID()}`) });
    const deps = { db: t.db, vault, resolveCapture: async () => { throw new Error('不应发起捕获'); } };
    await expect(refreshAccountCredential(deps, reloginAccount))
      .rejects.toMatchObject({ status: 409, code: 'CREDENTIAL_RELOGIN_REQUIRED', details: { app_id: 'minimax' } });
    await expect(refreshAccountCredential(deps, nullAccount))
      .rejects.toMatchObject({ status: 409, code: 'CREDENTIAL_RELOGIN_REQUIRED' });
    const ops = t.db.prepare('SELECT COUNT(*) AS n FROM account_operation').get() as { n: number };
    expect(ops.n).toBe(0);
    const app = bootRouter();
    const res = await request(app).post(`/api/managed-accounts/${reloginAccount.id}/refresh-credential`).set(keyHeader()).send({});
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('CREDENTIAL_RELOGIN_REQUIRED');
    expect(res.body.error.details).toMatchObject({ app_id: 'minimax', reason_code: 'CREDENTIAL_RELOGIN_REQUIRED' });
  });

  it('缺 Idempotency-Key → 400；账号不存在 → 404；body 多余字段 → 400', async () => {
    const app = bootRouter();
    const account = makeAccount(t.db, { client_instance_id: 'protocol-x', identity_hash: sha256(`x-${randomUUID()}`) });
    const noKey = await request(app).post(`/api/managed-accounts/${account.id}/refresh-credential`).send({});
    expect(noKey.status).toBe(400);
    const missing = await request(app).post(`/api/managed-accounts/${randomUUID()}/refresh-credential`).set(keyHeader()).send({});
    expect(missing.status).toBe(404);
    const badBody = await request(app).post(`/api/managed-accounts/${account.id}/refresh-credential`).set(keyHeader()).send({ foo: 1 });
    expect(badBody.status).toBe(400);
  });
});

describe('attemptMinimaxRefresh / 既有续期行为保持 (ACC-TOKEN-2)', () => {
  it('no_refresh_token → no_refresh_token', async () => {
    const outcome = await attemptMinimaxRefresh({ access_token: 'mmoat_x' }, 'cn');
    expect(outcome).toMatchObject({ ok: false, reason: 'no_refresh_token' });
  });

  it('invalid_grant 与网络失败可区分（端点据此给不同错误码）', async () => {
    const invalidGrant = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({ error: 'invalid_grant' }), { status: 400 }));
    await expect(attemptMinimaxRefresh({ access_token: 'a', refresh_token: 'r' }, 'cn', { fetchImpl: invalidGrant }))
      .resolves.toMatchObject({ ok: false, reason: 'invalid_grant' });
    const other = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({ error: 'invalid_request' }), { status: 400 }));
    await expect(attemptMinimaxRefresh({ access_token: 'a', refresh_token: 'r' }, 'cn', { fetchImpl: other }))
      .resolves.toMatchObject({ ok: false, reason: 'failed' });
  });

  it('既有 refreshMinimaxCredential（签到侧）行为不变：任何失败收敛为 null', async () => {
    const invalidGrant = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({ error: 'invalid_grant' }), { status: 400 }));
    const provider = createMinimaxCheckinProvider({ app_id: 'minimax', region: 'cn', provider_version: 'test', fetchImpl: invalidGrant });
    expect(await provider.refreshCredential!(Buffer.from(JSON.stringify({ access_token: 'a', refresh_token: 'r' }), 'utf8'))).toBeNull();
    const netFail = vi.fn<typeof fetch>().mockRejectedValue(new Error('offline'));
    const provider2 = createMinimaxCheckinProvider({ app_id: 'minimax', region: 'cn', provider_version: 'test', fetchImpl: netFail });
    expect(await provider2.refreshCredential!(Buffer.from(JSON.stringify({ access_token: 'a', refresh_token: 'r' }), 'utf8'))).toBeNull();
    const noRefresh = createMinimaxCheckinProvider({ app_id: 'minimax', region: 'cn', provider_version: 'test' });
    expect(await noRefresh.refreshCredential!(Buffer.from('bare-token'))).toBeNull();
  });
});

describe('parseTraeCredential (ACC-TOKEN-2)', () => {
  it('JSON 载荷取 token 字段；旧裸串原样（签到侧兼容）', () => {
    const json = Buffer.from(JSON.stringify({ token: 'Cloud-IDE-JWT abc', refresh_token: 'rt', expires_at: 1796606419025 }), 'utf8');
    expect(parseTraeCredential(json)).toEqual({ token: 'Cloud-IDE-JWT abc', refresh_token: 'rt', expires_at: 1796606419025 });
    expect(parseTraeCredential(Buffer.from('bare-jwt-token'))).toEqual({ token: 'bare-jwt-token' });
  });
});

describe('签到线 401 收尾落 invalid 列 (ACC-TOKEN-2)', () => {
  let t: TestDb;
  beforeEach(() => { t = createTestDb(); });
  afterEach(() => { t.cleanup(); });

  it('续期失败 → CHECKIN_CREDENTIAL_INVALID 且行记 invalid/invalid_at', async () => {
    const provider = new FakeCheckinProvider();
    provider.statusInvalidTimes = 1;
    provider.refreshedCredential = null;
    const vault = new FakeCheckinVault();
    const account = createManagedAccount(t.db, {
      app_id: 'workbuddy_desktop', client_instance_id: 'inst-inv', service_region: 'cn',
      identity_hash: sha256(`${CREDENTIAL_MARK}-inv`), display_name: '失效账号',
    });
    const ref = await vault.protect(Buffer.from(CREDENTIAL_MARK), { app_id: account.app_id, client_instance_id: account.client_instance_id, identity_hash: account.identity_hash, purpose: 'checkin' });
    attachCheckinCredential(t.db, account.id, ref);
    const batch = createCheckinBatch(t.db, { app_id: 'workbuddy_desktop', account_ids: [account.id], profile_local_day: profileLocalDay() });
    const finished = await runCheckinBatch({ db: t.db, vault, provider }, batch.id);
    expect(finished.status).toBe('failed');
    const row = t.db.prepare('SELECT credential_status, credential_invalid_at FROM managed_account WHERE id=?').get(account.id) as Record<string, unknown>;
    expect(row.credential_status).toBe('invalid');
    expect(row.credential_invalid_at).toBeGreaterThan(0);
  });

  it('续期成功 → 行 valid + 到期列取自载荷 expires_at + invalid_at 清空', async () => {
    const provider = new FakeCheckinProvider();
    provider.statusInvalidTimes = 1;
    provider.refreshedCredential = Buffer.from(JSON.stringify({ access_token: 'new', refresh_token: 'r2', expires_at: Date.now() + 7200_000 }));
    const vault = new FakeCheckinVault();
    const account = createManagedAccount(t.db, {
      app_id: 'workbuddy_desktop', client_instance_id: 'inst-ok', service_region: 'cn',
      identity_hash: sha256(`${CREDENTIAL_MARK}-ok`), display_name: '续期账号',
    });
    const ref = await vault.protect(Buffer.from(CREDENTIAL_MARK), { app_id: account.app_id, client_instance_id: account.client_instance_id, identity_hash: account.identity_hash, purpose: 'checkin' });
    attachCheckinCredential(t.db, account.id, ref);
    const batch = createCheckinBatch(t.db, { app_id: 'workbuddy_desktop', account_ids: [account.id], profile_local_day: profileLocalDay() });
    await runCheckinBatch({ db: t.db, vault, provider }, batch.id);
    const row = t.db.prepare('SELECT credential_status, credential_expires_at, credential_invalid_at FROM managed_account WHERE id=?').get(account.id) as Record<string, unknown>;
    expect(row.credential_status).toBe('valid');
    expect(row.credential_expires_at).toBeGreaterThan(Date.now());
    expect(row.credential_invalid_at).toBeNull();
  });

  it('markCredentialRefreshed 清 invalid_at 并落新到期', () => {
    const account = makeAccount(t.db, { client_instance_id: 'protocol-m', identity_hash: sha256(`m-${randomUUID()}`) });
    t.db.prepare("UPDATE managed_account SET credential_status='invalid', credential_invalid_at=123 WHERE id=?").run(account.id);
    markCredentialRefreshed(t.db, account.id, 456);
    const row = t.db.prepare('SELECT credential_status, credential_expires_at, credential_invalid_at FROM managed_account WHERE id=?').get(account.id) as Record<string, unknown>;
    expect(row).toMatchObject({ credential_status: 'valid', credential_expires_at: 456, credential_invalid_at: null });
  });
});
