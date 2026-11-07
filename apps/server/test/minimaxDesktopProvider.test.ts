/**
 * ACC-13：minimax 文件级登录态切换（capture / switch），失败分支逐个覆盖。
 * trae 不提供文件级切换（登录态不在可安全改写的明文文件里），此处只断言能力表口径。
 */
import { createHash, randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestDb, type TestDb } from './helpers.js';
import { ApiError } from '../src/errors.js';
import { getManagedAccount } from '../src/db/repos/managedAccount.js';
import { SecretVault } from '../src/services/accounts/secretVault.js';
import { MinimaxDesktopProvider, type MinimaxFileSystem, type MinimaxProcessControl } from '../src/services/accounts/minimaxDesktopProvider.js';
import { credentialUid } from '../src/services/accounts/switchStages.js';
import request from 'supertest';
import type { AgentAdapter } from '@agentboard/adapters';
import { createApp } from '../src/index.js';
import { FakeAdapter } from './fakeAdapter.js';
import { accountProviderCapability } from '../src/services/accounts/registry.js';
import type { MinimaxClientStatus } from '../src/services/accounts/minimaxClientProbe.js';
import { createMinimaxCheckinProvider } from '../src/services/accounts/httpCheckinProviders.js';

const authJson = (token: string) => JSON.stringify({
  schemaVersion: 1,
  records: {
    'com.minimax.mcode': { accessToken: token, refreshToken: 'refresh-abc', expiresAtMs: 1_900_000_000_000, audience: 'mcode', clientId: 'com.minimax.mcode' },
  },
});

