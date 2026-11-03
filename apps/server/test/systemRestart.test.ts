/**
 * SYSTEM-RESTART：`POST /api/system/restart`。
 * 核心断言：回环校验、202 先于关闭、spawn 失败不动旧进程、入口缺失 500、未装配 503。
 * RESTART-HARDENING：端口占用前置 409、响应带新 pid + 日志路径、新进程不健康则回退旧监听不退出。
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
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

/** 202 之后的交接是 fire-and-forget（生产里旧进程随后退出）；测试用一次宏任务把交接跑完 */
const flushHandoff = () => new Promise(resolve => setTimeout(resolve, 25));

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
  const logs: string[] = [];
  const injected: RestartDeps = {
    entry: () => ({ command: 'node', args: ['dist/index.js'], exists: true }),
    spawnChild: async () => { calls.push('spawn'); return { pid: 5151 }; },
    closeServer: async () => { calls.push('close'); },
    reopenServer: async () => { calls.push('reopen'); },
    exit: () => { calls.push('exit'); },
    schedule: fn => { calls.push('schedule'); fn(); },
    now: () => 1_700_000_000_000,
    pid: () => 4242,
    port: () => 8787,
    probePort: async () => { calls.push('probe'); return { kind: 'self' }; },
    waitForHealth: async () => { calls.push('health'); return true; },
    log: line => { logs.push(line); },
    logPath: () => 'D:/repo/.logs/server.log',
    ...overrides,
  };
  return { injected, calls, logs };
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
    await flushHandoff();
    expect(record.status).toBe(202);
    expect(record.body).toMatchObject({
      restarting: true,
      old_pid: 4242,
      new_pid: 5151,
      log_path: 'D:/repo/.logs/server.log',
      started_at: 1_700_000_000_000,
    });
    expect(calls).toEqual(['probe', 'spawn', 'schedule', 'close', 'health', 'exit']);
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
    expect(calls).toEqual(['probe']);
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

describe('restart hardening (RESTART-HARDENING)', () => {
  it('rejectsWith409WhenTargetPortHeldByForeignProcess', async () => {
    const { injected, calls, logs } = deps({ probePort: async () => ({ kind: 'foreign', detail: '端口 8787 由 pid 9999 占用' }) });
    const { res, record } = fakeRes();
    await createRestartHandler(injected)(fakeReq('127.0.0.1'), res);
    expect(record.status).toBe(409);
    expect((record.body as { error: { code: string } }).error.code).toBe('RESTART_PORT_CONFLICT');
    expect((record.body as { error: { message: string } }).error.message).toContain('pid 9999');
    // 关键：没有 spawn / close / exit，旧进程继续服务，且留一行可见日志
    expect(calls).toEqual([]);
    expect(logs).toHaveLength(1);
    expect(logs[0]).toContain('重启已拒绝');
  });

  it('logsIntentWithNewPidAndLogPathBeforeClosing', async () => {
    const { injected, calls, logs } = deps();
    const { res } = fakeRes();
    await createRestartHandler(injected)(fakeReq('127.0.0.1'), res);
    const intent = logs.find(line => line.includes('即将重启'));
    expect(intent).toBeDefined();
    expect(intent).toContain('5151');
    expect(intent).toContain('D:/repo/.logs/server.log');
    expect(intent).toContain('4242');
    // 意图行必须在 close 之前写出
    expect(logs.indexOf(intent as string)).toBeLessThan(logs.length);
    expect(calls.indexOf('close')).toBeGreaterThan(0);
  });

  it('reopensListenerAndDoesNotExitWhenNewProcessNeverHealthy', async () => {
    const { injected, calls, logs } = deps({ waitForHealth: async () => { calls.push('health'); return false; } });
    const { res, record } = fakeRes();
    await createRestartHandler(injected)(fakeReq('127.0.0.1'), res);
    await flushHandoff();
    expect(record.status).toBe(202);
    expect(calls).toEqual(['probe', 'spawn', 'schedule', 'close', 'health', 'reopen']);
    expect(logs.some(line => line.includes('重启失败') && line.includes('回退'))).toBe(true);
  });

  it('logsFatalLineWhenReopenAlsoFails', async () => {
    const { injected, logs } = deps({
      waitForHealth: async () => false,
      reopenServer: async () => { throw new Error('EADDRINUSE'); },
    });
    const { res } = fakeRes();
    await createRestartHandler(injected)(fakeReq('127.0.0.1'), res);
    await flushHandoff();
    expect(logs.some(line => line.includes('回退失败'))).toBe(true);
  });
});

