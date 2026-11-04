/**
 * DB-1：数据库位置配置与生效链路。
 * 来源优先级：AGENTBOARD_DB（env）→ config.json 的 dbPath（settings）→ 默认 %APPDATA%。
 * 同时验证 /api/settings 暴露 db_path、PATCH db_path 只改配置（不搬数据）。
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import type { AgentAdapter } from '@agentboard/adapters';
import { createTestDb, type TestDb } from './helpers.js';
import { FakeAdapter } from './fakeAdapter.js';
import { createApp } from '../src/index.js';
import { loadConfig } from '../src/config.js';

describe('dbPath resolution (DB-1)', () => {
  let appData: string;
  let previousAppData: string | undefined;

  beforeEach(() => {
    appData = mkdtempSync(join(tmpdir(), 'agentboard-dbhome-'));
    previousAppData = process.env.APPDATA;
    process.env.APPDATA = appData;
  });
  afterEach(() => {
    if (previousAppData === undefined) delete process.env.APPDATA; else process.env.APPDATA = previousAppData;
    rmSync(appData, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  });

  const writeConfig = (config: Record<string, unknown>): void => {
    mkdirSync(join(appData, 'AgentBoard'), { recursive: true });
    writeFileSync(join(appData, 'AgentBoard', 'config.json'), JSON.stringify(config, null, 2), 'utf8');
  };

  it('默认：没有 env、没有设置项 → %APPDATA% 下的库，source=default', () => {
    const config = loadConfig({ APPDATA: appData });
    expect(config.dbPath).toBe(join(appData, 'AgentBoard', 'agentboard.db'));
    expect(config.dbPathSource).toBe('default');
  });

  it('设置项：config.json 有 dbPath → source=settings', () => {
    const custom = join(appData, 'custom', 'agentboard.db');
    writeConfig({ port: 8787, dbPath: custom });
    const config = loadConfig({ APPDATA: appData });
    expect(config.dbPath).toBe(custom);
    expect(config.dbPathSource).toBe('settings');
  });

  it('env 优先：AGENTBOARD_DB 存在时忽略设置项 → source=env', () => {
    const custom = join(appData, 'custom', 'agentboard.db');
    const envDb = join(appData, 'env', 'agentboard.db');
    writeConfig({ port: 8787, dbPath: custom });
    const config = loadConfig({ APPDATA: appData, AGENTBOARD_DB: envDb });
    expect(config.dbPath).toBe(envDb);
    expect(config.dbPathSource).toBe('env');
  });
});

describe('settings db_path (DB-1)', () => {
  let t: TestDb;
  let appData: string;
  let previousAppData: string | undefined;
  beforeEach(async () => {
    t = createTestDb();
    appData = mkdtempSync(join(tmpdir(), 'agentboard-dbhome-api-'));
    previousAppData = process.env.APPDATA;
    process.env.APPDATA = appData;
  });
  afterEach(() => {
    if (previousAppData === undefined) delete process.env.APPDATA; else process.env.APPDATA = previousAppData;
    t.cleanup();
    rmSync(appData, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  });

  const openApp = async () => {
    const adapter = new FakeAdapter();
    const created = await createApp({
      db: t.db,
      getAdapter: (id: string): AgentAdapter => { if (id === 'fake') return adapter; throw new Error(`未知适配器 id: ${id}`); },
      adapters: [adapter],
      refreshClisOnBoot: false,
    });
    return created.app;
  };

  it('GET /api/settings 暴露 db_path（与 dbPath 同值）', async () => {
    const app = await openApp();
    const res = await request(app).get('/api/settings');
    expect(res.status).toBe(200);
    expect(typeof res.body.db_path).toBe('string');
    expect(res.body.db_path).toBe(res.body.dbPath);
  });

  it('PATCH db_path 只改配置（落 config.json），不搬数据', async () => {
    const app = await openApp();
    const target = join(appData, 'moved', 'agentboard.db');
    const res = await request(app).patch('/api/settings').send({ db_path: target });
    expect(res.status).toBe(200);
    expect(res.body.dbPath).toBe(target);
    const persisted = JSON.parse(readFileSync(join(appData, 'AgentBoard', 'config.json'), 'utf8')) as { dbPath: string };
    expect(persisted.dbPath).toBe(target);
    // 不搬数据：目标目录不会被创建
    expect(() => readFileSync(target, 'utf8')).toThrow();
  });

  it('db_path 与 dbPath 同时出现且不一致 → 400', async () => {
    const app = await openApp();
    const res = await request(app).patch('/api/settings').send({ db_path: join(appData, 'a', 'x.db'), dbPath: join(appData, 'b', 'y.db') });
    expect(res.status).toBe(400);
  });
});
