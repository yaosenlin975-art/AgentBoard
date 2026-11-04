/**
 * B4S-3：共用 S3（validate_target）/ S5（服务端身份校验）骨架 + 回滚落 A3 restore 通道。
 *
 * 三条主线：
 * 1. **S3/S5 失败码清单**：每一步失败都有固定码，不含凭据与原始异常文本；
 * 2. **MiniMax 注入「服务端身份不符」→ 进入 pendingRecovery 且可 restore**（贴状态迁移）；
 * 3. **幂等**：重复 restore 不新建操作（replayed=true）；restore 失败可再次触发。
 */
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createTestDb, type TestDb } from './helpers.js';
import {
  credentialUid,
  SWITCH_STAGE_ERROR_CODES,
  validateTarget,
  verifyByServerUid,
  type ServerIdentityProbe,
} from '../src/services/accounts/switchStages.js';
import { MinimaxDesktopProvider, type MinimaxFileSystem, type MinimaxProcessControl } from '../src/services/accounts/minimaxDesktopProvider.js';
import { startAccountRestore } from '../src/services/accounts/restore.js';
import { SecretVault } from '../src/services/accounts/secretVault.js';
import { ApiError } from '../src/errors.js';
import type { ManagedAccount } from '@agentboard/shared';

const AUTH = 'C:/fake/.minimax/auth/prod/cn/mcode-public/auth.json';
const EXE = 'C:/fake/MiniMax.exe';

const jwtToken = (sub: string): string => `h.${Buffer.from(JSON.stringify({ sub }), 'utf8').toString('base64url')}.s`;

const account = (over: Partial<ManagedAccount> = {}): ManagedAccount => ({
  id: randomUUID(), app_id: 'minimax', client_instance_id: 'minimax-desktop', service_region: 'cn',
  identity_hash: 'a'.repeat(64), display_name: '账号', identity_hint: null,
  client_snapshot_ref: null, checkin_credential_ref: null, client_snapshot_version: 1,
  checkin_capability: 'unknown', enabled: true, last_checkin_day: null, last_checkin_status: null,
  last_checkin_at: null, created_at: 1, updated_at: 1, ...over,
});

