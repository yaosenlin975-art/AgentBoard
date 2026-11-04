/**
 * B4S-4：共用切换骨架（S0–S5）的流程级单测。
 *
 * 两组用例：
 * 1. **骨架自身**：步序、每步失败的可定位性、start/verify 失败必回滚、write 失败不回滚、回滚收尾约定；
 * 2. **两 provider 全链路（dry-run 假客户端）**：WorkBuddy 与 MiniMax 走**同一份骨架**，
 *    成功路径的终态 stage 落点一致（verify），失败路径的阻断点可定位。
 *
 * 断言只针对骨架契约（步序 / stage / 回滚时机 / 失败码），不放宽既有 provider 用例的断言。
 */
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runSwitchFlow, switchFailureCause, type SwitchFlowCallbacks, type SwitchFlowStage } from '../src/services/accounts/switchFlow.js';
import { ApiError } from '../src/errors.js';
import { createTestDb, type TestDb } from './helpers.js';
import { SecretVault } from '../src/services/accounts/secretVault.js';
import { MinimaxDesktopProvider, type MinimaxFileSystem, type MinimaxProcessControl } from '../src/services/accounts/minimaxDesktopProvider.js';
import { credentialUid } from '../src/services/accounts/switchStages.js';
import { FakeWorkbuddyEnv, UID_A, UID_B } from './fakeWorkbuddy.js';

/** 记录调用序列的骨架夹具 */
function fixture(options: { failAt?: 'preflight' | 'stop' | 'snapshot' | 'validateTarget' | 'write' | 'start' | 'verify'; rollbackThrows?: 'SWITCH_ROLLED_BACK' | 'RECOVERY_REQUIRED' | null } = {}) {
  const calls: string[] = [];
  const stages: SwitchFlowStage[] = [];
  const boom = (step: string) => { calls.push(step); throw new ApiError(409, `FAIL_${step.toUpperCase()}`, `${step} 失败`); };
  const callbacks: SwitchFlowCallbacks<string, string> = {
    async preflight() { if (options.failAt === 'preflight') return boom('preflight'); calls.push('preflight'); },
    async stop() { if (options.failAt === 'stop') return boom('stop'); calls.push('stop'); },
    async snapshot() { if (options.failAt === 'snapshot') return boom('snapshot'); calls.push('snapshot'); return 'snap'; },
    async validateTarget() { if (options.failAt === 'validateTarget') return boom('validateTarget'); calls.push('validateTarget'); return 'target'; },
    async write(target) { if (options.failAt === 'write') return boom('write'); calls.push(`write:${target}`); },
    async start() { if (options.failAt === 'start') return boom('start'); calls.push('start'); },
    async verify() { if (options.failAt === 'verify') return boom('verify'); calls.push('verify'); },
    async rollback(snapshot, cause) {
      calls.push(`rollback:${snapshot}:${cause}`);
      if (options.rollbackThrows === 'SWITCH_ROLLED_BACK') throw new ApiError(409, 'SWITCH_ROLLED_BACK', '已回滚');
      if (options.rollbackThrows === 'RECOVERY_REQUIRED') throw new ApiError(409, 'RECOVERY_REQUIRED', '未能恢复');
    },
  };
  return { calls, stages, callbacks, run: () => runSwitchFlow({ setStage: stage => stages.push(stage), callbacks }) };
}

describe('B4S-4 共用切换骨架', () => {
  it('runsStepsInFixedOrderAndEndsAtVerify', async () => {
    const f = fixture();
    await expect(f.run()).resolves.toBe('succeeded');
    expect(f.calls).toEqual(['preflight', 'stop', 'snapshot', 'validateTarget', 'write:target', 'start', 'verify']);
    // 成功时 stage 停在 verify（运维能看到「核验完成」）
    expect(f.stages.at(-1)).toBe('verify');
  });

  it('locatesFailureAtEachStep', async () => {
    // 回调名 → 落库的 stage 名（骨架的阶段是 account_operation.stage 那一套值）
    const stageOf: Record<string, SwitchFlowStage> = {
      preflight: 'preflight', stop: 'stop', snapshot: 'snapshot',
      validateTarget: 'validate_target', write: 'write', start: 'start', verify: 'verify',
    };
    for (const step of ['preflight', 'stop', 'snapshot', 'validateTarget', 'write'] as const) {
      const f = fixture({ failAt: step });
      await expect(f.run()).rejects.toMatchObject({ code: `FAIL_${step.toUpperCase()}` });
      // 失败步之后不再继续（未触碰客户端）
      expect(f.calls.at(-1)).toBe(step);
      expect(f.stages.at(-1)).toBe(stageOf[step]);
    }
  });

  it('doesNotRollbackWhenWriteFails', async () => {
    // S4 写盘失败 = 客户端文件未被改动 → 不回滚（回滚本身也要写盘）
    const f = fixture({ failAt: 'write' });
    await expect(f.run()).rejects.toMatchObject({ code: 'FAIL_WRITE' });
    expect(f.calls.some(call => call.startsWith('rollback'))).toBe(false);
  });

  it('rollsBackWhenStartFails', async () => {
    const f = fixture({ failAt: 'start', rollbackThrows: 'SWITCH_ROLLED_BACK' });
    await expect(f.run()).rejects.toMatchObject({ code: 'SWITCH_ROLLED_BACK' });
    expect(f.calls).toContain('rollback:snap:FAIL_START');
    expect(f.stages.at(-1)).toBe('rollback');
  });

  it('rollsBackWhenVerifyFails', async () => {
    const f = fixture({ failAt: 'verify', rollbackThrows: 'RECOVERY_REQUIRED' });
    await expect(f.run()).rejects.toMatchObject({ code: 'RECOVERY_REQUIRED' });
    expect(f.calls).toContain('rollback:snap:FAIL_VERIFY');
    expect(f.stages.at(-1)).toBe('rollback');
  });

  it('fallsBackToRolledBackWhenRollbackReturnsNormally', async () => {
    // provider 的 rollback 回调必须以抛错收尾；万一没抛，骨架兜底按「已回滚」收尾
    const f = fixture({ failAt: 'verify', rollbackThrows: null });
    await expect(f.run()).rejects.toMatchObject({ code: 'SWITCH_ROLLED_BACK' });
  });

  it('mapsNonApiErrorCauseToFixedCode', () => {
    expect(switchFailureCause(new Error('boom'))).toBe('SWITCH_STAGE_FAILED');
    expect(switchFailureCause(new ApiError(409, 'SERVER_IDENTITY_MISMATCH', 'x'))).toBe('SERVER_IDENTITY_MISMATCH');
  });
});

