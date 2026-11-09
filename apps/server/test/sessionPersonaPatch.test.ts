/**
 * P1-C：PATCH /api/sessions/:id 的 persona 注入四字段契约测试。
 * 覆盖：四字段持久化 + GET 回读、API PATCH → runTurn 装配、null 清空、悬空 persona_id 400、
 * 非法 persona_injection 400、与 paused 互斥、字段全缺 400、file marker 删除回收。
 */
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
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
import { settle } from './fakeAdapter.js';

let t: TestDb;
let app: Express;
let created: CreatedApp;
let spaceDir: string;
let cfgDir: string;
let savedAppData: string | undefined;
let adapter: FakeAdapter;

function fakeResolver(id: string): AgentAdapter {
  if (id === 'fake' || id === 'codebuddy') return adapter;
  throw new Error(`未知适配器 id: ${id}`);
}

async function mkSpace(): Promise<string> {
  const res = await request(app).post('/api/workspaces').send({ name: 'demo', path: spaceDir });
  expect(res.status).toBe(200);
  return res.body.id as string;
}

async function mkPersona(name = '审查者'): Promise<{ id: string }> {
  const res = await request(app).post('/api/personas').send({ name, body_md: `${name} 正文` });
  expect(res.status).toBe(200);
  return res.body as { id: string };
}

async function mkSession(workspaceId: string): Promise<{ id: string }> {
  const res = await request(app).post('/api/sessions').send({ cli: 'fake', workspace_id: workspaceId });
  expect(res.status).toBe(200);
  return res.body as { id: string };
}

const TOOL_POLICY = { approval_mode: 'plan', allow: ['Read', 'Grep'], deny: ['Bash'] };
const SKILL_POLICY = { allow: ['kb-*'], deny: [] as string[] };

