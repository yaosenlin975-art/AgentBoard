/**
 * TRAVEL-REC-2：WorkBuddy 猫猫旅行到期自动回收。
 * 覆盖：到期前不动作、到期回收一次、同轮不重复、超窗记 missed 不发请求、
 * 失败可观察并保留 pending、开关关闭整轮跳过、provider 不支持/凭据缺失的终态、
 * 以及 createApp 接线（启动补偿真触发 + 5 分钟调度注册 + stop 生效）。
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createManagedAccount } from '../src/db/repos/managedAccount.js';
import { attachCheckinCredential } from '../src/db/repos/checkin.js';
import { createPendingTravelRound, getPendingTravelRound, getTravelRound } from '../src/db/repos/travelRound.js';
import { initSchema } from '../src/db/schema.js';
import { ApiError } from '../src/errors.js';
import { createApp } from '../src/index.js';
import type { SecretVault } from '../src/services/accounts/secretVault.js';
import {
  TRAVEL_RECOVERY_UNSUPPORTED,
  TRAVEL_SWEEP_INTERVAL_MS,
  TRAVEL_WINDOW_EXPIRED,
  startTravelRecoveryTicker,
  sweepTravelRecoveries,
} from '../src/services/accounts/travelRecovery.js';
import { CHECKIN_UID, CREDENTIAL_MARK, FakeCheckinProvider, FakeCheckinVault, sha256 } from './fakeCheckinProvider.js';
import { createTestDb, type TestDb } from './helpers.js';

const MINUTE = 60 * 1000;
const DISPATCHED_AT = 1_000_000;

describe('travel recovery sweep', () => {
  let t: TestDb;
  let vault: FakeCheckinVault;
  let provider: FakeCheckinProvider;

  beforeEach(() => {
    t = createTestDb();
    vault = new FakeCheckinVault();
    provider = new FakeCheckinProvider();
  });
  afterEach(() => t.cleanup());

  /** 建一个可回收账号（带 vault 凭据） */
  async function seedAccount(name: string): Promise<string> {
    const account = createManagedAccount(t.db, {
      app_id: 'workbuddy_desktop',
      client_instance_id: `inst-${name}`,
      service_region: 'cn',
      identity_hash: sha256(`${CHECKIN_UID}-${name}`),
      display_name: name,
    });
    const ref = await vault.protect(Buffer.from(CREDENTIAL_MARK), {
      app_id: account.app_id,
      client_instance_id: account.client_instance_id,
      identity_hash: account.identity_hash,
      purpose: 'checkin',
    });
    attachCheckinCredential(t.db, account.id, ref);
    return account.id;
  }

  function seedRound(accountId: string, dispatchedAt = DISPATCHED_AT): ReturnType<typeof createPendingTravelRound> {
    return createPendingTravelRound(t.db, { account_id: accountId, dispatched_at: dispatchedAt });
  }

  it('does nothing before due_at', async () => {
    let calls = 0;
    Object.assign(provider, { claimAfterTravel: async () => { calls += 1; return { kind: 'travel' as const, status: 'claimed' as const }; } });
    const accountId = await seedAccount('not-due');
    seedRound(accountId);

    const result = await sweepTravelRecoveries({ db: t.db, vault, provider }, { now: () => DISPATCHED_AT + 224 * MINUTE });

    expect(result.skipped).toBe(1);
    expect(calls).toBe(0);
    expect(getPendingTravelRound(t.db, accountId)?.state).toBe('pending');
  });

  it('claims once when due and never repeats the same round', async () => {
    let calls = 0;
    Object.assign(provider, { claimAfterTravel: async () => { calls += 1; return { kind: 'travel' as const, status: 'claimed' as const }; } });
    const accountId = await seedAccount('due');
    const round = seedRound(accountId);
    const now = () => DISPATCHED_AT + 226 * MINUTE;

    const first = await sweepTravelRecoveries({ db: t.db, vault, provider }, { now });
    const second = await sweepTravelRecoveries({ db: t.db, vault, provider }, { now });

    expect(first.attempted).toBe(1);
    expect(first.claimed).toBe(1);
    expect(calls).toBe(1);
    expect(second.attempted).toBe(0);
    expect(getTravelRound(t.db, round.id)?.state).toBe('claimed');
  });

  it('marks rounds past the 4-hour window as missed without calling the provider', async () => {
    let calls = 0;
    Object.assign(provider, { claimAfterTravel: async () => { calls += 1; return { kind: 'travel' as const, status: 'claimed' as const }; } });
    const accountId = await seedAccount('expired');
    const round = seedRound(accountId);

    const result = await sweepTravelRecoveries({ db: t.db, vault, provider }, { now: () => DISPATCHED_AT + 240 * MINUTE });

    expect(result.missed).toBe(1);
    expect(calls).toBe(0);
    const row = getTravelRound(t.db, round.id);
    expect(row?.state).toBe('missed');
    expect(row?.safe_error_code).toBe(TRAVEL_WINDOW_EXPIRED);
  });

  it('keeps a failed claim pending with attempts/safe_error_code for the next tick', async () => {
    Object.assign(provider, { claimAfterTravel: async () => ({ kind: 'travel' as const, status: 'failed' as const, safe_error_code: 'TRAVEL_HTTP_500' }) });
    const accountId = await seedAccount('failed');
    const round = seedRound(accountId);

    const result = await sweepTravelRecoveries({ db: t.db, vault, provider }, { now: () => DISPATCHED_AT + 226 * MINUTE });

    expect(result.failed).toBe(1);
    const row = getTravelRound(t.db, round.id);
    expect(row?.state).toBe('pending');
    expect(row?.attempts).toBe(1);
    expect(row?.safe_error_code).toBe('TRAVEL_HTTP_500');
  });

  it('keeps still-traveling and thrown errors observable without pretending success', async () => {
    Object.assign(provider, { claimAfterTravel: async () => ({ kind: 'travel' as const, status: 'dispatched' as const }) });
    const accountId = await seedAccount('still-traveling');
    const traveling = seedRound(accountId);
    const now = () => DISPATCHED_AT + 226 * MINUTE;

    await sweepTravelRecoveries({ db: t.db, vault, provider }, { now });
    expect(getTravelRound(t.db, traveling.id)?.safe_error_code).toBe('TRAVEL_STILL_TRAVELING');
    expect(getTravelRound(t.db, traveling.id)?.state).toBe('pending');

    Object.assign(provider, { claimAfterTravel: async () => { throw new ApiError(401, 'CHECKIN_CREDENTIAL_INVALID', '凭据失效'); } });
    await sweepTravelRecoveries({ db: t.db, vault, provider }, { now });
    const row = getTravelRound(t.db, traveling.id);
    expect(row?.state).toBe('pending');
    expect(row?.attempts).toBe(2);
    expect(row?.safe_error_code).toBe('TRAVEL_RECOVERY_FAILED:CHECKIN_CREDENTIAL_INVALID');
  });

  it('skips the whole sweep when the toggle is off', async () => {
    let calls = 0;
    Object.assign(provider, { claimAfterTravel: async () => { calls += 1; return { kind: 'travel' as const, status: 'claimed' as const }; } });
    const accountId = await seedAccount('disabled-switch');
    const round = seedRound(accountId);

    const result = await sweepTravelRecoveries({ db: t.db, vault, provider }, { now: () => DISPATCHED_AT + 226 * MINUTE, enabled: () => false });

    expect(result.skipped).toBe(1);
    expect(calls).toBe(0);
    expect(getTravelRound(t.db, round.id)?.state).toBe('pending');
  });

  it('fails terminally when the provider cannot claim or the credential is gone', async () => {
    const accountId = await seedAccount('unsupported');
    const unsupported = seedRound(accountId);
    await sweepTravelRecoveries({ db: t.db, vault, provider }, { now: () => DISPATCHED_AT + 226 * MINUTE });
    const failed = getTravelRound(t.db, unsupported.id);
    expect(failed?.state).toBe('failed');
    expect(failed?.safe_error_code).toBe(TRAVEL_RECOVERY_UNSUPPORTED);

    const noCredential = createManagedAccount(t.db, {
      app_id: 'workbuddy_desktop',
      client_instance_id: 'inst-no-credential',
      service_region: 'cn',
      identity_hash: sha256('no-credential'),
      display_name: 'no-credential',
    });
    const round = seedRound(noCredential.id);
    Object.assign(provider, { claimAfterTravel: async () => ({ kind: 'travel' as const, status: 'claimed' as const }) });
    await sweepTravelRecoveries({ db: t.db, vault, provider }, { now: () => DISPATCHED_AT + 226 * MINUTE });
    const row = getTravelRound(t.db, round.id);
    expect(row?.state).toBe('pending');
    expect(row?.safe_error_code).toBe('TRAVEL_CREDENTIAL_MISSING');
  });
});

