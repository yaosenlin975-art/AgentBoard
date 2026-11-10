/**
 * P3-C：专家包导入（createApp 真起 app，断言端点非 404、整包落库、非法包不半写、重复导入 409）。
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import type { AgentAdapter } from '@agentboard/adapters';
import { createTestDb, type TestDb } from './helpers.js';
import { FakeAdapter } from './fakeAdapter.js';
import { createApp } from '../src/index.js';
import { resetSessionManager } from '../src/services/sessionManager.js';

let t: TestDb;
let adapter: FakeAdapter;
let app: Express;
let spaceDir: string;
let pkgRoot: string;

function fakeResolver(id: string): AgentAdapter {
  if (id === 'codebuddy') return adapter;
  throw new Error(`未知适配器 id: ${id}`);
}

beforeEach(async () => {
  t = createTestDb();
  adapter = new FakeAdapter();
  spaceDir = mkdtempSync(join(tmpdir(), 'agentboard-pkg-space-'));
  pkgRoot = mkdtempSync(join(tmpdir(), 'agentboard-pkg-'));
  execFileSync('git', ['init', '-q'], { cwd: spaceDir, windowsHide: true });
  const created = await createApp({ db: t.db, getAdapter: fakeResolver, adapters: [adapter], maxConcurrentTurns: 3 });
  app = created.app;
});

afterEach(() => {
  resetSessionManager();
  t.cleanup();
  rmSync(spaceDir, { recursive: true, force: true });
  rmSync(pkgRoot, { recursive: true, force: true });
});

async function mkSpace(name = 'pkg-space'): Promise<string> {
  const res = await request(app).post('/api/workspaces').send({ name, path: spaceDir });
  expect(res.status).toBe(200);
  return (res.body as { id: string }).id;
}

function countRows(table: 'personas' | 'teams' | 'team_members'): number {
  return (t.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
}

/**
 * 最小夹具专家包：1 个 plugin.json（team + teamInfo.leadAgent）+ 1 个 agents/*.md + settings.json。
 */
function writePackage(dirName: string, overrides: { plugin?: unknown; agent?: string; settings?: unknown } = {}): string {
  const dir = join(pkgRoot, dirName);
  mkdirSync(join(dir, 'agents'), { recursive: true });
  const plugin = overrides.plugin ?? {
    name: '质量专家组',
    expertType: 'team',
    teamInfo: { leadAgent: 'architect' },
  };
  writeFileSync(join(dir, 'plugin.json'), typeof plugin === 'string' ? plugin : JSON.stringify(plugin), 'utf8');
  writeFileSync(
    join(dir, 'agents', 'architect.md'),
    overrides.agent ??
      ['---', 'name: architect', 'displayName: 架构师', 'profession: 架构', 'description: 负责系统设计', '---', '', '你是资深架构师，负责技术方案与评审。', ''].join('\n'),
    'utf8',
  );
  writeFileSync(join(dir, 'settings.json'), JSON.stringify(overrides.settings ?? { maxTurns: 5 }), 'utf8');
  return dir;
}

async function importPackage(workspaceId: string, path: string) {
  return request(app).post('/api/expert-packages/import').send({ workspace_id: workspaceId, path });
}

describe('专家包导入（P3-C）', () => {
  it('最小专家包导入：personas 新增 1 行（source=import）、teams 新增 1 行并含成员', async () => {
    const wsId = await mkSpace();
    const dir = writePackage('quality-team');

    const res = await importPackage(wsId, dir);
    expect(res.status).toBe(201);
    const body = res.body as {
      package: { name: string; type: string };
      personas: Array<{ id: string; name: string }>;
      team: { id: string; name: string; status: string; max_turns_per_member: number; members: Array<{ agent_name: string; role: string; session: unknown }> };
    };
    expect(body.package).toMatchObject({ name: '质量专家组', type: 'team' });
    expect(body.personas).toHaveLength(1);
    expect(body.team.members).toHaveLength(1);
    expect(body.team.members[0]).toMatchObject({ agent_name: '架构师', role: '架构', session: null });
    expect(body.team.max_turns_per_member).toBe(5);

    // 落库读数（卡验收可复算）
    expect(countRows('personas')).toBe(1);
    expect(countRows('teams')).toBe(1);
    expect(countRows('team_members')).toBe(1);
    const personaRow = t.db.prepare("SELECT name, source, package_path FROM personas WHERE id = ?").get(body.personas[0]!.id) as {
      name: string;
      source: string;
      package_path: string;
    };
    expect(personaRow).toMatchObject({ name: '架构师', source: 'import', package_path: dir });

    // 外部可触达：既有 personas / teams 列表接口能读到导入结果（非 404）
    const personas = await request(app).get('/api/personas');
    expect(personas.status).toBe(200);
    expect((personas.body as Array<{ id: string }>).map((row) => row.id)).toContain(body.personas[0]!.id);

    const teams = await request(app).get(`/api/teams?workspace=${wsId}`);
    expect(teams.status).toBe(200);
    const teamRows = teams.body as Array<{ id: string; members: Array<{ persona_id?: string | null }> }>;
    expect(teamRows.map((row) => row.id)).toEqual([body.team.id]);
  });

  it('坏 JSON / 缺 frontmatter name：400 且 personas、teams 行数不变（先校验后写）', async () => {
    const wsId = await mkSpace();
    const badJson = writePackage('bad-json', { plugin: '{ not json' });
    expect((await importPackage(wsId, badJson)).status).toBe(400);

    const noName = writePackage('no-name', { agent: ['---', 'displayName: 无名', '---', '', '正文', ''].join('\n') });
    expect((await importPackage(wsId, noName)).status).toBe(400);

    const missingDir = join(pkgRoot, 'not-exists');
    expect((await importPackage(wsId, missingDir)).status).toBe(400);

    expect(countRows('personas')).toBe(0);
    expect(countRows('teams')).toBe(0);
    expect(countRows('team_members')).toBe(0);
  });

  it('重复导入：同目录与同名不同目录都 409，不产生重复行', async () => {
    const wsId = await mkSpace();
    const dir = writePackage('quality-team');
    expect((await importPackage(wsId, dir)).status).toBe(201);

    const again = await importPackage(wsId, dir);
    expect(again.status).toBe(409);
    expect((again.body as { error: { message: string } }).error.message).toContain('已导入');

    const sameName = writePackage('quality-team-copy', {
      plugin: { name: '质量专家组', expertType: 'team', teamInfo: { leadAgent: 'architect2' } },
      agent: ['---', 'name: architect2', '---', '', '另一个专家', ''].join('\n'),
    });
    const conflict = await importPackage(wsId, sameName);
    expect(conflict.status).toBe(409);
    expect((conflict.body as { error: { message: string } }).error.message).toContain('同名专家包');

    expect(countRows('personas')).toBe(1);
    expect(countRows('teams')).toBe(1);
  });

  it('teamInfo 引用不存在的专家：400 整包拒绝', async () => {
    const wsId = await mkSpace();
    const dir = writePackage('bad-team', {
      plugin: { name: '坏团队', expertType: 'team', teamInfo: { leadAgent: 'architect', memberAgents: ['ghost'] } },
    });
    const res = await importPackage(wsId, dir);
    expect(res.status).toBe(400);
    expect((res.body as { error: { message: string } }).error.message).toContain('ghost');
    expect(countRows('personas')).toBe(0);
    expect(countRows('teams')).toBe(0);
  });
});
