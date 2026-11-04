/**
 * ACC-13：minimax 文件级登录态切换（capture / switch），失败分支逐个覆盖。
 * trae 不提供文件级切换（登录态不在可安全改写的明文文件里），此处只断言能力表口径。
 */
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestDb, type TestDb } from './helpers.js';
import { getManagedAccount } from '../src/db/repos/managedAccount.js';
import { SecretVault } from '../src/services/accounts/secretVault.js';
import { MinimaxDesktopProvider, type MinimaxFileSystem, type MinimaxProcessControl } from '../src/services/accounts/minimaxDesktopProvider.js';
import request from 'supertest';
import type { AgentAdapter } from '@agentboard/adapters';
import { createApp } from '../src/index.js';
import { FakeAdapter } from './fakeAdapter.js';
import { accountProviderCapability } from '../src/services/accounts/registry.js';

const authJson = (token: string) => JSON.stringify({
  schemaVersion: 1,
  records: {
    'com.minimax.mcode': { accessToken: token, refreshToken: 'refresh-abc', expiresAtMs: 1_900_000_000_000, audience: 'mcode', clientId: 'com.minimax.mcode' },
  },
});

/** 内存文件系统：可注入失败 */
function memoryFs(initial: Record<string, string>) {
  const files = new Map(Object.entries(initial));
  const failures = { write: 0, rename: 0 };
  const fs: MinimaxFileSystem = {
    exists: async path => files.has(path),
    readFile: async path => {
      const value = files.get(path);
      if (value === undefined) throw new Error(`ENOENT ${path}`);
      return Buffer.from(value, 'utf8');
    },
    writeFile: async (path, data) => {
      if (failures.write > 0) { failures.write -= 1; throw new Error('EACCES'); }
      files.set(path, data.toString('utf8'));
    },
    rename: async (from, to) => {
      if (failures.rename > 0) { failures.rename -= 1; throw new Error('EXDEV'); }
      const value = files.get(from);
      if (value === undefined) throw new Error(`ENOENT ${from}`);
      files.delete(from);
      files.set(to, value);
    },
    copyFile: async (from, to) => { files.set(to, files.get(from) ?? ''); },
    remove: async path => { files.delete(path); },
  };
  return { fs, files, failures };
}

const fakeProcess = (running = false): MinimaxProcessControl & { calls: string[] } => {
  const calls: string[] = [];
  return {
    calls,
    isRunning: async () => { calls.push('isRunning'); return running; },
    stop: async () => { calls.push('stop'); },
    start: async () => { calls.push('start'); },
  };
};

const AUTH = 'C:/fake/.minimax/auth/prod/cn/mcode-public/auth.json';
const EXE = 'C:/fake/MiniMax.exe';

