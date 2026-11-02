/**
 * ACC-05 WorkBuddy Desktop provider 契约测试（fake 客户端环境：注入路径与探针）。
 * 契约依据：Docs/verification/2026-11-01-workbuddy-desktop-contract.md「2026-11-01 授权观测」。
 */
import { readdirSync, writeFileSync } from 'node:fs';
import { SecretVault } from '../src/services/accounts/secretVault.js';
import { computeWorkbuddyInstanceId, readWorkbuddyIdentity } from '../src/services/accounts/workbuddyDesktopProvider.js';
import { createManagedAccount, getManagedAccount } from '../src/db/repos/managedAccount.js';
import { createTestDb, type TestDb } from './helpers.js';
import { ApiError } from '../src/errors.js';
import { ENVELOPE_MARK, FakeWorkbuddyEnv, UID_A, UID_B, UID_C, sha256 } from './fakeWorkbuddy.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

describe('workbuddy desktop provider', () => {
  let t: TestDb;
  let env: FakeWorkbuddyEnv;
  beforeEach(() => { t = createTestDb(); env = new FakeWorkbuddyEnv(); });
  afterEach(() => { t.cleanup(); env.cleanup(); });

  it('computes contract instance id and reads identity without touching envelopes', async () => {
    const identity = await readWorkbuddyIdentity(env.paths);
    expect(identity).toEqual({ uid_sha256_8: sha256(UID_A).slice(0, 8), identity_hash: sha256(UID_A) });
    // instance_id = sha256("workbuddy_desktop" + NUL + 小写 exe 路径)
    expect(computeWorkbuddyInstanceId(env.paths.exePath)).toBe(sha256(`workbuddy_desktop\0${env.paths.exePath.toLowerCase()}`));
    writeFileSync(env.paths.authInfoPath, '{broken');
    expect(await readWorkbuddyIdentity(env.paths)).toBeNull();
  });

  it('canCloseSafely always reports undecidable busy state', () => {
    expect(env.provider(t.db).canCloseSafely()).toEqual({ safe: false, reason: 'busy/未保存状态不可判定' });
  });

  it.runIf(process.platform === 'win32')('captureCurrent stores DPAPI snapshot and safe metadata', async () => {
    const provider = env.provider(t.db);
    const account = await provider.captureCurrent();
    expect(account.identity_hash).toBe(sha256(UID_A));
    expect(account.client_instance_id).toBe(computeWorkbuddyInstanceId(env.paths.exePath));
    expect(getManagedAccount(t.db, account.id)?.client_snapshot_ref).toMatch(/^[0-9a-f-]{36}$/);
    expect(readdirSync(env.vaultDir)).toHaveLength(1);
    // 重新捕获同身份：换快照引用（token 轮换），不产生 ACCOUNT_EXISTS，旧密文清理
    env.writeAuthInfo(UID_A, 'ENVELOPE-ROTATED-2');
    const again = await provider.captureCurrent({ display_name: '工作号A' });
    expect(again.id).toBe(account.id);
    expect(getManagedAccount(t.db, account.id)?.client_snapshot_ref).not.toBe(account.client_snapshot_ref);
    expect(readdirSync(env.vaultDir)).toHaveLength(1);
    // 元数据与操作记录不含 uid 原文与信封字节
    const dump = JSON.stringify(t.db.prepare('SELECT * FROM managed_account').all()) + JSON.stringify(t.db.prepare('SELECT * FROM account_operation').all());
    expect(dump).not.toContain(UID_A);
    expect(dump).not.toContain(ENVELOPE_MARK);
    expect(dump).not.toContain('ENVELOPE-ROTATED');
  }, 20000);

  it.runIf(process.platform === 'win32')('capture rejects unsupported version, missing instance, not running, missing uid, v1 schema', async () => {
    const provider = env.provider(t.db);
    const expectCode = async (action: () => Promise<unknown>, code: string) => {
      try { await action(); expect.unreachable(); }
      catch (error) {
        expect(error).toBeInstanceOf(ApiError);
        expect((error as ApiError).code).toBe(code);
        expect((error as ApiError).message).not.toContain(ENVELOPE_MARK);
      }
    };
    env.version = '4.22.5.0';
    await expectCode(() => provider.captureCurrent(), 'CLIENT_VERSION_UNSUPPORTED');
    env.version = null;
    await expectCode(() => provider.captureCurrent(), 'CLIENT_INSTANCE_NOT_FOUND');
    env.version = '5.9.3.0';
    env.pids = [];
    await expectCode(() => provider.captureCurrent(), 'CLIENT_NOT_RUNNING');
    env.pids = [4242];
    writeFileSync(env.paths.authInfoPath, JSON.stringify({ account: { nickname: { $wbEncrypted: 1, envelope: ENVELOPE_MARK } }, auth: { accessToken: { $wbEncrypted: 1, envelope: ENVELOPE_MARK } } }));
    await expectCode(() => provider.captureCurrent(), 'IDENTITY_UNAVAILABLE');
    writeFileSync(env.paths.authInfoPath, JSON.stringify({ account: { uid: UID_A, nickname: 'plain' }, auth: { accessToken: 'plaintext-v1-token' } }));
    await expectCode(() => provider.captureCurrent(), 'CLIENT_SCHEMA_UNSUPPORTED');
  }, 30000);

  async function captureTwoAccounts(provider: ReturnType<FakeWorkbuddyEnv['provider']>): Promise<{ accountA: { id: string }; accountB: { id: string } }> {
    const accountA = await provider.captureCurrent({ display_name: '账号A' });
    await env.loginAs(UID_B);
    const accountB = await provider.captureCurrent({ display_name: '账号B' });
    return { accountA, accountB };
  }

  it.runIf(process.platform === 'win32')('switch success: exit→write→restart→identity verify', async () => {
    env.trayExitWorks = true;
    const provider = env.provider(t.db);
    const { accountA } = await captureTwoAccounts(provider);
    const operation = await provider.switchAccount(accountA.id);
    expect(operation.state).toBe('succeeded');
    expect(operation.stage).toBe('verify');
    expect(env.authUid()).toBe(UID_A);
    expect(env.trayExitAttempts).toBe(1);
  }, 20000);

  it.runIf(process.platform === 'win32')('workbuddySwitchBlocksActiveOrUnknownDesktop: exit never confirmed → no write', async () => {
    env.trayExitWorks = false;
    const provider = env.provider(t.db);
    const { accountA } = await captureTwoAccounts(provider);
    const before = env.authBytes();
    const operation = await provider.switchAccount(accountA.id);
    expect(operation.state).toBe('failed');
    expect(operation.safe_error_code).toBe('EXIT_NOT_CONFIRMED');
    expect(operation.stage).toBe('stop');
    expect(env.authBytes().equals(before)).toBe(true); // 未确认完全退出绝不写
    expect(env.notices.length).toBe(1);
    expect(env.notices[0]).toContain('手动退出');
    expect(env.launchCount).toBe(1); // 仅 loginAs 的那次启动，切换未触碰客户端
  }, 20000);

  it.runIf(process.platform === 'win32')('workbuddyWriteWaitsForFullExit: tray click ineffective, write only after manual exit signature', async () => {
    env.trayExitWorks = false; // UIA 枚举到图标但无菜单（观测事实）
    const provider = env.provider(t.db, { uiaExitWaitMs: 120, manualExitTimeoutMs: 5_000 });
    const { accountA } = await captureTwoAccounts(provider);
    const before = env.authBytes();
    env.onNotice = () => { setTimeout(() => { void env.fullyExit(); }, 250); };
    const switching = provider.switchAccount(accountA.id);
    // 手动退出（250ms）发生前：客户端仍在运行，任何快照字节不得落盘
    await new Promise(resolve => setTimeout(resolve, 80));
    expect(env.authBytes().equals(before)).toBe(true);
    const operation = await switching;
    expect(operation.state).toBe('succeeded');
    expect(env.authUid()).toBe(UID_A);
    expect(env.notices.length).toBe(1);
  }, 20000);

  it.runIf(process.platform === 'win32')('snapshot triple mismatch refuses to write (instance/identity/version)', async () => {
    env.trayExitWorks = true;
    const provider = env.provider(t.db);
    const { accountA } = await captureTwoAccounts(provider);
    const instanceId = computeWorkbuddyInstanceId(env.paths.exePath);
    const before = env.authBytes();

    // 构造 scope 正确可解密、但内容与本机三元组不符的快照
    const foreign = async (overrides: Record<string, unknown>, accountIdentityHash: string) => {
      const vault = new SecretVault(env.vaultDir);
      const snapshot = {
        schema: 'agentboard.workbuddy-desktop.snapshot/1', app_id: 'workbuddy_desktop', client_instance_id: instanceId,
        identity: { uid_sha256_8: accountIdentityHash.slice(0, 8) },
        version: { product: env.version ?? '5.9.3.0', schema: 'v2-wbencrypted', captured_at: Date.now() },
        files: [
          { key: 'auth_info', role: 'credential', sha256: sha256(env.authBytes().toString('utf8')), content_base64: env.authBytes().toString('base64') },
          { key: 'skeleton', role: 'identity-skeleton', sha256: sha256('sk'), content_base64: Buffer.from('sk').toString('base64') },
        ],
        ...overrides,
      };
      const ref = await vault.protect(Buffer.from(JSON.stringify(snapshot)), { app_id: 'workbuddy_desktop', client_instance_id: instanceId, identity_hash: accountIdentityHash, purpose: 'client_snapshot' });
      return createManagedAccount(t.db, { app_id: 'workbuddy_desktop', client_instance_id: instanceId, service_region: 'unknown', identity_hash: accountIdentityHash, display_name: `外来-${Object.keys(overrides).join('-')}`, identity_hint: null, client_snapshot_ref: ref, client_snapshot_version: 1 });
    };

    const wrongInstance = await foreign({ client_instance_id: 'f'.repeat(64) }, sha256('foreign-instance'));
    const opInstance = await provider.switchAccount(wrongInstance.id);
    expect(opInstance.state).toBe('failed');
    expect(opInstance.safe_error_code).toBe('TARGET_INSTANCE_MISMATCH');
    expect(env.authBytes().equals(before)).toBe(true);

    const wrongIdentity = await foreign({ identity: { uid_sha256_8: sha256(UID_B).slice(0, 8) } }, sha256('foreign-identity')); // 快照 uid8=B，账号身份=外来
    const opIdentity = await provider.switchAccount(wrongIdentity.id);
    expect(opIdentity.safe_error_code).toBe('TARGET_IDENTITY_MISMATCH');
    expect(env.authBytes().equals(before)).toBe(true);

    const wrongVersion = await foreign({ version: { product: '5.9.4', schema: 'v2-wbencrypted', captured_at: Date.now() } }, sha256('foreign-version'));
    const opVersion = await provider.switchAccount(wrongVersion.id);
    expect(opVersion.safe_error_code).toBe('SNAPSHOT_VERSION_MISMATCH');
    expect(env.authBytes().equals(before)).toBe(true);
    // 验证性拒绝不冻结实例：accountA 快照仍可正常切换
    expect((await provider.switchAccount(accountA.id)).state).toBe('succeeded');
  }, 30000);

  it.runIf(process.platform === 'win32')('failedTargetIdentityRestoresOriginalAccount: verify fail → rollback + verified original', async () => {
    env.trayExitWorks = true;
    const provider = env.provider(t.db);
    const { accountA } = await captureTwoAccounts(provider); // 当前登录 B
    env.oneShotLaunchUid = UID_C; // 首次启动后客户端回到 C（目标 A 核验失败）
    const operation = await provider.switchAccount(accountA.id);
    expect(operation.state).toBe('failed');
    expect(operation.safe_error_code).toBe('SWITCH_ROLLED_BACK');
    expect(operation.stage).toBe('rollback');
    expect(env.authUid()).toBe(UID_B); // 原账号恢复并核验
    expect(env.launchCount).toBe(3); // loginAs(B) + 切换启动 + 回滚启动
  }, 20000);

  it.runIf(process.platform === 'win32')('rollback failure freezes the instance (recovery_required)', async () => {
    env.trayExitWorks = true;
    const provider = env.provider(t.db);
    const { accountA } = await captureTwoAccounts(provider);
    env.persistLaunchUid = UID_C; // 每次启动都回到 C：目标核验失败且回滚也核验失败
    const operation = await provider.switchAccount(accountA.id);
    expect(operation.state).toBe('recovery_required');
    expect(operation.safe_error_code).toBe('RECOVERY_REQUIRED');
    // 冻结：同实例后续切换/捕获均拒绝
    await expect(provider.switchAccount(accountA.id)).rejects.toMatchObject({ code: 'RECOVERY_REQUIRED' });
    await expect(provider.captureCurrent()).rejects.toMatchObject({ code: 'RECOVERY_REQUIRED' });
    const dump = JSON.stringify(t.db.prepare('SELECT * FROM account_operation').all());
    expect(dump).not.toContain(UID_A);
    expect(dump).not.toContain(ENVELOPE_MARK);
  }, 20000);

  it.runIf(process.platform === 'win32')('concurrent switches serialize on the client instance lock', async () => {
    env.trayExitWorks = true;
    const provider = env.provider(t.db);
    const { accountA } = await captureTwoAccounts(provider);
    const [first, second] = await Promise.all([provider.switchAccount(accountA.id), provider.switchAccount(accountA.id)]);
    expect([first.state, second.state]).toEqual(['succeeded', 'succeeded']);
    expect(env.startupMaxActive).toBe(1); // 切换执行体互斥（client 实例锁）
  }, 20000);
});
