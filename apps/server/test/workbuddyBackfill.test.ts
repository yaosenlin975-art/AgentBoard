/**
 * ACC-FIX-4：WorkBuddy 客户端未运行时用插件线 JWT 回填签到凭据（provider 级单测）。
 * 场景锚点：WorkBuddy.exe 不在运行（capture-current 409 CLIENT_NOT_RUNNING），但插件线
 * `Tencent-Cloud.coding-copilot.info` 明文 JWT 文件存在——backfillCheckinCredentialFromPlugin
 * 按库内既有账号行的 identity_hash 匹配回填，不建新行。
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { createTestDb, type TestDb } from './helpers.js';
import type { Db } from '../src/db/connection.js';
import { SecretVault } from '../src/services/accounts/secretVault.js';
import { WorkbuddyDesktopProvider } from '../src/services/accounts/workbuddyDesktopProvider.js';
import { createManagedAccount, getManagedAccount, listManagedAccounts } from '../src/db/repos/managedAccount.js';

const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');

const dbs: TestDb[] = [];
function newDb(): Db {
  const t = createTestDb();
  dbs.push(t);
  return t.db;
}
afterEach(() => { while (dbs.length) dbs.pop()!.cleanup(); });

function makeProvider(db: Db, vault: SecretVault, find: (identity: { identity_hash: string }) => Promise<string | null>): WorkbuddyDesktopProvider {
  const dir = mkdtempSync(join(tmpdir(), 'wb-backfill-'));
  return new WorkbuddyDesktopProvider({
    db,
    vault,
    paths: { exePath: join(dir, 'WorkBuddy.exe'), authInfoPath: join(dir, 'auth.info'), skeletonPath: join(dir, 'skeleton.json'), dataRoot: dir, windowStatePath: join(dir, 'window-state.json'), startupLogDir: join(dir, 'logs') },
    probe: { probe: async () => ({ pids: [], instanceId: 'fixture-instance', version: '0.0.0' }) } as never,
    broadcast: () => {},
    checkinTokenSource: { find },
  });
}

describe('workbuddy plugin-line checkin backfill (ACC-FIX-4)', () => {
  it('matched identity row gets checkin credential ref backfilled, idempotent on rerun', async () => {
    const db = newDb();
    const dir = mkdtempSync(join(tmpdir(), 'wb-backfill-'));
    const vault = new SecretVault(join(dir, 'accounts'));
    const identityHash = sha256('fixture-uid-1');
    const row = createManagedAccount(db, {
      app_id: 'workbuddy_desktop', client_instance_id: 'fixture-instance', service_region: 'unknown',
      identity_hash: identityHash, display_name: 'WorkBuddy-fixture',
    });
    const provider = makeProvider(db, vault, async identity => (identity.identity_hash === identityHash ? 'jwt-token-fixture' : null));

    const backfilled = await provider.backfillCheckinCredentialFromPlugin();
    expect(backfilled?.id).toBe(row.id);
    const after = getManagedAccount(db, row.id)!;
    expect(after.checkin_credential_ref).toBeTruthy();

    // 重复回填：替换为新 ref，不报错、不建新行
    const again = await provider.backfillCheckinCredentialFromPlugin();
    expect(again?.id).toBe(row.id);
    expect(getManagedAccount(db, row.id)!.checkin_credential_ref).toBeTruthy();
    expect(listManagedAccounts(db).filter(a => a.app_id === 'workbuddy_desktop')).toHaveLength(1);
  }, 30000);

  it('unmatched identity or empty table returns null without touching rows', async () => {
    const db = newDb();
    const dir = mkdtempSync(join(tmpdir(), 'wb-backfill-'));
    const vault = new SecretVault(join(dir, 'accounts'));
    const identityHash = sha256('fixture-uid-2');
    const row = createManagedAccount(db, {
      app_id: 'workbuddy_desktop', client_instance_id: 'fixture-instance', service_region: 'unknown',
      identity_hash: identityHash, display_name: 'WorkBuddy-fixture-2',
    });
    const provider = makeProvider(db, vault, async () => null);
    expect(await provider.backfillCheckinCredentialFromPlugin()).toBeNull();
    expect(getManagedAccount(db, row.id)!.checkin_credential_ref).toBeNull();

    const emptyProvider = makeProvider(newDb(), vault, async () => 'jwt-token-fixture');
    expect(await emptyProvider.backfillCheckinCredentialFromPlugin()).toBeNull();
  }, 30000);
});
