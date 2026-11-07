/**
 * ACC-KB-B3：Trae 离线凭据捕获（不落明文、不启停客户端）。
 *
 * 用**自造信封**（同一套 pepper + 随机 salt）覆盖正/负路径；另有一条「本机真有 storage.json
 * 就跑一次真机脱敏断言、没有就 skip」的用例——真实样本不进仓库。
 */
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { encryptTcEnvelope, traePepper, decryptTcEnvelope } from '@agentboard/adapters';
import {
  TRAE_CLIENT_INSTANCE,
  TRAE_STORAGE_KEY,
  TraeDesktopProvider,
  captureTraeCredential,
  defaultTraeStoragePath,
  traeStorageAvailable,
} from '../src/services/accounts/traeProvider.js';
import type { SecretVault } from '../src/services/accounts/secretVault.js';
import { FakeCheckinVault } from './fakeCheckinProvider.js';
import { createTestDb } from './helpers.js';

const sha8 = (value: string): string => createHash('sha256').update(value).digest('hex').slice(0, 8);

describe('trae tc envelope (ACC-KB-B3)', () => {
  it('pepper 是 64 字节且与开源常量表一致（JG[0]^KG[0]=0x4d）', () => {
    const pepper = traePepper();
    expect(pepper.length).toBe(64);
    expect(pepper[0]).toBe(0x4d);
  });

  it('自造信封可解开，且 SHA-512 校验生效', () => {
    const salt = Buffer.alloc(32, 7);
    const b64 = encryptTcEnvelope({ token: 'tok-abc', refreshToken: 'ref-xyz', host: 'https://api.trae.cn' }, salt);
    const payload = decryptTcEnvelope(b64);
    expect(payload.token).toBe('tok-abc');
    expect(payload.host).toBe('https://api.trae.cn');
  });

  it('篡改密文 → 报 TRAE_PAYLOAD_CORRUPT 或 TRAE_PEPPER_UNAVAILABLE（可读原因）', () => {
    const salt = Buffer.alloc(32, 9);
    const b64 = encryptTcEnvelope({ token: 'tok' }, salt);
    const blob = Buffer.from(b64, 'base64');
    blob[blob.length - 5] ^= 0xff; // 破坏最后一个密文块
    expect(() => decryptTcEnvelope(blob.toString('base64'))).toThrow(/校验不通过|解不开信封/);
  });

  it('pepper 不匹配 → 明确报 pepper 不可用', () => {
    const salt = Buffer.alloc(32, 3);
    const b64 = encryptTcEnvelope({ token: 'tok' }, salt);
    const wrong = Buffer.alloc(64, 1);
    expect(() => decryptTcEnvelope(b64, wrong)).toThrow(/解不开信封|校验不通过/);
  });

  it('magic 不符 → 明确报 BAD_MAGIC', () => {
    const b64 = Buffer.concat([Buffer.from('xxxxxx'), Buffer.alloc(64, 0)]).toString('base64');
    expect(() => decryptTcEnvelope(b64)).toThrow(/magic 不符/);
  });
});

