/**
 * ACC-10：`app_id` CHECK 扩到四值（workbuddy_desktop / codebuddy_desktop / minimax / trae）。
 * 迁移是「建新表 → 拷数据 → 删旧表 → 改名」，本文件验：幂等、保数据、新值可写、非法值仍拒、
 * 多账号唯一约束、结构稳定、回滚口径。
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { createTestDb, type TestDb } from './helpers.js';
import { initSchema } from '../src/db/schema.js';
import { openDb } from '../src/db/connection.js';
import { accountProviderCapabilities } from '../src/services/accounts/registry.js';
import request from 'supertest';
import { createApp } from '../src/index.js';
import { FakeAdapter } from './fakeAdapter.js';

const legacyAccountsDdl = `
CREATE TABLE managed_account (
  id TEXT PRIMARY KEY, app_id TEXT NOT NULL CHECK(app_id IN ('workbuddy_desktop','codebuddy_desktop')),
  client_instance_id TEXT NOT NULL, service_region TEXT NOT NULL CHECK(service_region IN ('cn','global','unknown')),
  identity_hash TEXT NOT NULL, display_name TEXT NOT NULL, identity_hint TEXT,
  client_snapshot_ref TEXT, checkin_credential_ref TEXT, client_snapshot_version INTEGER NOT NULL DEFAULT 1,
  checkin_capability TEXT NOT NULL DEFAULT 'unknown' CHECK(checkin_capability IN ('unknown','supported','unsupported')),
  enabled INTEGER NOT NULL DEFAULT 1 CHECK(enabled IN(0,1)), last_checkin_day TEXT, last_checkin_status TEXT, last_checkin_at INTEGER,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, UNIQUE(app_id,client_instance_id,identity_hash));
CREATE TABLE account_operation (
  id TEXT PRIMARY KEY, batch_id TEXT, account_id TEXT REFERENCES managed_account(id) ON DELETE SET NULL,
  app_id TEXT NOT NULL CHECK(app_id IN ('workbuddy_desktop','codebuddy_desktop')), client_instance_id TEXT NOT NULL,
  operation TEXT NOT NULL CHECK(operation IN ('capture','switch','checkin','restore')),
  state TEXT NOT NULL CHECK(state IN ('queued','running','succeeded','already_done','failed','unknown','recovery_required')),
  stage TEXT NOT NULL CHECK(stage IN ('preflight','stop','snapshot','validate_target','write','start','verify','rollback')),
  safe_error_code TEXT, recovery_ref TEXT, recovers_operation_id TEXT REFERENCES account_operation(id) ON DELETE RESTRICT,
  created_at INTEGER NOT NULL, started_at INTEGER, finished_at INTEGER);
CREATE INDEX account_operation_batch ON account_operation(batch_id,created_at);
CREATE INDEX account_operation_instance ON account_operation(app_id,client_instance_id,state);`;

type Row = Record<string, unknown>;

const accountRow = (overrides: Row = {}): Row => ({
  id: randomUUID(), app_id: 'workbuddy_desktop', client_instance_id: 'inst-1', service_region: 'cn',
  identity_hash: 'h-1', display_name: '账号甲', identity_hint: null, client_snapshot_ref: null,
  checkin_credential_ref: null, client_snapshot_version: 1, checkin_capability: 'unknown', enabled: 1,
  last_checkin_day: null, last_checkin_status: null, last_checkin_at: null, created_at: 1_700_000_000_000, updated_at: 1_700_000_000_001,
  ...overrides,
});

const operationRow = (overrides: Row = {}): Row => ({
  id: randomUUID(), batch_id: null, account_id: null, app_id: 'codebuddy_desktop', client_instance_id: 'inst-1',
  operation: 'checkin', state: 'queued', stage: 'preflight', safe_error_code: null, recovery_ref: null,
  recovers_operation_id: null, created_at: 1_700_000_000_002, started_at: null, finished_at: null,
  ...overrides,
});

const insertRow = (db: TestDb['db'], table: string, row: Row): void => {
  const keys = Object.keys(row);
  db.prepare(`INSERT INTO ${table} (${keys.join(',')}) VALUES (${keys.map(key => `@${key}`).join(',')})`).run(row);
};

describe('account platforms migration (ACC-10)', () => {
  let dir: string;

  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'agentboard-acc10-')); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }); });

  it('preservesEveryRowAndColumnValue', () => {
    const file = join(dir, 'legacy.db');
    const legacy = openDb(file);
    legacy.exec(legacyAccountsDdl);
    const account = accountRow({ display_name: '老账号', identity_hint: '尾号 1234' });
    const operation = operationRow({ account_id: account.id as string, state: 'succeeded', stage: 'verify' });
    insertRow(legacy, 'managed_account', account);
    insertRow(legacy, 'account_operation', operation);
    const before = {
      account: legacy.prepare('SELECT * FROM managed_account').all(),
      operation: legacy.prepare('SELECT * FROM account_operation').all(),
    };
    legacy.close();

    const db = openDb(file);
    try {
      initSchema(db);
      expect(db.prepare('SELECT * FROM managed_account').all()).toEqual(before.account);
      expect(db.prepare('SELECT * FROM account_operation').all()).toEqual(before.operation);
      // 外键仍然有效（account_operation.account_id 指向重建后的 managed_account）
      expect(db.pragma('foreign_key_check')).toEqual([]);
    } finally { db.close(); }
  });

  it('acceptsNewPlatformsAndKeepsRejectingUnknownAppIds', () => {
    const t = createTestDb();
    try {
      insertRow(t.db, 'managed_account', accountRow({ app_id: 'minimax' }));
      insertRow(t.db, 'managed_account', accountRow({ app_id: 'trae', identity_hash: 'h-2' }));
      insertRow(t.db, 'account_operation', operationRow({ app_id: 'minimax' }));
      expect(() => insertRow(t.db, 'managed_account', accountRow({ app_id: 'bogus', identity_hash: 'h-3' }))).toThrow(/CHECK/i);
      expect(() => insertRow(t.db, 'account_operation', operationRow({ app_id: 'bogus' }))).toThrow(/CHECK/i);
    } finally { t.cleanup(); }
  });

  it('keepsMultiAccountUniquePerAppInstanceIdentity', () => {
    const t = createTestDb();
    try {
      insertRow(t.db, 'managed_account', accountRow({ app_id: 'minimax', identity_hash: 'h-a' }));
      insertRow(t.db, 'managed_account', accountRow({ app_id: 'minimax', identity_hash: 'h-b' }));
      expect((t.db.prepare("SELECT COUNT(*) AS n FROM managed_account WHERE app_id='minimax'").get() as { n: number }).n).toBe(2);
      expect(() => insertRow(t.db, 'managed_account', accountRow({ app_id: 'minimax', identity_hash: 'h-a' }))).toThrow(/UNIQUE/i);
    } finally { t.cleanup(); }
  });

  it('isIdempotentAcrossRepeatedInit', () => {
    const dump = (db: TestDb['db']): string =>
      (db.prepare("SELECT type,name,sql FROM sqlite_master WHERE name IN ('managed_account','account_operation','account_operation_batch','account_operation_instance') ORDER BY type,name").all() as Array<{ sql: string }>)
        .map(row => row.sql).join('\n');
    const t = createTestDb();
    try {
      const first = dump(t.db);
      expect(first).toContain("'minimax'");
      initSchema(t.db);
      initSchema(t.db);
      expect(dump(t.db)).toBe(first);
      // 索引仍在
      const indexes = t.db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND name LIKE 'account_operation_%' ORDER BY name").all() as Array<{ name: string }>;
      expect(indexes.map(row => row.name)).toEqual(['account_operation_batch', 'account_operation_instance']);
    } finally { t.cleanup(); }
  });

  it('skipsWhenTableAlreadyMigratedEvenIfDataPresent', () => {
    const t = createTestDb();
    try {
      insertRow(t.db, 'managed_account', accountRow({ app_id: 'trae' }));
      const before = (t.db.prepare('SELECT COUNT(*) AS n FROM managed_account').get() as { n: number }).n;
      initSchema(t.db);
      expect((t.db.prepare('SELECT COUNT(*) AS n FROM managed_account').get() as { n: number }).n).toBe(before);
    } finally { t.cleanup(); }
  });

  it('rollbackRequiresManualCleanupThenRestoresLegacyCheck', () => {
    const file = join(dir, 'rollback.db');
    const db = openDb(file);
    try {
      initSchema(db);
      insertRow(db as unknown as TestDb['db'], 'managed_account', accountRow({ app_id: 'minimax' }));
      // 未清理就按旧 CHECK 重建 → 被旧约束拒绝（故意让人看见，不静默丢数据）
      expect(() => db.exec(`CREATE TABLE managed_account_rollback (id TEXT PRIMARY KEY, app_id TEXT NOT NULL CHECK(app_id IN ('workbuddy_desktop','codebuddy_desktop')));`)).not.toThrow();
      expect(() => db.exec('INSERT INTO managed_account_rollback SELECT id, app_id FROM managed_account')).toThrow(/CHECK/i);
      db.exec('DROP TABLE managed_account_rollback');

      // 清理新平台行后，旧 CHECK 重建可完成
      db.prepare("DELETE FROM managed_account WHERE app_id IN ('minimax','trae')").run();
      db.exec(`CREATE TABLE managed_account_rollback (
        id TEXT PRIMARY KEY, app_id TEXT NOT NULL CHECK(app_id IN ('workbuddy_desktop','codebuddy_desktop')));`);
      expect(() => db.exec('INSERT INTO managed_account_rollback SELECT id, app_id FROM managed_account')).not.toThrow();
    } finally { db.close(); }
  });

  it('registersNewPlatformsWithCaptureSwitchStillOff', () => {
    const capabilities = accountProviderCapabilities();
    for (const appId of ['minimax', 'trae'] as const) {
      const capability = capabilities.find(item => item.app_id === appId);
      // ACC-12 已开启签到；capture/switch 仍等 ACC-13
      expect(capability).toMatchObject({ app_id: appId, capture: false, switch: false, checkin: true, reason_code: 'CHECKIN_READY' });
    }
  });


  it('capabilitiesEndpointAcceptsNewAppsAndRejectsUnknown', async () => {
    const t = createTestDb();
    const adapter = new FakeAdapter();
    const created = await createApp({ db: t.db, getAdapter: (id: string) => { if (id === 'fake') return adapter; throw new Error(`未知适配器 id: ${id}`); }, adapters: [adapter], refreshClisOnBoot: false });
    try {
      const all = await request(created.app).get('/api/managed-account-capabilities');
      expect(all.status).toBe(200);
      expect((all.body as Array<{ app_id: string }>).map(row => row.app_id)).toEqual(['workbuddy_desktop', 'codebuddy_desktop', 'minimax', 'trae']);

      const minimax = await request(created.app).get('/api/managed-account-capabilities?app=minimax');
      expect(minimax.status).toBe(200);
      expect((minimax.body as Array<Record<string, unknown>>)[0]).toMatchObject({ app_id: 'minimax', capture: false, switch: false });

      const bogus = await request(created.app).get('/api/managed-account-capabilities?app=bogus');
      expect(bogus.status).toBe(400);
    } finally { t.cleanup(); }
  });

  it('exposesFourValueCheckInSqliteSchema', () => {
    const t = createTestDb();
    try {
      const row = t.db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='managed_account'").get() as { sql: string };
      for (const appId of ['workbuddy_desktop', 'codebuddy_desktop', 'minimax', 'trae']) expect(row.sql).toContain(`'${appId}'`);
      const operation = t.db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='account_operation'").get() as { sql: string };
      expect(operation.sql).toContain("'minimax'");
    } finally { t.cleanup(); }
  });
});

/** 让 `new Database` 的类型在本文件里可见（避免 lint 未使用告警） */
void Database;