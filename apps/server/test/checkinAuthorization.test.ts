/**
 * ACC-07 签到授权：三元组绑定、不匹配不落库、单次绑定、过期与产品隔离。
 * 替身 provider 只验证编排与状态机，不代表真实产品契约（真实 gate 仍 unverified）。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestDb, type TestDb } from './helpers.js';
import { createManagedAccount } from '../src/db/repos/managedAccount.js';
import { getManagedAccount } from '../src/db/repos/managedAccount.js';
import { pollCheckinAuthorization, startCheckinAuthorization } from '../src/services/accounts/checkinAuthorization.js';
import { ApiError } from '../src/errors.js';
import { CHECKIN_UID, CREDENTIAL_MARK, FakeCheckinProvider, FakeCheckinVault, sha256 } from './fakeCheckinProvider.js';

describe('checkin authorization', () => {
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
  const account = (over: Record<string, unknown> = {}) => createManagedAccount(t.db, {
    app_id: 'workbuddy_desktop',
    client_instance_id: 'inst-1',
    service_region: 'cn',
    identity_hash: sha256(CHECKIN_UID),
    display_name: '账号A',
    ...over,
  } as never);

  it('checkinAuthorizationBindsMatchingIdentityTriple', async () => {
    const target = account();
    const started = await startCheckinAuthorization(deps(), target.id);
    expect(started.status).toBe('pending');
    expect(started.authorization_url).toContain('https://');
    expect(JSON.stringify(started)).not.toContain('remote_state');

    const polled = await pollCheckinAuthorization(deps(), started.id);
    expect(polled.authorization.status).toBe('authorized');
    const bound = getManagedAccount(t.db, target.id)!;
    expect(bound.checkin_credential_ref).not.toBeNull();
    expect(bound.checkin_capability).toBe('supported');
    // vault 里两份：remote state + credential
    expect(vault.size).toBe(2);
    expect(vault.values().some(value => value.toString('utf8') === CREDENTIAL_MARK)).toBe(true);
    // 响应脱敏：无 ref/token/state 原文
    const body = JSON.stringify(polled);
    expect(body).not.toContain(bound.checkin_credential_ref!);
    expect(body).not.toContain(CREDENTIAL_MARK);
    expect(body).not.toContain('remote_state');
  });

  it('checkinAuthorizationRejectsProductRegionUidMismatch', async () => {
    const cases = [
      { identity: { app_id: 'codebuddy_desktop' as const, region: 'cn' as const, uid: CHECKIN_UID } },
      { identity: { app_id: 'workbuddy_desktop' as const, region: 'global' as const, uid: CHECKIN_UID } },
      { identity: { app_id: 'workbuddy_desktop' as const, region: 'cn' as const, uid: '22222222-2222-2222-2222-222222222222' } },
    ];
    for (const [index, item] of cases.entries()) {
      t.db.prepare('DELETE FROM checkin_authorization').run();
      provider.authResults = [{ status: 'authorized', identity: item.identity, credential: Buffer.from(CREDENTIAL_MARK) }];
      const target = account({ client_instance_id: `inst-mismatch-${index}`, display_name: `mismatch-${index}` });
      const started = await startCheckinAuthorization(deps(), target.id);
      const vaultBefore = vault.size;
      await expect(pollCheckinAuthorization(deps(), started.id)).rejects.toMatchObject({ code: 'CHECKIN_IDENTITY_MISMATCH' });
      // 不写凭据、不绑 ref
      expect(vault.size).toBe(vaultBefore);
      expect(getManagedAccount(t.db, target.id)!.checkin_credential_ref).toBeNull();
      expect(getManagedAccount(t.db, target.id)!.checkin_capability).toBe('unknown');
      // 授权行落 failed，可重新授权
      const row = t.db.prepare('SELECT status,safe_error_code FROM checkin_authorization WHERE id=?').get(started.id) as { status: string; safe_error_code: string | null };
      expect(row).toEqual({ status: 'failed', safe_error_code: 'CHECKIN_IDENTITY_MISMATCH' });
    }
  });

  it('checkinAuthorizationPollIsSingleBinding', async () => {
    const target = account();
    const started = await startCheckinAuthorization(deps(), target.id);
    await pollCheckinAuthorization(deps(), started.id);
    const vaultAfterBind = vault.size;
    const ref = getManagedAccount(t.db, target.id)!.checkin_credential_ref;
    await expect(pollCheckinAuthorization(deps(), started.id)).rejects.toMatchObject({ code: 'AUTHORIZATION_NOT_PENDING' });
    expect(vault.size).toBe(vaultAfterBind);
    expect(getManagedAccount(t.db, target.id)!.checkin_credential_ref).toBe(ref);
  });

  it('checkinAuthorizationPendingDoesNotWriteCredential', async () => {
    provider.authResults = [{ status: 'pending' }];
    const target = account();
    const started = await startCheckinAuthorization(deps(), target.id);
    const polled = await pollCheckinAuthorization(deps(), started.id);
    expect(polled.authorization.status).toBe('pending');
    expect(vault.size).toBe(1);
    expect(getManagedAccount(t.db, target.id)!.checkin_credential_ref).toBeNull();
  });

  it('checkinAuthorizationExpiredIsReported', async () => {
    const target = account();
    const started = await startCheckinAuthorization(deps(), target.id);
    t.db.prepare('UPDATE checkin_authorization SET expires_at=? WHERE id=?').run(Date.now() - 1000, started.id);
    await expect(pollCheckinAuthorization(deps(), started.id)).rejects.toMatchObject({ code: 'AUTHORIZATION_EXPIRED' });
    expect((t.db.prepare('SELECT status FROM checkin_authorization WHERE id=?').get(started.id) as { status: string }).status).toBe('expired');
    expect(vault.size).toBe(1);
  });

  it('checkinAuthorizationRejectsProviderAppMismatch', async () => {
    const target = account({ app_id: 'codebuddy_desktop' });
    await expect(startCheckinAuthorization(deps(), target.id)).rejects.toMatchObject({ code: 'CHECKIN_PROVIDER_MISMATCH' });
    expect(provider.startCalls).toBe(0);
    expect(t.db.prepare('SELECT COUNT(*) c FROM checkin_authorization').get()).toEqual({ c: 0 });
  });

  it('checkinAuthorizationOpenSessionIsUniquePerAccount', async () => {
    const target = account();
    await startCheckinAuthorization(deps(), target.id);
    const error = await startCheckinAuthorization(deps(), target.id).catch(caught => caught);
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).code).toBe('CHECKIN_AUTHORIZATION_EXISTS');
    expect(t.db.prepare('SELECT COUNT(*) c FROM checkin_authorization').get()).toEqual({ c: 1 });
  });
});
