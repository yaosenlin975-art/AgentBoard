/**
 * P1-C：personas 域 REST 契约测试。
 * 覆盖：CRUD 全路径（POST 校验 / PATCH / DELETE / builtin 409 / 404）、列表倒序、
 * GET /api/cli-capabilities（未安装 CLI 时全 false 不报错、未知 adapter 400）。
 *
 * 配置隔离照 settings.test.ts：APPDATA 指向临时目录，afterEach 恢复。
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import type { AgentAdapter } from '@agentboard/adapters';
import { createTestDb, type TestDb } from './helpers.js';
import { FakeAdapter } from './fakeAdapter.js';
import { createApp, type CreatedApp } from '../src/index.js';
import { resetSessionManager } from '../src/services/sessionManager.js';
import { createPersona } from '../src/db/repos/persona.js';

let t: TestDb;
let app: Express;
let created: CreatedApp;
let spaceDir: string;
let cfgDir: string;
let savedAppData: string | undefined;

function fakeResolver(id: string): AgentAdapter {
  if (id === 'fake' || id === 'codebuddy') return new FakeAdapter();
  throw new Error(`未知适配器 id: ${id}`);
}

beforeEach(async () => {
  t = createTestDb();
  spaceDir = mkdtempSync(join(tmpdir(), 'agentboard-space-'));
  savedAppData = process.env.APPDATA;
  cfgDir = mkdtempSync(join(tmpdir(), 'agentboard-cfg-'));
  process.env.APPDATA = cfgDir;
  created = await createApp({ db: t.db, getAdapter: fakeResolver, adapters: [new FakeAdapter()], maxConcurrentTurns: 3 });
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

describe('POST /api/personas', () => {
  it('创建 user persona：id 为 uuid、source=user、description 缺省空串', async () => {
    const res = await request(app).post('/api/personas').send({ name: '严谨审查', body_md: '只输出事实' });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ name: '严谨审查', description: '', body_md: '只输出事实', source: 'user', package_path: null });
    expect(res.body.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(typeof res.body.created_at).toBe('number');
  });

  it('description 显式空串合法；缺 body_md / name → 400', async () => {
    const ok = await request(app).post('/api/personas').send({ name: 'n', description: '', body_md: 'b' });
    expect(ok.status).toBe(200);
    expect(ok.body.description).toBe('');
    const noBody = await request(app).post('/api/personas').send({ name: 'n' });
    expect(noBody.status).toBe(400);
    const noName = await request(app).post('/api/personas').send({ body_md: 'b' });
    expect(noName.status).toBe(400);
    const emptyName = await request(app).post('/api/personas').send({ name: '  ', body_md: 'b' });
    expect(emptyName.status).toBe(400);
  });
});

describe('GET /api/personas', () => {
  it('列表按 created_at 倒序（新建在前），含 body_md', async () => {
    await request(app).post('/api/personas').send({ name: 'first', body_md: 'b1' });
    await request(app).post('/api/personas').send({ name: 'second', body_md: 'b2' });
    const res = await request(app).get('/api/personas');
    expect(res.status).toBe(200);
    expect(res.body.map((p: { name: string }) => p.name)).toEqual(['second', 'first']);
    expect(res.body[0]).toMatchObject({ body_md: 'b2' });
  });

  it('空表返回空数组', async () => {
    const res = await request(app).get('/api/personas');
    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
  });
});

describe('PATCH /api/personas/:id', () => {
  it('user persona 可改 name/description/body_md', async () => {
    const createdRow = (await request(app).post('/api/personas').send({ name: 'n', description: 'd', body_md: 'b' })).body;
    const res = await request(app).patch(`/api/personas/${createdRow.id}`).send({ name: 'n2', body_md: 'b2' });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ name: 'n2', description: 'd', body_md: 'b2' });
  });

  it('builtin → 409；不存在 → 404；无字段 → 400', async () => {
    const builtin = createPersona(t.db, { name: '内置', body_md: 'b', source: 'builtin' });
    const patchRes = await request(app).patch(`/api/personas/${builtin.id}`).send({ name: 'x' });
    expect(patchRes.status).toBe(409);
    const missing = await request(app).patch('/api/personas/00000000-0000-4000-8000-000000000000').send({ name: 'x' });
    expect(missing.status).toBe(404);
    const user = (await request(app).post('/api/personas').send({ name: 'n', body_md: 'b' })).body;
    const empty = await request(app).patch(`/api/personas/${user.id}`).send({});
    expect(empty.status).toBe(400);
  });
});

describe('DELETE /api/personas/:id', () => {
  it('user persona 可删（204），列表同步剔除', async () => {
    const user = (await request(app).post('/api/personas').send({ name: 'n', body_md: 'b' })).body;
    const res = await request(app).delete(`/api/personas/${user.id}`);
    expect(res.status).toBe(204);
    const list = await request(app).get('/api/personas');
    expect(list.body).toEqual([]);
  });

  it('builtin → 409；不存在 → 404', async () => {
    const builtin = createPersona(t.db, { name: '内置', body_md: 'b', source: 'builtin' });
    const res = await request(app).delete(`/api/personas/${builtin.id}`);
    expect(res.status).toBe(409);
    const missing = await request(app).delete('/api/personas/00000000-0000-4000-8000-000000000000');
    expect(missing.status).toBe(404);
  });
});

describe('GET /api/cli-capabilities', () => {
  // 真实 spawn `<命令> --help`（adapters 侧 5s 探测超时 + win32 垫片解析），负载下可能贴近上限 → 放宽用例超时
  it('已注册 adapter → 200 能力形状（CLI 未安装时全 false，不报错）', { timeout: 30_000 }, async () => {
    const res = await request(app).get('/api/cli-capabilities?adapter=codebuddy');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ adapter: 'codebuddy', command: 'codebuddy', personaFlag: expect.any(Boolean), toolFlags: expect.any(Boolean), permissionFlags: expect.any(Array) });
  });

  it('缺 adapter 参数 / 未知 adapter → 400', async () => {
    const missing = await request(app).get('/api/cli-capabilities');
    expect(missing.status).toBe(400);
    const unknown = await request(app).get('/api/cli-capabilities?adapter=nope');
    expect(unknown.status).toBe(400);
  });
});
