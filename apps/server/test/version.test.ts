/** 版本端点与全局响应头（x-agentboard-version）契约。 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import { createTestDb, type TestDb } from './helpers.js';
import { createApp, type CreatedApp } from '../src/index.js';
import { resetSessionManager } from '../src/services/sessionManager.js';

// 版本单一来源是 apps/server/package.json，断言跟随它而不是硬编码
const serverPkg = JSON.parse(
  readFileSync(fileURLToPath(new URL('../package.json', import.meta.url)), 'utf8'),
) as { version: string };

let t: TestDb;
let app: Express;

beforeEach(async () => {
  t = createTestDb();
  const created: CreatedApp = await createApp({ db: t.db, refreshClisOnBoot: false });
  app = created.app;
});

afterEach(() => {
  resetSessionManager();
  t.cleanup();
});

describe('版本端点与响应头', () => {
  it('GET /api/version 返回包版本与当前进程 pid', async () => {
    const res = await request(app).get('/api/version');
    expect(res.status).toBe(200);
    // pid 是 RESTART-HARDENING 的契约：客户端据它区分「新进程已接管」与「已回退旧进程」
    expect(res.body).toEqual({ name: 'agentboard-server', version: serverPkg.version, pid: process.pid });
    expect(typeof res.body.pid).toBe('number');
  });

  it('任意 /api 响应携带 x-agentboard-version 头（正常与 404 错误路径）', async () => {
    const ok = await request(app).get('/api/workspaces');
    expect(ok.status).toBe(200);
    expect(ok.headers['x-agentboard-version']).toBe(serverPkg.version);
    const notFound = await request(app).get('/api/definitely-missing');
    expect(notFound.status).toBe(404);
    expect(notFound.headers['x-agentboard-version']).toBe(serverPkg.version);
  });
});