describe('travel recovery ticker wiring (RULE-3)', () => {
  let t: TestDb;
  let vault: FakeCheckinVault;
  let provider: FakeCheckinProvider;
  let created: Awaited<ReturnType<typeof createApp>> | null;
  let spaceDir: string;

  beforeEach(() => {
    t = createTestDb();
    vault = new FakeCheckinVault();
    provider = new FakeCheckinProvider();
    created = null;
    spaceDir = mkdtempSync(join(tmpdir(), 'agentboard-travel-rec-'));
  });
  afterEach(() => {
    created?.travelRecovery?.stop();
    t.cleanup();
    rmSync(spaceDir, { recursive: true, force: true });
  });

  it('createApp starts the ticker: startup compensation really claims, 5-min interval registered, stop works', async () => {
    let calls = 0;
    Object.assign(provider, { claimAfterTravel: async () => { calls += 1; return { kind: 'travel' as const, status: 'claimed' as const }; } });
    const account = createManagedAccount(t.db, {
      app_id: 'workbuddy_desktop',
      client_instance_id: 'inst-wiring',
      service_region: 'cn',
      identity_hash: sha256(`${CHECKIN_UID}-wiring`),
      display_name: 'wiring',
    });
    const ref = await vault.protect(Buffer.from(CREDENTIAL_MARK), {
      app_id: account.app_id,
      client_instance_id: account.client_instance_id,
      identity_hash: account.identity_hash,
      purpose: 'checkin',
    });
    attachCheckinCredential(t.db, account.id, ref);
    // 派出已 226 分钟：已到期（due_at = +225min），但仍在 4 小时窗口内（窗口 240min）
    const round = createPendingTravelRound(t.db, { account_id: account.id, dispatched_at: Date.now() - 226 * MINUTE });

    const scheduled: { fn: () => void; ms: number }[] = [];
    let cancelled = 0;
    created = await createApp({
      db: t.db,
      refreshClisOnBoot: false,
      secretVault: vault as unknown as SecretVault,
      checkinProvider: provider,
      travelRecovery: {
        schedule: (fn, ms) => { scheduled.push({ fn, ms }); return 1; },
        cancel: () => { cancelled += 1; },
      },
    });

    // 启动补偿扫描（真实 createApp 接线，不是直接调服务）
    const sweep = await created.travelRecovery!.ready;
    expect(sweep.claimed).toBe(1);
    expect(calls).toBe(1);
    expect(getTravelRound(t.db, round.id)?.state).toBe('claimed');
    // ticker 真注册：5 分钟周期 + stop 取消
    expect(scheduled).toHaveLength(1);
    expect(scheduled[0]!.ms).toBe(TRAVEL_SWEEP_INTERVAL_MS);
    expect(TRAVEL_SWEEP_INTERVAL_MS).toBe(5 * MINUTE);
    // 同轮不重复：再触发一轮不再调 provider
    const again = await created.travelRecovery!.runNow();
    expect(again.attempted).toBe(0);
    expect(calls).toBe(1);
    created.travelRecovery!.stop();
    expect(cancelled).toBe(1);
  });

  it('does not start without a workbuddy provider or when explicitly disabled', async () => {
    const noProvider = await createApp({ db: t.db, refreshClisOnBoot: false });
    expect(noProvider.travelRecovery).toBeUndefined();

    const disabled = await createApp({ db: t.db, refreshClisOnBoot: false, checkinProvider: provider, travelRecovery: false });
    expect(disabled.travelRecovery).toBeUndefined();
  });

  it('settings: travelAutoRecover defaults to true and PATCH schema accepts a boolean', async () => {
    const { loadConfig } = await import('../src/config.js');
    const { patchSettingsSchema } = await import('../src/api/schemas.js');
    expect(loadConfig({ APPDATA: spaceDir }).travelAutoRecover).toBe(true);
    expect(patchSettingsSchema.safeParse({ travelAutoRecover: false }).success).toBe(true);
    expect(patchSettingsSchema.safeParse({ travelAutoRecover: 'no' }).success).toBe(false);
  });

  it('startTravelRecoveryTicker runs a startup sweep even without createApp', async () => {
    initSchema(t.db);
    const account = createManagedAccount(t.db, {
      app_id: 'workbuddy_desktop',
      client_instance_id: 'inst-direct',
      service_region: 'cn',
      identity_hash: sha256(`${CHECKIN_UID}-direct`),
      display_name: 'direct',
    });
    const ref = await vault.protect(Buffer.from(CREDENTIAL_MARK), {
      app_id: account.app_id,
      client_instance_id: account.client_instance_id,
      identity_hash: account.identity_hash,
      purpose: 'checkin',
    });
    attachCheckinCredential(t.db, account.id, ref);
    const round = createPendingTravelRound(t.db, { account_id: account.id, dispatched_at: Date.now() - 226 * MINUTE });
    Object.assign(provider, { claimAfterTravel: async () => ({ kind: 'travel' as const, status: 'already_done' as const }) });

    const handle = startTravelRecoveryTicker({ db: t.db, vault, provider }, {
      schedule: () => 1,
      cancel: () => undefined,
    });
    const sweep = await handle.ready;
    handle.stop();

    expect(sweep.claimed).toBe(1);
    expect(getTravelRound(t.db, round.id)?.state).toBe('claimed');
  });
});
