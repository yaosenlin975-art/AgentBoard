/**
 * BORROW-5.1（决策 A）：知识页每次 revise 一提交，且提交只含该页路径。
 *
 * 覆盖卡面验收：
 * 1. 每次 revise 产生一次提交，`git show --stat` 只含该页路径；
 * 2. 先落快照再提交（文件内容与 HEAD 同源）；
 * 3. 失败回滚不留半提交（非 git 目录 → committed=false 且文件被撤掉）；
 * 并在真实 app 上验证 revise 路由真的触发（RULE-3）。
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import type { AgentAdapter } from '@agentboard/adapters';
import { createTestDb, type TestDb } from './helpers.js';
import { FakeAdapter } from './fakeAdapter.js';
import { createApp } from '../src/index.js';
import { createWorkspace } from '../src/db/repos/workspace.js';
import {
  commitKnowledgePageRevision,
  commitKnowledgePageSnapshot,
  knowledgePageSnapshotPath,
  removeKnowledgePageRevision,
  removeKnowledgePageSnapshot,
  renderKnowledgePageSnapshot,
} from '../src/services/knowledgePageCommit.js';

const page = (revision: number, body = '正文 v1') => ({
  id: 'page-1',
  slug: 'ws-page',
  title: '本区页',
  scope: 'workspace',
  revision,
  body_md: body,
  updated_at: 1_800_000_000_000,
});

const git = (cwd: string, args: string[]) =>
  execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

let root: string;
let repo: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'agentboard-pagecommit-'));
  repo = join(root, 'ws');
  mkdirSync(repo, { recursive: true });
  git(repo, ['init', '-q']);
  git(repo, ['config', 'user.email', 'test@example.com']);
  git(repo, ['config', 'user.name', 'tester']);
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
});

describe('BORROW-5.1：每页快照 + 单页提交', () => {
  it('渲染：front matter 字段顺序固定 + 正文单个尾换行', () => {
    const text = renderKnowledgePageSnapshot(page(3, '正文'));
    expect(text.startsWith('---\nid: page-1\nslug: ws-page\ntitle: 本区页\nscope: workspace\nrevision: 3\n')).toBe(true);
    expect(text.endsWith('---\n\n正文\n')).toBe(true);
    expect(renderKnowledgePageSnapshot(page(3, '正文\n'))).toBe(text);
  });

  it('两次 revise → 两次提交，且每次只含该页路径', () => {
    const first = commitKnowledgePageSnapshot(repo, page(1));
    expect(first.committed).toBe(true);
    expect(first.relative_path).toBe('.agentboard/snapshot/knowledge/page-1.md');
    const stat1 = git(repo, ['show', '--stat', '--name-only', '--format=', 'HEAD']);
    expect(stat1).toBe('.agentboard/snapshot/knowledge/page-1.md');

    const second = commitKnowledgePageSnapshot(repo, page(2, '正文 v2'));
    expect(second.committed).toBe(true);
    expect(second.commit).not.toBe(first.commit);
    expect(git(repo, ['show', '--name-only', '--format=', 'HEAD'])).toBe('.agentboard/snapshot/knowledge/page-1.md');
    expect(git(repo, ['log', '--format=%s'])).toContain('knowledge(ws-page): r2 本区页');
    // 快照与提交同源：工作区文件内容 == HEAD 里那份
    const onDisk = readFileSync(knowledgePageSnapshotPath(repo, 'page-1'), 'utf8');
    const inHead = execFileSync('git', ['show', 'HEAD:.agentboard/snapshot/knowledge/page-1.md'], { cwd: repo, encoding: 'utf8' });
    expect(onDisk).toBe(inHead);
  });

  it('非 git 目录：committed=false 且文件回滚（不留半提交）', () => {
    const notRepo = join(root, 'plain');
    mkdirSync(notRepo, { recursive: true });
    const result = commitKnowledgePageSnapshot(notRepo, page(1));
    expect(result.committed).toBe(false);
    expect(result.reason).toBeTruthy();
    expect(existsSync(knowledgePageSnapshotPath(notRepo, 'page-1'))).toBe(false);
  });

  it('归档：同一路径重写，front matter 带 status: archived，仍只提交该页', () => {
    const first = commitKnowledgePageSnapshot(repo, page(1));
    const archived = commitKnowledgePageSnapshot(repo, { ...page(2), status: 'archived' });
    expect(archived.committed).toBe(true);
    expect(archived.path).toBe(first.path);
    expect(readFileSync(knowledgePageSnapshotPath(repo, 'page-1'), 'utf8')).toContain('status: archived');
    expect(git(repo, ['show', '--name-only', '--format=', 'HEAD'])).toBe('.agentboard/snapshot/knowledge/page-1.md');
  });

  it('软删：撤掉快照并提交删除；已删页的正文不再留在工作树', () => {
    const target = { ...page(1), title: '待删页' };
    commitKnowledgePageSnapshot(repo, target);
    const removed = removeKnowledgePageSnapshot(repo, target);
    expect(removed.committed).toBe(true);
    expect(existsSync(knowledgePageSnapshotPath(repo, 'page-1'))).toBe(false);
    expect(git(repo, ['show', '--name-only', '--format=', 'HEAD'])).toBe('.agentboard/snapshot/knowledge/page-1.md');
    expect(git(repo, ['log', '-1', '--format=%s'])).toBe('knowledge(ws-page): 删除快照 待删页');
  });

  it('软删不存在的快照：不造空提交，reason 说明无需提交', () => {
    const result = removeKnowledgePageSnapshot(repo, page(1));
    expect(result.committed).toBe(false);
    expect(result.reason).toContain('不存在');
  });
});

describe('BORROW-5.1：真实 app 的 revise 接线（RULE-3）', () => {
  let t: TestDb;
  let app: Express;
  let wsId: string;

  beforeEach(async () => {
    t = createTestDb();
    const adapter = new FakeAdapter();
    const created = await createApp({
      db: t.db,
      getAdapter: (_id: string): AgentAdapter => adapter,
      adapters: [adapter],
      refreshClisOnBoot: false,
    });
    app = created.app;
    wsId = createWorkspace(t.db, { name: '提交区', path: repo }).id;
  });
  afterEach(() => {
    t.cleanup();
  });

  it('PUT /api/knowledge/pages/:id 成功后返回 page_commit，仓库里出现一次单页提交', async () => {
    const created = await request(app).post('/api/knowledge/pages').send({
      scope: 'workspace',
      workspace_id: wsId,
      slug: 'ws-page',
      title: '本区页',
      body_md: '正文 v1',
      domain: 'knowledge',
      sources: [{ source_id: 'file:README.md', source_type: 'file', locator: 'README.md', captured_at: 1, content_hash: 'a'.repeat(64) }],
      evidence: [{ source_id: 'file:README.md', locator: 'README.md:1-2' }],
      actor: 'tester',
    });
    expect(created.status).toBe(200);

    const revised = await request(app).put(`/api/knowledge/pages/${created.body.id}`).send({
      expected_revision: 1,
      scope: 'workspace',
      workspace_id: wsId,
      body_md: '正文 v2',
      change_note: '改一句',
      sources: [{ source_id: 'file:README.md', source_type: 'file', locator: 'README.md', captured_at: 1, content_hash: 'a'.repeat(64) }],
      evidence: [{ source_id: 'file:README.md', locator: 'README.md:1-2' }],
      actor: 'tester',
    });
    expect(revised.status).toBe(200);
    expect(revised.body.page_commit?.committed).toBe(true);
    expect(revised.body.page_commit.relative_path).toBe(`.agentboard/snapshot/knowledge/${created.body.id}.md`);
    expect(git(repo, ['show', '--name-only', '--format=', 'HEAD'])).toBe(`.agentboard/snapshot/knowledge/${created.body.id}.md`);
    expect(readFileSync(knowledgePageSnapshotPath(repo, created.body.id), 'utf8')).toContain('正文 v2');
  }, 30_000);

  it('commitKnowledgePageRevision：scope=common 不落盘（只做工作区页）', () => {
    expect(commitKnowledgePageRevision(t.db, wsId, { ...page(1), scope: 'common' })).toBeNull();
    expect(removeKnowledgePageRevision(t.db, wsId, { ...page(1), scope: 'common' })).toBeNull();
  });

  it('相对路径工作区：跳过快照并说明原因，不得写进服务进程 cwd 所在的仓库', () => {
    const relativeId = createWorkspace(t.db, { name: 'Rel', path: 'A' }).id;
    const upsert = commitKnowledgePageRevision(t.db, relativeId, page(1));
    expect(upsert?.committed).toBe(false);
    expect(upsert?.reason).toContain('绝对路径');
    expect(removeKnowledgePageRevision(t.db, relativeId, page(1))?.reason).toContain('绝对路径');
    expect(existsSync(join(process.cwd(), '.agentboard', 'snapshot', 'knowledge', 'page-1.md'))).toBe(false);
  });

  it('create → revise → archive → restore → delete 五步各一次提交，每次只含该页路径', async () => {
    const payload = {
      scope: 'workspace',
      workspace_id: wsId,
      slug: 'lifecycle-page',
      title: '生命周期页',
      body_md: '正文 v1',
      domain: 'knowledge',
      sources: [{ source_id: 'file:README.md', source_type: 'file', locator: 'README.md', captured_at: 1, content_hash: 'a'.repeat(64) }],
      evidence: [{ source_id: 'file:README.md', locator: 'README.md:1-2' }],
      actor: 'tester',
    };
    const created = await request(app).post('/api/knowledge/pages').send(payload);
    expect(created.status).toBe(200);
    const pageId: string = created.body.id;
    const snapshot = `.agentboard/snapshot/knowledge/${pageId}.md`;
    expect(created.body.page_commit?.committed).toBe(true);
    expect(created.body.page_commit.relative_path).toBe(snapshot);
    expect(readFileSync(knowledgePageSnapshotPath(repo, pageId), 'utf8')).toContain('revision: 1');
    expect(git(repo, ['show', '--name-only', '--format=', 'HEAD'])).toBe(snapshot);

    // revise 的 strict schema 不收 slug，这里去掉再提交
    const { slug: _slug, ...reviseBase } = payload;
    const revised = await request(app).put(`/api/knowledge/pages/${pageId}`).send({
      ...reviseBase,
      expected_revision: 1,
      body_md: '正文 v2',
    });
    expect(revised.status).toBe(200);
    expect(revised.body.page_commit?.committed).toBe(true);
    expect(readFileSync(knowledgePageSnapshotPath(repo, pageId), 'utf8')).toContain('revision: 2');
    expect(git(repo, ['show', '--name-only', '--format=', 'HEAD'])).toBe(snapshot);

    const archived = await request(app).post(`/api/knowledge/pages/${pageId}/actions`).send({
      scope: 'workspace',
      workspace_id: wsId,
      action: 'archive',
      expected_revision: 2,
      actor: 'tester',
    });
    expect(archived.status).toBe(200);
    expect(archived.body.page_commit?.committed).toBe(true);
    expect(readFileSync(knowledgePageSnapshotPath(repo, pageId), 'utf8')).toContain('status: archived');
    expect(git(repo, ['show', '--name-only', '--format=', 'HEAD'])).toBe(snapshot);

    const restored = await request(app).post(`/api/knowledge/pages/${pageId}/actions`).send({
      scope: 'workspace',
      workspace_id: wsId,
      action: 'restore',
      expected_revision: 3,
      actor: 'tester',
    });
    expect(restored.status).toBe(200);
    expect(restored.body.page_commit?.committed).toBe(true);
    expect(readFileSync(knowledgePageSnapshotPath(repo, pageId), 'utf8')).toContain('status: active');

    const deleted = await request(app).post(`/api/knowledge/pages/${pageId}/actions`).send({
      scope: 'workspace',
      workspace_id: wsId,
      action: 'delete',
      expected_revision: 4,
      actor: 'tester',
    });
    expect(deleted.status).toBe(200);
    expect(deleted.body.page_commit?.committed).toBe(true);
    expect(existsSync(knowledgePageSnapshotPath(repo, pageId))).toBe(false);
    expect(git(repo, ['show', '--name-only', '--format=', 'HEAD'])).toBe(snapshot);
    // 删除提交不得把工作树里其它路径卷进来
    expect(git(repo, ['status', '--porcelain'])).toBe('');
  }, 30_000);
});