/** ACC-FIX-5：旧版 auth.json 没有 refreshToken */
const authJsonWithoutRefresh = (token: string) => JSON.stringify({
  schemaVersion: 1,
  records: {
    'com.minimax.mcode': { accessToken: token, expiresAtMs: 1_900_000_000_000, audience: 'mcode', clientId: 'com.minimax.mcode' },
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

/** ACC-SW-MAX：start 抛错（spawn 失败）的假进程，其余同 fakeProcess */
const fakeProcessWithStartFailure = (): MinimaxProcessControl & { calls: string[] } => {
  const calls: string[] = [];
  return {
    calls,
    isRunning: async () => { calls.push('isRunning'); return false; },
    stop: async () => { calls.push('stop'); },
    start: async () => { calls.push('start'); throw new ApiError(409, 'CLIENT_START_FAILED', '启动客户端失败'); },
  };
};

const AUTH = 'C:/fake/.minimax/auth/prod/cn/mcode-public/auth.json';
const EXE = 'C:/fake/MiniMax.exe';

/**
 * B4S-3：S5 的服务端身份校验拿的是**服务端签发**的身份标识。
 * 测试里的凭据据此造带 `sub` 的 JWT，探针从凭据里取 `sub`（等价于服务端认这份凭据并回报身份）。
 */
const jwtToken = (sub: string): string => `h.${Buffer.from(JSON.stringify({ sub }), 'utf8').toString('base64url')}.s`;
const TOKEN_A = jwtToken('uid-a');
const TOKEN_B = jwtToken('uid-b');
const TOKEN_C = jwtToken('uid-c');
const TOKEN_D = jwtToken('uid-d');
const TOKEN_E = jwtToken('uid-e');
const TOKEN_Z = jwtToken('uid-z');

/** 假的服务端身份探针：服务端认可这份凭据，并回报凭据里的身份标识 */
const fakeServerProbe = { probe: async (token: string) => ({ uid: credentialUid(token) }) };

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
      serverIdentityProbe: fakeServerProbe,
      // ACC-SW-MAX：失败分支测试不等 20s 真实窗口，注入短窗口
      verifySettleTimeoutMs: 300,
      verifyPollMs: 25,
    });
    return { provider, memory, process };
  };

  const filesWithClient = (token: string) => ({ [AUTH]: authJson(token), [EXE]: 'binary' });

  it('capturesCurrentLoginIntoAccountWithVaultRefs', async () => {
    const { provider } = build(filesWithClient(TOKEN_A));
    const account = await provider.captureCurrent({ display_name: '小号' });
    expect(account).toMatchObject({ app_id: 'minimax', client_instance_id: 'minimax-desktop', display_name: '小号' });
    expect(account.checkin_credential_ref).toBeTruthy();
    expect(account.client_snapshot_ref).toBeTruthy();
    expect(account.identity_hash).toMatch(/^[a-f0-9]{64}$/);
  }, 30000);

  it('ACC-FIX-5：capture 落 JSON 凭据（含 refresh_token）并置 checkin_capability=supported', async () => {
    const { provider } = build(filesWithClient(TOKEN_A));
    const account = await provider.captureCurrent({ display_name: '小号' });
    expect(account.checkin_capability).toBe('supported');
    const credential = await vault.unprotect(account.checkin_credential_ref!, {
      app_id: 'minimax', client_instance_id: 'minimax-desktop', identity_hash: account.identity_hash, purpose: 'checkin',
    });
    expect(JSON.parse(credential.toString('utf8'))).toEqual({
      access_token: TOKEN_A,
      refresh_token: 'refresh-abc',
      expires_at: 1_900_000_000_000,
    });
  }, 30000);

  it('ACC-FIX-5：重复 capture 命中同一行时也回填 capability 与新凭据', async () => {
    const { provider } = build(filesWithClient(TOKEN_A));
    const first = await provider.captureCurrent();
    t.db.prepare("UPDATE managed_account SET checkin_capability='unknown' WHERE id=?").run(first.id);
    const again = await provider.captureCurrent({ display_name: '改名' });
    expect(again.id).toBe(first.id);
    expect(again.checkin_capability).toBe('supported');
    expect(again.display_name).toBe('改名');
  }, 30000);

  it('ACC-FIX-5：auth.json 没有 refreshToken 时保留裸串凭据（不伪造续期能力）', async () => {
    const { provider } = build({ [AUTH]: authJsonWithoutRefresh(TOKEN_A), [EXE]: 'binary' });
    const account = await provider.captureCurrent();
    const credential = await vault.unprotect(account.checkin_credential_ref!, {
      app_id: 'minimax', client_instance_id: 'minimax-desktop', identity_hash: account.identity_hash, purpose: 'checkin',
    });
    expect(credential.toString('utf8')).toBe(TOKEN_A);
  }, 30000);

  it('ACC-FIX-5：捕获落库的 JSON 凭据可直接交给签到 provider 续期（401 自愈链路贯通）', async () => {
    const { provider } = build(filesWithClient(TOKEN_A));
    const account = await provider.captureCurrent();
    const credential = await vault.unprotect(account.checkin_credential_ref!, {
      app_id: 'minimax', client_instance_id: 'minimax-desktop', identity_hash: account.identity_hash, purpose: 'checkin',
    });
    const calls: string[] = [];
    const fetchImpl = (async (url: string | URL | Request) => {
      calls.push(String(url));
      return {
        ok: true,
        status: 200,
        json: async () => ({ access_token: 'new-token', refresh_token: 'rt-new', expires_in: 3600 }),
      };
    }) as unknown as typeof fetch;
    const checkin = createMinimaxCheckinProvider({ app_id: 'minimax', region: 'cn', provider_version: 'test', fetchImpl });
    const next = await checkin.refreshCredential!(credential);
    expect(next).not.toBeNull();
    const payload = JSON.parse(next!.toString('utf8')) as { access_token: string; refresh_token: string; expires_at: number };
    expect(payload.access_token).toBe('new-token');
    expect(payload.refresh_token).toBe('rt-new');
    expect(payload.expires_at).toBeGreaterThan(Date.now());
    expect(calls).toEqual(['https://account.minimax.cn/oauth2/token']);
  }, 30000);

  it('ACC-SW-MAX：切换到 JSON 凭据账号时同写 refreshToken 与 expiresAtMs', async () => {
    const { provider, memory } = build(filesWithClient(TOKEN_A));
    await provider.captureCurrent();
    const identityHash = 'a'.repeat(64);
    const targetId = randomUUID();
    const scope = { app_id: 'minimax' as const, client_instance_id: 'minimax-desktop', identity_hash: identityHash, purpose: 'checkin' as const };
    const ref = await vault.protect(Buffer.from(JSON.stringify({ access_token: TOKEN_B, refresh_token: 'rt-b', expires_at: 1_800_000_000_000 }), 'utf8'), scope);
    t.db.prepare(`INSERT INTO managed_account (id,app_id,client_instance_id,service_region,identity_hash,display_name,checkin_credential_ref,client_snapshot_version,created_at,updated_at)
      VALUES (?,'minimax','minimax-desktop','cn',?,?,?,1,1,1)`).run(targetId, identityHash, '目标 JSON', ref);

    const operation = await provider.switchAccount(targetId);
    expect(operation.state).toBe('succeeded');
    const record = JSON.parse(memory.files.get(AUTH)!).records['com.minimax.mcode'];
    expect(record.accessToken).toBe(TOKEN_B);
    expect(record.refreshToken).toBe('rt-b');
    expect(record.expiresAtMs).toBe(1_800_000_000_000);
  }, 30000);

  it('ACC-SW-MAX：JSON 凭据缺 refresh_token/expires_at 时只写 accessToken，不伪造续期能力', async () => {
    const { provider, memory } = build(filesWithClient(TOKEN_A));
    await provider.captureCurrent();
    const identityHash = 'a'.repeat(64);
    const targetId = randomUUID();
    const scope = { app_id: 'minimax' as const, client_instance_id: 'minimax-desktop', identity_hash: identityHash, purpose: 'checkin' as const };
    const ref = await vault.protect(Buffer.from(JSON.stringify({ access_token: TOKEN_B }), 'utf8'), scope);
    t.db.prepare(`INSERT INTO managed_account (id,app_id,client_instance_id,service_region,identity_hash,display_name,checkin_credential_ref,client_snapshot_version,created_at,updated_at)
      VALUES (?,'minimax','minimax-desktop','cn',?,?,?,1,1,1)`).run(targetId, identityHash, '目标 窄JSON', ref);

    const operation = await provider.switchAccount(targetId);
    expect(operation.state).toBe('succeeded');
    const record = JSON.parse(memory.files.get(AUTH)!).records['com.minimax.mcode'];
    expect(record.accessToken).toBe(TOKEN_B);
    expect(record.refreshToken).toBe('refresh-abc'); // 原文件字段原样保留，不凭空造 refreshToken
    expect(record.expiresAtMs).toBe(1_900_000_000_000);
  }, 30000);

  it('ACC-SW-MAX：records 键收敛为目标账号快照里的记录键（不产生并存键）', async () => {
    const { provider, memory } = build(filesWithClient(TOKEN_A));
    await provider.captureCurrent();
    const identityHash = 'a'.repeat(64);
    const targetId = randomUUID();
    const scope = { app_id: 'minimax' as const, client_instance_id: 'minimax-desktop', identity_hash: identityHash, purpose: 'checkin' as const };
    const ref = await vault.protect(Buffer.from(TOKEN_B, 'utf8'), scope);
    // 目标账号被捕获时的快照：记录键与源文件不同（键尾 43 字符摘要无法从凭据推导，只能复用捕获产物）
    const targetSnapshot = JSON.stringify({
      schemaVersion: 1,
      records: { 'com.target.account': { accessToken: TOKEN_B, refreshToken: 'rt-b', expiresAtMs: 1_800_000_000_000, clientId: 'com.target.account' } },
    });
    const snapshotRef = await vault.protect(Buffer.from(targetSnapshot, 'utf8'), scope);
    t.db.prepare(`INSERT INTO managed_account (id,app_id,client_instance_id,service_region,identity_hash,display_name,checkin_credential_ref,client_snapshot_ref,client_snapshot_version,created_at,updated_at)
      VALUES (?,'minimax','minimax-desktop','cn',?,?,?,? ,1,1,1)`).run(targetId, identityHash, '目标键', ref, snapshotRef);

    const operation = await provider.switchAccount(targetId);
    expect(operation.state).toBe('succeeded');
    const file = JSON.parse(memory.files.get(AUTH)!);
    expect(Object.keys(file.records)).toEqual(['com.target.account']);
    expect(file.records['com.target.account'].accessToken).toBe(TOKEN_B);
  }, 30000);

  it('readsCurrentIdentityHashFromAuthFileWithoutClientExe', async () => {
    const { provider } = build({ [AUTH]: authJson(TOKEN_A) });
    expect(await provider.getCurrentIdentityHash()).toBe(
      createHash('sha256').update(`minimax\u0000com.minimax.mcode`).digest('hex'),
    );
  });

  it('returnsNullCurrentIdentityWhenAuthFileMissingOrCorrupt', async () => {
    const { provider } = build({});
    expect(await provider.getCurrentIdentityHash()).toBeNull();
    const corrupt = build({ [AUTH]: '{not-json' });
    expect(await corrupt.provider.getCurrentIdentityHash()).toBeNull();
  });

  it('serializesConcurrentSwitchesOnSameClientInstance', async () => {
    const { provider, memory, process } = build(filesWithClient(TOKEN_A));
    await provider.captureCurrent();

    // 两个不同目标账号（凭据各自独立）
    const makeTarget = async (token: string, displayName: string) => {
      const identityHash = createHash('sha256').update(`target\u0000${token}`).digest('hex');
      const id = randomUUID();
      const ref = await vault.protect(Buffer.from(token, 'utf8'), { app_id: 'minimax', client_instance_id: 'minimax-desktop', identity_hash: identityHash, purpose: 'checkin' });
      t.db.prepare(`INSERT INTO managed_account (id,app_id,client_instance_id,service_region,identity_hash,display_name,checkin_credential_ref,client_snapshot_version,created_at,updated_at)
        VALUES (?,'minimax','minimax-desktop','cn',?,?,?,1,1,1)`).run(id, identityHash, displayName, ref);
      return id;
    };
    const targetB = await makeTarget(TOKEN_B, '目标 B');
    const targetC = await makeTarget(TOKEN_C, '目标 C');

    // 在写盘处记录并发度：同一时刻只允许一个切换在写客户端
    let active = 0;
    let maxActive = 0;
    const originalWrite = memory.fs.writeFile;
    memory.fs.writeFile = async (path, data) => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise(resolve => setTimeout(resolve, 25));
      try { await originalWrite(path, data, 0o600); } finally { active -= 1; }
    };

    const [first, second] = await Promise.allSettled([provider.switchAccount(targetB), provider.switchAccount(targetC)]);
    const settled = [first, second];
    const succeeded = settled.filter(item => item.status === 'fulfilled') as PromiseFulfilledResult<Awaited<ReturnType<typeof provider.switchAccount>>>[];
    const rejected = settled.filter(item => item.status === 'rejected') as PromiseRejectedResult[];
    // ACC-SWITCH：同一实例同时只允许一个切换（第二个立刻 409 ACCOUNT_BUSY），不出现双写
    expect(succeeded).toHaveLength(1);
    expect(succeeded[0]!.value.state).toBe('succeeded');
    expect(rejected).toHaveLength(1);
    expect((rejected[0]!.reason as { code?: string }).code).toBe('ACCOUNT_BUSY');
    expect(maxActive).toBe(1);
    // 只跑了一轮探测/启动，被拒的那一路没有碰客户端
    expect(process.calls).toEqual(['isRunning', 'start']);
  }, 30000);

  it('switching WritesTargetTokenAndVerifies', async () => {
    const { provider, memory, process } = build(filesWithClient(TOKEN_A));
    const source = await provider.captureCurrent();
    // 目标账号是另一个登录态：手工造一行 + vault 凭据
    const identityHash = 'b'.repeat(64);
    const targetId = randomUUID();
    const scope = { app_id: 'minimax' as const, client_instance_id: 'minimax-desktop', identity_hash: identityHash, purpose: 'checkin' as const };
    const ref = await vault.protect(Buffer.from(TOKEN_B, 'utf8'), scope);
    t.db.prepare(`INSERT INTO managed_account (id,app_id,client_instance_id,service_region,identity_hash,display_name,checkin_credential_ref,client_snapshot_version,created_at,updated_at)
      VALUES (?,'minimax','minimax-desktop','cn',?,?,?,1,1,1)`).run(targetId, identityHash, '目标', ref);

    const operation = await provider.switchAccount(targetId);
    expect(operation.state).toBe('succeeded');
    const record = JSON.parse(memory.files.get(AUTH)!).records['com.minimax.mcode'];
    // ACC-SW-MAX：裸串（旧形态）目标只写 accessToken，原 refreshToken/expiresAtMs 原样保留
    expect(record.accessToken).toBe(TOKEN_B);
    expect(record.refreshToken).toBe('refresh-abc');
    expect(process.calls).toEqual(['isRunning', 'start']);
    // 快照已写入源账号行（用于人工恢复）
    expect(getManagedAccount(t.db, source.id)!.client_snapshot_ref).toBeTruthy();
  }, 30000);

  it('ACC-SW-MAX：start 成功走通全链（spawn 已装配进默认 process）', async () => {
    const { provider, memory, process } = build(filesWithClient(TOKEN_A));
    const source = await provider.captureCurrent();
    const identityHash = 'f'.repeat(64);
    const targetId = randomUUID();
    const scope = { app_id: 'minimax' as const, client_instance_id: 'minimax-desktop', identity_hash: identityHash, purpose: 'checkin' as const };
    const ref = await vault.protect(Buffer.from(TOKEN_Z, 'utf8'), scope);
    t.db.prepare(`INSERT INTO managed_account (id,app_id,client_instance_id,service_region,identity_hash,display_name,checkin_credential_ref,client_snapshot_version,created_at,updated_at)
      VALUES (?,'minimax','minimax-desktop','cn',?,?,?,1,1,1)`).run(targetId, identityHash, '同号目标', ref);

    const operation = await provider.switchAccount(targetId);
    expect(operation.state).toBe('succeeded');
    expect(process.calls).toEqual(['isRunning', 'start']);
    expect(JSON.parse(memory.files.get(AUTH)!).records['com.minimax.mcode'].accessToken).toBe(TOKEN_Z);
    expect(getManagedAccount(t.db, source.id)!.client_snapshot_ref).toBeTruthy();
  }, 30000);

  it('ACC-SW-MAX：start 抛错 → 回滚到快照（原文件恢复，SWITCH_ROLLED_BACK）', async () => {
    const memory = memoryFs(filesWithClient(TOKEN_A));
    const process = fakeProcessWithStartFailure();
    const provider = new MinimaxDesktopProvider({
      db: t.db, vault, paths: { authFile: AUTH, clientExe: EXE }, fs: memory.fs, process,
      now: () => 1_700_000_000_000,
      serverIdentityProbe: fakeServerProbe,
    });
    await provider.captureCurrent();
    const identityHash = 'b'.repeat(64);
    const targetId = randomUUID();
    const scope = { app_id: 'minimax' as const, client_instance_id: 'minimax-desktop', identity_hash: identityHash, purpose: 'checkin' as const };
    const ref = await vault.protect(Buffer.from(TOKEN_B, 'utf8'), scope);
    t.db.prepare(`INSERT INTO managed_account (id,app_id,client_instance_id,service_region,identity_hash,display_name,checkin_credential_ref,client_snapshot_version,created_at,updated_at)
      VALUES (?,'minimax','minimax-desktop','cn',?,?,?,1,1,1)`).run(targetId, identityHash, 'start失败', ref);

    const operation = await provider.switchAccount(targetId);
    expect(operation.state).toBe('failed');
    expect(operation.safe_error_code).toBe('SWITCH_ROLLED_BACK');
    // 客户端文件已回滚为原内容
    expect(JSON.parse(memory.files.get(AUTH)!).records['com.minimax.mcode'].accessToken).toBe(TOKEN_A);
    // ACC-SW-MAX：回滚前必须先停客户端（isRunning 探测 → start 失败 → rollback 里 stop → 恢复）
    expect(process.calls).toEqual(['isRunning', 'start', 'stop']);
  }, 30000);

  it('ACC-SW-MAX：verify 等待客户端启动归一化后再判定（不与启动写盘竞态）', async () => {
    const memory = memoryFs(filesWithClient(TOKEN_A));
    const process = fakeProcess(false);
    const provider = new MinimaxDesktopProvider({
      db: t.db, vault, paths: { authFile: AUTH, clientExe: EXE }, fs: memory.fs, process,
      now: () => 1_700_000_000_000,
      serverIdentityProbe: fakeServerProbe,
      verifySettleTimeoutMs: 5_000,
      verifyPollMs: 25,
    });
    await provider.captureCurrent();
    const identityHash = 'c'.repeat(64);
    const targetId = randomUUID();
    const scope = { app_id: 'minimax' as const, client_instance_id: 'minimax-desktop', identity_hash: identityHash, purpose: 'checkin' as const };
    const ref = await vault.protect(Buffer.from(TOKEN_B, 'utf8'), scope);
    t.db.prepare(`INSERT INTO managed_account (id,app_id,client_instance_id,service_region,identity_hash,display_name,checkin_credential_ref,client_snapshot_version,created_at,updated_at)
      VALUES (?,'minimax','minimax-desktop','cn',?,?,?,1,1,1)`).run(targetId, identityHash, '启动慢', ref);

    // 模拟客户端启动归一化：切换写入后先短暂回到旧 token，150ms 后客户端落回目标 token
    const originalRename = memory.fs.rename;
    memory.fs.rename = async (from, to) => {
      await originalRename(from, to);
      if (to === AUTH && memory.files.get(from)?.includes(TOKEN_B)) {
        memory.files.set(AUTH, authJson(TOKEN_A));
        setTimeout(() => { memory.files.set(AUTH, authJson(TOKEN_B)); }, 150);
      }
    };
    const operation = await provider.switchAccount(targetId);
    expect(operation.state).toBe('succeeded');
    expect(JSON.parse(memory.files.get(AUTH)!).records['com.minimax.mcode'].accessToken).toBe(TOKEN_B);
    expect(process.calls).toEqual(['isRunning', 'start']);
  }, 30000);

  it('ACC-SW-MAX：切到当前同号 → 幂等成功（真机单活跃账号口径）', async () => {
    const { provider, memory, process } = build(filesWithClient(TOKEN_A));
    const source = await provider.captureCurrent();
    const operation = await provider.switchAccount(source.id);
    expect(operation.state).toBe('succeeded');
    const record = JSON.parse(memory.files.get(AUTH)!).records['com.minimax.mcode'];
    expect(record.accessToken).toBe(TOKEN_A);
    expect(record.refreshToken).toBe('refresh-abc');
    expect(process.calls).toEqual(['isRunning', 'start']);
  }, 30000);

  it('rejectsWhenTargetAccountMissing', async () => {
    const { provider, memory } = build(filesWithClient(TOKEN_A));
    await expect(provider.switchAccount(randomUUID())).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(JSON.parse(memory.files.get(AUTH)!).records['com.minimax.mcode'].accessToken).toBe(TOKEN_A);
  });

  it('rejectsWhenAuthFileMissing', async () => {
    const { provider } = build({ [EXE]: 'binary' });
    await expect(provider.captureCurrent()).rejects.toMatchObject({ code: 'CLIENT_PATH_MISSING' });
  });

  it('rejectsWhenExecutableMissingEvenIfAuthFileExists', async () => {
    const { provider } = build({ [AUTH]: authJson(TOKEN_A) });
    await expect(provider.captureCurrent()).rejects.toMatchObject({ code: 'CLIENT_PATH_MISSING' });
    await expect(provider.preflight()).rejects.toMatchObject({ code: 'CLIENT_PATH_MISSING' });
  });

  it('rollsBackToOriginalWhenVerificationFails', async () => {
    const { provider, memory } = build(filesWithClient(TOKEN_A));
    await provider.captureCurrent();
    const identityHash = 'c'.repeat(64);
    const targetC = randomUUID();
    const scope = { app_id: 'minimax' as const, client_instance_id: 'minimax-desktop', identity_hash: identityHash, purpose: 'checkin' as const };
    const ref = await vault.protect(Buffer.from(TOKEN_C, 'utf8'), scope);
    t.db.prepare(`INSERT INTO managed_account (id,app_id,client_instance_id,service_region,identity_hash,display_name,checkin_credential_ref,client_snapshot_version,created_at,updated_at)
      VALUES (?,'minimax','minimax-desktop','cn',?,?,?,1,1,1)`).run(targetC, identityHash, 'C', ref);

    // 第一次 write 成功（写 temp），rename 成功；让「写回原文件」后读到的仍是旧 token → 走回滚分支
    const originalRename = memory.fs.rename;
    memory.fs.rename = async (from, to) => {
      if (to === AUTH && memory.files.get(from)?.includes(TOKEN_C)) {
        // 模拟客户端启动后把文件改回旧 token：校验失败
        await originalRename(from, to);
        memory.files.set(AUTH, authJson(TOKEN_A));
        return;
      }
      await originalRename(from, to);
    };
    const operation = await provider.switchAccount(targetC);
    expect(operation.state).toBe('failed');
    expect(operation.safe_error_code).toBe('SWITCH_ROLLED_BACK');
    expect(JSON.parse(memory.files.get(AUTH)!).records['com.minimax.mcode'].accessToken).toBe(TOKEN_A);
  }, 30000);

  it('marksRecoveryRequiredWhenRollbackAlsoFails', async () => {
    const { provider, memory } = build(filesWithClient(TOKEN_A));
    await provider.captureCurrent();
    const identityHash = 'd'.repeat(64);
    const targetD = randomUUID();
    const scope = { app_id: 'minimax' as const, client_instance_id: 'minimax-desktop', identity_hash: identityHash, purpose: 'checkin' as const };
    const ref = await vault.protect(Buffer.from(TOKEN_D, 'utf8'), scope);
    t.db.prepare(`INSERT INTO managed_account (id,app_id,client_instance_id,service_region,identity_hash,display_name,checkin_credential_ref,client_snapshot_version,created_at,updated_at)
      VALUES (?,'minimax','minimax-desktop','cn',?,?,?,1,1,1)`).run(targetD, identityHash, 'D', ref);

    const originalRename = memory.fs.rename;
    memory.fs.rename = async (from, to) => {
      if (to === AUTH && memory.files.get(from)?.includes(TOKEN_D)) {
        await originalRename(from, to);
        memory.files.set(AUTH, authJson(TOKEN_A));
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
    const { provider, memory } = build(filesWithClient(TOKEN_A));
    await provider.captureCurrent();
    const identityHash = 'e'.repeat(64);
    const targetE = randomUUID();
    const scope = { app_id: 'minimax' as const, client_instance_id: 'minimax-desktop', identity_hash: identityHash, purpose: 'checkin' as const };
    const ref = await vault.protect(Buffer.from(TOKEN_E, 'utf8'), scope);
    t.db.prepare(`INSERT INTO managed_account (id,app_id,client_instance_id,service_region,identity_hash,display_name,checkin_credential_ref,client_snapshot_version,created_at,updated_at)
      VALUES (?,'minimax','minimax-desktop','cn',?,?,?,1,1,1)`).run(targetE, identityHash, 'E', ref);
    memory.failures.write = 1;
    const operation = await provider.switchAccount(targetE);
    expect(operation.state).toBe('failed');
    expect(operation.safe_error_code).toBe('SWITCH_WRITE_FAILED');
    expect(JSON.parse(memory.files.get(AUTH)!).records['com.minimax.mcode'].accessToken).toBe(TOKEN_A);
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
    const memory = memoryFs({ [AUTH]: authJson(TOKEN_A), [EXE]: 'binary' });
    const process = fakeProcess(false);
    const provider = new MinimaxDesktopProvider({ db: t2.db, vault: vault2, paths: { authFile: AUTH, clientExe: EXE }, fs: memory.fs, process, serverIdentityProbe: fakeServerProbe });
    // ACC-SW-MAX：gate 与能力矩阵同一探测口径——注入可变的探测结果，先 installed（放行）后 not installed（拒绝）
    let probeStatus: MinimaxClientStatus = { installed: true, exe: EXE, source: 'override', reason_code: 'CLIENT_READY', message: '', probed: [] };
    const mutableProbe = { get: async () => probeStatus, reset: () => {} };
    const adapter = new FakeAdapter();
    const created = await createApp({
      db: t2.db,
      getAdapter: (id: string): AgentAdapter => { if (id === 'fake') return adapter; throw new Error(`未知适配器 id: ${id}`); },
      adapters: [adapter],
      refreshClisOnBoot: false,
      secretVault: vault2,
      desktopProviders: { minimax: provider },
      minimaxClientProbe: mutableProbe,
    });
    const captured = await request(created.app).post('/api/managed-accounts/minimax/capture-current').send({ display_name: '小号' });
    expect(captured.status, 'capture body: ' + JSON.stringify(captured.body)).toBe(200);
    expect(captured.body.account).toMatchObject({ app_id: 'minimax', display_name: '小号' });

    const targetHash = 'f'.repeat(64);
    const scope = { app_id: 'minimax' as const, client_instance_id: 'minimax-desktop', identity_hash: targetHash, purpose: 'checkin' as const };
    const ref = await vault2.protect(Buffer.from(TOKEN_Z, 'utf8'), scope);
    const targetId = randomUUID();
    t2.db.prepare(`INSERT INTO managed_account (id,app_id,client_instance_id,service_region,identity_hash,display_name,checkin_credential_ref,client_snapshot_version,created_at,updated_at)
      VALUES (?,'minimax','minimax-desktop','cn',?,?,?,1,1,1)`).run(targetId, targetHash, '目标', ref);

    // 探测到客户端（installed）→ gate 放行，切换端点返回 operation 并最终 succeeded
    const switched = await request(created.app).post(`/api/managed-accounts/${targetId}/switch`).send({});
    expect(switched.status, 'switch body: ' + JSON.stringify(switched.body)).toBe(202);
    expect(switched.body.operation_id).toMatch(/^[0-9a-f-]{36}$/);
    let final: { state: string } | null = null;
    for (let i = 0; i < 200; i++) {
      const op = await request(created.app).get(`/api/account-operations/${switched.body.operation_id}`);
      if (['succeeded', 'failed', 'recovery_required'].includes(op.body.state)) { final = op.body; break; }
      await new Promise(resolve => setTimeout(resolve, 25));
    }
    expect(final).not.toBeNull();
    expect(final!.state).toBe('succeeded');
    expect(JSON.parse(memory.files.get(AUTH)!).records['com.minimax.mcode'].accessToken).toBe(TOKEN_Z);

    // 探测未安装 → gate 与能力矩阵同口径拒绝，原文件未被改动
    probeStatus = { installed: false, exe: null, source: null, reason_code: 'CLIENT_NOT_INSTALLED', message: '', probed: [] };
    const rejected = await request(created.app).post(`/api/managed-accounts/${targetId}/switch`).send({});
    expect(rejected.status).toBe(409);
    expect(rejected.body.error).toMatchObject({ code: 'PROVIDER_UNVERIFIED', details: { reason_code: 'CLIENT_NOT_INSTALLED' } });
    expect(JSON.parse(memory.files.get(AUTH)!).records['com.minimax.mcode'].accessToken).toBe(TOKEN_Z);
  }, 40000);
});

