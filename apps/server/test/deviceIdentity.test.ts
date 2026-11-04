/**
 * ACC-KB-B6：设备身份（方案 B）——迁移幂等、回填成功/失败(pending)/重试、安全快照写入与校验。
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestDb, type TestDb } from './helpers.js';
import { migrateDeviceIdentity } from '../src/db/migrations/deviceIdentity.js';
import {
  DEVICE_IDENTITY_ERROR_CODES,
  backfillDeviceIdentity,
  getDeviceIdentity,
  securitySnapshotDir,
  verifySecuritySnapshot,
  writeSecuritySnapshot,
  type DeviceIdentityCapture,
} from '../src/services/accounts/deviceIdentity.js';

const accountRow = (id: string, appId: string, snapshotRef: string | null = null) => ({
  id,
  app_id: appId,
  client_instance_id: `inst-${id}`,
  service_region: 'cn',
  identity_hash: `hash-${id}`,
  display_name: `账号 ${id}`,
  client_snapshot_ref: snapshotRef,
  created_at: 1,
  updated_at: 1,
});

describe('device identity migration (ACC-KB-B6)', () => {
  let t: TestDb;
  beforeEach(() => { t = createTestDb(); });
  afterEach(() => { t.cleanup(); });

  const columns = (): string[] =>
    (t.db.prepare('PRAGMA table_info(managed_account)').all() as Array<{ name: string }>).map(row => row.name).sort();

  it('幂等：连跑两次结构不变', () => {
    migrateDeviceIdentity(t.db);
    const first = columns();
    migrateDeviceIdentity(t.db);
    expect(columns()).toEqual(first);
    expect(first).toEqual(expect.arrayContaining([
      'device_identity_ref',
      'device_identity_status',
      'device_identity_error',
      'device_identity_updated_at',
    ]));
  });

  it('老数据默认 pending（方案 B 要求必须回填，不回填=没效果）', () => {
    t.db.prepare(`INSERT INTO managed_account (id, app_id, client_instance_id, service_region, identity_hash, display_name, client_snapshot_ref, created_at, updated_at)
      VALUES (?,?,?,?,?,?,?,?,?)`).run('a1', 'workbuddy_desktop', 'inst-a1', 'cn', 'hash-a1', '旧账号', 'ref-1', 1, 1);
    migrateDeviceIdentity(t.db);
    const row = getDeviceIdentity(t.db, 'a1');
    expect(row).toMatchObject({ status: 'pending', ref: null, error: null });
  });
});

describe('device identity backfill (ACC-KB-B6)', () => {
  let t: TestDb;
  let dir: string;
  beforeEach(() => {
    t = createTestDb();
    migrateDeviceIdentity(t.db);
    dir = mkdtempSync(join(tmpdir(), 'agentboard-device-'));
    const insert = t.db.prepare(`INSERT INTO managed_account (id, app_id, client_instance_id, service_region, identity_hash, display_name, client_snapshot_ref, created_at, updated_at)
      VALUES (?,?,?,?,?,?,?,?,?)`);
    insert.run('wb1', 'workbuddy_desktop', 'inst-wb1', 'cn', 'hash-wb1', '工作号', 'ref-wb1', 1, 1);
    insert.run('wb2', 'workbuddy_desktop', 'inst-wb2', 'cn', 'hash-wb2', '失败号', 'ref-wb2', 1, 1);
    insert.run('mm1', 'minimax', 'inst-mm1', 'cn', 'hash-mm1', 'MiniMax', null, 1, 1);
  });
  afterEach(() => { t.cleanup(); rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }); });

  const capture = (files: Record<string, string>) => async (account: { id: string }): Promise<DeviceIdentityCapture | null> => {
    if (account.id === 'wb2') throw new Error('客户端文件不可读');
    return { files: Object.entries(files).map(([path, content]) => ({ path, content: Buffer.from(content, 'utf8') })) };
  };

  it('成功 → ok + 新 ref；失败 → pending + 固定错误码；minimax → not_applicable', async () => {
    const summary = await backfillDeviceIdentity(t.db, {
      capture: capture({ 'device-id': 'dev-1', 'security/uuid/nonce': 'nonce-1' }),
      writeSnapshot: async (account) => {
        const snapshotDir = securitySnapshotDir(join(dir, 'agentboard.db'), account.id);
        writeSecuritySnapshot(snapshotDir, account.id, { files: [{ path: 'device-id', content: Buffer.from('dev-1') }] }, 1);
        return `security/${account.id}`;
      },
    });
    expect(summary).toMatchObject({ scanned: 3, ok: 1, pending: 1, notApplicable: 1 });
    expect(summary.failures.wb2).toBe(DEVICE_IDENTITY_ERROR_CODES.captureFailed);

    expect(getDeviceIdentity(t.db, 'wb1')).toMatchObject({ status: 'ok', ref: 'security/wb1', error: null });
    expect(getDeviceIdentity(t.db, 'wb2')).toMatchObject({ status: 'pending', error: DEVICE_IDENTITY_ERROR_CODES.captureFailed });
    expect(getDeviceIdentity(t.db, 'mm1')).toMatchObject({ status: 'not_applicable', ref: null });
  });

  it('失败可重试：只重跑 pending，第二次成功后转 ok', async () => {
    await backfillDeviceIdentity(t.db, { capture: capture({ 'device-id': 'dev-1' }), writeSnapshot: async (account) => `security/${account.id}` });
    expect(getDeviceIdentity(t.db, 'wb2')?.status).toBe('pending');
    // 第二次：wb2 现在可读
    const retry = await backfillDeviceIdentity(t.db, {
      capture: async (account) => ({ files: [{ path: 'device-id', content: Buffer.from(`dev-${account.id}`) }] }),
      writeSnapshot: async (account) => `security/${account.id}`,
    });
    expect(retry).toMatchObject({ scanned: 1, ok: 1, pending: 0 });
    expect(getDeviceIdentity(t.db, 'wb2')).toMatchObject({ status: 'ok', ref: 'security/wb2' });
  });

  it('写快照失败 → pending + SNAPSHOT_FAILED（不半写）', async () => {
    const summary = await backfillDeviceIdentity(t.db, {
      capture: capture({ 'device-id': 'dev-1' }),
      writeSnapshot: async (account) => {
        if (account.id === 'wb1') throw new Error('磁盘满');
        return `security/${account.id}`;
      },
      onlyAccountIds: ['wb1'],
    });
    expect(summary.failures.wb1).toBe(DEVICE_IDENTITY_ERROR_CODES.snapshotFailed);
    expect(getDeviceIdentity(t.db, 'wb1')).toMatchObject({ status: 'pending', ref: null, error: DEVICE_IDENTITY_ERROR_CODES.snapshotFailed });
  });
});

describe('security snapshot (ACC-KB-B6)', () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'agentboard-secsnap-')); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }); });

  it('写快照：文件落盘 + manifest 记清单/字节数/sha256 前 8 位，校验通过', () => {
    const snapshotDir = securitySnapshotDir(join(dir, 'agentboard.db'), 'acc-1');
    const manifest = writeSecuritySnapshot(snapshotDir, 'acc-1', {
      files: [
        { path: 'device-id', content: Buffer.from('device-abc', 'utf8') },
        { path: 'security/uuid/login-device-nonce', content: Buffer.from('nonce-xyz', 'utf8') },
      ],
    }, 1700000000000);
    expect(manifest.schema).toBe('agentboard.device-identity.snapshot/1');
    expect(manifest.files.map(file => file.path)).toEqual(['device-id', 'security/uuid/login-device-nonce']);
    expect(manifest.files[0]).toMatchObject({ bytes: 10 });
    expect(manifest.files[0]!.sha8).toMatch(/^[0-9a-f]{8}$/);
    expect(existsSync(join(snapshotDir, 'files', 'device-id'))).toBe(true);
    expect(verifySecuritySnapshot(snapshotDir)).toEqual([]);
  });

  it('校验能抓出被改动的文件（sha8 不符）与缺文件', () => {
    const snapshotDir = securitySnapshotDir(join(dir, 'agentboard.db'), 'acc-2');
    writeSecuritySnapshot(snapshotDir, 'acc-2', { files: [{ path: 'device-id', content: Buffer.from('abc') }] }, 1);
    writeFileSync(join(snapshotDir, 'files', 'device-id'), 'abcd');
    const problems = verifySecuritySnapshot(snapshotDir);
    expect(problems.join('\n')).toContain('字节数不符');
    expect(problems.join('\n')).toContain('sha256 前 8 位不符');

    const manifest = JSON.parse(readFileSync(join(snapshotDir, 'manifest.json'), 'utf8')) as { files: Array<{ path: string }> };
    manifest.files.push({ path: 'missing-file', bytes: 1, sha8: 'deadbeef' });
    writeFileSync(join(snapshotDir, 'manifest.json'), JSON.stringify(manifest));
    expect(verifySecuritySnapshot(snapshotDir).join('\n')).toContain('缺文件');
  });

  it('拒绝写空快照（避免「有目录没内容」的假备份）', () => {
    const snapshotDir = securitySnapshotDir(join(dir, 'agentboard.db'), 'acc-3');
    expect(() => writeSecuritySnapshot(snapshotDir, 'acc-3', { files: [] }, 1)).toThrow(/拒绝写空快照/);
  });
});
