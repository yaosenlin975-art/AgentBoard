/**
 * ACC-KB-B2S：协议级「添加账号」的会话服务测试。
 *
 * 覆盖三件最要紧的事：
 * 1. **凭据只在授权成功后落库**——pending 期间库里没有账号、响应里没有凭据；
 * 2. **放弃/超时/失败不留痕**——待激活凭据从 vault 消失、不留半条账号；
 * 3. **成功即出现在 managed_account 列表**——不需要重启客户端。
 *
 * provider 替身只验证编排与状态机；协议解析器的真实请求形状见 addAccountProviders.test.ts。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestDb, type TestDb } from './helpers.js';
import {
  cancelAddAccountAuthorization,
  pollAddAccountAuthorization,
  startAddAccountAuthorization,
  sweepExpiredAddAccountSessions,
} from '../src/services/accounts/addAccountAuthorization.js';
import { getManagedAccount, listManagedAccounts } from '../src/db/repos/managedAccount.js';
import {
  ADD_ACCOUNT_CREDENTIAL_MARK as CREDENTIAL_MARK,
  ADD_ACCOUNT_PENDING_MARK as PENDING_MARK,
  FakeAddAccountProvider,
  FakeAddAccountVault,
} from './fakeAddAccountProvider.js';

describe('add account authorization', () => {
  let t: TestDb;
  let provider: FakeAddAccountProvider;
  let vault: FakeAddAccountVault;

  beforeEach(() => {
    t = createTestDb();
    provider = new FakeAddAccountProvider();
    vault = new FakeAddAccountVault();
  });
  afterEach(() => t.cleanup());

  const deps = () => ({ db: t.db, vault, providers: { minimax: provider } });

  it('addAccountStartDoesNotCreateAccount', async () => {
    const session = await startAddAccountAuthorization(deps(), { app_id: 'minimax', region: 'cn' });
    expect(session.status).toBe('pending');
    expect(session.authorization_url).toContain('https://');
    expect(session.user_code).toBe('ABCD-EFGH');
    // 待激活凭据只在 vault，且用 pending_credential purpose
    expect(vault.size).toBe(1);
    expect(vault.purposes()).toEqual(['pending_credential']);
    // 库里没有任何账号
    expect(listManagedAccounts(t.db)).toHaveLength(0);
    // 响应不含凭据/vault 引用
    const body = JSON.stringify(session);
    expect(body).not.toContain(PENDING_MARK);
    expect(body).not.toContain('pending_secret');
  });

  it('addAccountPollPendingKeepsNoAccount', async () => {
    provider.pollResults = [{ status: 'pending' }];
    const started = await startAddAccountAuthorization(deps(), { app_id: 'minimax' });
    const polled = await pollAddAccountAuthorization(deps(), started.id);
    expect(polled.session.status).toBe('pending');
    expect(polled.account).toBeNull();
    expect(listManagedAccounts(t.db)).toHaveLength(0);
    expect(vault.size).toBe(1);
  });

  it('addAccountPollAuthorizedCreatesAccountAndCleansPending', async () => {
    const started = await startAddAccountAuthorization(deps(), { app_id: 'minimax' });
    const polled = await pollAddAccountAuthorization(deps(), started.id);
    expect(polled.session.status).toBe('authorized');
    expect(polled.account).not.toBeNull();
    expect(polled.account!.app_id).toBe('minimax');
    expect(polled.account!.display_name).toBe('测试账号');
    // 账号落库：凭据引用在 checkin_credential_ref 上，且带签到能力标记
    const row = getManagedAccount(t.db, polled.account!.id)!;
    expect(row.checkin_credential_ref).not.toBeNull();
    expect(row.checkin_capability).toBe('supported');
    // vault 里只剩最终凭据（待激活凭据已删，不留孤儿）
    expect(vault.size).toBe(1);
    expect(vault.purposes()).toEqual(['checkin']);
    expect(vault.deletedRefs).toHaveLength(1);
    // 响应不泄露凭据原文或 vault 引用
    const body = JSON.stringify(polled);
    expect(body).not.toContain(CREDENTIAL_MARK);
    expect(body).not.toContain(row.checkin_credential_ref!);
  });

  it('addAccountSameIdentityDoesNotDuplicate', async () => {
    const first = await startAddAccountAuthorization(deps(), { app_id: 'minimax' });
    await pollAddAccountAuthorization(deps(), first.id);
    // 结束上一条会话后再加一次同一个账号（同一 app + 同一 uid）
    t.db.prepare('DELETE FROM add_account_session WHERE id=?').run(first.id);
    const second = await startAddAccountAuthorization(deps(), { app_id: 'minimax' });
    const polled = await pollAddAccountAuthorization(deps(), second.id);
    expect(listManagedAccounts(t.db)).toHaveLength(1);
    expect(polled.account!.id).toBe(listManagedAccounts(t.db)[0]!.id);
  });

  it('addAccountExpiredSessionLeavesNoAccountAndNoOrphan', async () => {
    const started = await startAddAccountAuthorization(deps(), { app_id: 'minimax' });
    t.db.prepare('UPDATE add_account_session SET expires_at=? WHERE id=?').run(Date.now() - 1000, started.id);
    await expect(pollAddAccountAuthorization(deps(), started.id)).rejects.toMatchObject({ code: 'AUTHORIZATION_EXPIRED' });
    const row = t.db.prepare('SELECT status FROM add_account_session WHERE id=?').get(started.id) as { status: string };
    expect(row.status).toBe('expired');
    expect(listManagedAccounts(t.db)).toHaveLength(0);
    expect(vault.size).toBe(0);
  });

  it('addAccountSweepCleansExpiredSessionWithoutPolling', async () => {
    const started = await startAddAccountAuthorization(deps(), { app_id: 'minimax' });
    t.db.prepare('UPDATE add_account_session SET expires_at=? WHERE id=?').run(Date.now() - 1000, started.id);
    const swept = await sweepExpiredAddAccountSessions(deps());
    expect(swept).toBe(1);
    expect(vault.size).toBe(0);
    expect(listManagedAccounts(t.db)).toHaveLength(0);
    const row = t.db.prepare('SELECT status FROM add_account_session WHERE id=?').get(started.id) as { status: string };
    expect(row.status).toBe('expired');
  });

  it('addAccountCancelLeavesNoAccountAndNoOrphan', async () => {
    const started = await startAddAccountAuthorization(deps(), { app_id: 'minimax' });
    const cancelled = await cancelAddAccountAuthorization(deps(), started.id);
    expect(cancelled.status).toBe('cancelled');
    expect(listManagedAccounts(t.db)).toHaveLength(0);
    expect(vault.size).toBe(0);
    expect(provider.disposed).toBe(1);
  });

  it('addAccountFailedPollCleansPending', async () => {
    provider.pollResults = [{ status: 'failed', safe_error_code: 'MINIMAX_ACCESS_DENIED' }];
    const started = await startAddAccountAuthorization(deps(), { app_id: 'minimax' });
    const polled = await pollAddAccountAuthorization(deps(), started.id);
    expect(polled.session.status).toBe('failed');
    expect(polled.session.safe_error_code).toBe('MINIMAX_ACCESS_DENIED');
    expect(listManagedAccounts(t.db)).toHaveLength(0);
    expect(vault.size).toBe(0);
  });

  it('addAccountSecondStartIsRejected', async () => {
    await startAddAccountAuthorization(deps(), { app_id: 'minimax' });
    const error = await startAddAccountAuthorization(deps(), { app_id: 'minimax' }).catch(caught => caught);
    expect(error).toMatchObject({ code: 'ADD_ACCOUNT_SESSION_EXISTS' });
    // 重复点加号不会往 vault 里再堆一份待激活凭据
    expect(vault.size).toBe(1);
  });

  it('addAccountUnsupportedPlatformIsRejected', async () => {
    const error = await startAddAccountAuthorization(deps(), { app_id: 'qoder_cn' }).catch(caught => caught);
    expect(error).toMatchObject({ code: 'PROVIDER_UNVERIFIED' });
    expect(t.db.prepare('SELECT COUNT(*) c FROM add_account_session').get()).toEqual({ c: 0 });
    expect(vault.size).toBe(0);
  });

  it('addAccountPollAfterFinishIsRejected', async () => {
    const started = await startAddAccountAuthorization(deps(), { app_id: 'minimax' });
    await pollAddAccountAuthorization(deps(), started.id);
    await expect(pollAddAccountAuthorization(deps(), started.id)).rejects.toMatchObject({ code: 'AUTHORIZATION_NOT_PENDING' });
  });
});
