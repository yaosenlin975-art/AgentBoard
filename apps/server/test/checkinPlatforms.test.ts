/**
 * ACC-12：`checkin_authorization` / `checkin_batch` 的 app_id CHECK 扩到四值。
 * ACC-10 只重建了账号两表，签到两表自带 2 值 CHECK，导致 minimax/trae 建批次直接 CHECK 失败。
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestDb, type TestDb } from './helpers.js';
import { openDb } from '../src/db/connection.js';
import { initSchema } from '../src/db/schema.js';
import { createManagedAccount } from '../src/db/repos/managedAccount.js';
import { createCheckinBatch, getCheckinBatch } from '../src/db/repos/checkin.js';
import { migrateCheckin } from '../src/db/migrations/checkin.js';
import { migrateCheckinPlatforms } from '../src/db/migrations/checkinPlatforms.js';

const legacyCheckinDdl = `
CREATE TABLE managed_account (
  id TEXT PRIMARY KEY, app_id TEXT NOT NULL CHECK(app_id IN ('workbuddy_desktop','codebuddy_desktop','minimax','trae')),
  client_instance_id TEXT NOT NULL, service_region TEXT NOT NULL CHECK(service_region IN ('cn','global','unknown')),
  identity_hash TEXT NOT NULL, display_name TEXT NOT NULL, identity_hint TEXT,
  client_snapshot_ref TEXT, checkin_credential_ref TEXT, client_snapshot_version INTEGER NOT NULL DEFAULT 1,
  checkin_capability TEXT NOT NULL DEFAULT 'unknown' CHECK(checkin_capability IN ('unknown','supported','unsupported')),
  enabled INTEGER NOT NULL DEFAULT 1 CHECK(enabled IN(0,1)), last_checkin_day TEXT, last_checkin_status TEXT, last_checkin_at INTEGER,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, UNIQUE(app_id,client_instance_id,identity_hash));
CREATE TABLE account_operation (
  id TEXT PRIMARY KEY, batch_id TEXT, account_id TEXT REFERENCES managed_account(id) ON DELETE SET NULL,
  app_id TEXT NOT NULL CHECK(app_id IN ('workbuddy_desktop','codebuddy_desktop','minimax','trae')), client_instance_id TEXT NOT NULL,
  operation TEXT NOT NULL CHECK(operation IN ('capture','switch','checkin','restore')),
  state TEXT NOT NULL CHECK(state IN ('queued','running','succeeded','already_done','failed','unknown','recovery_required')),
  stage TEXT NOT NULL CHECK(stage IN ('preflight','stop','snapshot','validate_target','write','start','verify','rollback')),
  safe_error_code TEXT, recovery_ref TEXT, recovers_operation_id TEXT REFERENCES account_operation(id) ON DELETE RESTRICT,
  created_at INTEGER NOT NULL, started_at INTEGER, finished_at INTEGER);
CREATE TABLE checkin_authorization (
  id TEXT PRIMARY KEY, account_id TEXT NOT NULL REFERENCES managed_account(id) ON DELETE CASCADE,
  app_id TEXT NOT NULL CHECK(app_id IN ('workbuddy_desktop','codebuddy_desktop')),
  status TEXT NOT NULL CHECK(status IN ('pending','authorized','failed','expired')),
  remote_state_hash TEXT NOT NULL, remote_state_ref TEXT, authorization_url TEXT, safe_error_code TEXT,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, expires_at INTEGER NOT NULL);
CREATE TABLE checkin_batch (
  id TEXT PRIMARY KEY, app_id TEXT NOT NULL CHECK(app_id IN ('workbuddy_desktop','codebuddy_desktop')),
  status TEXT NOT NULL CHECK(status IN ('queued','running','succeeded','partial','failed','cancelled')),
  total INTEGER NOT NULL, profile_local_day TEXT, created_at INTEGER NOT NULL, finished_at INTEGER);
CREATE TABLE checkin_batch_item (
  batch_id TEXT NOT NULL REFERENCES checkin_batch(id) ON DELETE CASCADE, account_id TEXT NOT NULL, seq INTEGER NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('queued','running','succeeded','already_done','failed','unknown','cancelled')),
  operation_id TEXT REFERENCES account_operation(id) ON DELETE SET NULL, safe_error_code TEXT, updated_at INTEGER NOT NULL,
  PRIMARY KEY(batch_id,account_id));`;

const account = (app: string) => ({
  id: randomUUID(), app_id: app, client_instance_id: 'inst', service_region: 'cn', identity_hash: randomUUID().replace(/-/g, '').padEnd(64, '0').slice(0, 64),
  display_name: `账号-${app}`, created_at: 1_700_000_000_000, updated_at: 1_700_000_000_000,
});

describe('checkin platforms migration (ACC-12)', () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'agentboard-acc12-')); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }); });

  it('preservesLegacyBatchesAndAllowsNewPlatforms', () => {
    const file = join(dir, 'legacy.db');
    const legacy = openDb(file);
    legacy.exec(legacyCheckinDdl);
    const legacyAccount = account('workbuddy_desktop');
    legacy.prepare('INSERT INTO managed_account (id,app_id,client_instance_id,service_region,identity_hash,display_name,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)')
      .run(legacyAccount.id, legacyAccount.app_id, legacyAccount.client_instance_id, legacyAccount.service_region, legacyAccount.identity_hash, legacyAccount.display_name, legacyAccount.created_at, legacyAccount.updated_at);
    const batchId = randomUUID();
    legacy.prepare("INSERT INTO checkin_batch (id,app_id,status,total,created_at) VALUES (?,?, 'succeeded', 1, ?)").run(batchId, 'workbuddy_desktop', 1_700_000_000_001);
    legacy.prepare('INSERT INTO checkin_batch_item (batch_id,account_id,seq,state,updated_at) VALUES (?,?,0,?,?)').run(batchId, legacyAccount.id, 'succeeded', 1_700_000_000_002);
    const before = legacy.prepare('SELECT * FROM checkin_batch').all();
    legacy.close();

    const db = openDb(file);
    try {
      initSchema(db);
      expect(db.prepare('SELECT * FROM checkin_batch').all()).toEqual(before);
      expect(db.pragma('foreign_key_check')).toEqual([]);
      // 新平台可建批次；旧值仍可
      for (const app of ['minimax', 'trae', 'workbuddy_desktop']) {
        const created = createManagedAccount(db, { app_id: app as never, client_instance_id: 'inst', service_region: 'cn', identity_hash: 'a'.repeat(64), display_name: app });
        const batch = createCheckinBatch(db, { app_id: app as never, account_ids: [created.id], profile_local_day: '2026-11-02' });
        expect(getCheckinBatch(db, batch.id)?.app_id).toBe(app);
      }
      expect(() => db.prepare("INSERT INTO checkin_batch (id,app_id,status,total,created_at) VALUES (?,?, 'queued', 1, ?)").run(randomUUID(), 'bogus', 1)).toThrow(/CHECK/i);
    } finally { db.close(); }
  });

  it('isIdempotentAndKeepsIndexes', () => {
    const t = createTestDb();
    try {
      const dump = () => (t.db.prepare("SELECT type,name,sql FROM sqlite_master WHERE name IN ('checkin_authorization','checkin_batch','checkin_authorization_open','checkin_batch_app_state') ORDER BY type,name").all() as Array<{ sql: string | null }>).map(row => row.sql).join('\n');
      const first = dump();
      expect(first).toContain("'minimax'");
      initSchema(t.db);
      migrateCheckinPlatforms(t.db);
      expect(dump()).toBe(first);
    } finally { t.cleanup(); }
  });

  it('rollbackRequiresCleanupBeforeOldCheck', () => {
    const t = createTestDb();
    try {
      const created = createManagedAccount(t.db, { app_id: 'minimax', client_instance_id: 'inst', service_region: 'cn', identity_hash: 'b'.repeat(64), display_name: 'mm' });
      createCheckinBatch(t.db, { app_id: 'minimax', account_ids: [created.id], profile_local_day: '2026-11-02' });
      // 未清理就按旧 CHECK 重建 → 被拒
      t.db.exec("CREATE TABLE legacy_probe (app_id TEXT NOT NULL CHECK(app_id IN ('workbuddy_desktop','codebuddy_desktop')))");
      expect(() => t.db.exec('INSERT INTO legacy_probe SELECT app_id FROM checkin_batch')).toThrow(/CHECK/i);
      t.db.exec('DROP TABLE legacy_probe');
      t.db.prepare("DELETE FROM checkin_batch_item WHERE batch_id IN (SELECT id FROM checkin_batch WHERE app_id IN ('minimax','trae'))").run();
      t.db.prepare("DELETE FROM checkin_batch WHERE app_id IN ('minimax','trae')").run();
      t.db.exec("CREATE TABLE legacy_probe (app_id TEXT NOT NULL CHECK(app_id IN ('workbuddy_desktop','codebuddy_desktop')))");
      expect(() => t.db.exec('INSERT INTO legacy_probe SELECT app_id FROM checkin_batch')).not.toThrow();
    } finally { t.cleanup(); }
  });

  it('skipsOnFreshDatabaseAlreadyMigratedByInitSchema', () => {
    const t = createTestDb();
    try {
      migrateCheckin(t.db);
      const sql = (t.db.prepare("SELECT sql FROM sqlite_master WHERE name='checkin_batch'").get() as { sql: string }).sql;
      expect(sql).toContain("'minimax'");
    } finally { t.cleanup(); }
  });
});
