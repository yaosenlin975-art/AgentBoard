/**
 * PERSONA-LIB：POST /api/personas/draft 契约测试（RULE-3 接线自证）。
 * 用真 createApp 起 app + 注入 draftRunner，证明端点在真实路由树上可被外部调用：
 * 成功返回结构化草稿且不落库；空描述 400；适配器不可用 503；调用失败 502；
 * 结构不合法重试后 422；超时 504。
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import type { AgentAdapter, TurnResult } from '@agentboard/adapters';
import { createTestDb, type TestDb } from './helpers.js';
import { FakeAdapter } from './fakeAdapter.js';
import { createApp, type CreatedApp } from '../src/index.js';
import { defaultDraftRunner } from '../src/api/routes/issueRoutes.js';
import { resetSessionManager } from '../src/services/sessionManager.js';
import type { DraftRunner } from '../src/services/smartCreateDraft.js';

let t: TestDb;
let app: Express;
let created: CreatedApp;
let cfgDir: string;
let savedAppData: string | undefined;

function fakeResolver(id: string): AgentAdapter {
  if (id === 'codebuddy') return new FakeAdapter();
  throw new Error(`未知适配器 id: ${id}`);
}

function makeApp(runner: DraftRunner, timeoutMs?: number): Promise<CreatedApp> {
  return createApp({
    db: t.db,
    getAdapter: fakeResolver,
    adapters: [new FakeAdapter()],
    maxConcurrentTurns: 3,
    draftRunner: runner,
    ...(timeoutMs === undefined ? {} : { draftTimeoutMs: timeoutMs }),
  });
}

/** 不注入 draftRunner：走生产默认链路（getAdapter(adapter).runTurn → CLI 子进程） */
function makeDefaultApp(adapter: FakeAdapter, timeoutMs?: number): Promise<CreatedApp> {
  return createApp({
    db: t.db,
    getAdapter: (id: string): AgentAdapter => {
      if (id === adapter.id) return adapter;
      throw new Error(`未知适配器 id: ${id}`);
    },
    adapters: [adapter],
    maxConcurrentTurns: 3,
    refreshClisOnBoot: false,
    ...(timeoutMs === undefined ? {} : { draftTimeoutMs: timeoutMs }),
  });
}

const PERSONA_JSON = JSON.stringify({
  name: '技术文档编辑',
  description: '把口语化笔记改成可发布的说明',
  role: '你是严谨的技术文档编辑。',
  tone: '冷静、克制。',
  boundary: '- 不改动原意',
  domain: '发布说明与使用指南。',
  warnings: [],
});

beforeEach(() => {
  t = createTestDb();
  savedAppData = process.env.APPDATA;
  cfgDir = mkdtempSync(join(tmpdir(), 'agentboard-cfg-'));
  process.env.APPDATA = cfgDir;
});

afterEach(() => {
  resetSessionManager();
  t.cleanup();
  if (savedAppData === undefined) delete process.env.APPDATA;
  else process.env.APPDATA = savedAppData;
  rmSync(cfgDir, { recursive: true, force: true });
});