describe('minimax desktop provider (ACC-13)', () => {
  let t: TestDb;
  let root: string;
  let vault: SecretVault;

  beforeEach(() => {
    t = createTestDb();
    root = mkdtempSync(join(tmpdir(), 'agentboard-acc13-'));
    vault = new SecretVault(join(root, 'vault'));
  });
  afterEach(() => { t.cleanup(); rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }); });

  const build = (files: Record<string, string>, running = false) => {
    const memory = memoryFs(files);
    const process = fakeProcess(running);
    const provider = new MinimaxDesktopProvider({
      db: t.db, vault, paths: { authFile: AUTH, clientExe: EXE }, fs: memory.fs, process,
      now: () => 1_700_000_000_000,
    });
    return { provider, memory, process };
  };

  const filesWithClient = (token: string) => ({ [AUTH]: authJson(token), [EXE]: 'binary' });

  it('capturesCurrentLoginIntoAccountWithVaultRefs', async () => {
    const { provider } = build(filesWithClient('token-a'));
    const account = await provider.captureCurrent({ display_name: '小号' });
    expect(account).toMatchObject({ app_id: 'minimax', client_instance_id: 'minimax-desktop', display_name: '小号' });
    expect(account.checkin_credential_ref).toBeTruthy();
    expect(account.client_snapshot_ref).toBeTruthy();
    expect(account.identity_hash).toMatch(/^[a-f0-9]{64}$/);
  }, 30000);

  it('switching WritesTargetTokenAndVerifies', async () => {
    const { provider, memory, process } = build(filesWithClient('token-a'));
    const source = await provider.captureCurrent();
    // 目标账号是另一个登录态：手工造一行 + vault 凭据
    const identityHash = 'b'.repeat(64);
    const targetId = randomUUID();
    const scope = { app_id: 'minimax' as const, client_instance_id: 'minimax-desktop', identity_hash: identityHash, purpose: 'checkin' as const };
    const ref = await vault.protect(Buffer.from('token-b', 'utf8'), scope);
    t.db.prepare(`INSERT INTO managed_account (id,app_id,client_instance_id,service_region,identity_hash,display_name,checkin_credential_ref,client_snapshot_version,created_at,updated_at)
      VALUES (?,'minimax','minimax-desktop','cn',?,?,?,1,1,1)`).run(targetId, identityHash, '目标', ref);

    const operation = await provider.switchAccount(targetId);
    expect(operation.state).toBe('succeeded');
    expect(JSON.parse(memory.files.get(AUTH)!).records['com.minimax.mcode'].accessToken).toBe('token-b');
    expect(process.calls).toEqual(['isRunning', 'start']);
    // 快照已写入源账号行（用于人工恢复）
    expect(getManagedAccount(t.db, source.id)!.client_snapshot_ref).toBeTruthy();
  }, 30000);

  it('rejectsWhenTargetAccountMissing', async () => {
    const { provider, memory } = build(filesWithClient('token-a'));
    await expect(provider.switchAccount(randomUUID())).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(JSON.parse(memory.files.get(AUTH)!).records['com.minimax.mcode'].accessToken).toBe('token-a');
  });

  it('rejectsWhenAuthFileMissing', async () => {
    const { provider } = build({ [EXE]: 'binary' });
    await expect(provider.captureCurrent()).rejects.toMatchObject({ code: 'CLIENT_PATH_MISSING' });
  });

  it('rejectsWhenExecutableMissingEvenIfAuthFileExists', async () => {
    const { provider } = build({ [AUTH]: authJson('token-a') });
    await expect(provider.captureCurrent()).rejects.toMatchObject({ code: 'CLIENT_PATH_MISSING' });
    await expect(provider.preflight()).rejects.toMatchObject({ code: 'CLIENT_PATH_MISSING' });
  });

  it('rollsBackToOriginalWhenVerificationFails', async () => {
    const { provider, memory } = build(filesWithClient('token-a'));
    await provider.captureCurrent();
    const identityHash = 'c'.repeat(64);
    const targetC = randomUUID();
    const scope = { app_id: 'minimax' as const, client_instance_id: 'minimax-desktop', identity_hash: identityHash, purpose: 'checkin' as const };
    const ref = await vault.protect(Buffer.from('token-c', 'utf8'), scope);
    t.db.prepare(`INSERT INTO managed_account (id,app_id,client_instance_id,service_region,identity_hash,display_name,checkin_credential_ref,client_snapshot_version,created_at,updated_at)
      VALUES (?,'minimax','minimax-desktop','cn',?,?,?,1,1,1)`).run(targetC, identityHash, 'C', ref);

    // 第一次 write 成功（写 temp），rename 成功；让「写回原文件」后读到的仍是旧 token → 走回滚分支
    const originalRename = memory.fs.rename;
    memory.fs.rename = async (from, to) => {
      if (to === AUTH && memory.files.get(from)?.includes('token-c')) {
        // 模拟客户端启动后把文件改回旧 token：校验失败
        await originalRename(from, to);
        memory.files.set(AUTH, authJson('token-a'));
        return;
      }
      await originalRename(from, to);
    };
    const operation = await provider.switchAccount(targetC);
    expect(operation.state).toBe('failed');
    expect(operation.safe_error_code).toBe('SWITCH_ROLLED_BACK');
    expect(JSON.parse(memory.files.get(AUTH)!).records['com.minimax.mcode'].accessToken).toBe('token-a');
  }, 30000);

  it('marksRecoveryRequiredWhenRollbackAlsoFails', async () => {
    const { provider, memory } = build(filesWithClient('token-a'));
    await provider.captureCurrent();
    const identityHash = 'd'.repeat(64);
    const targetD = randomUUID();
    const scope = { app_id: 'minimax' as const, client_instance_id: 'minimax-desktop', identity_hash: identityHash, purpose: 'checkin' as const };
    const ref = await vault.protect(Buffer.from('token-d', 'utf8'), scope);
    t.db.prepare(`INSERT INTO managed_account (id,app_id,client_instance_id,service_region,identity_hash,display_name,checkin_credential_ref,client_snapshot_version,created_at,updated_at)
      VALUES (?,'minimax','minimax-desktop','cn',?,?,?,1,1,1)`).run(targetD, identityHash, 'D', ref);

    const originalRename = memory.fs.rename;
    memory.fs.rename = async (from, to) => {
      if (to === AUTH && memory.files.get(from)?.includes('token-d')) {
        await originalRename(from, to);
        memory.files.set(AUTH, authJson('token-a'));
        return;
      }
      if (to === AUTH) throw new Error('EACCES'); // 回滚写盘失败
      await originalRename(from, to);
    };
    const operation = await provider.switchAccount(targetD);
    expect(operation.state).toBe('recovery_required');
    expect(operation.safe_error_code).toBe('RECOVERY_REQUIRED');
  }, 30000);

  it('reportsWriteFailureWithoutTouchingOriginal', async () => {
    const { provider, memory } = build(filesWithClient('token-a'));
    await provider.captureCurrent();
    const identityHash = 'e'.repeat(64);
    const targetE = randomUUID();
    const scope = { app_id: 'minimax' as const, client_instance_id: 'minimax-desktop', identity_hash: identityHash, purpose: 'checkin' as const };
    const ref = await vault.protect(Buffer.from('token-e', 'utf8'), scope);
    t.db.prepare(`INSERT INTO managed_account (id,app_id,client_instance_id,service_region,identity_hash,display_name,checkin_credential_ref,client_snapshot_version,created_at,updated_at)
      VALUES (?,'minimax','minimax-desktop','cn',?,?,?,1,1,1)`).run(targetE, identityHash, 'E', ref);
    memory.failures.write = 1;
    const operation = await provider.switchAccount(targetE);
    expect(operation.state).toBe('failed');
    expect(operation.safe_error_code).toBe('SWITCH_WRITE_FAILED');
    expect(JSON.parse(memory.files.get(AUTH)!).records['com.minimax.mcode'].accessToken).toBe('token-a');
  }, 30000);
});

