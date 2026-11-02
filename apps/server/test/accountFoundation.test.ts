import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SecretVault, type VaultScope } from '../src/services/accounts/secretVault.js';
import { withAccountLock } from '../src/services/accounts/locks.js';
import { createManagedAccount, listManagedAccounts } from '../src/db/repos/managedAccount.js';
import { createAccountOperation, updateAccountOperation } from '../src/db/repos/accountOperation.js';
import { runAccountOperation, recoverAccountOperations } from '../src/services/accounts/operationRunner.js';
import { createTestDb, type TestDb } from './helpers.js';
import { ApiError } from '../src/errors.js';
describe('account foundation', () => {
  let t: TestDb; let dir: string;
  const scope: VaultScope = { app_id: 'workbuddy_desktop', client_instance_id: 'instance-A', identity_hash: 'a'.repeat(64), purpose: 'client_snapshot' };
  const account = () => createManagedAccount(t.db, { app_id: 'workbuddy_desktop', client_instance_id: 'instance-A', identity_hash: 'a'.repeat(64), service_region: 'cn', display_name: '测试账号' });
  beforeEach(() => { t = createTestDb(); dir = mkdtempSync(join(tmpdir(), 'agentboard-vault-test-')); });
  afterEach(() => { t.cleanup(); rmSync(dir, { recursive: true, force: true }); });
  it.runIf(process.platform === 'win32')('vaultProtectUnprotectWorksForCurrentUser with real Windows DPAPI', async () => {
    const vault = new SecretVault(dir); const secret = Buffer.from('fixture-token-not-real 中文');
    const ref = await vault.protect(secret, scope);
    expect(ref).toMatch(/^[a-f0-9-]{36}$/); expect((await vault.unprotect(ref, scope)).equals(secret)).toBe(true);
    const persisted = readFileSync(join(dir, `${ref}.dpapi`)); expect(persisted.includes(secret)).toBe(false);
    expect(readdirSync(dir)).toEqual([`${ref}.dpapi`]); await vault.delete(ref); expect(readdirSync(dir)).toHaveLength(0);
  }, 20000);
  it.runIf(process.platform === 'win32')('wrongScopeOrReferenceCannotDecrypt and corrupt cipher gives a safe error', async () => {
    const vault = new SecretVault(dir); const ref = await vault.protect(Buffer.from('fixture-secret'), scope);
    for (const wrong of [{ ...scope, purpose: 'checkin' as const }, { ...scope, client_instance_id: 'other' }, { ...scope, identity_hash: 'b'.repeat(64) }]) {
      await expect(vault.unprotect(ref, wrong)).rejects.toMatchObject({ code: 'VAULT_READ_FAILED' });
    }
    await expect(vault.delete('../outside')).rejects.toThrow();
    writeFileSync(join(dir, `${ref}.dpapi`), 'corrupt');
    await expect(vault.unprotect(ref, scope)).rejects.toMatchObject({ code: 'VAULT_READ_FAILED' });
  }, 30000);
  it('sameAccountLockSerializesOperations and releases after throw', async () => {
    let active = 0; let max = 0;
    await Promise.all([1, 2, 3].map(() => withAccountLock('account', 'A', async () => { active++; max = Math.max(max, active); await new Promise(r => setTimeout(r, 5)); active--; })));
    expect(max).toBe(1);
    await expect(withAccountLock('account', 'A', async () => { throw Error('failed'); })).rejects.toThrow();
    expect(await withAccountLock('account', 'A', async () => 42)).toBe(42);
  });
  it('registry rejects secret fields, duplicates and invalid refs; returns safe metadata', () => {
    const created = account(); expect(created.checkin_capability).toBe('unknown');
    expect(() => account()).toThrow(); expect(() => createManagedAccount(t.db, { ...created, access_token: 'do-not-store' } as any)).toThrow();
    expect(JSON.stringify(listManagedAccounts(t.db))).not.toContain('client_snapshot_ref'); expect(JSON.stringify(listManagedAccounts(t.db))).not.toContain('identity_hash');
    const columns = t.db.prepare('PRAGMA table_info(managed_account)').all() as Array<{ name: string }>;
    expect(columns.map(c => c.name)).not.toContain('access_token');
  });
  it('recovery_required freezes new operations and records only safe error codes', async () => {
    const a = account(); const input = { account_id: a.id, app_id: a.app_id, client_instance_id: a.client_instance_id, operation: 'switch' as const };
    const result = await runAccountOperation(t.db, input, async () => { throw new ApiError(409, 'RECOVERY_REQUIRED', 'fixture-secret-must-not-leak'); });
    expect(result.state).toBe('recovery_required'); expect(result.safe_error_code).toBe('RECOVERY_REQUIRED');
    await expect(runAccountOperation(t.db, input, async () => 'succeeded')).rejects.toMatchObject({ code: 'RECOVERY_REQUIRED' });
    expect(JSON.stringify(t.db.prepare('SELECT * FROM account_operation').all())).not.toContain('fixture-secret-must-not-leak');
  });
  it('operation transitions are durable and illegal final-state rewrites fail', () => {
    const a = account(); const op = createAccountOperation(t.db, { account_id: a.id, app_id: a.app_id, client_instance_id: a.client_instance_id, operation: 'checkin' });
    expect(op.state).toBe('queued'); updateAccountOperation(t.db, op.id, { state: 'running', stage: 'preflight' });
    expect(updateAccountOperation(t.db, op.id, { state: 'succeeded' }).finished_at).not.toBeNull();
    expect(() => updateAccountOperation(t.db, op.id, { state: 'running' })).toThrow();
  });
  it('boot recovery freezes interrupted client writes and keeps checkin unknown', () => {
    const a = account();
    const write = createAccountOperation(t.db, { account_id: a.id, app_id: a.app_id, client_instance_id: a.client_instance_id, operation: 'switch' });
    updateAccountOperation(t.db, write.id, { state: 'running', stage: 'write' });
    const checkin = createAccountOperation(t.db, { account_id: a.id, app_id: a.app_id, client_instance_id: a.client_instance_id, operation: 'checkin' });
    updateAccountOperation(t.db, checkin.id, { state: 'running' });
    recoverAccountOperations(t.db);
    expect(t.db.prepare('SELECT state FROM account_operation WHERE id=?').get(write.id)).toEqual({ state: 'recovery_required' });
    expect(t.db.prepare('SELECT state FROM account_operation WHERE id=?').get(checkin.id)).toEqual({ state: 'unknown' });
  });
  it('post-write generic errors freeze the instance without trusting exception labels', async () => {
    const a = account(); const input = { account_id: a.id, app_id: a.app_id, client_instance_id: a.client_instance_id, operation: 'switch' as const };
    const failed = await runAccountOperation(t.db, input, async op => { updateAccountOperation(t.db, op.id, { stage: 'write' }); throw Error('write interrupted'); });
    expect(failed.state).toBe('recovery_required');
    await expect(runAccountOperation(t.db, input, async () => 'succeeded')).rejects.toMatchObject({ code: 'RECOVERY_REQUIRED' });
  });
  it('linked restore success unfreezes only its recovered operation atomically', async () => {
    const a = account(); const input = { account_id: a.id, app_id: a.app_id, client_instance_id: a.client_instance_id, operation: 'switch' as const };
    const failed = await runAccountOperation(t.db, input, async () => { throw new ApiError(409, 'RECOVERY_REQUIRED', 'test'); });
    const restoreInput = { ...input, operation: 'restore' as const, recovers_operation_id: failed.id };
    expect((await runAccountOperation(t.db, restoreInput, async () => 'succeeded')).state).toBe('succeeded');
    expect((await runAccountOperation(t.db, input, async () => 'succeeded')).state).toBe('succeeded');
    const nextFailure = await runAccountOperation(t.db, input, async () => { throw new ApiError(409, 'RECOVERY_REQUIRED', 'test'); });
    await expect(runAccountOperation(t.db, { ...restoreInput, account_id: undefined, client_instance_id: 'other', recovers_operation_id: nextFailure.id }, async () => 'succeeded')).rejects.toMatchObject({ status: 400 });
    const failedRestore = await runAccountOperation(t.db, { ...restoreInput, recovers_operation_id: nextFailure.id }, async () => { throw Error('not verified'); });
    expect(failedRestore.state).toBe('failed');
    await expect(runAccountOperation(t.db, input, async () => 'succeeded')).rejects.toMatchObject({ code: 'RECOVERY_REQUIRED' });
  });
});
