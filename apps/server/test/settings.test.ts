/**
 * 设置端点测试（issue 65898a1b）：GET /api/settings 反映 config.json 持久化值（环境变量不参与）、
 * PATCH 合法值持久化、非法值 400、并发上限即时生效排队。
 *
 * 配置隔离：无既有先例，采用注入方式——APPDATA 指向临时目录（appDataDir 调用时读取该变量），
 * configFilePath() 全部落到临时目录，不污染真实 %APPDATA%；afterEach 恢复原值并删除临时目录。
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import type { AgentAdapter } from '@agentboard/adapters';
import { createTestDb, type TestDb } from './helpers.js';
import { FakeAdapter, settle, type FakeTurnControl } from './fakeAdapter.js';
import { createApp, type CreatedApp } from '../src/index.js';
import {
  configDir,
  configFilePath,
  DEFAULT_MAX_CONCURRENT_TURNS,
  DEFAULT_PORT,
  defaultDbPath,
} from '../src/config.js';
import {
  initSessionManager,
  resetSessionManager,
  setMaxConcurrentTurns,
} from '../src/services/sessionManager.js';
import { ValidationError } from '../src/errors.js';
import {
  DEFAULT_ATTACHMENT_CLEANUP_INTERVAL_MS,
  DEFAULT_ATTACHMENT_QUOTA_BYTES,
  DEFAULT_ATTACHMENT_STAGED_TTL_MS,
} from '../src/services/attachments.js';

let t: TestDb;
let adapter: FakeAdapter;
let app: Express;
let spaceDir: string;
let cfgDir: string;
let savedAppData: string | undefined;

function fakeResolver(id: string): AgentAdapter {
  if (id === 'fake' || id === 'codebuddy') return adapter;
  throw new Error(`未知适配器 id: ${id}`);
}

beforeEach(async () => {
  t = createTestDb();
  adapter = new FakeAdapter();
  spaceDir = mkdtempSync(join(tmpdir(), 'agentboard-space-'));
  savedAppData = process.env.APPDATA;
  cfgDir = mkdtempSync(join(tmpdir(), 'agentboard-cfg-'));
  process.env.APPDATA = cfgDir;
  const created: CreatedApp = await createApp({
    db: t.db,
    getAdapter: fakeResolver,
    adapters: [adapter],
    maxConcurrentTurns: 3,
  });
  app = created.app;
  let clock = 1_000_000;
  vi.spyOn(Date, 'now').mockImplementation(() => ++clock);
});

afterEach(() => {
  vi.restoreAllMocks();
  resetSessionManager();
  t.cleanup();
  rmSync(spaceDir, { recursive: true, force: true });
  if (savedAppData === undefined) delete process.env.APPDATA;
  else process.env.APPDATA = savedAppData;
  rmSync(cfgDir, { recursive: true, force: true });
});

/** 建工作空间（合法目录），返回 id */
async function mkSpace(name = 'demo'): Promise<string> {
  const res = await request(app).post('/api/workspaces').send({ name, path: spaceDir });
  expect(res.status).toBe(200);
  return res.body.id as string;
}

/** 在隔离的配置目录写入 config.json */
function writeConfigFile(value: Record<string, unknown>): void {
  mkdirSync(configDir(), { recursive: true });
  writeFileSync(configFilePath(), JSON.stringify(value), 'utf8');
}

describe('GET /api/settings', () => {
  it('文件缺失 → 默认值，且不写回文件', async () => {
    const res = await request(app).get('/api/settings');
    expect(res.status).toBe(200);
    // DB-1：对外规范名 db_path 与既有 dbPath 同值共存（两者都在，语义一致）
    expect(res.body).toEqual({
      port: DEFAULT_PORT,
      dbPath: defaultDbPath(),
      db_path: defaultDbPath(),
      maxConcurrentTurns: DEFAULT_MAX_CONCURRENT_TURNS,
      attachmentQuotaBytes: DEFAULT_ATTACHMENT_QUOTA_BYTES,
      attachmentStagedTtlMs: DEFAULT_ATTACHMENT_STAGED_TTL_MS,
      attachmentCleanupIntervalMs: DEFAULT_ATTACHMENT_CLEANUP_INTERVAL_MS,
      travelAutoRecover: true,
    });
    expect(res.body.db_path).toBe(res.body.dbPath);
    // 落盘只写持久化键 dbPath，不写对外别名
    expect(existsSync(configFilePath())).toBe(false);
  });

  it('文件存在 → 文件持久化值', async () => {
    writeConfigFile({ port: 9000, dbPath: 'D:\\db\\a.db', maxConcurrentTurns: 5 });
    const res = await request(app).get('/api/settings');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      port: 9000,
      dbPath: 'D:\\db\\a.db',
      db_path: 'D:\\db\\a.db',
      maxConcurrentTurns: 5,
      attachmentQuotaBytes: DEFAULT_ATTACHMENT_QUOTA_BYTES,
      attachmentStagedTtlMs: DEFAULT_ATTACHMENT_STAGED_TTL_MS,
      attachmentCleanupIntervalMs: DEFAULT_ATTACHMENT_CLEANUP_INTERVAL_MS,
      travelAutoRecover: true,
    });
    expect(res.body.db_path).toBe(res.body.dbPath);
  });

  it('环境变量 AGENTBOARD_PORT 不参与（端点只反映文件持久化值）', async () => {
    writeConfigFile({ port: 9000, dbPath: 'D:\\db\\a.db', maxConcurrentTurns: 5 });
    process.env.AGENTBOARD_PORT = '1234';
    try {
      const res = await request(app).get('/api/settings');
      expect(res.status).toBe(200);
      expect(res.body.port).toBe(9000);
    } finally {
      delete process.env.AGENTBOARD_PORT;
    }
  });
});

