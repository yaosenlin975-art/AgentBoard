/**
 * ACC-QUOTA-ALL：平台额度凭据解析（vault 签到凭据 + zcode 本机文件）。
 * - 中心库：多账号取最新 enabled；停用/无凭据/解不开各给精确 reason_code；
 * - zcode 本机文件：enc:v1 AES-256-GCM 解密（key=sha256(secret)），明文直用，坏值给 null；
 * - 隐私：missing detail 不含 token / identity_hash / 绝对路径。
 */
import { describe, expect, it } from 'vitest';
import { createCipheriv, createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createTestDb, type TestDb } from './helpers.js';
import { createManagedAccount } from '../src/db/repos/managedAccount.js';
import {
  decryptZcodeCredentialValue,
  QUOTA_SOURCE_APP_ID,
  readZcodeOauthToken,
  resolveCliAccountQuotaCredential,
  resolvePlatformQuotaCredential,
} from '../src/services/quotas/platformQuotaCredentials.js';

const hex64 = (): string => randomBytes(32).toString('hex');

/** 与 ZCode CLI createZCodeCredentialCipher 同算法的加密（测试造 enc:v1 样本用） */
function encryptZcodeValue(plain: string, secret: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', createHash('sha256').update(secret).digest(), iv);
  const encrypted = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  return `enc:v1:${[iv.toString('base64url'), cipher.getAuthTag().toString('base64url'), encrypted.toString('base64url')].join('.')}`;
}

/** 测试 secret：走 ZCODE_CREDENTIAL_SECRET env 路径，不依赖平台/用户名 */
const SECRET = 'unit-test-secret';

interface FakeVaultCall { ref: string; scope: { app_id: string; purpose: string; client_instance_id: string; identity_hash: string } }
/** 内存 vault：记录调用（断言不泄露 scope 明文），按 ref 返回凭据字节 */
function fakeVault(credentials: Record<string, Buffer>, options: { failRefs?: string[] } = {}) {
  const calls: FakeVaultCall[] = [];
  return {
    calls,
    async unprotect(ref: string, scope: { app_id: string; client_instance_id: string; identity_hash: string; purpose: 'checkin' | 'cli_credential' | 'client_snapshot' | 'pending_credential' }): Promise<Buffer> {
      calls.push({ ref, scope: { ...scope } });
      if (options.failRefs?.includes(ref)) throw new Error('DPAPI_FAIL');
      const credential = credentials[ref];
      if (!credential) throw new Error('NO_SUCH_REF');
      return credential;
    },
  };
}

function insertAccount(t: TestDb, overrides: Record<string, unknown> & { app_id: 'workbuddy_desktop' | 'codebuddy_desktop' | 'minimax' | 'trae' | 'qoder_cn' | 'zcode' }): string {
  const account = createManagedAccount(t.db, {
    client_instance_id: 'imported',
    service_region: 'cn',
    identity_hash: hex64(),
    display_name: `acct-${randomUUID().slice(0, 8)}`,
    ...overrides,
  } as Parameters<typeof createManagedAccount>[1]);
  return account.id;
}

describe('ZCode enc:v1 解密（AES-256-GCM，key=sha256(secret)）', () => {
  it('enc:v1 密文用正确 secret 可解；明文原样透传', () => {
    const encrypted = encryptZcodeValue('eyJhbGci.test-token', SECRET);
    expect(decryptZcodeCredentialValue(encrypted, { ZCODE_CREDENTIAL_SECRET: SECRET })).toBe('eyJhbGci.test-token');
    expect(decryptZcodeCredentialValue('plain-oauth-token', {})).toBe('plain-oauth-token');
  });

  it('secret 不匹配 / 格式坏 → null（不抛错）', () => {
    const encrypted = encryptZcodeValue('secret-value', SECRET);
    expect(decryptZcodeCredentialValue(encrypted, {})).toBeNull(); // 空 env → fallback 串，与测试 secret 不匹配
    expect(decryptZcodeCredentialValue(encrypted, { ZCODE_CREDENTIAL_SECRET: 'other-secret' })).toBeNull();
    expect(decryptZcodeCredentialValue('enc:v1:only-two.parts', {})).toBeNull();
  });
});