describe('ACC-CUR-FIX:切换成功后 identity_hash 收敛到登录态派生', () => {
  let t: TestDb;
  let root: string;
  let vault: SecretVault;

  beforeEach(() => {
    t = createTestDb();
    root = mkdtempSync(join(tmpdir(), 'agentboard-acccurfix-'));
    vault = new SecretVault(join(root, 'vault'));
  });
  afterEach(() => { t.cleanup(); rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }); });

  const loginHashOf = (recordKey: string) => createHash('sha256').update(`minimax\u0000${recordKey}`).digest('hex');
  const RECORD_KEY = 'com.minimax.mcode';
  const LOGIN_HASH = loginHashOf(RECORD_KEY);
  /** protocol 线建号派生(ACC-FIX-6 兜底):sha256(app_id+NUL+uid),uid = sha256(token) 截 16 */
  const protocolHashOf = (token: string) => {
    const uid = createHash('sha256').update(token).digest('hex').slice(0, 16);
    return createHash('sha256').update(`minimax\u0000${uid}`).digest('hex');
  };

  /** 与首个 describe 的 filesWithClient 同形(那里是 describe 内局部函数) */
  const filesWithClient = (token: string) => ({ [AUTH]: authJson(token), [EXE]: 'binary' });

  /** 造一个 protocol 线目标行(凭据与身份哈希同 scope 落 vault),返回行 id 与行内凭据 scope */
  const insertProtocolAccount = async (token: string, displayName: string) => {
    const identityHash = protocolHashOf(token);
    const id = randomUUID();
    const scope = { app_id: 'minimax' as const, client_instance_id: 'protocol', identity_hash: identityHash, purpose: 'checkin' as const };
    const ref = await vault.protect(Buffer.from(token, 'utf8'), scope);
    t.db.prepare(`INSERT INTO managed_account (id,app_id,client_instance_id,service_region,identity_hash,display_name,checkin_credential_ref,client_snapshot_version,created_at,updated_at)
      VALUES (?,'minimax','protocol','cn',?,?,?,1,1,1)`).run(id, identityHash, displayName, ref);
    return { id, identityHash, scope };
  };

  const buildProvider = (files: Record<string, string>, running = false) => {
    const memory = memoryFs(files);
    const process = fakeProcess(running);
    const provider = new MinimaxDesktopProvider({
      db: t.db, vault, paths: { authFile: AUTH, clientExe: EXE }, fs: memory.fs, process,
      now: () => 1_700_000_000_000,
      serverIdentityProbe: fakeServerProbe,
      verifySettleTimeoutMs: 300,
      verifyPollMs: 25,
    });
    return { provider, memory, process };
  };

  it('切到 protocol 线账号后行哈希收敛到登录态派生,凭据引用按新 scope 重护', async () => {
    const { provider } = buildProvider(filesWithClient(TOKEN_A));
    const target = await insertProtocolAccount(TOKEN_B, 'protocol 小号');
    // 前置:protocol 行哈希(凭据推导)≠ 登录态派生 → is_current 比对不上(复现根因)
    expect(target.identityHash).not.toBe(LOGIN_HASH);
    expect(await provider.getCurrentIdentityHash()).toBe(LOGIN_HASH);

    const operation = await provider.switchAccount(target.id);
    expect(operation.state).toBe('succeeded');
    const row = getManagedAccount(t.db, target.id)!;
    // 收敛:行 identity_hash 与登录态派生同源 → is_current 比对命中
    expect(row.identity_hash).toBe(LOGIN_HASH);
    expect(await provider.getCurrentIdentityHash()).toBe(row.identity_hash);
    // vault 引用已按新 scope 重护:新 scope 可解,旧 scope 解不开
    const credential = await vault.unprotect(row.checkin_credential_ref!, { ...target.scope, identity_hash: LOGIN_HASH });
    expect(credential.toString('utf8')).toBe(TOKEN_B);
    await expect(vault.unprotect(row.checkin_credential_ref!, target.scope)).rejects.toMatchObject({ code: 'VAULT_READ_FAILED' });
  }, 30000);

  it('端到端:切到 protocol 线账号后 GET /managed-accounts 的 is_current=true', async () => {
    const memory = memoryFs(filesWithClient(TOKEN_A));
    const process = fakeProcess(false);
    const provider = new MinimaxDesktopProvider({ db: t.db, vault, paths: { authFile: AUTH, clientExe: EXE }, fs: memory.fs, process, serverIdentityProbe: fakeServerProbe });
    const adapter = new FakeAdapter();
    const created = await createApp({
      db: t.db,
      getAdapter: (id: string): AgentAdapter => { if (id === 'fake') return adapter; throw new Error(`未知适配器 id: ${id}`); },
      adapters: [adapter],
      refreshClisOnBoot: false,
      secretVault: vault,
      desktopProviders: { minimax: provider },
    });
    const target = await insertProtocolAccount(TOKEN_B, 'protocol 小号');
    // 切换前列表:protocol 行 is_current=false(哈希不同源,复现根因)
    const before = await request(created.app).get('/api/managed-accounts?app=minimax');
    expect(before.status).toBe(200);
    expect(before.body.find((item: { id: string }) => item.id === target.id)?.is_current).toBe(false);

    const switched = await request(created.app).post(`/api/managed-accounts/${target.id}/switch`).send({});
    expect(switched.status).toBe(202);
    let final: { state: string } | null = null;
    for (let i = 0; i < 200; i++) {
      const op = await request(created.app).get(`/api/account-operations/${switched.body.operation_id}`);
      if (['succeeded', 'failed', 'recovery_required'].includes(op.body.state)) { final = op.body; break; }
      await new Promise(resolve => setTimeout(resolve, 25));
    }
    expect(final).not.toBeNull();
    expect(final!.state).toBe('succeeded');

    // 切换后列表:protocol 行 is_current=true(身份派生统一)
    const after = await request(created.app).get('/api/managed-accounts?app=minimax');
    expect(after.status).toBe(200);
    const row = after.body.find((item: { id: string }) => item.id === target.id);
    expect(row?.is_current).toBe(true);
    expect(row?.identity_hash).toBeUndefined(); // 公共视图不外泄 identity_hash,只断言 is_current
  }, 40000);

  it('UNIQUE(app_id,client_instance_id,identity_hash) 已被他行占用时跳过收敛,行保持旧状态', async () => {
    const { provider } = buildProvider(filesWithClient(TOKEN_A));
    // 另一行已占住 (minimax, protocol, 登录态哈希)
    const occupiedId = randomUUID();
    const occupiedRef = await vault.protect(Buffer.from(TOKEN_C, 'utf8'), { app_id: 'minimax', client_instance_id: 'protocol', identity_hash: LOGIN_HASH, purpose: 'checkin' });
    t.db.prepare(`INSERT INTO managed_account (id,app_id,client_instance_id,service_region,identity_hash,display_name,checkin_credential_ref,client_snapshot_version,created_at,updated_at)
      VALUES (?,'minimax','protocol','cn',?,?,?,1,1,1)`).run(occupiedId, LOGIN_HASH, '占位行', occupiedRef);
    const target = await insertProtocolAccount(TOKEN_B, 'protocol 小号');

    const operation = await provider.switchAccount(target.id);
    expect(operation.state).toBe('succeeded');
    const row = getManagedAccount(t.db, target.id)!;
    // 行哈希未收敛(仍为凭据推导),凭据引用仍按旧 scope 可解
    expect(row.identity_hash).toBe(target.identityHash);
    const credential = await vault.unprotect(row.checkin_credential_ref!, target.scope);
    expect(credential.toString('utf8')).toBe(TOKEN_B);
  }, 30000);

  it('捕获线行哈希本就是登录态派生,切换后原样保留(no-op)', async () => {
    const { provider, memory } = buildProvider(filesWithClient(TOKEN_A));
    const source = await provider.captureCurrent();
    expect(source.identity_hash).toBe(LOGIN_HASH);
    const target = await insertProtocolAccount(TOKEN_B, '先切走');

    const away = await provider.switchAccount(target.id);
    expect(away.state).toBe('succeeded');
    const back = await provider.switchAccount(source.id);
    expect(back.state).toBe('succeeded');
    // 切回捕获行:哈希不变,文件 token 回到 TOKEN_A
    expect(getManagedAccount(t.db, source.id)!.identity_hash).toBe(LOGIN_HASH);
    expect(JSON.parse(memory.files.get(AUTH)!).records[RECORD_KEY].accessToken).toBe(TOKEN_A);
  }, 30000);
});