describe('POST /api/personas/draft', () => {
  it('返回结构化草稿，且不落库', async () => {
    created = await makeApp(async () => JSON.stringify({
      name: '技术文档编辑',
      description: '把口语化笔记改成可发布的说明',
      role: '你是严谨的技术文档编辑。',
      tone: '冷静、克制。',
      boundary: '- 不改动原意\n- 保留风险提示',
      domain: '发布说明与使用指南。',
      warnings: [],
    }));
    app = created.app;
    const before = (await request(app).get('/api/personas')).body.length;

    const res = await request(app)
      .post('/api/personas/draft')
      .send({ requirement: '帮我写一个改文档的人设', adapter: 'codebuddy' });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ name: '技术文档编辑', tone: '冷静、克制。' });
    expect(res.body.warnings).toEqual([]);
    const after = (await request(app).get('/api/personas')).body.length;
    expect(after).toBe(before);
  });

  it('可选段落为 null 时归一化成空串', async () => {
    created = await makeApp(async () => JSON.stringify({ name: '极简', description: null, role: '你是极简助手。', tone: null, boundary: null, domain: null, warnings: ['信息不足'] }));
    app = created.app;
    const res = await request(app).post('/api/personas/draft').send({ requirement: '极简', adapter: 'codebuddy' });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ description: '', tone: '', boundary: '', domain: '', warnings: ['信息不足'] });
  });

  it('requirement 为空 400', async () => {
    created = await makeApp(async () => '{}');
    app = created.app;
    const res = await request(app).post('/api/personas/draft').send({ requirement: '   ', adapter: 'codebuddy' });
    expect(res.status).toBe(400);
  });

  it('未知 adapter 400', async () => {
    created = await makeApp(async () => '{}');
    app = created.app;
    const res = await request(app).post('/api/personas/draft').send({ requirement: 'x', adapter: 'nope' });
    expect(res.status).toBe(400);
  });

  it('适配器不可用 503', async () => {
    created = await makeApp(async () => '{}');
    app = created.app;
    const res = await request(app).post('/api/personas/draft').send({ requirement: 'x', adapter: 'codex' });
    expect(res.status).toBe(503);
    expect(String(res.body.error?.message ?? res.body.message)).toContain('探测失败');
  });

  it('调用失败 502', async () => {
    created = await makeApp(async () => { throw new Error('boom'); });
    app = created.app;
    const res = await request(app).post('/api/personas/draft').send({ requirement: 'x', adapter: 'codebuddy' });
    expect(res.status).toBe(502);
  });

  it('两次都非法 JSON → 422', async () => {
    let calls = 0;
    created = await makeApp(async () => { calls += 1; return '不是 JSON'; });
    app = created.app;
    const res = await request(app).post('/api/personas/draft').send({ requirement: 'x', adapter: 'codebuddy' });
    expect(res.status).toBe(422);
    expect(calls).toBe(2);
  });

  it('超时 504', async () => {
    created = await makeApp(async ({ signal }) => new Promise<string>((_resolve, reject) => {
      signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
    }), 20);
    app = created.app;
    const res = await request(app).post('/api/personas/draft').send({ requirement: 'x', adapter: 'codebuddy' });
    expect(res.status).toBe(504);
  });
});

describe('POST /api/personas/draft（默认 runner，不注入）', () => {
  it('走 getAdapter(adapter).runTurn 的 CLI 通道，并带人设提示词', async () => {
    const adapter = new FakeAdapter();
    adapter.script = (control) => {
      control.emit({ type: 'text', delta: PERSONA_JSON });
      control.finish(0);
    };
    created = await makeDefaultApp(adapter);
    app = created.app;

    const res = await request(app)
      .post('/api/personas/draft')
      .send({ requirement: '把口语笔记改成发布说明', adapter: 'codebuddy' });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ name: '技术文档编辑' });
    expect(adapter.calls).toHaveLength(1);
    expect(adapter.calls[0]!.prompt).toContain('把口语笔记改成发布说明');
    expect(adapter.calls[0]!.prompt).toContain('智能体人设草稿生成器');
  });

  it('适配器不结束时按超时返回 504，而不是挂起', async () => {
    const adapter = new FakeAdapter();
    adapter.script = () => {}; // 模拟卡住的 CLI 子进程
    created = await makeDefaultApp(adapter, 30);
    app = created.app;

    const res = await request(app)
      .post('/api/personas/draft')
      .send({ requirement: 'x', adapter: 'codebuddy' });

    expect(res.status).toBe(504);
    expect(res.body.error.code).toBe('DRAFT_TIMEOUT');
  });
});

describe('defaultDraftRunner', () => {
  it('abort 后立即结算（子进程被 kill 后不回报结束也不影响）', async () => {
    // 真实 CLI 经 cmd.exe 包装时，kill 后 result 可能永不结算；这里复刻该形态，
    // 要求 abort 本身就能让调用方拿到结算，否则 504 分支不可达、请求一直挂着。
    const adapter = new FakeAdapter();
    adapter.runTurn = () => ({
      onEvent: () => {},
      kill: async () => {},
      result: new Promise<TurnResult>(() => {}),
    });
    const controller = new AbortController();
    const pending = defaultDraftRunner(() => adapter)({
      adapter: 'codebuddy',
      prompt: 'x',
      cwd: process.cwd(),
      signal: controller.signal,
    });
    const expectation = expect(pending).rejects.toThrow('草稿生成已取消');
    controller.abort();
    await expectation;
  });
});