describe('readZcodeOauthToken（~/.zcode/v2/credentials.json）', () => {
  it('加密值解出 access_token；坏 JSON / 缺键 / 空文件目录 → null', () => {
    const token = 'oauth-token-abc123';
    const good = mkdtempSync(join(tmpdir(), 'zcodecred-'));
    mkdirSync(join(good, '.zcode', 'v2'), { recursive: true });
    writeFileSync(join(good, '.zcode', 'v2', 'credentials.json'), JSON.stringify({
      'oauth:bigmodel:access_token': encryptZcodeValue(token, SECRET),
      'zcodejwttoken': 'should-not-be-used',
    }), 'utf8');
    expect(readZcodeOauthToken(good, { ZCODE_CREDENTIAL_SECRET: SECRET })).toBe(token);

    const bad = mkdtempSync(join(tmpdir(), 'zcodecred-'));
    mkdirSync(join(bad, '.zcode', 'v2'), { recursive: true });
    writeFileSync(join(bad, '.zcode', 'v2', 'credentials.json'), 'not-json', 'utf8');
    expect(readZcodeOauthToken(bad, { ZCODE_CREDENTIAL_SECRET: SECRET })).toBeNull();
    expect(readZcodeOauthToken(mkdtempSync(join(tmpdir(), 'zcodecred-')), { ZCODE_CREDENTIAL_SECRET: SECRET })).toBeNull();
  });

  it('只认 oauth:bigmodel:access_token，不拿 zcodejwttoken（知识 §2：后者打 quota/limit 必 401）', () => {
    const home = mkdtempSync(join(tmpdir(), 'zcodecred-'));
    mkdirSync(join(home, '.zcode', 'v2'), { recursive: true });
    writeFileSync(join(home, '.zcode', 'v2', 'credentials.json'), JSON.stringify({ zcodejwttoken: 'jwt-only' }), 'utf8');
    expect(readZcodeOauthToken(home, {})).toBeNull();
  });
});