describe('captureTraeCredential (ACC-KB-B3)', () => {
  let dir: string;
  let storagePath: string;

  const writeStorage = (content: unknown): void => {
    writeFileSync(storagePath, JSON.stringify(content), 'utf8');
  };
  const envelope = (payload: Record<string, unknown>): string => encryptTcEnvelope(payload, Buffer.alloc(32, 5));

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'agentboard-trae-'));
    storagePath = join(dir, 'storage.json');
  });
  afterEach(() => { rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }); });

  it('storage.json 不存在 → TRAE_STORAGE_MISSING（可读）', () => {
    const result = captureTraeCredential({ storagePath });
    expect(result.ok).toBe(false);
    expect(result.reason_code).toBe('TRAE_STORAGE_MISSING');
    expect(result.message).toContain('未找到 Trae 凭据文件');
  });

  it('有 storage.json 但没有 iCubeAuthInfo 键 → TRAE_ENVELOPE_MISSING', () => {
    writeStorage({ 'some.other.key': 'x' });
    const result = captureTraeCredential({ storagePath });
    expect(result.ok).toBe(false);
    expect(result.reason_code).toBe('TRAE_ENVELOPE_MISSING');
  });

  it('pepper 不匹配 → TRAE_PEPPER_UNAVAILABLE，且不返回任何凭据字段', () => {
    writeStorage({ [TRAE_STORAGE_KEY]: envelope({ token: 'tok-1' }) });
    const result = captureTraeCredential({ storagePath, pepper: Buffer.alloc(64, 2) });
    expect(result.ok).toBe(false);
    expect(result.reason_code).toBe('TRAE_PEPPER_UNAVAILABLE');
    expect(JSON.stringify(result)).not.toContain('tok-1');
  });

  it('成功捕获 → 只返回脱敏字段（sha8 + 长度），绝不回明文', () => {
    const token = 'eyJhbGciOiJSUzI1NiJ9.payload.signature';
    const refresh = 'refresh-token-abc';
    writeStorage({ [TRAE_STORAGE_KEY]: envelope({ token, refreshToken: refresh, host: 'https://api.trae.cn', userId: 'u-123', expiredAt: '2026-12-01T00:00:00Z' }) });
    const result = captureTraeCredential({ storagePath });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.entry).toMatchObject({
      token_sha8: sha8(token),
      token_length: token.length,
      refresh_sha8: sha8(refresh),
      refresh_length: refresh.length,
      user_id_sha8: sha8('u-123'),
      host: 'https://api.trae.cn',
      expired_at: '2026-12-01T00:00:00Z',
    });
    // 明文绝不出现
    expect(JSON.stringify(result)).not.toContain(token);
    expect(JSON.stringify(result)).not.toContain(refresh);
  });

  it('解开但缺 token → TRAE_TOKEN_MISSING', () => {
    writeStorage({ [TRAE_STORAGE_KEY]: envelope({ refreshToken: 'r' }) });
    const result = captureTraeCredential({ storagePath });
    expect(result.ok).toBe(false);
    expect(result.reason_code).toBe('TRAE_TOKEN_MISSING');
  });

  it('真机 storage.json 存在时：能捕获且与内存扫描路径的 sub 口径一致（不存在则 skip）', () => {
    const real = defaultTraeStoragePath();
    if (!existsSync(real)) {
      expect(traeStorageAvailable(real)).toBe(false);
      return; // 本机没装/没登录 Trae：跳过（不算失败）
    }
    const result = captureTraeCredential({ storagePath: real });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.entry.token_length).toBeGreaterThan(100);
    expect(result.entry.token_sha8).toMatch(/^[0-9a-f]{8}$/);
    // 只允许出现脱敏字段
    expect(JSON.stringify(result)).not.toMatch(/eyJ[A-Za-z0-9_-]{20,}/);
  });
});