describe('capability registry for switch (ACC-13 / ACC-SW-MAX)', () => {
  const probeStatus = (over: Partial<MinimaxClientStatus>): MinimaxClientStatus =>
    ({ installed: true, exe: 'C:/x/MiniMax.exe', source: 'default', reason_code: 'CLIENT_READY', message: '', probed: [], ...over });

  it('探测推导：installed → capture/switch 可用（OK）；未安装 → probe 原因码', () => {
    const installed = accountProviderCapability('minimax', probeStatus({}));
    expect(installed).toMatchObject({ capture: true, switch: true, checkin: true, reason_code: 'OK' });
    const notInstalled = accountProviderCapability('minimax', probeStatus({ installed: false, exe: null, source: null, reason_code: 'CLIENT_NOT_INSTALLED' }));
    expect(notInstalled).toMatchObject({ capture: false, switch: false, reason_code: 'CLIENT_NOT_INSTALLED' });
    // ACC-SW-TRAE：trae 行按 storage.json 存在推导（注入断言，不随测试机装没装 Trae 波动）
    expect(accountProviderCapability('trae', undefined, true)).toMatchObject({ capture: true, switch: true, reason_code: 'OK' });
    expect(accountProviderCapability('trae', undefined, false)).toMatchObject({ capture: false, switch: false, reason_code: 'TRAE_STORAGE_MISSING' });
  });

  it('未探测（静态登记）→ switch 关闭并保留 CLIENT_PROCESS_CONTROL_UNAVAILABLE', () => {
    const minimax = accountProviderCapability('minimax');
    expect(minimax).toMatchObject({ capture: true, switch: false, checkin: true, reason_code: 'CLIENT_PROCESS_CONTROL_UNAVAILABLE' });
  });
});
