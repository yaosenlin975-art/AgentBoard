/**
 * CLI-DEFAULT-MODEL-1：settings 的 cliDefaultModels 读写契约测试（issue 8054ee9b）。
 * RULE-3：起真 createApp 断言 GET/PATCH /api/settings；adapter 注册表用注入 stub
 * （codex=清单非空 / opencode=清单为空 / dsh=模型由 profile 决定），不依赖真实 CLI。
 * 配置隔离沿用 settings.test.ts 口径：APPDATA 指向临时目录。
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import type { AgentAdapter } from '@agentboard/adapters';
import type { ModelInfo } from '@agentboard/shared';
import { createTestDb, type TestDb } from './helpers.js';
import { createApp } from '../src/index.js';
import { configDir, configFilePath, configuredModelFor } from '../src/config.js';
import { resetSessionManager } from '../src/services/sessionManager.js';

/** 可数 stub adapter：listModels 可编程、计调用次数 */
function stubAdapter(id: 'codex' | 'dsh' | 'opencode', models: ModelInfo[], supportsModelSelection = true): AgentAdapter & { listCalls: number } {
  let listCalls = 0;
  return {
    id,
    displayName: id,
    supportsModelSelection,
    supportsImageInput: () => false,
    async detect() {
      return { installed: true, version: 'stub-1.0' };
    },
    async listModels() {
      listCalls += 1;
      return models;
    },
    runTurn() {
      throw new Error('本测试不使用 runTurn');
    },
    get listCalls() {
      return listCalls;
    },
  };
}

let t: TestDb;
let app: Express;
let cfgDir: string;
let savedAppData: string | undefined;
let codex: ReturnType<typeof stubAdapter>;
let dsh: ReturnType<typeof stubAdapter>;
let opencode: ReturnType<typeof stubAdapter>;

beforeEach(async () => {
  t = createTestDb();
  codex = stubAdapter('codex', [
    { id: 'gpt-5', source: 'static' },
    { id: 'gpt-5-codex', source: 'static' },
  ]);
  dsh = stubAdapter('dsh', [], false);
  opencode = stubAdapter('opencode', []);
  const byId = new Map<string, AgentAdapter>([
    ['codex', codex],
    ['dsh', dsh],
    ['opencode', opencode],
  ]);
  const resolver = (id: string): AgentAdapter => {
    const adapter = byId.get(id);
    if (!adapter) throw new Error(`未知适配器 id: ${id}`);
    return adapter;
  };
  savedAppData = process.env.APPDATA;
  cfgDir = mkdtempSync(join(tmpdir(), 'agentboard-cfg-'));
  process.env.APPDATA = cfgDir;
  const created = await createApp({
    db: t.db,
    getAdapter: resolver,
    adapters: [codex, dsh, opencode],
    maxConcurrentTurns: 3,
  });
  app = created.app;
});

afterEach(() => {
  resetSessionManager();
  t.cleanup();
  if (savedAppData === undefined) delete process.env.APPDATA;
  else process.env.APPDATA = savedAppData;
  rmSync(cfgDir, { recursive: true, force: true });
});

function writeConfigFile(value: Record<string, unknown>): void {
  mkdirSync(configDir(), { recursive: true });
  writeFileSync(configFilePath(), JSON.stringify(value), 'utf8');
}

describe('GET /api/settings · cliDefaultModels', () => {
  it('旧配置无字段 → {}，且响应没有 defaultModel', async () => {
    writeConfigFile({ port: 8787 });
    const res = await request(app).get('/api/settings');
    expect(res.status).toBe(200);
    expect(res.body.cliDefaultModels).toEqual({});
    expect(res.body.defaultModel).toBeUndefined();
  });

  it('历史非法值（字符串）读侧丢弃 → {}，不 500', async () => {
    writeConfigFile({ cliDefaultModels: 'oops' });
    const res = await request(app).get('/api/settings');
    expect(res.status).toBe(200);
    expect(res.body.cliDefaultModels).toEqual({});
  });
});

describe('PATCH /api/settings · cliDefaultModels', () => {
  it('清单内模型 → 200；再 PATCH 另一 CLI，既有键仍在（按键合并）；GET 回读一致', async () => {
    const first = await request(app).patch('/api/settings').send({ cliDefaultModels: { codex: 'gpt-5' } });
    expect(first.status).toBe(200);
    expect(first.body.cliDefaultModels).toEqual({ codex: 'gpt-5' });

    const second = await request(app).patch('/api/settings').send({ cliDefaultModels: { opencode: 'm2' } });
    expect(second.status).toBe(200);
    expect(second.body.cliDefaultModels).toEqual({ codex: 'gpt-5', opencode: 'm2' });

    const got = await request(app).get('/api/settings');
    expect(got.body.cliDefaultModels).toEqual({ codex: 'gpt-5', opencode: 'm2' });
  });

  it('空串删键 → 200，该键被删除且其余键保留', async () => {
    await request(app).patch('/api/settings').send({ cliDefaultModels: { codex: 'gpt-5', opencode: 'm2' } });
    const res = await request(app).patch('/api/settings').send({ cliDefaultModels: { codex: '' } });
    expect(res.status).toBe(200);
    expect(res.body.cliDefaultModels).toEqual({ opencode: 'm2' });
    const got = await request(app).get('/api/settings');
    expect(got.body.cliDefaultModels).toEqual({ opencode: 'm2' });
  });

  it('dsh（模型由 profile 决定）与未知 CLI → 400 VALIDATION_ERROR，且不落盘', async () => {
    for (const body of [{ cliDefaultModels: { dsh: 'x' } }, { cliDefaultModels: { nope: 'x' } }]) {
      const res = await request(app).patch('/api/settings').send(body);
      expect(res.status, `body=${JSON.stringify(body)}`).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_ERROR');
    }
    const dshRes = await request(app).patch('/api/settings').send({ cliDefaultModels: { dsh: 'x' } });
    expect(dshRes.body.error.message).toContain('该 CLI 的模型由 profile 配置决定');
    const got = await request(app).get('/api/settings');
    expect(got.body.cliDefaultModels).toEqual({});
  });

  it('清单外模型 → 422 MODEL_UNAVAILABLE，未写入；listModels 恰好调用一次', async () => {
    const res = await request(app).patch('/api/settings').send({ cliDefaultModels: { codex: 'bogus-model' } });
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('MODEL_UNAVAILABLE');
    expect(codex.listCalls).toBe(1);
    const got = await request(app).get('/api/settings');
    expect(got.body.cliDefaultModels).toEqual({});
  });

  it('清单为空（listModels 返回 []）→ 允许保存 200', async () => {
    const res = await request(app).patch('/api/settings').send({ cliDefaultModels: { opencode: 'any-model' } });
    expect(res.status).toBe(200);
    expect(res.body.cliDefaultModels).toEqual({ opencode: 'any-model' });
  });

  it('值 trim 后超 100 字符 → 400 VALIDATION_ERROR', async () => {
    const res = await request(app).patch('/api/settings').send({ cliDefaultModels: { codex: 'x'.repeat(101) } });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });
});

describe('configuredModelFor', () => {
  it('配置 → 值；未配置 → null；空串 → null（读侧丢弃）', () => {
    writeConfigFile({ cliDefaultModels: { codex: 'gpt-5', opencode: '' } });
    expect(configuredModelFor('codex')).toBe('gpt-5');
    expect(configuredModelFor('opencode')).toBeNull();
    expect(configuredModelFor('dsh')).toBeNull();
  });

  it('未写配置文件 → null', () => {
    expect(configuredModelFor('codex')).toBeNull();
  });
});
