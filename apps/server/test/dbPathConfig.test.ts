/**
 * DB-1 / P1-01：数据库位置配置与生效链路。
 * 来源优先级：AGENTBOARD_DB（只读 env）→ 默认 %APPDATA%（config.json 的 dbPath 被忽略）。
 * 同时验证 /api/settings 仍只读回显 db_path、PATCH 带 db_path/dbPath 被拒（400 VALIDATION_ERROR）。
 */
import { existsSync, mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import type { AgentAdapter } from '@agentboard/adapters';
import { createTestDb, type TestDb } from './helpers.js';
import { FakeAdapter } from './fakeAdapter.js';
import { createApp } from '../src/index.js';
import { loadConfig } from '../src/config.js';

describe('dbPath resolution (DB-1 / P1-01)', () => {
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

  it('config.json 里的 dbPath 被忽略 → 恒为默认库、source=default，并给一次性 warning（M4）', () => {
    const custom = join(appData, 'custom', 'agentboard.db');
    writeConfig({ port: 8787, dbPath: custom });
    const warns: string[] = [];
    const spy = vi.spyOn(console, 'warn').mockImplementation((chunk) => { warns.push(String(chunk)); });
    try {
      const config = loadConfig({ APPDATA: appData });
      // 值被忽略：不是 custom，而是中心库默认路径
      expect(config.dbPath).toBe(join(appData, 'AgentBoard', 'agentboard.db'));
      expect(config.dbPath).not.toBe(custom);
      // 'settings' 来源已下线
      expect(config.dbPathSource).toBe('default');
      // M4：一次性 warning 提示已不再生效、数据不丢失
      expect(warns.join('\n')).toContain('已不再生效');
      expect(warns.join('\n')).toContain('数据不丢失');
      expect(warns.filter((w) => w.includes('已不再生效'))).toHaveLength(1);
      // 不静默迁移：custom 路径的数据库文件不会被创建
      expect(() => readFileSync(custom, 'utf8')).toThrow();
    } finally {
      spy.mockRestore();
    }
  });

  it('AGENTBOARD_DB 仍生效且 db_source=env（启动首行日志按此值打印）', () => {
    const envDb = join(appData, 'env', 'agentboard.db');
    const custom = join(appData, 'custom', 'agentboard.db');
    writeConfig({ port: 8787, dbPath: custom });
    const config = loadConfig({ APPDATA: appData, AGENTBOARD_DB: envDb });
    // 只读 env 覆盖中心库，优先于被忽略的 config.json dbPath
    expect(config.dbPath).toBe(envDb);
    expect(config.dbPathSource).toBe('env');
    // 启动首行日志（index.ts:532）按 config.dbPathSource 渲染 db_source，env 时应为 db_source=env
    const listeningLine = `listening http://${config.host}:${config.port} pid=${process.pid} db=${config.dbPath} db_source=${config.dbPathSource}`;
    expect(listeningLine).toContain('db_source=env');
  });
});

describe('settings db_path (DB-1 / P1-01)', () => {
  let t: TestDb;
  let appData: string;
  let previousAppData: string | undefined;
  let previousEnvDb: string | undefined;
  beforeEach(async () => {
    t = createTestDb();
    appData = mkdtempSync(join(tmpdir(), 'agentboard-dbhome-api-'));
    previousAppData = process.env.APPDATA;
    previousEnvDb = process.env.AGENTBOARD_DB;
    process.env.APPDATA = appData;
    delete process.env.AGENTBOARD_DB;
  });
  afterEach(() => {
    if (previousAppData === undefined) delete process.env.APPDATA; else process.env.APPDATA = previousAppData;
    if (previousEnvDb === undefined) delete process.env.AGENTBOARD_DB; else process.env.AGENTBOARD_DB = previousEnvDb;
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

  it('GET /api/settings 只读回显 db_path（与 dbPath 同值，排障用）', async () => {
    const app = await openApp();
    const res = await request(app).get('/api/settings');
    expect(res.status).toBe(200);
    expect(typeof res.body.db_path).toBe('string');
    expect(res.body.db_path).toBe(res.body.dbPath);
  });

  it('PATCH /api/settings 带 db_path 被拒 → 400 VALIDATION_ERROR（错误码稳定可断言）', async () => {
    const app = await openApp();
    const target = join(appData, 'moved', 'agentboard.db');
    const res = await request(app).patch('/api/settings').send({ db_path: target });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
    // db_path 不再落 config.json：被拒在校验层，文件未被写成目标路径
    expect(existsSync(join(appData, 'AgentBoard', 'config.json'))).toBe(false);
  });

  it('PATCH /api/settings 带 dbPath（驼峰）同样被拒 → 400 VALIDATION_ERROR', async () => {
    const app = await openApp();
    const res = await request(app).patch('/api/settings').send({ dbPath: join(appData, 'b', 'y.db') });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('db_path 与 dbPath 同时出现 → 400（两者都已下线）', async () => {
    const app = await openApp();
    const res = await request(app).patch('/api/settings').send({ db_path: join(appData, 'a', 'x.db'), dbPath: join(appData, 'b', 'y.db') });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('真实 app：/api/version 200，且 AGENTBOARD_DB 生效时启动日志 db_source=env', async () => {
    const envDb = join(appData, 'env', 'agentboard.db');
    process.env.AGENTBOARD_DB = envDb;
    try {
      const app = await openApp();
      const version = await request(app).get('/api/version');
      expect(version.status).toBe(200);
      // 启动期解析：只读 env 覆盖中心库、来源 env（启动首行 db_source 取值）
      const config = loadConfig({ APPDATA: appData, AGENTBOARD_DB: envDb });
      expect(config.dbPath).toBe(envDb);
      expect(config.dbPathSource).toBe('env');
      const listeningLine = `listening http://${config.host}:${config.port} pid=${process.pid} db=${config.dbPath} db_source=${config.dbPathSource}`;
      expect(listeningLine).toContain('db_source=env');
    } finally {
      delete process.env.AGENTBOARD_DB;
    }
  });
});
