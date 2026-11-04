/**
 * DB-2B：数据库位置迁移编排（阶段机 + 新进程自检 + 回滚）。
 *
 * 断言口径：
 * - 阶段顺序 preflight → snapshot → verify → switch → restart，状态可查（重启后读盘）；
 * - 自检在**新进程**里跑：通过才归档旧文件；失败 → 设置回滚旧库 + 要求本进程退出（旧进程重新接管）；
 * - 单并发（409 DB_MIGRATION_BUSY）、迁移中拒绝 PATCH db_path、env 覆盖时拒绝迁移；
 * - 错误码带可读文案 + retryable。
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import Database from 'better-sqlite3';
import type { AgentAdapter } from '@agentboard/adapters';
import { createTestDb } from './helpers.js';
import { FakeAdapter } from './fakeAdapter.js';
import { createApp } from '../src/index.js';
import {
  describeMigrationError,
  getMigrationStatus,
  isMigrationActive,
  migrationIntentPath,
  orchestrateMigration,
  readMigrationIntent,
  resetMigrationState,
  runBootSelfCheck,
} from '../src/services/dbMigration.js';
import { readSettings, writeSettings } from '../src/config.js';
import type { RestartDeps } from '../src/api/systemRoutes.js';

interface Fixture {
  root: string;
  stateDir: string;
  fromDb: string;
  fromAttach: string;
  toDb: string;
  toAttach: string;
}

/** 源库：2 张表 + 3 张卡；附件 2 个（含子目录） */
function makeFixture(): Fixture {
  const root = mkdtempSync(join(tmpdir(), 'agentboard-db2b-'));
  const fromDb = join(root, 'old', 'agentboard.db');
  const fromAttach = join(root, 'old', 'attachments');
  const toDb = join(root, 'new', 'agentboard.db');
  const toAttach = join(root, 'new', 'attachments');
  const stateDir = join(root, 'state');
  mkdirSync(join(root, 'old'), { recursive: true });
  const db = new Database(fromDb);
  db.exec('CREATE TABLE issue (id TEXT PRIMARY KEY, title TEXT); CREATE TABLE workspace (id TEXT PRIMARY KEY)');
  db.prepare('INSERT INTO workspace VALUES (?)').run('w1');
  for (const id of ['i1', 'i2', 'i3']) db.prepare('INSERT INTO issue VALUES (?, ?)').run(id, `卡${id}`);
  db.close();
  mkdirSync(join(fromAttach, 'sub'), { recursive: true });
  writeFileSync(join(fromAttach, 'a.png'), Buffer.from('png-a'));
  writeFileSync(join(fromAttach, 'sub', 'b.png'), Buffer.from('png-bb'));
  return { root, stateDir, fromDb, fromAttach, toDb, toAttach };
}

