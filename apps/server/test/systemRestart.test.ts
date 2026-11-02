/**
 * SYSTEM-RESTART：`POST /api/system/restart`。
 * 核心断言：回环校验、202 先于关闭、spawn 失败不动旧进程、入口缺失 500、未装配 503。
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import type { AgentAdapter } from '@agentboard/adapters';
import type { Request, Response } from 'express';
import { createTestDb, type TestDb } from './helpers.js';
import { FakeAdapter } from './fakeAdapter.js';
import { createApp } from '../src/index.js';
import { createRestartHandler, isLoopbackAddress, type RestartDeps } from '../src/api/systemRoutes.js';

const fakeReq = (ip: string | undefined) => ({ ip } as unknown as Request);

function fakeRes() {
  const record = { status: 0, body: undefined as unknown };
  const res = {
    status(code: number) { record.status = code; return res; },
    json(body: unknown) { record.body = body; return res; },
    setHeader() { return res; },
  };
  return { res: res as unknown as Response, record };
}

const deps = (overrides: Partial<RestartDeps> = {}) => {
  const calls: string[] = [];
  const injected: RestartDeps = {
    entry: () => ({ command: 'node', args: ['dist/index.js'], exists: true }),
    spawnChild: async () => { calls.push('spawn'); },
    closeServer: async () => { calls.push('close'); },
    exit: () => { calls.push('exit'); },
    schedule: fn => { calls.push('schedule'); fn(); },
    now: () => 1_700_000_000_000,
    pid: () => 4242,
    ...overrides,
  };
  return { injected, calls };
};

describe('system restart (SYSTEM-RESTART)', () => {
  it('treatsOnlyLoopbackAddressesAsAllowed', () => {
    for (const ip of ['127.0.0.1', '::1', '::ffff:127.0.0.1']) expect(isLoopbackAddress(ip)).toBe(true);
    for (const ip of ['10.0.0.5', '192.168.1.20', '::ffff:10.0.0.5', '', undefined]) expect(isLoopbackAddress(ip as string | undefined)).toBe(false);
  });

  it('responds202BeforeClosingAndExiting', async () => {
    const { injected, calls } = deps();
    const { res, record } = fakeRes();
    await createRestartHandler(injected)(fakeReq('127.0.0.1'), res);
    expect(record.status).toBe(202);
    expect(record.body).toMatchObject({ restarting: true, pid: 4242, started_at: 1_700_000_000_000 });
    expect(calls).toEqual(['spawn', 'schedule', 'close', 'exit']);
  });

  it('rejectsNonLoopbackWithoutSpawning', async () => {
    const { injected, calls } = deps();
    const { res, record } = fakeRes();
    await createRestartHandler(injected)(fakeReq('10.1.2.3'), res);
    expect(record.status).toBe(403);
    expect((record.body as { error: { code: string } }).error.code).toBe('RESTART_FORBIDDEN');
    expect(calls).toEqual([]);
  });

  it('keepsOldProcessServingWhenSpawnFails', async () => {
    const { injected, calls } = deps({ spawnChild: async () => { throw new Error('ENOENT'); } });
    const { res, record } = fakeRes();
    await createRestartHandler(injected)(fakeReq('127.0.0.1'), res);
    expect(record.status).toBe(500);
    expect((record.body as { error: { code: string } }).error.code).toBe('RESTART_SPAWN_FAILED');
    // 关键：没有 close、没有 exit，旧进程继续服务
    expect(calls).toEqual([]);
  });

  it('failsWhenEntryMissingWithoutSpawning', async () => {
    const { injected, calls } = deps({ entry: () => ({ command: 'node', args: ['missing.js'], exists: false }) });
    const { res, record } = fakeRes();
    await createRestartHandler(injected)(fakeReq('127.0.0.1'), res);
    expect(record.status).toBe(500);
    expect((record.body as { error: { code: string } }).error.code).toBe('RESTART_ENTRY_MISSING');
    expect(calls).toEqual([]);
  });
});

describe('system restart endpoint (SYSTEM-RESTART)', () => {
  let t: TestDb;
  let root: string;
  beforeEach(() => { t = createTestDb(); root = mkdtempSync(join(tmpdir(), 'agentboard-restart-')); });
  afterEach(() => { t.cleanup(); rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }); });

  const openApp = (restart?: RestartDeps) => {
    const adapter = new FakeAdapter();
    return createApp({
      db: t.db,
      getAdapter: (id: string): AgentAdapter => { if (id === 'fake') return adapter; throw new Error(`未知适配器 id: ${id}`); },
      adapters: [adapter],
      refreshClisOnBoot: false,
      ...(restart ? { restart } : {}),
    });
  };

  it('returns503WhenRestartNotAssembled', async () => {
    const { app } = await openApp();
    const res = await request(app).post('/api/system/restart').send({});
    expect(res.status).toBe(503);
    expect(res.body.error.code).toBe('RESTART_UNAVAILABLE');
  });

  it('returns202ShapeAndSchedulesRestartOnLoopback', async () => {
    const { injected, calls } = deps();
    const { app } = await openApp(injected);
    const res = await request(app).post('/api/system/restart').send({});
    expect(res.status).toBe(202);
    expect(Object.keys(res.body).sort()).toEqual(['pid', 'restarting', 'started_at']);
    expect(res.body).toMatchObject({ restarting: true, pid: 4242 });
    expect(calls).toEqual(['spawn', 'schedule', 'close', 'exit']);
  });

  it('returns500AndKeepsServingWhenSpawnFails', async () => {
    const { injected, calls } = deps({ spawnChild: async () => { throw new Error('boom'); } });
    const { app } = await openApp(injected);
    const res = await request(app).post('/api/system/restart').send({});
    expect(res.status).toBe(500);
    expect(res.body.error.code).toBe('RESTART_SPAWN_FAILED');
    expect(calls).toEqual([]);
    // 旧进程仍在服务：同实例的普通请求照常 200
    const health = await request(app).get('/api/version');
    expect(health.status).toBe(200);
  });
});
