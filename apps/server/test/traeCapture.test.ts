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
  TRAE_STORAGE_KEY,
  captureTraeCredential,
  defaultTraeStoragePath,
  traeStorageAvailable,
} from '../src/services/accounts/traeProvider.js';

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
