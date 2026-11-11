/**
 * CLI-DEFAULT-MODEL-2：新建会话与派发的 model 解析契约测试（issue b6463245）。
 * RULE-3：起真 createApp 断言 POST /api/sessions（自由会话 + 绑 issue 派发两条分支）。
 * 优先级写死：body.model（显式）> settings.cliDefaultModels[cli] > null；无第三级回落，
 * 校验失败 422 MODEL_UNAVAILABLE 且不建会话。配置隔离沿用 settingsCliModels.test.ts 口径
 * （APPDATA 指向临时目录 + 直写 config.json；直写可绕过设置侧校验，正好覆盖运行时兜底）。
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import type { AgentAdapter } from '@agentboard/adapters';
import { createTestDb, type TestDb } from './helpers.js';
import { FakeAdapter } from './fakeAdapter.js';
import { createApp } from '../src/index.js';
import { configDir, configFilePath } from '../src/config.js';
import { resetSessionManager } from '../src/services/sessionManager.js';

let t: TestDb;
let adapter: FakeAdapter;
let app: Express;
let spaceDir: string;
let cfgDir: string;
let savedAppData: string | undefined;

function fakeResolver(id: string): AgentAdapter {
  if (id === 'fake' || id === 'codebuddy') return adapter;
  if (id === 'nomodel') {
    return Object.assign(Object.create(Object.getPrototypeOf(adapter)), {
      id: 'nomodel',
      supportsModelSelection: false,
      displayName: 'nomodel',
    }) as unknown as AgentAdapter;
  }
  throw new Error(`未知适配器 id: ${id}`);
}

function writeConfigCliDefault(cli: string, model: string): void {
  mkdirSync(configDir(), { recursive: true });
  writeFileSync(configFilePath(), JSON.stringify({ cliDefaultModels: { [cli]: model } }), 'utf8');
}

beforeEach(async () => {
  t = createTestDb();
  adapter = new FakeAdapter();
  spaceDir = mkdtempSync(join(tmpdir(), 'agentboard-space-'));
  execFileSync('git', ['init', '-q'], { cwd: spaceDir, windowsHide: true });
  savedAppData = process.env.APPDATA;
  cfgDir = mkdtempSync(join(tmpdir(), 'agentboard-cfg-'));
  process.env.APPDATA = cfgDir;
  const created = await createApp({ db: t.db, getAdapter: fakeResolver, adapters: [adapter], maxConcurrentTurns: 3 });
  app = created.app;
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

async function mkSpace(name = 'demo'): Promise<string> {
  const res = await request(app).post('/api/workspaces').send({ name, path: spaceDir });
  expect(res.status).toBe(200);
  return res.body.id as string;
}

async function mkIssue(workspaceId: string, title = '任务'): Promise<string> {
  const res = await request(app)
    .post('/api/issues')
    .send({ workspace_id: workspaceId, title, description: '描述', priority: '高' });
  expect(res.status).toBe(200);
  return res.body.id as string;
}

describe('POST /api/sessions · model 解析优先级（自由会话分支）', () => {
  it('未配置：model:null → 落库 null（使用 CLI 自身默认）', async () => {
    const workspaceId = await mkSpace();
    const res = await request(app)
      .post('/api/sessions')
      .send({ cli: 'codebuddy', model: null, workspace_id: workspaceId, prompt: '闲聊' });
    expect(res.status).toBe(200);
    expect(res.body.model).toBeNull();
    const got = await request(app).get(`/api/sessions/${res.body.id}`);
    expect(got.body.model).toBeNull();
  });

  it('配置清单内模型：不带 model → 用配置值，回读一致', async () => {
    vi.spyOn(adapter, 'listModels').mockResolvedValue([
      { id: 'm1', source: 'static' },
      { id: 'm2', source: 'static' },
    ]);
    writeConfigCliDefault('codebuddy', 'm1');
    const workspaceId = await mkSpace();
    const res = await request(app)
      .post('/api/sessions')
      .send({ cli: 'codebuddy', workspace_id: workspaceId, prompt: '闲聊' });
    expect(res.status).toBe(200);
    expect(res.body.model).toBe('m1');
    const got = await request(app).get(`/api/sessions/${res.body.id}`);
    expect(got.body.model).toBe('m1');
  });

  it('显式 model 覆盖配置值', async () => {
    vi.spyOn(adapter, 'listModels').mockResolvedValue([
      { id: 'm1', source: 'static' },
      { id: 'm2', source: 'static' },
    ]);
    writeConfigCliDefault('codebuddy', 'm1');
    const workspaceId = await mkSpace();
    const res = await request(app)
      .post('/api/sessions')
      .send({ cli: 'codebuddy', model: 'm2', workspace_id: workspaceId, prompt: '闲聊' });
    expect(res.status).toBe(200);
    expect(res.body.model).toBe('m2');
  });

  it('清单为空（探测不到模型清单）→ 按配置值落库（200），由 CLI 运行时自行失败', async () => {
    writeConfigCliDefault('codebuddy', 'm1');
    const workspaceId = await mkSpace();
    const res = await request(app)
      .post('/api/sessions')
      .send({ cli: 'codebuddy', workspace_id: workspaceId, prompt: '闲聊' });
    expect(res.status).toBe(200);
    expect(res.body.model).toBe('m1');
  });
});

describe('POST /api/sessions · 不降级（422 MODEL_UNAVAILABLE 且不建会话）', () => {
  it('配置值不在 listModels 清单（直写 config.json 绕过设置校验）→ 422，会话列表条数不变', async () => {
    vi.spyOn(adapter, 'listModels').mockResolvedValue([{ id: 'm1', source: 'static' }]);
    writeConfigCliDefault('codebuddy', 'mX');
    const workspaceId = await mkSpace();
    const before = await request(app).get(`/api/sessions?workspace_id=${workspaceId}`);
    const res = await request(app)
      .post('/api/sessions')
      .send({ cli: 'codebuddy', workspace_id: workspaceId, prompt: '闲聊' });
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('MODEL_UNAVAILABLE');
    const after = await request(app).get(`/api/sessions?workspace_id=${workspaceId}`);
    expect(after.body.length ?? after.body.items?.length ?? 0).toBe(before.body.length ?? before.body.items?.length ?? 0);
  });

  it('显式 model 不在清单 → 422', async () => {
    vi.spyOn(adapter, 'listModels').mockResolvedValue([{ id: 'm1', source: 'static' }]);
    const workspaceId = await mkSpace();
    const res = await request(app)
      .post('/api/sessions')
      .send({ cli: 'codebuddy', model: 'mY', workspace_id: workspaceId, prompt: '闲聊' });
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('MODEL_UNAVAILABLE');
  });

  it('supportsModelSelection=false 的 CLI：显式带 model → 422；配置了默认 → 422', async () => {
    const workspaceId = await mkSpace();
    const explicit = await request(app)
      .post('/api/sessions')
      .send({ cli: 'nomodel', model: 'm1', workspace_id: workspaceId, prompt: '闲聊' });
    expect(explicit.status).toBe(422);
    expect(explicit.body.error.code).toBe('MODEL_UNAVAILABLE');

    writeConfigCliDefault('nomodel', 'm1');
    const configured = await request(app)
      .post('/api/sessions')
      .send({ cli: 'nomodel', workspace_id: workspaceId, prompt: '闲聊' });
    expect(configured.status).toBe(422);
    expect(configured.body.error.code).toBe('MODEL_UNAVAILABLE');
  });
});

describe('POST /api/sessions · 设置变更与派发分支', () => {
  it('改配置后，既有 model 非空会话不变', async () => {
    writeConfigCliDefault('codebuddy', 'm1');
    const workspaceId = await mkSpace();
    const created = await request(app)
      .post('/api/sessions')
      .send({ cli: 'codebuddy', workspace_id: workspaceId, prompt: '闲聊' });
    expect(created.body.model).toBe('m1');
    writeConfigCliDefault('codebuddy', 'm2');
    const got = await request(app).get(`/api/sessions/${created.body.id}`);
    expect(got.body.model).toBe('m1');
  });

  it('绑 issue 的派发分支同样生效：配置 m1 → 会话带 m1；不合法配置 → 422 且不占用 issue', async () => {
    const workspaceId = await mkSpace();
    const issueId = await mkIssue(workspaceId);
    writeConfigCliDefault('codebuddy', 'm1');
    adapter.script = () => undefined; // 挂起首轮（不关心回合结果）
    const res = await request(app)
      .post('/api/sessions')
      .send({ cli: 'codebuddy', issue_id: issueId });
    expect(res.status).toBe(200);
    expect(res.body.model).toBe('m1');

    const issue2 = await mkIssue(workspaceId, '第二张');
    writeConfigCliDefault('codebuddy', 'mX');
    vi.spyOn(adapter, 'listModels').mockResolvedValue([{ id: 'm1', source: 'static' }]);
    const rejected = await request(app)
      .post('/api/sessions')
      .send({ cli: 'codebuddy', issue_id: issue2 });
    expect(rejected.status).toBe(422);
    const issue2After = await request(app).get(`/api/issues/${issue2}`);
    expect(issue2After.body.claimed_by ?? null).toBeNull();
  });
});