describe('db migration orchestration (DB-2B)', () => {
  let f: Fixture;
  beforeEach(() => {
    resetMigrationState();
    f = makeFixture();
  });
  afterEach(() => {
    resetMigrationState();
    rmSync(f.root, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  });

  const orchestrate = async (overrides: Partial<Parameters<typeof orchestrateMigration>[0]> = {}) => {
    const settingsWrites: string[] = [];
    const restarts: string[] = [];
    const db = new Database(f.fromDb, { readonly: true });
    try {
      const status = await orchestrateMigration({
        fromDbPath: f.fromDb,
        toDbPath: f.toDb,
        fromAttachmentsDir: f.fromAttach,
        toAttachmentsDir: f.toAttach,
        stateDir: f.stateDir,
        sourceDb: db,
        freeBytes: async () => 100 * 1024 * 1024,
        applySettings: (path) => { settingsWrites.push(path); },
        triggerRestart: async () => { restarts.push('restart'); },
        ...overrides,
      });
      return { status, settingsWrites, restarts };
    } finally {
      db.close();
    }
  };

  it('阶段顺序 preflight→snapshot→verify→switch→restart，返回 migration_id/backup_dir/stages 并落意图', async () => {
    const { status, settingsWrites, restarts } = await orchestrate();
    expect(status.stages.map((entry) => entry.stage)).toEqual(['preflight', 'snapshot', 'verify', 'switch', 'restart']);
    expect(status.migration_id).toMatch(/^mig-/);
    expect(status.backup_dir).not.toBeNull();
    expect(status.ok).toBeNull(); // 等新进程自检
    expect(status.retryable).toBe(false);
    expect(settingsWrites).toEqual([f.toDb]);
    expect(restarts).toEqual(['restart']);
    // 意图文件写在固定状态目录（不随库路径漂移），新进程靠它自检
    const intent = readMigrationIntent(f.stateDir);
    expect(intent).toMatchObject({ to_db_path: f.toDb, from_db_path: f.fromDb, to_attachments_dir: f.toAttach });
    expect(intent?.expected.issues).toBe(3);
    expect(intent?.expected.attachment_files).toBe(2);
    expect(existsSync(f.toDb)).toBe(true);
    // 状态可跨进程读：清内存表后仍能从磁盘读到
    resetMigrationState();
    expect(getMigrationStatus(f.stateDir, status.migration_id)).toMatchObject({ stage: 'restart' });
  });

  it('新进程自检通过 → 归档旧库文件、清意图、状态 cleanup→done', async () => {
    const { status } = await orchestrate();
    resetMigrationState(); // 模拟重启：内存表清空，只剩磁盘上的意图与状态
    const newDb = new Database(f.toDb, { readonly: true });
    const settingsWrites: string[] = [];
    try {
      const boot = runBootSelfCheck({
        stateDir: f.stateDir,
        currentDbPath: f.toDb,
        sourceDb: newDb,
        applySettings: (path) => { settingsWrites.push(path); },
        schedule: () => { /* 重试调度不触发 */ },
      });
      expect(boot).toMatchObject({ handled: true, ok: true, needsRestartToOldDb: false, migration_id: status.migration_id });
    } finally {
      newDb.close();
    }
    expect(settingsWrites).toEqual([]); // 通过则不回滚设置
    expect(readMigrationIntent(f.stateDir)).toBeNull();
    const archived = getMigrationStatus(f.stateDir, status.migration_id);
    expect(archived?.stage).toBe('done');
    expect(archived?.ok).toBe(true);
    expect(archived?.stages.map((entry) => entry.stage)).toContain('selfcheck');
    expect(archived?.stages.map((entry) => entry.stage)).toContain('cleanup');
    // 旧库被移进 <bak>.old/，.bak 目录保留
    expect(existsSync(f.fromDb)).toBe(false);
    expect(existsSync(join(`${status.backup_dir}`, 'agentboard.db'))).toBe(false);
    expect(existsSync(join(`${status.backup_dir}.old`, 'agentboard.db'))).toBe(true);
  });

  it('新进程自检失败（附件少一个）→ 设置回滚旧库、旧库保留、要求退出回旧库', async () => {
    const { status } = await orchestrate();
    resetMigrationState();
    rmSync(join(f.toAttach, 'a.png')); // 篡改目标侧：附件数不符
    const newDb = new Database(f.toDb, { readonly: true });
    const settingsWrites: string[] = [];
    try {
      const boot = runBootSelfCheck({
        stateDir: f.stateDir,
        currentDbPath: f.toDb,
        sourceDb: newDb,
        applySettings: (path) => { settingsWrites.push(path); },
        schedule: () => { /* 不应重试清理 */ },
      });
      expect(boot).toMatchObject({ handled: true, ok: false, code: 'DB_MIGRATION_ROLLED_BACK', needsRestartToOldDb: true });
      expect(boot.message).toContain('附件数不符');
    } finally {
      newDb.close();
    }
    expect(settingsWrites).toEqual([f.fromDb]);
    expect(readMigrationIntent(f.stateDir)).toBeNull();
    const archived = getMigrationStatus(f.stateDir, status.migration_id);
    expect(archived?.stage).toBe('rolled_back');
    expect(archived?.code).toBe('DB_MIGRATION_ROLLED_BACK');
    // 旧库仍在原处（回滚要能直接启动）
    expect(existsSync(f.fromDb)).toBe(true);
    // 迁移目标库保留（供排障），旧文件不归档
    expect(existsSync(f.toDb)).toBe(true);
    expect(existsSync(join(`${status.backup_dir}.old`, 'agentboard.db'))).toBe(false);
  });

  it('卡数不符也算自检失败（表数/卡数口径）', async () => {
    await orchestrate();
    resetMigrationState();
    const tampered = new Database(f.toDb);
    tampered.prepare('DELETE FROM issue WHERE id = ?').run('i1');
    tampered.close();
    const newDb = new Database(f.toDb, { readonly: true });
    const settingsWrites: string[] = [];
    try {
      const boot = runBootSelfCheck({ stateDir: f.stateDir, currentDbPath: f.toDb, sourceDb: newDb, applySettings: (path) => { settingsWrites.push(path); } });
      expect(boot.ok).toBe(false);
      expect(boot.message).toContain('卡数不符');
    } finally {
      newDb.close();
    }
    expect(settingsWrites).toEqual([f.fromDb]);
  });

  it('单并发：迁移进行中再发起 → DB_MIGRATION_BUSY（可重试）', async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const db = new Database(f.fromDb, { readonly: true });
    try {
      const first = orchestrateMigration({
        fromDbPath: f.fromDb,
        toDbPath: f.toDb,
        fromAttachmentsDir: f.fromAttach,
        toAttachmentsDir: f.toAttach,
        stateDir: f.stateDir,
        sourceDb: db,
        freeBytes: async () => 100 * 1024 * 1024,
        applySettings: () => {},
        triggerRestart: async () => { await gate; },
      });
      // 等第一次进入 restart 阶段（意图已落盘）
      for (let i = 0; i < 50 && readMigrationIntent(f.stateDir) === null; i += 1) {
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      expect(isMigrationActive(f.stateDir)).toBe(true);
      const second = await orchestrate({ toDbPath: join(f.root, 'other', 'agentboard.db'), toAttachmentsDir: join(f.root, 'other', 'attachments') });
      expect(second.status).toMatchObject({ ok: false, code: 'DB_MIGRATION_BUSY', retryable: true });
      expect(second.status.message).toContain('同一时间只允许一个');
      release();
      const done = await first;
      expect(done.stage).toBe('restart');
    } finally {
      db.close();
    }
  });

  it('重启失败 → 设置回滚旧库 + DB_MIGRATION_ROLLED_BACK（可重试）', async () => {
    const { status, settingsWrites } = await orchestrate({
      triggerRestart: async () => { throw new Error('端口 8787 由另一个看板实例（pid 1）占用'); },
    });
    expect(status).toMatchObject({ ok: false, code: 'DB_MIGRATION_ROLLED_BACK', retryable: true });
    expect(status.stage).toBe('rolled_back');
    expect(status.message).toContain('端口 8787 由另一个看板实例');
    expect(settingsWrites).toEqual([f.toDb, f.fromDb]);
    expect(readMigrationIntent(f.stateDir)).toBeNull();
  });

  it('错误码带可读文案 + retryable（NO_SPACE / TARGET_EXISTS）', async () => {
    const noSpace = await orchestrate({ freeBytes: async () => 1 });
    expect(noSpace.status.code).toBe('DB_MIGRATION_NO_SPACE');
    expect(noSpace.status.retryable).toBe(true);
    expect(noSpace.status.message).toContain('剩余空间不足');
    expect(noSpace.status.message).toContain('目标剩余 1 字节');
    expect(noSpace.settingsWrites).toEqual([]);

    mkdirSync(join(f.root, 'new'), { recursive: true });
    writeFileSync(f.toDb, 'existing');
    const exists = await orchestrate();
    expect(exists.status.code).toBe('DB_MIGRATION_TARGET_EXISTS');
    expect(exists.status.message).toContain('overwrite=true');
    expect(describeMigrationError('DB_MIGRATION_TARGET_EXISTS').retryable).toBe(true);
  });
});

describe('db migration endpoints (DB-2B)', () => {
  let t: TestDb;
  let f: Fixture;
  let previousAppData: string | undefined;
  let settingsFile: string;

  beforeEach(() => {
    resetMigrationState();
    f = makeFixture();
    t = createTestDb();
    // 设置写盘隔离：readSettings/writeSettings 落在临时 APPDATA
    previousAppData = process.env.APPDATA;
    process.env.APPDATA = join(f.root, 'appdata');
    mkdirSync(join(f.root, 'appdata', 'AgentBoard'), { recursive: true });
    settingsFile = join(f.root, 'appdata', 'AgentBoard', 'config.json');
  });
  afterEach(() => {
    resetMigrationState();
    if (previousAppData === undefined) delete process.env.APPDATA; else process.env.APPDATA = previousAppData;
    t.cleanup();
    rmSync(f.root, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  });

  const restartDeps = (calls: string[]): RestartDeps => ({
    entry: () => ({ command: 'node', args: ['index.js'], exists: true }),
    spawnChild: async () => { calls.push('spawn'); return { pid: 4242 }; },
    closeServer: async () => { calls.push('close'); },
    reopenServer: async () => { calls.push('reopen'); },
    exit: () => { calls.push('exit'); },
    schedule: () => { /* 不执行交接，避免测试里真关监听 */ },
    probePort: async () => ({ kind: 'free' }),
    waitForHealth: async () => true,
  });

  const openApp = async (options: { calls?: string[]; stateDir?: string; dbPathSource?: 'env' | 'settings' | 'default'; exit?: (code: number) => void; dbPath?: string; attachmentStorageDir?: string } = {}) => {
    const calls = options.calls ?? [];
    const adapter = new FakeAdapter();
    const created = await createApp({
      db: t.db,
      getAdapter: (id: string): AgentAdapter => { if (id === 'fake') return adapter; throw new Error(`未知适配器 id: ${id}`); },
      adapters: [adapter],
      refreshClisOnBoot: false,
      restart: restartDeps(calls),
      dbMigration: {
        stateDir: options.stateDir ?? f.stateDir,
        dbPath: options.dbPath ?? f.fromDb,
        attachmentStorageDir: options.attachmentStorageDir ?? f.fromAttach,
        ...(options.dbPathSource !== undefined ? { dbPathSource: options.dbPathSource } : {}),
        ...(options.exit !== undefined ? { exit: options.exit } : {}),
        schedule: () => { /* 旧文件清理重试不触发 */ },
      },
    });
    return created.app;
  };

  it('POST /api/settings/db-path/migrate → 202 {migration_id, backup_dir, stages}，GET 状态可查', async () => {
    const calls: string[] = [];
    const app = await openApp({ calls });
    const res = await request(app)
      .post('/api/settings/db-path/migrate')
      .send({ target_db_path: f.toDb })
      .expect(202);
    expect(res.body.migration_id).toMatch(/^mig-/);
    expect(res.body.backup_dir).not.toBeNull();
    expect(res.body.stages.map((entry: { stage: string }) => entry.stage)).toEqual(['preflight', 'snapshot', 'verify', 'switch', 'restart']);
    expect(calls).toContain('spawn');
    // 设置已切到新库（重启后新进程读它）
    expect(readSettings().dbPath).toBe(f.toDb);
    expect(JSON.parse(readFileSync(settingsFile, 'utf8')).dbPath).toBe(f.toDb);

    const status = await request(app).get(`/api/settings/db-path/migrate/${res.body.migration_id}`).expect(200);
    expect(status.body).toMatchObject({ stage: 'restart', ok: null, from_db_path: f.fromDb, to_db_path: f.toDb });

    // 未知 id → 404
    await request(app).get('/api/settings/db-path/migrate/mig-nope').expect(404);
  });

  it('迁移进行中：PATCH db_path 与再次 POST 都 409 DB_MIGRATION_BUSY', async () => {
    const app = await openApp();
    await request(app).post('/api/settings/db-path/migrate').send({ target_db_path: f.toDb }).expect(202);
    // 意图还在（新进程尚未自检）→ 视为迁移中
    expect(readMigrationIntent(f.stateDir)).not.toBeNull();
    const patch = await request(app).patch('/api/settings').send({ db_path: join(f.root, 'x', 'agentboard.db') }).expect(409);
    expect(patch.body.error.code).toBe('DB_MIGRATION_BUSY');
    const again = await request(app).post('/api/settings/db-path/migrate').send({ target_db_path: join(f.root, 'y', 'agentboard.db') }).expect(409);
    expect(again.body.error.code).toBe('DB_MIGRATION_BUSY');
    // 非 db 路径的设置照旧可改
    await request(app).patch('/api/settings').send({ maxConcurrentTurns: 2 }).expect(200);
  });

  it('env 指定库路径时拒绝迁移（改设置不生效）', async () => {
    const app = await openApp({ dbPathSource: 'env' });
    const res = await request(app).post('/api/settings/db-path/migrate').send({ target_db_path: f.toDb }).expect(409);
    expect(res.body.error.code).toBe('DB_MIGRATION_ENV_OVERRIDDEN');
    expect(res.body.error.message).toContain('AGENTBOARD_DB');
  });

  it('target_db_path 缺失 → 400 中文校验', async () => {
    const app = await openApp();
    const res = await request(app).post('/api/settings/db-path/migrate').send({}).expect(400);
    expect(res.body.error.message).toContain('target_db_path');
  });

  it('自检失败的新进程：设置回滚旧库并退出（旧进程重新接管）', async () => {
    const exits: number[] = [];
    const app = await openApp({ exit: (code) => { exits.push(code); } });
    await request(app).post('/api/settings/db-path/migrate').send({ target_db_path: f.toDb }).expect(202);
    expect(readSettings().dbPath).toBe(f.toDb);
    // 篡改目标侧附件 → 下一次 createApp（模拟新进程启动，用的是迁移后的库）自检必失败
    rmSync(join(f.toAttach, 'a.png'));
    const nextApp = await openApp({ exit: (code) => { exits.push(code); }, dbPath: f.toDb, attachmentStorageDir: f.toAttach });
    expect(exits).toEqual([1]);
    expect(readSettings().dbPath).toBe(f.fromDb);
    expect(readMigrationIntent(f.stateDir)).toBeNull();
    // 新进程仍可服务（旧库路径已回滚，等旧进程接管）
    await request(nextApp).get('/api/version').expect(200);
  });
});