describe('B4S-3 switch stages', () => {
  describe('S3 validate_target', () => {
    it('listsFixedErrorCodes', () => {
      // 失败码清单是契约：固定大写码，不含凭据与原始异常文本
      for (const code of SWITCH_STAGE_ERROR_CODES) expect(code).toMatch(/^[A-Z][A-Z0-9_]*$/);
      expect(SWITCH_STAGE_ERROR_CODES).toContain('TARGET_CREDENTIAL_MISSING');
      expect(SWITCH_STAGE_ERROR_CODES).toContain('SERVER_IDENTITY_MISMATCH');
    });

    it('rejectsMissingAccount', () => {
      expect(() => validateTarget({ app_id: 'minimax', account: null, credential: Buffer.from('x') }))
        .toThrowError(expect.objectContaining({ code: 'TARGET_ACCOUNT_NOT_FOUND' }));
    });

    it('rejectsForeignProduct', () => {
      expect(() => validateTarget({ app_id: 'minimax', account: account({ app_id: 'trae' }), credential: Buffer.from('x'), uid: 'u' }))
        .toThrowError(expect.objectContaining({ code: 'ACCOUNT_APP_MISMATCH' }));
    });

    it('rejectsEmptyCredential', () => {
      expect(() => validateTarget({ app_id: 'minimax', account: account(), credential: Buffer.alloc(0), uid: 'u' }))
        .toThrowError(expect.objectContaining({ code: 'TARGET_CREDENTIAL_MISSING' }));
    });

    it('acceptsTargetWithoutIdentityAndDefersToS5', () => {
      // S3 只管「目标能不能用」：身份取不到不在这里拦（那是 S5 的比对基准问题）
      const result = validateTarget({ app_id: 'minimax', account: account(), credential: Buffer.from('x'), uid: null });
      expect(result.uid).toBeNull();
      expect(result.credential.length).toBe(1);
    });

    it('acceptsValidTarget', () => {
      const result = validateTarget({ app_id: 'minimax', account: account(), credential: Buffer.from('cred'), uid: 'uid-1' });
      expect(result.uid).toBe('uid-1');
    });
  });

  describe('S5 verify by server uid', () => {
    it('reportsProviderNotImplementedWithoutProbe', async () => {
      await expect(verifyByServerUid({ app_id: 'trae', token: 't', expectedUid: 'u', probe: null }))
        .rejects.toMatchObject({ code: 'PROVIDER_NOT_IMPLEMENTED' });
    });

    it('reportsUnknownTargetIdentityWhenNoBaselineToCompare', async () => {
      // 目标身份取不到 → 没有比对基准，S5 明确报 TARGET_IDENTITY_UNKNOWN（不是「比对通过」）
      const probe: ServerIdentityProbe = { probe: async () => ({ uid: 'u' }) };
      await expect(verifyByServerUid({ app_id: 'minimax', token: 't', expectedUid: null, probe }))
        .rejects.toMatchObject({ code: 'TARGET_IDENTITY_UNKNOWN' });
    });

    it('reportsServerRejectedCredential', async () => {
      const probe: ServerIdentityProbe = { probe: async () => { throw new Error('boom'); } };
      await expect(verifyByServerUid({ app_id: 'minimax', token: 't', expectedUid: 'u', probe }))
        .rejects.toMatchObject({ code: 'SERVER_CREDENTIAL_REJECTED' });
    });

    it('reportsServerIdentityUnavailable', async () => {
      const probe: ServerIdentityProbe = { probe: async () => ({ uid: null }) };
      await expect(verifyByServerUid({ app_id: 'minimax', token: 't', expectedUid: 'u', probe }))
        .rejects.toMatchObject({ code: 'SERVER_IDENTITY_UNAVAILABLE' });
    });

    it('reportsServerIdentityMismatch', async () => {
      const probe: ServerIdentityProbe = { probe: async () => ({ uid: 'other-uid' }) };
      await expect(verifyByServerUid({ app_id: 'minimax', token: 't', expectedUid: 'u', probe }))
        .rejects.toMatchObject({ code: 'SERVER_IDENTITY_MISMATCH' });
    });

    it('passesWhenServerIdentityMatches', async () => {
      const probe: ServerIdentityProbe = { probe: async () => ({ uid: 'u' }) };
      await expect(verifyByServerUid({ app_id: 'minimax', token: 't', expectedUid: 'u', probe })).resolves.toBeUndefined();
    });
  });

  describe('credentialUid', () => {
    it('readsServerSignedSubjectFromJwt', () => {
      expect(credentialUid(jwtToken('uid-x'))).toBe('uid-x');
      expect(credentialUid('not-a-jwt')).toBeNull();
    });
  });
});

/** 内存文件系统（MiniMax 切换用）；`failOnWrite` 让第 N 次写盘失败（模拟回滚写盘失败） */
function memoryFs(initial: Record<string, string>, failOnWrite: number | null = null) {
  const files = new Map(Object.entries(initial));
  let writes = 0;
  const fs: MinimaxFileSystem = {
    exists: async path => files.has(path),
    readFile: async path => {
      const value = files.get(path);
      if (value === undefined) throw new Error(`ENOENT ${path}`);
      return Buffer.from(value, 'utf8');
    },
    writeFile: async (path, data) => {
      writes += 1;
      if (failOnWrite !== null && writes === failOnWrite) throw new Error('EACCES');
      files.set(path, data.toString('utf8'));
    },
    rename: async (from, to) => {
      const value = files.get(from);
      if (value === undefined) throw new Error(`ENOENT ${from}`);
      files.delete(from);
      files.set(to, value);
    },
    copyFile: async (from, to) => { files.set(to, files.get(from) ?? ''); },
    remove: async path => { files.delete(path); },
  };
  return { fs, files, writeCount: () => writes };
}

const fakeProcess = (): MinimaxProcessControl => ({
  isRunning: async () => false,
  stop: async () => {},
  start: async () => {},
});