describe('restart port pre-check against real listeners (RESTART-HARDENING)', () => {
  // 真实走 defaultProbePort（TCP 连接 + /api/version 探测），只注入「子进程将绑定的端口」
  const listen = async (app: import('express').Express): Promise<{ port: number; close: () => Promise<void> }> => {
    const server = app.listen(0, '127.0.0.1');
    await new Promise<void>(resolve => server.once('listening', () => resolve()));
    const address = server.address();
    const port = typeof address === 'object' && address !== null ? address.port : 0;
    return { port, close: () => new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()); }) };
  };

  it('409 with holder description when the target port is held by a non-board service', async () => {
    const foreign = createServer((_req, res) => { res.writeHead(200, { 'content-type': 'text/plain' }); res.end('not a board'); });
    await new Promise<void>(resolve => foreign.listen(0, '127.0.0.1', () => resolve()));
    const address = foreign.address();
    const port = typeof address === 'object' && address !== null ? address.port : 0;
    try {
      const { injected, calls, logs } = deps({ port: () => port, probePort: undefined });
      const { res, record } = fakeRes();
      await createRestartHandler(injected)(fakeReq('127.0.0.1'), res);
      expect(record.status).toBe(409);
      expect((record.body as { error: { code: string; message: string } }).error.code).toBe('RESTART_PORT_CONFLICT');
      expect((record.body as { error: { message: string } }).error.message).toContain(`端口 ${port} 被非看板服务占用`);
      // 没有 spawn / close / exit：旧进程继续服务
      expect(calls).toEqual([]);
      expect(logs.some(line => line.includes('重启已拒绝'))).toBe(true);
    } finally {
      await new Promise<void>(resolve => foreign.close(() => resolve()));
    }
  });

  it('409 naming the other board instance when the target port is held by a second board', async () => {
    const t2 = createTestDb();
    const adapter2 = new FakeAdapter();
    const { app: app2 } = await createApp({
      db: t2.db,
      getAdapter: (id: string): AgentAdapter => { if (id === 'fake') return adapter2; throw new Error(`未知适配器 id: ${id}`); },
      adapters: [adapter2],
      refreshClisOnBoot: false,
    });
    const second = await listen(app2);
    try {
      const version = await (await fetch(`http://127.0.0.1:${second.port}/api/version`)).json() as { pid: number };
      const { injected, calls, logs } = deps({ port: () => second.port, probePort: undefined });
      const { res, record } = fakeRes();
      await createRestartHandler(injected)(fakeReq('127.0.0.1'), res);
      expect(record.status).toBe(409);
      const message = (record.body as { error: { message: string } }).error.message;
      expect(message).toContain('另一个看板实例');
      expect(message).toContain(`pid ${version.pid}`);
      expect(calls).toEqual([]);
      expect(logs.some(line => line.includes(`pid ${version.pid}`))).toBe(true);
    } finally {
      await second.close();
      t2.cleanup();
    }
  });

  it('proceeds to 202 when the target port is free', async () => {
    // 拿一个空闲端口：先监听再立刻关掉
    const probe = createServer(() => {});
    await new Promise<void>(resolve => probe.listen(0, '127.0.0.1', () => resolve()));
    const address = probe.address();
    const port = typeof address === 'object' && address !== null ? address.port : 0;
    await new Promise<void>(resolve => probe.close(() => resolve()));

    const { injected, calls } = deps({ port: () => port, probePort: undefined });
    const { res, record } = fakeRes();
    await createRestartHandler(injected)(fakeReq('127.0.0.1'), res);
    await flushHandoff();
    expect(record.status).toBe(202);
    expect(calls).toContain('spawn');
    expect(calls).toContain('exit');
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
    expect(Object.keys(res.body).sort()).toEqual(['log_path', 'new_pid', 'old_pid', 'restarting', 'started_at']);
    expect(res.body).toMatchObject({ restarting: true, old_pid: 4242, new_pid: 5151 });
    expect(calls).toEqual(['probe', 'spawn', 'schedule', 'close', 'health', 'exit']);
  });

  it('returns409AndKeepsServingWhenPortHeldByForeignProcess', async () => {
    const { injected, calls } = deps({ probePort: async () => ({ kind: 'foreign', detail: '端口 8787 由 pid 9999 占用' }) });
    const { app } = await openApp(injected);
    const res = await request(app).post('/api/system/restart').send({});
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('RESTART_PORT_CONFLICT');
    expect(calls).toEqual([]);
    const health = await request(app).get('/api/version');
    expect(health.status).toBe(200);
  });

  it('returns500AndKeepsServingWhenSpawnFails', async () => {
    const { injected, calls } = deps({ spawnChild: async () => { throw new Error('boom'); } });
    const { app } = await openApp(injected);
    const res = await request(app).post('/api/system/restart').send({});
    expect(res.status).toBe(500);
    expect(res.body.error.code).toBe('RESTART_SPAWN_FAILED');
    expect(calls).toEqual(['probe']);
    // 旧进程仍在服务：同实例的普通请求照常 200
    const health = await request(app).get('/api/version');
    expect(health.status).toBe(200);
  });

  it('versionExposesPidSoClientCanTellNewProcessFromRollback', async () => {
    const { app } = await openApp();
    const res = await request(app).get('/api/version');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ name: 'agentboard-server' });
    expect(typeof res.body.pid).toBe('number');
  });
});