beforeEach(async () => {
  t = createTestDb();
  adapter = new FakeAdapter();
  spaceDir = mkdtempSync(join(tmpdir(), 'agentboard-space-'));
  savedAppData = process.env.APPDATA;
  cfgDir = mkdtempSync(join(tmpdir(), 'agentboard-cfg-'));
  process.env.APPDATA = cfgDir;
  created = await createApp({ db: t.db, getAdapter: fakeResolver, adapters: [adapter], maxConcurrentTurns: 3 });
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

describe('PATCH /api/sessions/:id persona 四字段', () => {
  it('四字段写入持久化，GET 回读（tool/skill policy 存 JSON 字符串列）', async () => {
    const wsId = await mkSpace();
    const persona = await mkPersona();
    const session = await mkSession(wsId);
    const patchRes = await request(app).patch(`/api/sessions/${session.id}`).send({
      persona_id: persona.id,
      tool_policy: TOOL_POLICY,
      skill_policy: SKILL_POLICY,
      persona_injection: 'file',
    });
    expect(patchRes.status).toBe(200);
    expect(patchRes.body).toMatchObject({
      persona_id: persona.id,
      tool_policy: JSON.stringify(TOOL_POLICY),
      skill_policy: JSON.stringify(SKILL_POLICY),
      persona_injection: 'file',
    });
    const got = await request(app).get(`/api/sessions/${session.id}`);
    expect(got.status).toBe(200);
    expect(got.body).toMatchObject({
      persona_id: persona.id,
      tool_policy: JSON.stringify(TOOL_POLICY),
      skill_policy: JSON.stringify(SKILL_POLICY),
      persona_injection: 'file',
    });
  });

  it('null 清空：persona_id/tool_policy/skill_policy/persona_injection 回到未设置', async () => {
    const wsId = await mkSpace();
    const persona = await mkPersona();
    const session = await mkSession(wsId);
    await request(app).patch(`/api/sessions/${session.id}`).send({
      persona_id: persona.id,
      tool_policy: TOOL_POLICY,
      skill_policy: SKILL_POLICY,
      persona_injection: 'flag',
    });
    const res = await request(app).patch(`/api/sessions/${session.id}`).send({
      persona_id: null,
      tool_policy: null,
      skill_policy: null,
      persona_injection: null,
    });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ persona_id: null, tool_policy: null, skill_policy: null, persona_injection: null });
  });

  it('悬空 persona_id → 400；非法 persona_injection → 400；tool_policy 形状错 → 400', async () => {
    const wsId = await mkSpace();
    const session = await mkSession(wsId);
    const dangling = await request(app).patch(`/api/sessions/${session.id}`).send({
      persona_id: '00000000-0000-4000-8000-000000000000',
    });
    expect(dangling.status).toBe(400);
    const badInjection = await request(app).patch(`/api/sessions/${session.id}`).send({ persona_injection: 'yolo' });
    expect(badInjection.status).toBe(400);
    const badPolicy = await request(app).patch(`/api/sessions/${session.id}`).send({ tool_policy: { approval_mode: 'yolo', allow: [], deny: [] } });
    expect(badPolicy.status).toBe(400);
  });

  it('与既有契约共存：单独 model 仍可改；paused 与 persona 字段互斥；全缺 → 400', async () => {
    const wsId = await mkSpace();
    const session = await mkSession(wsId);
    const model = await request(app).patch(`/api/sessions/${session.id}`).send({ model: 'm2' });
    expect(model.status).toBe(200);
    expect(model.body.model).toBe('m2');
    const persona = await mkPersona();
    const mixedPaused = await request(app).patch(`/api/sessions/${session.id}`).send({ paused: true, persona_id: persona.id });
    expect(mixedPaused.status).toBe(400);
    const empty = await request(app).patch(`/api/sessions/${session.id}`).send({});
    expect(empty.status).toBe(400);
  });

  it('接线：API PATCH 设置 persona/flag 后，消息起轮的 runTurn options 收到配置', async () => {
    const wsId = await mkSpace();
    const persona = await mkPersona();
    const session = await mkSession(wsId);
    const patchRes = await request(app).patch(`/api/sessions/${session.id}`).send({
      persona_id: persona.id,
      persona_injection: 'flag',
      tool_policy: TOOL_POLICY,
    });
    expect(patchRes.status).toBe(200);

    const sendRes = await request(app).post(`/api/sessions/${session.id}/messages`).send({ text: '按 API 配置起轮' });
    expect(sendRes.status).toBe(200);
    await settle();

    expect(adapter.calls).toHaveLength(1);
    expect(adapter.calls[0]!.persona).toEqual({ id: persona.id, body: '审查者 正文', source: 'user' });
    expect(adapter.calls[0]!.personaInjection).toBe('flag');
    expect(adapter.calls[0]!.toolPolicy).toEqual(TOOL_POLICY);
  });

  it('接线：file 模式起轮写入的工作区标记块随会话删除回收（DELETE /api/sessions/:id）', async () => {
    const wsId = await mkSpace();
    const persona = await mkPersona();
    const session = await mkSession(wsId);
    await request(app).patch(`/api/sessions/${session.id}`).send({ persona_id: persona.id, persona_injection: 'file' });
    const sendRes = await request(app).post(`/api/sessions/${session.id}/messages`).send({ text: '起一轮写标记块' });
    expect(sendRes.status).toBe(200);
    await settle();
    const blockFile = join(spaceDir, 'AGENTS.md');
    expect(existsSync(blockFile)).toBe(true);
    expect(readFileSync(blockFile, 'utf8')).toContain(`AGENTBOARD-SESSION:${session.id}`);
    expect(adapter.calls).toHaveLength(1);
    expect(adapter.calls[0]!.persona).toBeUndefined();
    expect(adapter.calls[0]!.personaInjection).toBe('file');
    const delRes = await request(app).delete(`/api/sessions/${session.id}`);
    expect(delRes.status).toBe(204);
    // 文件只承载过本会话块 → 删除后回收文件
    expect(existsSync(blockFile)).toBe(false);
  });
});