describe('B4S-3 minimax server-side identity check + rollback into A3 restore', () => {
  it('serverIdentityMismatchEntersPendingRecoveryAndRestoreUnfreezesIt', async () => {
    const t: TestDb = createTestDb();
    const dir = mkdtempSync(join(tmpdir(), 'agentboard-b4s3-'));
    const vault = new SecretVault(join(dir, 'vault'));
    const token = jwtToken('uid-target');
    // 第 2 次写盘失败 = 写目标凭据成功、回滚写快照失败 → RECOVERY_REQUIRED
    const memory = memoryFs({
      [AUTH]: JSON.stringify({ schemaVersion: 1, records: { 'com.minimax.mcode': { accessToken: jwtToken('uid-current'), expiresAtMs: 1_900_000_000_000 } } }),
      [EXE]: 'binary',
    }, 2);
    // 服务端回报的身份与目标不一致 → S5 失败
    const provider = new MinimaxDesktopProvider({
      db: t.db, vault, paths: { authFile: AUTH, clientExe: EXE }, fs: memory.fs, process: fakeProcess(),
      serverIdentityProbe: { probe: async () => ({ uid: 'uid-someone-else' }) },
    });
    await provider.captureCurrent();
    const identityHash = 'b'.repeat(64);
    const targetId = randomUUID();
    const scope = { app_id: 'minimax' as const, client_instance_id: 'minimax-desktop', identity_hash: identityHash, purpose: 'checkin' as const };
    const ref = await vault.protect(Buffer.from(token, 'utf8'), scope);
    t.db.prepare(`INSERT INTO managed_account (id,app_id,client_instance_id,service_region,identity_hash,display_name,checkin_credential_ref,client_snapshot_version,created_at,updated_at)
      VALUES (?,'minimax','minimax-desktop','cn',?,?,?,1,1,1)`).run(targetId, identityHash, '目标', ref);

    const operation = await provider.switchAccount(targetId);
    // S5 失败 → 回滚；回滚也失败 → recovery_required（pendingRecovery）
    expect(operation.state).toBe('recovery_required');
    expect(operation.safe_error_code).toBe('RECOVERY_REQUIRED');
    // 冻结时记下恢复依据（快照 ref，UUID）
    expect(operation.recovery_ref).toMatch(/^[0-9a-f-]{36}$/);
    expect((t.db.prepare("SELECT COUNT(*) c FROM account_operation WHERE state='recovery_required'").get() as { c: number }).c).toBe(1);

    // restore 端点：处理器把快照写回客户端 → 解冻
    const restored = await startAccountRestore(t.db, targetId, {
      minimax: async ({ account: acc, snapshotRef }) => { await provider.restoreFromSnapshot({ account: acc, snapshotRef: snapshotRef! }); },
    });
    expect(restored.replayed).toBe(false);
    expect(restored.operation.state).toBe('succeeded');
    // 原操作被收尾为 failed(RESTORED)，实例解冻
    const original = t.db.prepare('SELECT state,safe_error_code FROM account_operation WHERE id=?').get(restored.recovered_operation_id) as { state: string; safe_error_code: string };
    expect(original).toEqual({ state: 'failed', safe_error_code: 'RESTORED' });
    expect((t.db.prepare("SELECT COUNT(*) c FROM account_operation WHERE state='recovery_required'").get() as { c: number }).c).toBe(0);

    // 幂等：再调一次 restore 不新建操作（replayed=true）
    const again = await startAccountRestore(t.db, targetId, {
      minimax: async ({ account: acc, snapshotRef }) => { await provider.restoreFromSnapshot({ account: acc, snapshotRef: snapshotRef! }); },
    });
    expect(again.replayed).toBe(true);
    expect(again.operation.id).toBe(restored.operation.id);
    // switch + restore = 2 行（MiniMax 的 capture 不建 operation 行），重放没有新建
    expect((t.db.prepare('SELECT COUNT(*) c FROM account_operation').get() as { c: number }).c).toBe(2);
    t.cleanup();
    rmSync(dir, { recursive: true, force: true });
  }, 30000);

  it('reportsProviderNotImplementedAndRollsBackWhenNoServerProbeIsWired', async () => {
    // 能力缺失的平台要如实报 PROVIDER_NOT_IMPLEMENTED（不拿本地比对冒充服务端校验），并走回滚
    const t: TestDb = createTestDb();
    const dir = mkdtempSync(join(tmpdir(), 'agentboard-b4s3c-'));
    const vault = new SecretVault(join(dir, 'vault'));
    const current = jwtToken('uid-current');
    const memory = memoryFs({
      [AUTH]: JSON.stringify({ schemaVersion: 1, records: { 'com.minimax.mcode': { accessToken: current, expiresAtMs: 1_900_000_000_000 } } }),
      [EXE]: 'binary',
    });
    const provider = new MinimaxDesktopProvider({
      db: t.db, vault, paths: { authFile: AUTH, clientExe: EXE }, fs: memory.fs, process: fakeProcess(),
      // 不注入 serverIdentityProbe → provider 默认没有服务端校验能力
    });
    await provider.captureCurrent();
    const identityHash = 'd'.repeat(64);
    const targetId = randomUUID();
    const scope = { app_id: 'minimax' as const, client_instance_id: 'minimax-desktop', identity_hash: identityHash, purpose: 'checkin' as const };
    const ref = await vault.protect(Buffer.from(jwtToken('uid-target'), 'utf8'), scope);
    t.db.prepare(`INSERT INTO managed_account (id,app_id,client_instance_id,service_region,identity_hash,display_name,checkin_credential_ref,client_snapshot_version,created_at,updated_at)
      VALUES (?,'minimax','minimax-desktop','cn',?,?,?,1,1,1)`).run(targetId, identityHash, '目标', ref);

    const operation = await provider.switchAccount(targetId);
    expect(operation.state).toBe('failed');
    expect(operation.safe_error_code).toBe('SWITCH_ROLLED_BACK');
    // 回滚成功 → 客户端文件回到原账号（实例不冻结）
    expect(JSON.parse(memory.files.get(AUTH)!).records['com.minimax.mcode'].accessToken).toBe(current);
    expect((t.db.prepare("SELECT COUNT(*) c FROM account_operation WHERE state='recovery_required'").get() as { c: number }).c).toBe(0);
    t.cleanup();
    rmSync(dir, { recursive: true, force: true });
  }, 30000);

  it('restoreFailureKeepsInstanceFrozenAndAllowsRetry', async () => {
    const t: TestDb = createTestDb();
    const dir = mkdtempSync(join(tmpdir(), 'agentboard-b4s3b-'));
    const vault = new SecretVault(join(dir, 'vault'));
    const memory = memoryFs({
      [AUTH]: JSON.stringify({ schemaVersion: 1, records: { 'com.minimax.mcode': { accessToken: jwtToken('uid-current'), expiresAtMs: 1_900_000_000_000 } } }),
      [EXE]: 'binary',
    }, 2);
    const provider = new MinimaxDesktopProvider({
      db: t.db, vault, paths: { authFile: AUTH, clientExe: EXE }, fs: memory.fs, process: fakeProcess(),
      serverIdentityProbe: { probe: async () => ({ uid: 'uid-someone-else' }) },
    });
    await provider.captureCurrent();
    const identityHash = 'c'.repeat(64);
    const targetId = randomUUID();
    const scope = { app_id: 'minimax' as const, client_instance_id: 'minimax-desktop', identity_hash: identityHash, purpose: 'checkin' as const };
    const ref = await vault.protect(Buffer.from(jwtToken('uid-target'), 'utf8'), scope);
    t.db.prepare(`INSERT INTO managed_account (id,app_id,client_instance_id,service_region,identity_hash,display_name,checkin_credential_ref,client_snapshot_version,created_at,updated_at)
      VALUES (?,'minimax','minimax-desktop','cn',?,?,?,1,1,1)`).run(targetId, identityHash, '目标', ref);

    const operation = await provider.switchAccount(targetId);
    expect(operation.state).toBe('recovery_required');

    // 处理器失败 → restore 操作失败、实例保持冻结（可再次触发）
    const failed = await startAccountRestore(t.db, targetId, {
      minimax: async () => { throw new ApiError(409, 'SNAPSHOT_WRITE_FAILED', '恢复快照失败'); },
    });
    expect(failed.operation.state).toBe('failed');
    expect(failed.operation.safe_error_code).toBe('SNAPSHOT_WRITE_FAILED');
    expect((t.db.prepare("SELECT COUNT(*) c FROM account_operation WHERE state='recovery_required'").get() as { c: number }).c).toBe(1);

    // 再触发一次：处理器这次成功 → 解冻
    const restored = await startAccountRestore(t.db, targetId, {
      minimax: async ({ account: acc, snapshotRef }) => { await provider.restoreFromSnapshot({ account: acc, snapshotRef: snapshotRef! }); },
    });
    expect(restored.operation.state).toBe('succeeded');
    expect((t.db.prepare("SELECT COUNT(*) c FROM account_operation WHERE state='recovery_required'").get() as { c: number }).c).toBe(0);
    t.cleanup();
    rmSync(dir, { recursive: true, force: true });
  }, 30000);
});