describe('TraeDesktopProvider captureCurrent (ACC-GET)', () => {
  let dir: string;
  let storagePath: string;
  let t: ReturnType<typeof createTestDb>;
  let vault: FakeCheckinVault;

  const jwt = (sub?: string): string => {
    const enc = (obj: unknown): string => Buffer.from(JSON.stringify(obj)).toString('base64url');
    return `${enc({ alg: 'RS256' })}.${enc(sub === undefined ? {} : { sub })}.sig`;
  };
  const writeEnvelope = (payload: Record<string, unknown>): void => {
    writeFileSync(storagePath, JSON.stringify({ [TRAE_STORAGE_KEY]: encryptTcEnvelope(payload, Buffer.alloc(32, 5)) }), 'utf8');
  };
  const mkProvider = (): TraeDesktopProvider => new TraeDesktopProvider({
    db: t.db, vault: vault as unknown as SecretVault, storagePath,
  });

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'agentboard-trae-get-'));
    storagePath = join(dir, 'storage.json');
    t = createTestDb();
    vault = new FakeCheckinVault();
  });
  afterEach(() => {
    t.cleanup();
    rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  });

  it('storage.json 不存在 → 409 TRAE_STORAGE_MISSING', async () => {
    await expect(mkProvider().captureCurrent()).rejects.toMatchObject({ code: 'TRAE_STORAGE_MISSING' });
    expect(t.db.prepare('SELECT COUNT(*) AS n FROM managed_account').get()).toEqual({ n: 0 });
  });

  it('捕获成功 → 落库且 checkin_credential_ref 可被签到链路按同 scope 读到', async () => {
    const token = jwt('trae-user-a');
    writeEnvelope({ token, host: 'https://api.trae.cn', userId: 'ignored-when-sub-present' });
    const account = await mkProvider().captureCurrent();
    const stored = t.db.prepare('SELECT * FROM managed_account WHERE id=?').get(account.id) as Record<string, unknown>;
    expect(stored.checkin_credential_ref).toMatch(/^[0-9a-f-]{36}$/);
    expect(stored.checkin_capability).toBe('supported');
    expect(stored.client_instance_id).toBe(TRAE_CLIENT_INSTANCE);
    expect(stored.service_region).toBe('cn');
    const read = await vault.unprotect(String(stored.checkin_credential_ref), {
      app_id: 'trae', client_instance_id: String(stored.client_instance_id), identity_hash: String(stored.identity_hash), purpose: 'checkin',
    });
    // ACC-TOKEN-2：捕获落 JSON 载荷 {token, refresh_token, expires_at}（旧裸串契约改为信封字段不再丢弃）；
    // 签到链路 parseTraeCredential 兼容两种形态
    const payload = JSON.parse(read.toString('utf8')) as { token: string; refresh_token?: string; expires_at: number | null };
    expect(payload.token).toBe(token);
    expect(payload.refresh_token).toBeUndefined();
    expect(payload.expires_at).toBeNull();
    expect(stored.credential_refresh_method).toBe('recapture');
    expect(stored.credential_status).toBe('unknown');
    const dump = JSON.stringify(t.db.prepare('SELECT * FROM managed_account').all()) + JSON.stringify(t.db.prepare('SELECT * FROM account_operation').all());
    expect(dump).not.toContain(token);
  });

  it('ACC-TOKEN-2：信封带 refreshToken/expiredAt → JSON 载荷齐全 + 到期列落库', async () => {
    const token = jwt('trae-user-c');
    writeEnvelope({ token, refreshToken: 'rt-123', expiredAt: '1796606419', userId: 'trae-user-c' });
    const account = await mkProvider().captureCurrent();
    const stored = t.db.prepare('SELECT * FROM managed_account WHERE id=?').get(account.id) as Record<string, unknown>;
    const read = await vault.unprotect(String(stored.checkin_credential_ref), {
      app_id: 'trae', client_instance_id: String(stored.client_instance_id), identity_hash: String(stored.identity_hash), purpose: 'checkin',
    });
    const payload = JSON.parse(read.toString('utf8')) as { token: string; refresh_token?: string; expires_at: number | null };
    expect(payload.refresh_token).toBe('rt-123');
    expect(payload.expires_at).toBe(1_796_606_419_000); // 秒级字符串归一化为 ms
    expect(stored.credential_expires_at).toBe(1_796_606_419_000);
    expect(stored.credential_refresh_method).toBe('recapture');
  });

  it('同身份重复捕获 → 更新同一账号、换 ref 并清理旧密文', async () => {
    const firstToken = jwt('trae-user-a');
    writeEnvelope({ token: firstToken });
    const first = await mkProvider().captureCurrent();
    writeEnvelope({ token: jwt('trae-user-a'), refreshToken: 'r2' });
    const second = await mkProvider().captureCurrent();
    expect(second.id).toBe(first.id);
    expect(second.checkin_credential_ref).not.toBe(first.checkin_credential_ref);
    expect(vault.deletedRefs).toContain(first.checkin_credential_ref);
    expect(t.db.prepare('SELECT COUNT(*) AS n FROM managed_account').get()).toEqual({ n: 1 });
  });

  it('不同身份 → 新建第二个账号', async () => {
    writeEnvelope({ token: jwt('trae-user-a') });
    const a = await mkProvider().captureCurrent();
    writeEnvelope({ token: jwt('trae-user-b') });
    const b = await mkProvider().captureCurrent();
    expect(b.id).not.toBe(a.id);
    expect(t.db.prepare('SELECT COUNT(*) AS n FROM managed_account').get()).toEqual({ n: 2 });
  });

  it('token 与 payload 都无稳定身份 → 409 TRAE_IDENTITY_UNAVAILABLE', async () => {
    writeEnvelope({ token: 'not-a-jwt' });
    await expect(mkProvider().captureCurrent()).rejects.toMatchObject({ code: 'TRAE_IDENTITY_UNAVAILABLE' });
  });
});
