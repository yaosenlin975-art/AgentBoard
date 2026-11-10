/**
 * SKILLS-SYNC：设置页「一键复制配套技能」的服务端契约。
 *
 * 全部落在临时 home / 临时技能源 / 临时记录目录，不触碰真实 ~/.agents 等目录。
 * 覆盖：探测（存在/可创建/同物理目录/来源即目标）、真实复制与逐文件自检、
 * 冲突三选（overwrite / skip / backup）、移除、未知 id 与路径穿越拒绝、工作区目标。
 */
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import type { AgentAdapter } from '@agentboard/adapters';
import { createTestDb, type TestDb } from './helpers.js';
import { FakeAdapter } from './fakeAdapter.js';
import { createApp } from '../src/index.js';
import { REQUIRED_SKILLS } from '../src/services/skillsSync.js';

let t: TestDb;
let app: Express;
let home: string;
let source: string;
let stateDir: string;
let workspaceDir: string;

function writeSkill(root: string, name: string, body: string): void {
  mkdirSync(join(root, name), { recursive: true });
  writeFileSync(join(root, name, 'SKILL.md'), `---\nname: ${name}\ndescription: ${name} 测试技能\n---\n${body}\n`);
  writeFileSync(join(root, name, 'reference.md'), `${name} 附属文件\n`);
}

async function boot(options: { sourceRoot?: string } = {}): Promise<void> {
  const adapter = new FakeAdapter();
  const created = await createApp({
    db: t.db,
    getAdapter: (id: string): AgentAdapter => {
      if (id === 'fake') return adapter;
      throw new Error(`未知适配器 id: ${id}`);
    },
    adapters: [adapter],
    refreshClisOnBoot: false,
    skillsSync: { homeDir: home, sourceRoot: options.sourceRoot ?? source, stateDir },
  });
  app = created.app;
}

beforeEach(async () => {
  t = createTestDb();
  home = mkdtempSync(join(tmpdir(), 'agentboard-sync-home-'));
  source = mkdtempSync(join(tmpdir(), 'agentboard-sync-src-'));
  stateDir = mkdtempSync(join(tmpdir(), 'agentboard-sync-state-'));
  workspaceDir = mkdtempSync(join(tmpdir(), 'agentboard-sync-ws-'));
  for (const name of REQUIRED_SKILLS) writeSkill(source, name, '正文');
  // 父目录存在 → 可创建；~/.agents 也留空目录
  for (const dir of ['.claude', '.agents', '.cursor', '.qoder']) mkdirSync(join(home, dir), { recursive: true });
  // qoder 已有一个旧版本技能 → 冲突源
  mkdirSync(join(home, '.qoder', 'skills', 'using-agentboard'), { recursive: true });
  writeFileSync(join(home, '.qoder', 'skills', 'using-agentboard', 'SKILL.md'), '旧版本\n');
  await boot();
});

afterEach(() => {
  t.cleanup();
  for (const dir of [home, source, stateDir, workspaceDir]) rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
});

describe('GET /api/settings/skills-sync/targets', () => {
  it('returnsProbeStateAndDeduplicatesPhysicalDirs', async () => {
    const res = await request(app).get('/api/settings/skills-sync/targets');
    expect(res.status).toBe(200);
    const body = res.body as {
      source: { root: string; skill_count: number; file_count: number; skills: Array<{ name: string }> };
      targets: Array<{ id: string; creatable: boolean; exists: boolean; status: string; is_source: boolean; shared_with: string[]; synced_at: string | null }>;
    };
    expect(body.source.skill_count).toBe(8);
    expect(body.source.file_count).toBe(16);
    expect(body.source.root).toBe(source);
    const byId = new Map(body.targets.map((target) => [target.id, target]));
    expect(byId.get('claude')).toMatchObject({ exists: false, creatable: true, status: 'never', is_source: false });
    expect(byId.get('qoder')).toMatchObject({ exists: true, status: 'stale' });
    expect(byId.get('workspace')).toBeUndefined();
    // 未同步过 → 无时间
    expect(body.targets.every((target) => target.synced_at === null)).toBe(true);
  });

  it('listsWorkspaceTargetOnlyWithWorkspaceId', async () => {
    const created = await request(app).post('/api/workspaces').send({ name: 'sync-demo', path: workspaceDir });
    expect(created.status).toBe(200);
    const workspaceId = (created.body as { id: string }).id;
    const res = await request(app).get(`/api/settings/skills-sync/targets?workspace_id=${workspaceId}`);
    expect(res.status).toBe(200);
    const target = (res.body as { targets: Array<{ id: string; path: string; creatable: boolean }> }).targets.find((item) => item.id === 'workspace');
    expect(target).toMatchObject({ path: join(workspaceDir, '.agentboard', 'skills'), creatable: true });
    expect((await request(app).get('/api/settings/skills-sync/targets?workspace_id=missing-id')).status).toBe(404);
  });
});

