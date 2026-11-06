/**
 * ACC-07 批量签到编排：串行、逐账号结果、超时 unknown 不重发、已签到不发请求、
 * 本地同日跳过、取消排队项、ACCOUNT_BUSY 隔离、脱敏。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ManagedAccount } from '@agentboard/shared';
import { createTestDb, type TestDb } from './helpers.js';
import { attachCheckinCredential, createCheckinBatch, getCheckinBatch, listCheckinBatchItems, operationsForBatch } from '../src/db/repos/checkin.js';
import { createManagedAccount, getManagedAccount } from '../src/db/repos/managedAccount.js';
import { profileLocalDay } from '../src/services/accounts/checkinAuthorization.js';
import { runCheckinBatch } from '../src/services/accounts/checkinRunner.js';
import { withAccountLock } from '../src/services/accounts/locks.js';
import { CHECKIN_UID, CREDENTIAL_MARK, FakeCheckinProvider, FakeCheckinVault, sha256 } from './fakeCheckinProvider.js';

describe('checkin runner', () => {
  let t: TestDb;
  let provider: FakeCheckinProvider;
  let vault: FakeCheckinVault;

  beforeEach(() => {
    t = createTestDb();
    provider = new FakeCheckinProvider();
    vault = new FakeCheckinVault();
  });
  afterEach(() => t.cleanup());

  const deps = () => ({ db: t.db, vault, provider });

  async function makeAccount(name: string, over: Record<string, unknown> = {}): Promise<ManagedAccount> {
    const account = createManagedAccount(t.db, {
      app_id: 'workbuddy_desktop',
      client_instance_id: `inst-${name}`,
      service_region: 'cn',
      identity_hash: sha256(`${CHECKIN_UID}-${name}`),
      display_name: name,
      ...over,
    } as never);
    return account;
  }

  async function boundAccount(name: string): Promise<ManagedAccount> {
    const account = await makeAccount(name);
    const ref = await vault.protect(Buffer.from(CREDENTIAL_MARK), { app_id: account.app_id, client_instance_id: account.client_instance_id, identity_hash: account.identity_hash, purpose: 'checkin' });
    return attachCheckinCredential(t.db, account.id, ref);
  }

  function newBatch(accountIds: string[], appId: 'workbuddy_desktop' | 'codebuddy_desktop' = 'workbuddy_desktop') {
    return createCheckinBatch(t.db, { app_id: appId, account_ids: accountIds, profile_local_day: profileLocalDay() });
  }

  it('checkinBatchRunsSeriallyPerAccount', async () => {
    provider.submitDelayMs = 15;
    const accounts = [await boundAccount('A'), await boundAccount('B'), await boundAccount('C')];
    const batch = newBatch(accounts.map(account => account.id));
    const finished = await runCheckinBatch(deps(), batch.id);
    expect(provider.maxActive).toBe(1);
    expect(provider.submitCalls).toBe(3);
    expect(finished.status).toBe('succeeded');
    const items = listCheckinBatchItems(t.db, batch.id);
    expect(items.map(item => item.account_id)).toEqual(accounts.map(account => account.id));
    expect(items.every(item => item.state === 'succeeded')).toBe(true);
    // 逐账号都落了 account_operation（batch_id 可回溯）
    expect(operationsForBatch(t.db, batch.id)).toHaveLength(3);
  });

  it('checkinTimeoutProducesUnknownWithoutRetry', async () => {
    provider.submitResults = ['unknown'];
    const account = await boundAccount('A');
    const batch = newBatch([account.id]);
    const finished = await runCheckinBatch(deps(), batch.id);
    expect(provider.submitCalls).toBe(1);
    expect(provider.statusCalls).toBe(1);
    expect(finished.status).toBe('failed');
    expect(listCheckinBatchItems(t.db, batch.id)[0]).toMatchObject({ state: 'unknown', safe_error_code: 'OPERATION_UNKNOWN' });
    expect(getManagedAccount(t.db, account.id)!.last_checkin_status).toBe('unknown');
    expect(operationsForBatch(t.db, batch.id)[0]!.state).toBe('unknown');
  });

  it('checkinAlreadyDoneSkipsRequest', async () => {
    provider.statusResult = 'already_done';
    const account = await boundAccount('A');
    const batch = newBatch([account.id]);
    const finished = await runCheckinBatch(deps(), batch.id);
    expect(provider.submitCalls).toBe(0);
    expect(provider.statusCalls).toBe(1);
    expect(finished.status).toBe('succeeded');
    expect(listCheckinBatchItems(t.db, batch.id)[0]!.state).toBe('already_done');
  });

  it('checkinLocalSameDayRecordSkipsRequest', async () => {
    const account = await boundAccount('A');
    t.db.prepare('UPDATE managed_account SET last_checkin_day=?,last_checkin_status=? WHERE id=?').run(profileLocalDay(), 'succeeded', account.id);
    const batch = newBatch([account.id]);
    const finished = await runCheckinBatch(deps(), batch.id);
    expect(provider.statusCalls).toBe(0);
    expect(provider.submitCalls).toBe(0);
    expect(finished.status).toBe('succeeded');
    expect(listCheckinBatchItems(t.db, batch.id)[0]).toMatchObject({ state: 'already_done', safe_error_code: 'LOCAL_RECORD' });
    expect(operationsForBatch(t.db, batch.id)).toHaveLength(0);
  });

  it('checkinCancelQueuedSkipsRemainingAccounts', async () => {
    const accounts = [await boundAccount('A'), await boundAccount('B')];
    const batch = newBatch(accounts.map(account => account.id));
    const { cancelQueuedCheckinItems } = await import('../src/db/repos/checkin.js');
    expect(cancelQueuedCheckinItems(t.db, batch.id)).toEqual(accounts.map(account => account.id));
    const finished = await runCheckinBatch(deps(), batch.id);
    expect(provider.submitCalls).toBe(0);
    expect(provider.statusCalls).toBe(0);
    expect(finished.status).toBe('cancelled');
    expect(listCheckinBatchItems(t.db, batch.id).every(item => item.state === 'cancelled')).toBe(true);
    expect(operationsForBatch(t.db, batch.id)).toHaveLength(0);
  });

  it('checkinRateLimitedIsDistinctFromFailure', async () => {
    provider.submitResults = ['rate_limited'];
    const limited = await boundAccount('A');
    const first = newBatch([limited.id]);
    await runCheckinBatch(deps(), first.id);
    expect(listCheckinBatchItems(t.db, first.id)[0]).toMatchObject({ state: 'failed', safe_error_code: 'CHECKIN_RATE_LIMITED' });

    provider.submitResults = ['failed'];
    const failed = await boundAccount('B');
    const second = newBatch([failed.id]);
    await runCheckinBatch(deps(), second.id);
    expect(listCheckinBatchItems(t.db, second.id)[0]).toMatchObject({ state: 'failed', safe_error_code: 'CHECKIN_FAILED' });
  });

  it('checkinAccountBusyDoesNotBlockOtherAccounts', async () => {
    const busy = await boundAccount('A');
    const free = await boundAccount('B');
    const batch = newBatch([busy.id, free.id]);
    let release!: () => void;
    const held = withAccountLock('account', busy.id, () => new Promise<void>(resolve => { release = resolve; }));
    await new Promise(resolve => setTimeout(resolve, 10));
    const finished = await runCheckinBatch(deps(), batch.id);
    release();
    await held;
    expect(provider.submitCalls).toBe(1);
    const items = listCheckinBatchItems(t.db, batch.id);
    expect(items[0]).toMatchObject({ state: 'failed', safe_error_code: 'ACCOUNT_BUSY' });
    expect(items[1]).toMatchObject({ state: 'succeeded' });
    expect(finished.status).toBe('partial');
  });

  it('checkinWithoutCredentialFailsWithoutProviderCall', async () => {
    const account = await makeAccount('A');
    const batch = newBatch([account.id]);
    const finished = await runCheckinBatch(deps(), batch.id);
    expect(provider.statusCalls).toBe(0);
    expect(provider.submitCalls).toBe(0);
    expect(finished.status).toBe('failed');
    expect(listCheckinBatchItems(t.db, batch.id)[0]).toMatchObject({ state: 'failed', safe_error_code: 'CHECKIN_CREDENTIAL_MISSING' });
  });

  it('checkinBatchItemRespectsProviderAppScope', async () => {
    const account = await boundAccount('A');
    // 用 codebuddy 的 provider 跑 workbuddy 账号的批次 → 不匹配，不发请求
    const other = new FakeCheckinProvider();
    (other as { app_id: string }).app_id = 'codebuddy_desktop';
    const batch = newBatch([account.id]);
    await runCheckinBatch({ db: t.db, vault, provider: other }, batch.id);
    expect(other.statusCalls).toBe(0);
    expect(other.submitCalls).toBe(0);
    expect(listCheckinBatchItems(t.db, batch.id)[0]).toMatchObject({ state: 'failed', safe_error_code: 'CHECKIN_PROVIDER_MISMATCH' });
  });

  it('checkinBatchResponsesNeverLeakCredential', async () => {
    const account = await boundAccount('A');
    const batch = newBatch([account.id]);
    await runCheckinBatch(deps(), batch.id);
    const serialized = JSON.stringify(getCheckinBatch(t.db, batch.id)) + JSON.stringify(operationsForBatch(t.db, batch.id));
    expect(serialized).not.toContain(CREDENTIAL_MARK);
    expect(serialized).not.toContain(account.checkin_credential_ref ?? 'never');
    expect(serialized).not.toContain('remote_state');
  });

  it('ACC-FIX-3：401 后自动续期一次并写回 vault，重试成功', async () => {
    provider.statusInvalidTimes = 1;
    const account = await boundAccount('refresh-ok');
    const oldRef = account.checkin_credential_ref!;
    const batch = newBatch([account.id]);
    const finished = await runCheckinBatch(deps(), batch.id);
    expect(provider.refreshCalls).toBe(1);
    expect(provider.statusCalls).toBe(2);
    expect(provider.submitCalls).toBe(1);
    expect(finished.status).toBe('succeeded');
    const updated = getManagedAccount(t.db, account.id)!;
    expect(updated.checkin_credential_ref).not.toBe(oldRef);
    expect(vault.deletedRefs).toContain(oldRef);
    expect(vault.values().map(value => value.toString())).toContain('FAKE-REFRESHED-CREDENTIAL');
  });

  it('ACC-FIX-3：无法续期（null）→ CHECKIN_CREDENTIAL_INVALID，只试一次不循环', async () => {
    provider.statusInvalidTimes = 1;
    provider.refreshedCredential = null;
    const account = await boundAccount('refresh-null');
    const batch = newBatch([account.id]);
    const finished = await runCheckinBatch(deps(), batch.id);
    expect(provider.refreshCalls).toBe(1);
    expect(provider.statusCalls).toBe(1);
    expect(provider.submitCalls).toBe(0);
    expect(finished.status).toBe('failed');
    expect(listCheckinBatchItems(t.db, batch.id)[0]).toMatchObject({ state: 'failed', safe_error_code: 'CHECKIN_CREDENTIAL_INVALID' });
  });

  it('ACC-FIX-3：续期后仍 401 → 停止重试，结果仍为 CHECKIN_CREDENTIAL_INVALID', async () => {
    provider.statusInvalidTimes = 2;
    const account = await boundAccount('refresh-twice');
    const batch = newBatch([account.id]);
    await runCheckinBatch(deps(), batch.id);
    expect(provider.refreshCalls).toBe(1);
    expect(provider.statusCalls).toBe(2);
    expect(listCheckinBatchItems(t.db, batch.id)[0]).toMatchObject({ state: 'failed', safe_error_code: 'CHECKIN_CREDENTIAL_INVALID' });
  });

describe('cat travel hook (ACC-12)', () => {
  it('travel failure keeps checkin result and is visible in operation.recovery_ref', async () => {
    const account = await boundAccount('travel-fail');
    const travelProvider = new FakeCheckinProvider('workbuddy_desktop');
    travelProvider.afterCheckin = async () => ({ kind: 'travel', status: 'failed', safe_error_code: 'TRAVEL_HTTP_500' });
    const batch = newBatch([account.id]);
    const finished = await runCheckinBatch({ db: t.db, vault, provider: travelProvider }, batch.id);
    const items = listCheckinBatchItems(t.db, finished.id);
    expect(items[0]).toMatchObject({ state: 'succeeded' });
    const operations = operationsForBatch(t.db, finished.id);
    expect(operations[0]?.recovery_ref).toBe('travel=failed:TRAVEL_HTTP_500');
  });

  it('travel dispatched is recorded without touching checkin state', async () => {
    const account = await boundAccount('travel-ok');
    const travelProvider = new FakeCheckinProvider('workbuddy_desktop');
    travelProvider.afterCheckin = async () => ({ kind: 'travel', status: 'dispatched' });
    const batch = newBatch([account.id]);
    const finished = await runCheckinBatch({ db: t.db, vault, provider: travelProvider }, batch.id);
    expect(listCheckinBatchItems(t.db, finished.id)[0]).toMatchObject({ state: 'succeeded' });
    expect(operationsForBatch(t.db, finished.id)[0]?.recovery_ref).toBe('travel=dispatched');
  });

  it('travel hook is skipped when checkin failed', async () => {
    const account = await boundAccount('travel-skip');
    const failing = new FakeCheckinProvider('workbuddy_desktop');
    failing.submitResults = ['failed'];
    let called = 0;
    failing.afterCheckin = async () => { called += 1; return { kind: 'travel', status: 'dispatched' }; };
    const batch = newBatch([account.id]);
    await runCheckinBatch({ db: t.db, vault, provider: failing }, batch.id);
    expect(called).toBe(0);
  });
});
});