// ---- 两 provider 全链路（dry-run 假客户端） ----

const AUTH = 'C:/fake/.minimax/auth/prod/cn/mcode-public/auth.json';
const EXE = 'C:/fake/MiniMax.exe';
const jwtToken = (sub: string): string => `h.${Buffer.from(JSON.stringify({ sub }), 'utf8').toString('base64url')}.s`;

function memoryFs(initial: Record<string, string>): MinimaxFileSystem {
  const files = new Map(Object.entries(initial));
  return {
    exists: async path => files.has(path),
    readFile: async path => {
      const value = files.get(path);
      if (value === undefined) throw new Error(`ENOENT ${path}`);
      return Buffer.from(value, 'utf8');
    },
    writeFile: async (path, data) => { files.set(path, data.toString('utf8')); },
    rename: async (from, to) => {
      const value = files.get(from);
      if (value === undefined) throw new Error(`ENOENT ${from}`);
      files.delete(from);
      files.set(to, value);
    },
    copyFile: async (from, to) => { files.set(to, files.get(from) ?? ''); },
    remove: async path => { files.delete(path); },
  };
}

describe('B4S-4 两 provider 走同一骨架（全链路 dry-run）', () => {
  let t: TestDb;
  let env: FakeWorkbuddyEnv;
  let root: string;
  let vault: SecretVault;

  beforeEach(() => {
    t = createTestDb();
    env = new FakeWorkbuddyEnv();
    root = mkdtempSync(join(tmpdir(), 'agentboard-b4s4-'));
    vault = new SecretVault(join(root, 'vault'));
  });
  afterEach(() => { t.cleanup(); env.cleanup(); rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }); });

  it('workbuddyFullChainEndsAtVerify', async () => {
    env.trayExitWorks = true;
    const provider = env.provider(t.db);
    const accountA = await provider.captureCurrent({ display_name: '账号A' });
    await env.loginAs(UID_B);
    const operation = await provider.switchAccount(accountA.id);
    expect(operation.state).toBe('succeeded');
    expect(operation.stage).toBe('verify');
    expect(env.authUid()).toBe(UID_A);
  }, 20000);

  it('minimaxFullChainEndsAtVerify', async () => {
    const token = jwtToken('uid-target');
    const files = memoryFs({
      [AUTH]: JSON.stringify({ schemaVersion: 1, records: { 'com.minimax.mcode': { accessToken: jwtToken('uid-current'), expiresAtMs: 1_900_000_000_000 } } }),
      [EXE]: 'binary',
    });
    const process: MinimaxProcessControl = { isRunning: async () => false, stop: async () => {}, start: async () => {} };
    const provider = new MinimaxDesktopProvider({
      db: t.db, vault, paths: { authFile: AUTH, clientExe: EXE }, fs: files, process,
      serverIdentityProbe: { probe: async (t2: string) => ({ uid: credentialUid(t2) }) },
    });
    await provider.captureCurrent();
    const identityHash = 'e'.repeat(64);
    const targetId = randomUUID();
    const scope = { app_id: 'minimax' as const, client_instance_id: 'minimax-desktop', identity_hash: identityHash, purpose: 'checkin' as const };
    const ref = await vault.protect(Buffer.from(token, 'utf8'), scope);
    t.db.prepare(`INSERT INTO managed_account (id,app_id,client_instance_id,service_region,identity_hash,display_name,checkin_credential_ref,client_snapshot_version,created_at,updated_at)
      VALUES (?,'minimax','minimax-desktop','cn',?,?,?,1,1,1)`).run(targetId, identityHash, '目标', ref);

    const operation = await provider.switchAccount(targetId);
    expect(operation.state).toBe('succeeded');
    // 与 WorkBuddy 同一骨架的同一落点：成功时 stage 停在 verify
    expect(operation.stage).toBe('verify');
  }, 30000);
});