describe('POST /api/settings/skills-sync', () => {
  it('copiesAllSkillsAndVerifiesFilesOnDisk', async () => {
    const res = await request(app).post('/api/settings/skills-sync').send({ target_ids: ['agents', 'claude'] });
    expect(res.status).toBe(200);
    const body = res.body as {
      results: Array<{ target_id: string; action: string; errors: unknown[]; skills: Array<{ name: string; files: number; status: string }> }>;
      summary: { copied: number; errors: number; total_files: number };
    };
    expect(body.summary).toMatchObject({ copied: 2, errors: 0, total_files: 32 });
    for (const id of ['agents', 'claude']) {
      const target = body.results.find((item) => item.target_id === id);
      expect(target?.action).toBe('copied');
      expect(target?.skills).toHaveLength(8);
      expect(target?.skills.every((skill) => skill.status === 'copied' && skill.files === 2)).toBe(true);
    }
    // 真实落盘可核对
    for (const name of REQUIRED_SKILLS) {
      const file = join(home, '.claude', 'skills', name, 'SKILL.md');
      expect(existsSync(file)).toBe(true);
      expect(readFileSync(file, 'utf8')).toContain(`${name} 测试技能`);
      expect(existsSync(join(home, '.claude', 'skills', name, 'reference.md'))).toBe(true);
    }
    // 复探：状态 synced + 记录同步时间
    const probe = await request(app).get('/api/settings/skills-sync/targets');
    const claude = (probe.body as { targets: Array<{ id: string; status: string; synced_at: string | null }> }).targets.find((item) => item.id === 'claude');
    expect(claude?.status).toBe('synced');
    expect(claude?.synced_at).not.toBeNull();
  });

  it('requiresPolicyWhenTargetDiffers', async () => {
    const res = await request(app).post('/api/settings/skills-sync').send({ target_ids: ['qoder'] });
    expect(res.status).toBe(409);
    const body = res.body as { error: { code: string; details: { conflicts: Array<{ target_id: string; skill: string }> } } };
    expect(body.error.code).toBe('SKILLS_SYNC_CONFLICT');
    expect(body.error.details.conflicts).toEqual([
      expect.objectContaining({ target_id: 'qoder', skill: 'using-agentboard' }),
    ]);
  });

  it('skipsConflictsWithSkipPolicy', async () => {
    const res = await request(app).post('/api/settings/skills-sync').send({ target_ids: ['qoder'], conflict: 'skip' });
    expect(res.status).toBe(200);
    const result = (res.body as { results: Array<{ action: string; skills: Array<{ name: string; status: string }> }> }).results[0]!;
    // 其余 7 个技能照常复制，只有冲突项被跳过
    expect(result.action).toBe('copied');
    expect(result.skills.find((skill) => skill.name === 'using-agentboard')?.status).toBe('skipped');
    expect(readFileSync(join(home, '.qoder', 'skills', 'using-agentboard', 'SKILL.md'), 'utf8')).toBe('旧版本\n');
  });

  it('backsUpThenOverwritesWithBackupPolicy', async () => {
    const res = await request(app).post('/api/settings/skills-sync').send({ target_ids: ['qoder'], conflict: 'backup' });
    expect(res.status).toBe(200);
    const result = (res.body as { results: Array<{ action: string; backup_dir: string | null; errors: unknown[] }> }).results[0]!;
    expect(result.action).toBe('copied');
    expect(result.errors).toEqual([]);
    expect(result.backup_dir).not.toBeNull();
    expect(readFileSync(join(result.backup_dir!, 'using-agentboard', 'SKILL.md'), 'utf8')).toBe('旧版本\n');
    expect(readFileSync(join(home, '.qoder', 'skills', 'using-agentboard', 'SKILL.md'), 'utf8')).toContain('using-agentboard 测试技能');
  });

  it('overwritesWithOverwritePolicy', async () => {
    const res = await request(app).post('/api/settings/skills-sync').send({ target_ids: ['qoder'], conflict: 'overwrite' });
    expect(res.status).toBe(200);
    const result = (res.body as { results: Array<{ backup_dir: string | null; skills: Array<{ name: string; status: string }> }> }).results[0]!;
    expect(result.backup_dir).toBeNull();
    expect(result.skills.find((skill) => skill.name === 'using-agentboard')?.status).toBe('overwritten');
    expect(readFileSync(join(home, '.qoder', 'skills', 'using-agentboard', 'SKILL.md'), 'utf8')).toContain('using-agentboard 测试技能');
  });

  it('rejectsPathTraversalAndUnknownTarget', async () => {
    expect((await request(app).post('/api/settings/skills-sync').send({ target_ids: ['../evil'] })).status).toBe(400);
    expect((await request(app).post('/api/settings/skills-sync').send({ target_ids: [] })).status).toBe(400);
    expect((await request(app).post('/api/settings/skills-sync').send({})).status).toBe(400);
  });

  it('neverWritesThroughJunctionSkillDir', async () => {
    // 本机常见形态：目标里的技能目录是指向别处的 junction，覆盖时必须只删链接、不跟进去写真实目录
    const external = mkdtempSync(join(tmpdir(), 'agentboard-sync-ext-'));
    mkdirSync(join(external, 'using-agentboard'), { recursive: true });
    writeFileSync(join(external, 'using-agentboard', 'SKILL.md'), '外部真实目录\n');
    mkdirSync(join(home, '.claude', 'skills'), { recursive: true });
    symlinkSync(join(external, 'using-agentboard'), join(home, '.claude', 'skills', 'using-agentboard'), process.platform === 'win32' ? 'junction' : 'dir');

    const res = await request(app).post('/api/settings/skills-sync').send({ target_ids: ['claude'], conflict: 'overwrite' });
    expect(res.status).toBe(200);
    expect((res.body as { results: Array<{ errors: unknown[] }> }).results[0]!.errors).toEqual([]);
    // 链接目标原样保留，目标位置变成真实目录
    expect(readFileSync(join(external, 'using-agentboard', 'SKILL.md'), 'utf8')).toBe('外部真实目录\n');
    expect(lstatSync(join(home, '.claude', 'skills', 'using-agentboard')).isSymbolicLink()).toBe(false);
    expect(readFileSync(join(home, '.claude', 'skills', 'using-agentboard', 'SKILL.md'), 'utf8')).toContain('using-agentboard 测试技能');
    rmSync(external, { recursive: true, force: true });
  });

  it('refusesWhenTargetIsSourceRoot', async () => {
    // 让来源指向 ~/.agents/skills（先复制一次生成该目录）
    await request(app).post('/api/settings/skills-sync').send({ target_ids: ['agents'] });
    await boot({ sourceRoot: join(home, '.agents', 'skills') });
    const probe = await request(app).get('/api/settings/skills-sync/targets');
    const agents = (probe.body as { targets: Array<{ id: string; is_source: boolean }> }).targets.find((item) => item.id === 'agents');
    expect(agents?.is_source).toBe(true);
    const res = await request(app).post('/api/settings/skills-sync').send({ target_ids: ['agents'] });
    const result = (res.body as { results: Array<{ errors: Array<{ message: string }> }> }).results[0]!;
    expect(result.errors[0]?.message).toContain('技能来源目录');
    expect(existsSync(join(home, '.agents', 'skills', 'using-agentboard', 'SKILL.md'))).toBe(true);
  });
});

