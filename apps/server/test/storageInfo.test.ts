/**
 * DB-3B-S：`GET /api/settings/storage` 只读汇总。
 *
 * 断言口径：
 * - `usage` 与手工 `statSync`/`readdirSync` 求和一致（含 `-wal`/`-shm`）；
 * - `migration_estimate.estimated_bytes` 与迁移前置检查同源（`measureMigrationSource().totalBytes`），
 *   `required_bytes` = ceil(×1.2)，前端不再自己算；
 * - 三来源（env / settings / default）如实反映；
 * - 附件目录缺失 → 0 且不报错；文件数超上限 → null + `truncated: true`；
 * - 只读：不改 config.json、不写迁移意图。
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import type { AgentAdapter } from '@agentboard/adapters';
import { createTestDb, type TestDb } from './helpers.js';
import { FakeAdapter } from './fakeAdapter.js';
import { createApp } from '../src/index.js';
import { loadConfig } from '../src/config.js';
import { measureMigrationSource } from '../src/services/dbMigration.js';
import { collectStorageInfo, scanDirectoryCapped, STORAGE_SCAN_MAX_FILES } from '../src/services/storageInfo.js';

describe('storage summary (DB-3B-S)', () => {
  let t: TestDb;
  let root: string;
  let attachDir: string;
  let appData: string;
  let savedAppData: string | undefined;
  let savedEnvDb: string | undefined;

  beforeEach(() => {
    t = createTestDb();
    root = mkdtempSync(join(tmpdir(), 'agentboard-storage-'));
    attachDir = join(root, 'attachments');
    mkdirSync(join(attachDir, 'sub'), { recursive: true });
    writeFileSync(join(attachDir, 'a.bin'), Buffer.alloc(1024, 1));
    writeFileSync(join(attachDir, 'sub', 'b.bin'), Buffer.alloc(2048, 2));
    appData = mkdtempSync(join(tmpdir(), 'agentboard-storage-cfg-'));
    mkdirSync(join(appData, 'AgentBoard'), { recursive: true });
    savedAppData = process.env.APPDATA;
    savedEnvDb = process.env.AGENTBOARD_DB;
    process.env.APPDATA = appData;
    delete process.env.AGENTBOARD_DB;
  });
  afterEach(() => {
    if (savedAppData === undefined) delete process.env.APPDATA; else process.env.APPDATA = savedAppData;
    if (savedEnvDb === undefined) delete process.env.AGENTBOARD_DB; else process.env.AGENTBOARD_DB = savedEnvDb;
    t.cleanup();
    rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
    rmSync(appData, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  });

  const writeConfig = (value: Record<string, unknown>): void => {
    writeFileSync(join(appData, 'AgentBoard', 'config.json'), JSON.stringify(value), 'utf8');
  };

  const openApp = async (attachmentStorageDir: string = attachDir) => {
    const adapter = new FakeAdapter();
    const created = await createApp({
      db: t.db,
      getAdapter: (id: string): AgentAdapter => { if (id === 'fake') return adapter; throw new Error(`未知适配器 id: ${id}`); },
      adapters: [adapter],
      refreshClisOnBoot: false,
      attachmentStorageDir,
    });
    return created.app;
  };

  /** 手工求和（不复用被测实现）：db + sidecar + 附件目录里所有文件 */
  const manualSum = (dbPath: string, dir: string): { db: number; wal: number; shm: number; files: number; attachments: number } => {
    const size = (p: string): number => (existsSync(p) ? statSync(p).size : 0);
    const walk = (base: string): { files: number; bytes: number } => {
      let files = 0;
      let bytes = 0;
      for (const entry of readdirSync(base, { withFileTypes: true })) {
        const p = join(base, entry.name);
        if (entry.isDirectory()) {
          const sub = walk(p);
          files += sub.files;
          bytes += sub.bytes;
        } else {
          files += 1;
          bytes += statSync(p).size;
        }
      }
      return { files, bytes };
    };
    const attachments = walk(dir);
    return { db: size(dbPath), wal: size(`${dbPath}-wal`), shm: size(`${dbPath}-shm`), files: attachments.files, attachments: attachments.bytes };
  };

  it('usage 与手工求和一致，estimated_bytes 与前置检查同源', async () => {
    const app = await openApp();
    const res = await request(app).get('/api/settings/storage').expect(200);
    const body = res.body as {
      db_path: string; db_path_source: string; attachments_dir: string;
      usage: { db_bytes: number; wal_bytes: number; shm_bytes: number; attachments_bytes: number; attachments_files: number; total_bytes: number };
      migration_estimate: { issue_count: number; attachment_count: number; estimated_bytes: number; required_bytes: number };
      truncated: boolean;
    };
    const manual = manualSum(t.db.name, attachDir);
    expect(body.db_path).toBe(t.db.name);
    expect(body.attachments_dir).toBe(attachDir);
    expect(body.usage.db_bytes).toBe(manual.db);
    expect(body.usage.wal_bytes).toBe(manual.wal);
    expect(body.usage.shm_bytes).toBe(manual.shm);
    expect(body.usage.attachments_files).toBe(manual.files);
    expect(body.usage.attachments_bytes).toBe(manual.attachments);
    expect(body.usage.total_bytes).toBe(manual.db + manual.wal + manual.shm + manual.attachments);
    expect(body.truncated).toBe(false);

    // 与迁移前置检查同一个总量口径（不许前后端各算一套）
    const measured = measureMigrationSource(t.db.name, attachDir);
    expect(body.migration_estimate.estimated_bytes).toBe(measured.totalBytes);
    expect(body.migration_estimate.attachment_count).toBe(measured.attachmentFiles);
    expect(body.migration_estimate.required_bytes).toBe(Math.ceil(measured.totalBytes * 1.2));
    expect(body.migration_estimate.issue_count).toBe(0);
  });

  it('只读：不改 config.json、不写迁移意图', async () => {
    writeConfig({ port: 8787, maxConcurrentTurns: 3 });
    const before = readFileSync(join(appData, 'AgentBoard', 'config.json'), 'utf8');
    const app = await openApp();
    await request(app).get('/api/settings/storage').expect(200);
    expect(readFileSync(join(appData, 'AgentBoard', 'config.json'), 'utf8')).toBe(before);
    expect(existsSync(join(appData, 'AgentBoard', 'db-migration-pending.json'))).toBe(false);
  });

  it('三来源：env / settings / default 如实反映', async () => {
    // default：config.json 没有 dbPath、没有 env
    writeConfig({ port: 8787 });
    const appDefault = await openApp();
    expect((await request(appDefault).get('/api/settings/storage').expect(200)).body.db_path_source).toBe('default');

    // settings：config.json 有 dbPath
    writeConfig({ port: 8787, dbPath: 'D:\\db\\custom.db' });
    const appSettings = await openApp();
    expect((await request(appSettings).get('/api/settings/storage').expect(200)).body.db_path_source).toBe('settings');

    // env：AGENTBOARD_DB 存在（优先于设置项）
    process.env.AGENTBOARD_DB = 'D:\\env\\agentboard.db';
    const appEnv = await openApp();
    expect((await request(appEnv).get('/api/settings/storage').expect(200)).body.db_path_source).toBe('env');
  });

  it('来源取启动期注入值：readSettings 首读写回默认值后也不会把 default 误判成 settings', async () => {
    // 启动期解析 = default（无 env、无 config.json）；首次 loadConfig 会把默认值写回文件（含 dbPath）
    rmSync(join(appData, 'AgentBoard', 'config.json'), { force: true });
    expect(loadConfig(process.env).dbPathSource).toBe('default');
    expect(JSON.parse(readFileSync(join(appData, 'AgentBoard', 'config.json'), 'utf8')).dbPath).toBeTruthy();
    // 反证：请求期重新 loadConfig 会把 default 误判成 settings —— 所以端点必须用启动期注入的来源
    expect(loadConfig(process.env).dbPathSource).toBe('settings');
    const adapter = new FakeAdapter();
    const created = await createApp({
      db: t.db,
      getAdapter: (id: string): AgentAdapter => { if (id === 'fake') return adapter; throw new Error(`未知适配器 id: ${id}`); },
      adapters: [adapter],
      refreshClisOnBoot: false,
      attachmentStorageDir: attachDir,
      dbPathSource: 'default',
    });
    expect((await request(created.app).get('/api/settings/storage').expect(200)).body.db_path_source).toBe('default');
  });

  it('附件目录缺失 → 0 且不报错', async () => {
    const missing = join(root, 'no-such-dir');
    const app = await openApp(missing);
    const res = await request(app).get('/api/settings/storage').expect(200);
    expect(res.body.attachments_dir).toBe(missing);
    expect(res.body.usage.attachments_files).toBe(0);
    expect(res.body.usage.attachments_bytes).toBe(0);
    expect(res.body.truncated).toBe(false);
    // 总量仍等于 db + sidecar
    expect(res.body.usage.total_bytes).toBe(res.body.usage.db_bytes + res.body.usage.wal_bytes + res.body.usage.shm_bytes);
  });

  it('附件文件数超上限 → null + truncated:true（不长时间占着请求）', () => {
    const many = join(root, 'many');
    mkdirSync(many, { recursive: true });
    for (let i = 0; i < 5; i += 1) writeFileSync(join(many, `f${i}.bin`), Buffer.alloc(10, i));
    const scan = scanDirectoryCapped(many, 3);
    expect(scan).toMatchObject({ files: 3, truncated: true });

    const info = collectStorageInfo({ dbPath: t.db.name, attachmentsDir: many, dbPathSource: 'settings', countIssues: () => 7, maxFiles: 3 });
    expect(info.truncated).toBe(true);
    expect(info.usage.attachments_files).toBeNull();
    expect(info.usage.attachments_bytes).toBeNull();
    expect(info.usage.total_bytes).toBeNull();
    expect(info.migration_estimate.estimated_bytes).toBeNull();
    expect(info.migration_estimate.required_bytes).toBeNull();
    // 卡数与库体积仍可给（不依赖附件遍历）
    expect(info.migration_estimate.issue_count).toBe(7);
    expect(info.usage.db_bytes).toBeGreaterThan(0);
  });

  it('默认上限是 5 万文件', () => {
    expect(STORAGE_SCAN_MAX_FILES).toBe(50_000);
  });
});
