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
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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
  findConflictMarker,
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
  }, 30_000);

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
    expect(result.skipped).toBe(true);
    expect(result.reason).toContain('不存在');
  });

  /**
   * KB-SNAP-SILENT：git 写失败时 reason 必须是「真原因」（git stderr 首行），而不是
   * `Command failed: git add ...` 这种只有命令行的壳；且文件要回滚到上一版。
   * 这里真的注入 .git/index.lock，不 mock git。
   */
  it('git 写入失败（index.lock 注入）：reason 带 git stderr，快照回滚且无新提交', () => {
    expect(commitKnowledgePageSnapshot(repo, page(1)).committed).toBe(true);
    const head = git(repo, ['rev-parse', '--short', 'HEAD']);
    writeFileSync(join(repo, '.git', 'index.lock'), '', 'utf8');
    try {
      const failed = commitKnowledgePageSnapshot(repo, page(2, '正文 v2'));
      expect(failed.committed).toBe(false);
      expect(failed.skipped).toBeUndefined();
      expect(failed.reason).toContain('git add 失败');
      expect(failed.reason).toContain('index.lock');
      // KB-SNAP-ROLLBACK 回归：单失败（git add 未成功，索引里没有本 run 内容）时 reason 只报原始失败，不混入回滚失败
      expect(failed.reason).not.toContain('回滚失败');
      expect(failed.rollback_failed).toBeUndefined();
      expect(readFileSync(knowledgePageSnapshotPath(repo, 'page-1'), 'utf8')).toContain('revision: 1');
      expect(git(repo, ['rev-parse', '--short', 'HEAD'])).toBe(head);
      expect(git(repo, ['log', '--format=%s'])).not.toContain('r2');
    } finally {
      rmSync(join(repo, '.git', 'index.lock'), { force: true });
    }
    // 锁释放后同一正文可正常提交 r2（说明失败是可恢复的，不需要人工重写内容）
    const retried = commitKnowledgePageSnapshot(repo, page(2, '正文 v2'));
    expect(retried.committed).toBe(true);
    expect(git(repo, ['log', '--format=%s'])).toContain('knowledge(ws-page): r2 本区页');
  }, 30_000);

  /**
   * GIT-SNAPSHOT-CHECK（卡 9fa0d16f）：快照正文只能来自 DB 权威正文。
   * 多会话共用工作树时，stash pop 会在写盘与 add/commit 之间把冲突标记写进同一路径。
   */
  it('DB 正文含冲突标记：拒绝落盘，不留半成品', () => {
    const conflicted = '正文前\n<<<<<<< HEAD\n本地\n=======\n远端\n>>>>>>> other\n';
    const result = commitKnowledgePageSnapshot(repo, page(1, conflicted));
    expect(result.committed).toBe(false);
    expect(result.reason).toContain('冲突标记');
    expect(existsSync(knowledgePageSnapshotPath(repo, 'page-1'))).toBe(false);
  });

  it('冲突标记识别：只认 7 位以上且行首的标记，正常 Markdown 不受影响', () => {
    expect(findConflictMarker('<<<<<<< HEAD')).toBe('<<<<<<< HEAD');
    expect(findConflictMarker('  =======')).toBe('=======');
    expect(findConflictMarker('>>>>>>> branch')).toBe('>>>>>>> branch');
    expect(findConflictMarker('标题\n===\n')).toBeNull(); // setext 标题下划线（3 位）不误判
    expect(findConflictMarker('`<<<<<<<` 在行内')).toBeNull();
    expect(findConflictMarker('a\n---\nb')).toBeNull();
  });

  it('暂存内容被并发改写（clean filter 注入冲突标记）：判失败并回滚', () => {
    writeFileSync(join(repo, '.gitattributes'), '.agentboard/snapshot/knowledge/*.md filter=corrupt\n', 'utf8');
    git(repo, ['config', 'filter.corrupt.clean', "printf '<<<<<<< HEAD\\n'"]);
    const result = commitKnowledgePageSnapshot(repo, page(1));
    expect(result.committed).toBe(false);
    expect(result.reason).toContain('冲突标记');
    expect(existsSync(knowledgePageSnapshotPath(repo, 'page-1'))).toBe(false);
  });

  /**
   * KB-SNAP-ROLLBACK：双重失败不再静默。clean filter 在 git add 期间把快照文件 chmod 只读并注入冲突标记：
   * 暂存内容校验失败（原始失败）→ 回滚还原文件也失败（EPERM 只读）→ reason 同时含两者 + rollback_failed=true，
   * console.error 日志指认残留路径；git status --porcelain 能看到未还原的快照路径。
   */
  it('双重失败（暂存校验失败 + 还原被只读挡住）：reason 含原始失败与回滚失败，日志指认残留路径', () => {
    expect(commitKnowledgePageSnapshot(repo, page(1)).committed).toBe(true);
    const snapshotPath = knowledgePageSnapshotPath(repo, 'page-1');
    writeFileSync(join(repo, '.gitattributes'), '.agentboard/snapshot/knowledge/*.md filter=corrupt\n', 'utf8');
    const corrupt = `chmod 444 '${snapshotPath.split('\\').join('/')}' && printf '<<<<<<< HEAD\\n'`;
    git(repo, ['config', 'filter.corrupt.clean', corrupt]);
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const failed = commitKnowledgePageSnapshot(repo, page(2, '正文 v2'));
      expect(failed.committed).toBe(false);
      expect(failed.rollback_failed).toBe(true);
      expect(failed.reason).toContain('暂存内容校验 失败');
      expect(failed.reason).toContain('回滚失败（还原快照文件）');
      // 文件未还原（仍是本次写入的 r2）：工作树残留该路径，且日志里出现该路径
      expect(readFileSync(snapshotPath, 'utf8')).toContain('revision: 2');
      expect(git(repo, ['status', '--porcelain', '--', '.agentboard/snapshot/knowledge/page-1.md'])).not.toBe('');
      expect(errorSpy.mock.calls.some((call) => String(call[0]).includes('snapshot/knowledge/page-1.md'))).toBe(true);
    } finally {
      errorSpy.mockRestore();
      chmodSync(snapshotPath, 0o644);
      git(repo, ['config', '--unset', 'filter.corrupt.clean']);
    }
  }, 30_000);
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

  /**
   * KB-SNAP-SILENT 接线：真实 app + 真实 git 失败时，HTTP 仍是 200（正文已写入），
   * 但响应体必须诚实给出 page_commit.committed=false 与真原因，供 CLI 报警。
   */
  it('index.lock 注入：revise 返回 200 但 page_commit.committed=false 且 reason 含 git 原因', async () => {
    const payload = {
      scope: 'workspace',
      workspace_id: wsId,
      slug: 'locked-page',
      title: '锁冲突页',
      body_md: '正文 v1',
      domain: 'knowledge',
      sources: [{ source_id: 'file:README.md', source_type: 'file', locator: 'README.md', captured_at: 1, content_hash: 'a'.repeat(64) }],
      evidence: [{ source_id: 'file:README.md', locator: 'README.md:1-2' }],
      actor: 'tester',
    };
    const created = await request(app).post('/api/knowledge/pages').send(payload);
    expect(created.status).toBe(200);
    const pageId: string = created.body.id;
    const { slug: _slug, ...reviseBase } = payload;

    writeFileSync(join(repo, '.git', 'index.lock'), '', 'utf8');
    try {
      const revised = await request(app).put(`/api/knowledge/pages/${pageId}`).send({
        ...reviseBase,
        expected_revision: 1,
        body_md: '正文 v2',
      });
      expect(revised.status).toBe(200);
      expect(revised.body.revision).toBe(2);
      expect(revised.body.page_commit?.committed).toBe(false);
      expect(revised.body.page_commit?.reason).toContain('index.lock');
      // 回滚：文件仍是 rev1，git 侧没有 r2
      expect(readFileSync(knowledgePageSnapshotPath(repo, pageId), 'utf8')).toContain('revision: 1');
      expect(git(repo, ['log', '--format=%s'])).not.toContain('r2 锁冲突页');
    } finally {
      rmSync(join(repo, '.git', 'index.lock'), { force: true });
    }

    // 锁释放后按新 revision 重跑成功（正文已被上次写入，故提交 r3）
    const retried = await request(app).put(`/api/knowledge/pages/${pageId}`).send({
      ...reviseBase,
      expected_revision: 2,
      body_md: '正文 v3',
    });
    expect(retried.status).toBe(200);
    expect(retried.body.page_commit?.committed).toBe(true);
    expect(git(repo, ['log', '--format=%s'])).toContain('r3 锁冲突页');
  }, 30_000);
});
