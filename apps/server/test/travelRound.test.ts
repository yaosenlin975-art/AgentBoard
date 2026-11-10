/**
 * TRAVEL-REC-1：WorkBuddy 猫猫旅行轮次持久化。
 * 覆盖：迁移幂等、pending 唯一不重置到期、状态 CAS、失败可观察、签到后 dispatched 自动落轮次。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createManagedAccount } from '../src/db/repos/managedAccount.js';
import { attachCheckinCredential, createCheckinBatch, operationsForBatch } from '../src/db/repos/checkin.js';
import {
  TRAVEL_RECOVERY_DELAY_MS,
  createPendingTravelRound,
  getPendingTravelRound,
  listPendingTravelRounds,
  recordTravelAttemptFailure,
  transitionTravelRound,
} from '../src/db/repos/travelRound.js';
import { initSchema } from '../src/db/schema.js';
import { profileLocalDay } from '../src/services/accounts/checkinAuthorization.js';
import { runCheckinBatch } from '../src/services/accounts/checkinRunner.js';
import { CHECKIN_UID, CREDENTIAL_MARK, FakeCheckinProvider, FakeCheckinVault, sha256 } from './fakeCheckinProvider.js';
import { createTestDb, type TestDb } from './helpers.js';

describe('travel round persistence', () => {
  let t: TestDb;

  beforeEach(() => {
    t = createTestDb();
  });
  afterEach(() => t.cleanup());

  it('migration is idempotent: repeated initSchema keeps the same table/index DDL', () => {
    const ddl = () => (t.db.prepare(
      "SELECT name,sql FROM sqlite_master WHERE name IN ('workbuddy_travel_round','workbuddy_travel_round_open','workbuddy_travel_round_due','workbuddy_travel_round_account') ORDER BY name",
    ).all() as { name: string; sql: string }[]);
    const before = ddl();
    expect(before.length).toBe(4);
    initSchema(t.db);
    initSchema(t.db);
    expect(ddl()).toEqual(before);
  });

  it('creates one pending round per account and never resets its due time', () => {
    const first = createPendingTravelRound(t.db, { account_id: 'acc-1', operation_id: 'op-1', dispatched_at: 1_000, due_at: 1_000 + TRAVEL_RECOVERY_DELAY_MS });
    const second = createPendingTravelRound(t.db, { account_id: 'acc-1', operation_id: 'op-2', dispatched_at: 9_999 });
    expect(second.id).toBe(first.id);
    expect(second.due_at).toBe(first.due_at);
    expect(second.operation_id).toBe('op-1');
    expect(listPendingTravelRounds(t.db)).toHaveLength(1);
  });

  it('transition is CAS: the same round can only leave pending once', () => {
    const round = createPendingTravelRound(t.db, { account_id: 'acc-2', dispatched_at: 0 });
    expect(transitionTravelRound(t.db, round.id, 'pending', { state: 'claimed' })?.state).toBe('claimed');
    expect(transitionTravelRound(t.db, round.id, 'pending', { state: 'missed' })).toBeNull();
  });

  it('keeps a failed attempt pending and observable via attempts/safe_error_code', () => {
    const round = createPendingTravelRound(t.db, { account_id: 'acc-3', dispatched_at: 0 });
    const failed = recordTravelAttemptFailure(t.db, round.id, 'TRAVEL_HTTP_500');
    expect(failed?.state).toBe('pending');
    expect(failed?.attempts).toBe(1);
    expect(failed?.safe_error_code).toBe('TRAVEL_HTTP_500');
    expect(failed?.last_attempt_at).not.toBeNull();
  });

  it('checkin runner records a pending round when the travel hook dispatches', async () => {
    const provider = new FakeCheckinProvider();
    const vault = new FakeCheckinVault();
    provider.afterCheckin = async () => ({ kind: 'travel' as const, status: 'dispatched' as const });
    const account = createManagedAccount(t.db, {
      app_id: 'workbuddy_desktop',
      client_instance_id: 'inst-travel-rec',
      service_region: 'cn',
      identity_hash: sha256(`${CHECKIN_UID}-travel-rec`),
      display_name: 'travel-rec',
    } as never);
    const ref = await vault.protect(Buffer.from(CREDENTIAL_MARK), {
      app_id: account.app_id,
      client_instance_id: account.client_instance_id,
      identity_hash: account.identity_hash,
      purpose: 'checkin',
    });
    attachCheckinCredential(t.db, account.id, ref);
    const batch = createCheckinBatch(t.db, { app_id: 'workbuddy_desktop', account_ids: [account.id], profile_local_day: profileLocalDay() });

    const finished = await runCheckinBatch({ db: t.db, vault, provider }, batch.id);

    expect(finished.status).toBe('succeeded');
    const round = getPendingTravelRound(t.db, account.id);
    expect(round).not.toBeNull();
    expect(round!.operation_id).toBe(operationsForBatch(t.db, batch.id)[0]?.id);
    expect(round!.due_at - round!.dispatched_at).toBe(225 * 60 * 1000);
    expect(TRAVEL_RECOVERY_DELAY_MS).toBe(225 * 60 * 1000);
  });

  it('leaves no pending round when the hook claims immediately', async () => {
    const provider = new FakeCheckinProvider();
    const vault = new FakeCheckinVault();
    provider.afterCheckin = async () => ({ kind: 'travel' as const, status: 'claimed' as const });
    const account = createManagedAccount(t.db, {
      app_id: 'workbuddy_desktop',
      client_instance_id: 'inst-travel-claimed',
      service_region: 'cn',
      identity_hash: sha256(`${CHECKIN_UID}-travel-claimed`),
      display_name: 'travel-claimed',
    } as never);
    const ref = await vault.protect(Buffer.from(CREDENTIAL_MARK), {
      app_id: account.app_id,
      client_instance_id: account.client_instance_id,
      identity_hash: account.identity_hash,
      purpose: 'checkin',
    });
    attachCheckinCredential(t.db, account.id, ref);
    const batch = createCheckinBatch(t.db, { app_id: 'workbuddy_desktop', account_ids: [account.id], profile_local_day: profileLocalDay() });

    await runCheckinBatch({ db: t.db, vault, provider }, batch.id);

    expect(getPendingTravelRound(t.db, account.id)).toBeNull();
  });
});