describe('DELETE /api/settings/skills-sync/:targetId', () => {
  it('removesSyncedSkillsAndClearsRecord', async () => {
    await request(app).post('/api/settings/skills-sync').send({ target_ids: ['agents'] });
    const del = await request(app).delete('/api/settings/skills-sync/agents');
    expect(del.status).toBe(200);
    const body = del.body as { removed: string[]; errors: unknown[]; state_cleared: boolean };
    expect(body.removed.sort()).toEqual([...REQUIRED_SKILLS].sort());
    expect(body.errors).toEqual([]);
    expect(body.state_cleared).toBe(true);
    for (const name of REQUIRED_SKILLS) expect(existsSync(join(home, '.agents', 'skills', name))).toBe(false);
    const probe = await request(app).get('/api/settings/skills-sync/targets');
    const agents = (probe.body as { targets: Array<{ id: string; synced_at: string | null }> }).targets.find((item) => item.id === 'agents');
    expect(agents?.synced_at).toBeNull();
  });

  it('rejectsUnknownTarget', async () => {
    expect((await request(app).delete('/api/settings/skills-sync/nope')).status).toBe(400);
  });

  it('refusesRemovingSourceRoot', async () => {
    await request(app).post('/api/settings/skills-sync').send({ target_ids: ['agents'] });
    await boot({ sourceRoot: join(home, '.agents', 'skills') });
    const res = await request(app).delete('/api/settings/skills-sync/agents');
    expect(res.status).toBe(409);
    expect(existsSync(join(home, '.agents', 'skills', 'using-agentboard', 'SKILL.md'))).toBe(true);
  });
});