describe('PATCH /api/settings', () => {
  it('合法值 → 200 返回新值并持久化（再 GET 可见、文件落盘）', async () => {
    const res = await request(app)
      .patch('/api/settings')
      .send({
        port: 9001,
        dbPath: 'D:\\db\\new.db',
        maxConcurrentTurns: 2,
        attachmentQuotaBytes: 2048,
        attachmentStagedTtlMs: 5000,
        attachmentCleanupIntervalMs: 10000,
      });
    expect(res.status).toBe(200);
    // PATCH 响应与 GET 同形（含对外 db_path），二者可直接比较
    expect(res.body).toEqual({
      port: 9001,
      dbPath: 'D:\\db\\new.db',
      db_path: 'D:\\db\\new.db',
      maxConcurrentTurns: 2,
      attachmentQuotaBytes: 2048,
      attachmentStagedTtlMs: 5000,
      attachmentCleanupIntervalMs: 10000,
      travelAutoRecover: true,
    });

    const again = await request(app).get('/api/settings');
    expect(again.status).toBe(200);
    expect(again.body).toEqual(res.body);
    // 文件里只落持久化键 dbPath（db_path 是纯对外别名）
    const persisted = JSON.parse(readFileSync(configFilePath(), 'utf8')) as Record<string, unknown>;
    expect(persisted).toEqual({ ...res.body, db_path: undefined });
    expect(persisted.db_path).toBeUndefined();
  });

  it('port=0 / port=70000 / maxConcurrentTurns=0 / 空体 → 400 且文件不变', async () => {
    writeConfigFile({ port: 8787, dbPath: 'D:\\db\\keep.db', maxConcurrentTurns: 3 });

    for (const body of [{ port: 0 }, { port: 70000 }, { maxConcurrentTurns: 0 }, {}]) {
      const res = await request(app).patch('/api/settings').send(body);
      expect(res.status, `body=${JSON.stringify(body)}`).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_ERROR');
    }

    const after = await request(app).get('/api/settings');
    expect(after.body).toMatchObject({ port: 8787, maxConcurrentTurns: 3 });
  });
});

describe('并发上限即时生效', () => {
  it('PATCH maxConcurrentTurns=1 后起 2 轮：第 2 轮等槽位，释放后运行', async () => {
    const patch = await request(app).patch('/api/settings').send({ maxConcurrentTurns: 1 });
    expect(patch.status).toBe(200);
    expect(patch.body.maxConcurrentTurns).toBe(1);

    const wsId = await mkSpace();
    const held: FakeTurnControl[] = [];
    adapter.script = (control) => {
      held.push(control); // 全部挂起，逐轮手动放行
    };

    const a = await request(app)
      .post('/api/sessions')
      .send({ cli: 'codebuddy', workspace_id: wsId, prompt: 'A 轮' });
    expect(a.status).toBe(200);
    await settle();
    expect(adapter.calls).toHaveLength(1);

    const b = await request(app)
      .post('/api/sessions')
      .send({ cli: 'codebuddy', workspace_id: wsId, prompt: 'B 轮' });
    expect(b.status).toBe(200);
    await settle();
    expect(adapter.calls).toHaveLength(1); // B 受理但等槽位，runTurn 未被调

    held[0]!.finish(0, 'fake-as-a');
    await settle();
    expect(adapter.calls.map((c) => c.prompt)).toEqual(['A 轮', 'B 轮']);

    held[1]!.finish(0, 'fake-as-b');
    await settle();
  });

  it('setMaxConcurrentTurns：未装配报错；非法值 ValidationError；合法值生效', () => {
    resetSessionManager();
    expect(() => setMaxConcurrentTurns(2)).toThrow('sessionManager 未装配');

    initSessionManager(t.db, fakeResolver, { maxConcurrentTurns: 3 });
    expect(() => setMaxConcurrentTurns(0)).toThrow(ValidationError);
    expect(() => setMaxConcurrentTurns(1.5)).toThrow(ValidationError);
    expect(() => setMaxConcurrentTurns(2)).not.toThrow();
  });
});