describe('resolvePlatformQuotaCredential（中心库 + vault）', () => {
  it('workbuddy → app_id workbuddy_desktop；取最新 enabled 账号凭据，回传 token + display_name', async () => {
    const t = createTestDb();
    try {
      const oldRef = randomUUID();
      const newRef = randomUUID();
      insertAccount(t, { app_id: 'workbuddy_desktop', display_name: '旧号', checkin_credential_ref: oldRef, client_instance_id: 'protocol' });
      const newId = insertAccount(t, { app_id: 'workbuddy_desktop', display_name: '新号', checkin_credential_ref: newRef, client_instance_id: 'imported' });
      // 同毫秒插入时排序不稳定：显式把后插账号的 updated_at 抬高，锁定「最新优先」断言
      t.db.prepare('UPDATE managed_account SET updated_at=updated_at+10 WHERE id=?').run(newId);
      const vault = fakeVault({ [newRef]: Buffer.from('wb-new-token', 'utf8'), [oldRef]: Buffer.from('wb-old-token', 'utf8') });
      const result = await resolvePlatformQuotaCredential({ db: t.db, vault, source: 'workbuddy' });
      expect(result).toEqual({ kind: 'ok', token: 'wb-new-token', accountName: '新号' });
      expect(vault.calls).toHaveLength(1);
      expect(vault.calls[0]!.scope).toMatchObject({ purpose: 'checkin', app_id: 'workbuddy_desktop' });
    } finally { t.cleanup(); }
  });

  it('指定 accountId 时严格读取该账号；禁用、平台不符与无凭据都明确返回 missing', async () => {
    const t = createTestDb();
    try {
      const oldRef = randomUUID();
      const newRef = randomUUID();
      const oldId = insertAccount(t, { app_id: 'workbuddy_desktop', display_name: '旧号', checkin_credential_ref: oldRef, client_instance_id: 'protocol' });
      const newId = insertAccount(t, { app_id: 'workbuddy_desktop', display_name: '新号', checkin_credential_ref: newRef, client_instance_id: 'imported' });
      t.db.prepare('UPDATE managed_account SET updated_at=updated_at+10 WHERE id=?').run(newId);
      const vault = fakeVault({ [oldRef]: Buffer.from('account-a-token'), [newRef]: Buffer.from('account-b-token') });

      const oldAccount = await resolvePlatformQuotaCredential({ db: t.db, vault, source: 'workbuddy', accountId: oldId });
      expect(oldAccount).toEqual({ kind: 'ok', token: 'account-a-token', accountName: '旧号' });
      expect(vault.calls[0]!.ref).toBe(oldRef);

      const minimaxId = insertAccount(t, { app_id: 'minimax', checkin_credential_ref: randomUUID() });
      const mismatch = await resolvePlatformQuotaCredential({ db: t.db, vault, source: 'workbuddy', accountId: minimaxId });
      expect(mismatch).toMatchObject({ kind: 'missing', reasonCode: 'NO_CREDENTIAL', detail: '该账号的平台与额度来源不匹配' });

      const disabledId = insertAccount(t, { app_id: 'workbuddy_desktop', checkin_credential_ref: randomUUID() });
      const { setManagedAccountEnabled } = await import('../src/db/repos/managedAccount.js');
      setManagedAccountEnabled(t.db, disabledId, false);
      const disabled = await resolvePlatformQuotaCredential({ db: t.db, vault, source: 'workbuddy', accountId: disabledId });
      expect(disabled).toMatchObject({ kind: 'missing', reasonCode: 'NO_CREDENTIAL', detail: '账号已停用，无法读取额度' });

      const noCredentialId = insertAccount(t, { app_id: 'workbuddy_desktop' });
      const noCredential = await resolvePlatformQuotaCredential({ db: t.db, vault, source: 'workbuddy', accountId: noCredentialId });
      expect(noCredential).toMatchObject({ kind: 'missing', reasonCode: 'NO_CREDENTIAL' });
      expect(noCredential).toMatchObject({ kind: 'missing', detail: expect.stringContaining('未导入') });
      const missing = await resolvePlatformQuotaCredential({ db: t.db, vault, source: 'workbuddy', accountId: randomUUID() });
      expect(missing).toMatchObject({ kind: 'missing', reasonCode: 'NO_CREDENTIAL' });
      expect(missing).toMatchObject({ kind: 'missing', detail: expect.stringContaining('账号不存在') });
    } finally { t.cleanup(); }
  });

  it('minimax JSON 凭据取 access_token；trae/qoder_cn 裸串凭据 trim 后直用', async () => {
    const t = createTestDb();
    try {
      const mmRef = randomUUID();
      const traeRef = randomUUID();
      insertAccount(t, { app_id: 'minimax', checkin_credential_ref: mmRef });
      insertAccount(t, { app_id: 'trae', checkin_credential_ref: traeRef });
      const vault = fakeVault({
        [mmRef]: Buffer.from(JSON.stringify({ access_token: 'mmoat_token', refresh_token: 'r', expires_at: 1 }), 'utf8'),
        [traeRef]: Buffer.from('  eyJhbGci.trae-jwt  \n', 'utf8'),
      });
      const minimax = await resolvePlatformQuotaCredential({ db: t.db, vault, source: 'minimax' });
      expect(minimax).toMatchObject({ kind: 'ok', token: 'mmoat_token' });
      const trae = await resolvePlatformQuotaCredential({ db: t.db, vault, source: 'trae' });
      expect(trae).toMatchObject({ kind: 'ok', token: 'eyJhbGci.trae-jwt' });
      expect(QUOTA_SOURCE_APP_ID.qoder_cn).toBe('qoder_cn');
    } finally { t.cleanup(); }
  });

  it('无账号 → 各平台精确 NO_CREDENTIAL 指引；vault 未装配 → VAULT_UNAVAILABLE', async () => {
    const t = createTestDb();
    try {
      const empty = await resolvePlatformQuotaCredential({ db: t.db, vault: fakeVault({}), source: 'qoder_cn' });
      expect(empty).toMatchObject({ kind: 'missing', reasonCode: 'NO_CREDENTIAL' });
      expect(empty.detail).toContain('Qoder');
      const noVault = await resolvePlatformQuotaCredential({ db: t.db, source: 'trae' });
      expect(noVault).toMatchObject({ kind: 'missing', reasonCode: 'VAULT_UNAVAILABLE' });
    } finally { t.cleanup(); }
  });

  it('凭据解不开 → CREDENTIAL_UNAVAILABLE；停用账号不参与；detail 不含 token/identity_hash', async () => {
    const t = createTestDb();
    try {
      const failRef = randomUUID();
      insertAccount(t, { app_id: 'trae', checkin_credential_ref: failRef });
      const vault = fakeVault({}, { failRefs: [failRef] });
      const result = await resolvePlatformQuotaCredential({ db: t.db, vault, source: 'trae' });
      expect(result).toMatchObject({ kind: 'missing', reasonCode: 'CREDENTIAL_UNAVAILABLE' });
      expect(result.detail).toContain('重新导入');
      expect(result.detail).not.toContain(failRef);

      const disabledRef = randomUUID();
      const disabledId = insertAccount(t, { app_id: 'workbuddy_desktop', checkin_credential_ref: disabledRef });
      const { setManagedAccountEnabled } = await import('../src/db/repos/managedAccount.js');
      setManagedAccountEnabled(t.db, disabledId, false);
      const disabled = await resolvePlatformQuotaCredential({ db: t.db, vault: fakeVault({ [disabledRef]: Buffer.from('x', 'utf8') }), source: 'workbuddy' });
      expect(disabled).toMatchObject({ kind: 'missing', reasonCode: 'NO_CREDENTIAL' });
    } finally { t.cleanup(); }
  });

  it('zcode：本机文件优先；无本机文件回落库内 zcode 账号', async () => {
    const t = createTestDb();
    try {
      const home = mkdtempSync(join(tmpdir(), 'zcodecred-'));
      mkdirSync(join(home, '.zcode', 'v2'), { recursive: true });
      writeFileSync(join(home, '.zcode', 'v2', 'credentials.json'), JSON.stringify({
        'oauth:bigmodel:access_token': encryptZcodeValue('local-oauth-token', SECRET),
      }), 'utf8');
      const vault = fakeVault({ [randomUUID()]: Buffer.from('vault-token-ignored', 'utf8') });
      const local = await resolvePlatformQuotaCredential({ db: t.db, vault, source: 'zcode', homeDir: home, env: { ZCODE_CREDENTIAL_SECRET: SECRET } });
      expect(local).toEqual({ kind: 'ok', token: 'local-oauth-token', accountName: null });
      expect(vault.calls).toHaveLength(0); // 本机文件命中时不碰 vault

      const ref = randomUUID();
      const accountId = insertAccount(t, { app_id: 'zcode', checkin_credential_ref: ref, display_name: '库内号' });
      const accountVault = fakeVault({ [ref]: Buffer.from('vault-zcode-token', 'utf8') });
      const accountScoped = await resolvePlatformQuotaCredential({ db: t.db, vault: accountVault, source: 'zcode', accountId, homeDir: home, env: { ZCODE_CREDENTIAL_SECRET: SECRET } });
      expect(accountScoped).toMatchObject({ kind: 'ok', token: 'vault-zcode-token', accountName: '库内号' });
      expect(accountVault.calls).toHaveLength(1); // 账号模式必须忽略本机 oauth token
      const fallback = await resolvePlatformQuotaCredential({ db: t.db, vault: fakeVault({ [ref]: Buffer.from('vault-zcode-token', 'utf8') }), source: 'zcode', homeDir: mkdtempSync(join(tmpdir(), 'zcodecred-')), env: {} });
      expect(fallback).toMatchObject({ kind: 'ok', token: 'vault-zcode-token' });
    } finally { t.cleanup(); }
  });

  it('CLI 来源传进解析器 → 如实拒绝（不是平台额度来源）', async () => {
    const t = createTestDb();
    try {
      const result = await resolvePlatformQuotaCredential({ db: t.db, source: 'deepseek' });
      expect(result).toMatchObject({ kind: 'missing', reasonCode: 'NO_CREDENTIAL' });
    } finally { t.cleanup(); }
  });

  it('Command Code 凭据只从指定 cli_account ref 与 CLI scope 读取', async () => {
    const t = createTestDb();
    try {
      const id = randomUUID();
      const identityHash = hex64();
      const ref = randomUUID();
      t.db.prepare('INSERT INTO cli_account (id,app_id,identity_hash,credential_ref,created_at,last_seen_at) VALUES (?,?,?,?,?,?)')
        .run(id, 'commandcode', identityHash, ref, 10, 20);
      const vault = fakeVault({ [ref]: Buffer.from('command-code-key') });
      const result = await resolveCliAccountQuotaCredential({
        db: t.db,
        vault,
        accountId: id,
        clientInstanceId: 'cli-local',
      });
      expect(result).toEqual({ kind: 'ok', token: 'command-code-key', accountName: null });
      expect(vault.calls).toEqual([{
        ref,
        scope: { app_id: 'commandcode', client_instance_id: 'cli-local', identity_hash: identityHash, purpose: 'cli_credential' },
      }]);
      expect(await resolveCliAccountQuotaCredential({ db: t.db, vault, accountId: randomUUID(), clientInstanceId: 'cli-local' }))
        .toMatchObject({ kind: 'missing', reasonCode: 'CREDENTIAL_MISSING' });
    } finally { t.cleanup(); }
  });
});