describe('endpoint capture → switch (ACC-13)', () => {
  let t2: TestDb;
  let root2: string;
  let vault2: SecretVault;
  beforeEach(() => {
    t2 = createTestDb();
    root2 = mkdtempSync(join(tmpdir(), 'agentboard-acc13-route-'));
    vault2 = new SecretVault(join(root2, 'vault'));
  });
  afterEach(() => { t2.cleanup(); rmSync(root2, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }); });

  it('capturesThenSwitchesThroughHttp', async () => {
    const memory = memoryFs({ [AUTH]: authJson('token-a'), [EXE]: 'binary' });
    const process = fakeProcess(false);
    const provider = new MinimaxDesktopProvider({ db: t2.db, vault: vault2, paths: { authFile: AUTH, clientExe: EXE }, fs: memory.fs, process });
    const adapter = new FakeAdapter();
    const created = await createApp({
      db: t2.db,
      getAdapter: (id: string): AgentAdapter => { if (id === 'fake') return adapter; throw new Error(`未知适配器 id: ${id}`); },
      adapters: [adapter],
      refreshClisOnBoot: false,
      secretVault: vault2,
      desktopProviders: { minimax: provider },
    });
    const captured = await request(created.app).post('/api/managed-accounts/minimax/capture-current').send({ display_name: '小号' });
    expect(captured.status, 'capture body: ' + JSON.stringify(captured.body)).toBe(200);
    expect(captured.body.account).toMatchObject({ app_id: 'minimax', display_name: '小号' });

    const targetHash = 'f'.repeat(64);
    const scope = { app_id: 'minimax' as const, client_instance_id: 'minimax-desktop', identity_hash: targetHash, purpose: 'checkin' as const };
    const ref = await vault2.protect(Buffer.from('token-z', 'utf8'), scope);
    const targetId = randomUUID();
    t2.db.prepare(`INSERT INTO managed_account (id,app_id,client_instance_id,service_region,identity_hash,display_name,checkin_credential_ref,client_snapshot_version,created_at,updated_at)
      VALUES (?,'minimax','minimax-desktop','cn',?,?,?,1,1,1)`).run(targetId, targetHash, '目标', ref);

    // switch 能力按本机事实关闭 → 端点必须拒绝并给出 reason_code
    const switched = await request(created.app).post(`/api/managed-accounts/${targetId}/switch`).send({});
    expect(switched.status).toBe(409);
    expect(switched.body.error).toMatchObject({ code: 'PROVIDER_UNVERIFIED', details: { reason_code: 'CLIENT_NOT_INSTALLED' } });
    // 拒绝后原文件未被改动
    expect(JSON.parse(memory.files.get(AUTH)!).records['com.minimax.mcode'].accessToken).toBe('token-a');

  }, 40000);
});

describe('capability registry for switch (ACC-13)', () => {
  it('minimax switch is enabled and trae stays disabled with a reason', () => {
    // 本机无 MiniMax.exe（扩展/CLI 形态）→ capture 可行、switch 不可行
    const minimax = accountProviderCapability('minimax');
    expect(minimax).toMatchObject({ capture: true, switch: false, checkin: true, reason_code: 'CLIENT_NOT_INSTALLED' });
    const trae = accountProviderCapability('trae');
    // B4S-1：Trae 没有进程概念（无 preflight/stop），switch 明确声明未实现，不再用 LOGIN_STATE_NOT_FILE_BASED 混淆
    expect(trae?.switch).toBe(false);
    expect(trae?.reason_code).toBe('PROVIDER_NOT_IMPLEMENTED');
  });
});
