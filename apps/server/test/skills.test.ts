/**
 * `GET /api/skills`：只读技能目录（固定根、忽略任何路径参数、只返回 name/description）。
 */
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
import { listSkills, parseFrontmatter, resetSkillsCache } from '../src/services/skills.js';

const writeSkill = (root: string, dir: string, content: string): void => {
  mkdirSync(join(root, dir), { recursive: true });
  writeFileSync(join(root, dir, 'SKILL.md'), content);
};

describe('skills endpoint', () => {
  let t: TestDb;
  let app: Express;
  let root: string;

  const boot = async (skillsRoot?: string): Promise<void> => {
    const adapter = new FakeAdapter();
    const created = await createApp({
      db: t.db,
      getAdapter: (id: string): AgentAdapter => {
        if (id === 'fake') return adapter;
        throw new Error(`未知适配器 id: ${id}`);
      },
      adapters: [adapter],
      refreshClisOnBoot: false,
      skillsRoot,
    });
    app = created.app;
  };

  beforeEach(async () => {
    resetSkillsCache();
    t = createTestDb();
    root = mkdtempSync(join(tmpdir(), 'agentboard-skills-'));
    writeSkill(root, 'agentboard', '---\nname: agentboard\ndescription: 通过 kb CLI 领取任务\n---\n\n# 正文不该出现\n');
    writeSkill(root, 'no-name', '---\ndescription: 没有 name 字段\n---\n');
    writeSkill(root, 'quoted', '---\nname: "带引号技能"\ndescription: \'单引号描述\'\n---\n');
    mkdirSync(join(root, 'empty-dir'), { recursive: true });
    await boot(root);
  });
  afterEach(() => {
    t.cleanup();
    rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  });

  it('returnsNameAndDescriptionOnly', async () => {
    const res = await request(app).get('/api/skills');
    expect(res.status).toBe(200);
    const expected = [
      { name: 'agentboard', description: '通过 kb CLI 领取任务' },
      { name: 'no-name', description: '没有 name 字段' },
      { name: '带引号技能', description: '单引号描述' },
    ].sort((left, right) => left.name.localeCompare(right.name));
    expect(res.body).toEqual(expected);
    // 每项只有两个字段，不返回正文
    for (const item of res.body as Array<Record<string, unknown>>) {
      expect(Object.keys(item).sort()).toEqual(['description', 'name']);
      expect(JSON.stringify(item)).not.toContain('正文不该出现');
    }
  });

  it('fallsBackToDirectoryNameWhenNameMissing', async () => {
    const res = await request(app).get('/api/skills');
    expect((res.body as Array<{ name: string }>).map(item => item.name)).toContain('no-name');
  });

  it('returnsEmptyArrayWhenRootMissing', async () => {
    resetSkillsCache();
    await boot(join(root, 'does-not-exist'));
    const res = await request(app).get('/api/skills');
    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
  });

  it('ignoresPathLikeQueryParams', async () => {
    const plain = await request(app).get('/api/skills');
    const injected = await request(app).get('/api/skills?path=C:\\Windows\\win.ini&root=C:\\&dir=../..');
    expect(injected.status).toBe(200);
    expect(injected.body).toEqual(plain.body);
    expect(JSON.stringify(injected.body)).not.toContain('win.ini');
  });

  it('skipsDirectoriesWithoutSkillMd', async () => {
    const res = await request(app).get('/api/skills');
    expect((res.body as Array<{ name: string }>).map(item => item.name)).not.toContain('empty-dir');
  });

  it('cachesWithinTtlAndRefreshesAfterExpiry', () => {
    let clock = 1_000;
    const before = listSkills({ root, ttlMs: 30_000, now: () => clock });
    writeSkill(root, 'late', '---\nname: late\ndescription: 后加的技能\n---\n');
    // TTL 内不重扫
    expect(listSkills({ root, ttlMs: 30_000, now: () => clock })).toEqual(before);
    // 超时后重扫并读到新目录
    clock += 31_000;
    expect(listSkills({ root, ttlMs: 30_000, now: () => clock }).map(item => item.name)).toContain('late');
  });

  it('parsesFrontmatterOnlyWhenDocumentStartsWithDelimiter', () => {
    expect(parseFrontmatter('---\nname: a\ndescription: b\n---\n')).toEqual({ name: 'a', description: 'b' });
    expect(parseFrontmatter('# 没有 frontmatter\nname: x')).toEqual({});
    // 嵌套块（缩进）不作为顶层键
    const nested = parseFrontmatter('---\nname: a\nmetadata:\n  opencode/slash: "true"\n---\n');
    expect(nested.name).toBe('a');
    expect(nested).not.toHaveProperty('opencode/slash');
  });
});
