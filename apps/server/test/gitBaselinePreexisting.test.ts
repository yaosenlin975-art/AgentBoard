/**
 * GIT-BASELINE-BLIND：claim 前就已未提交的文件在 done 时不再被静默跳过。
 *
 * 场景：A 卡 claim 前工作树里已有未提交的 X（属 A 的声明范围），同一工作树另有 B 卡的未提交 Y。
 * A done 后：X 被提交且出现在系统评论里（标注「claim 前就已修改、按声明范围强制提交」），
 * Y 仍在工作树、未被提交。无声明时至少给出可直接执行的补救命令（不得静默）。
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
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

const git = (cwd: string, args: string[]): string =>
  execFileSync('git', args, { cwd, encoding: 'utf8', windowsHide: true }).trim();

describe('git baseline pre-existing dirty files (GIT-BASELINE-BLIND)', () => {
  let t: TestDb;
  let app: Express;
  let root: string;
  let repo: string;
  let workspaceId: string;

  const commitCount = (): number => Number(git(repo, ['rev-list', '--count', 'HEAD']));
  const lastCommitFiles = (): string[] => git(repo, ['show', '--name-only', '--pretty=format:', '-1']).split('\n').filter(Boolean);
  const comments = (issueId: string): string[] =>
    (t.db.prepare('SELECT content FROM issue_comment WHERE issue_id=? ORDER BY ts,id').all(issueId) as Array<{ content: string }>).map(row => row.content);

  const makeIssue = async (title: string): Promise<string> => {
    const res = await request(app).post('/api/issues').send({ workspace_id: workspaceId, title, description: '' });
    expect(res.status).toBe(200);
    return res.body.id as string;
  };
  const claim = async (issueId: string): Promise<void> => {
    const res = await request(app).post(`/api/issues/${issueId}/claim`).send({ agent_id: 'fake' });
    expect(res.status).toBe(200);
  };
  const done = (issueId: string, scope?: string[]) => request(app)
    .post(`/api/issues/${issueId}/done`)
    .send({ workspace_id: workspaceId, agent_id: 'fake', notes: '', ...(scope ? { scope_paths: scope } : {}) });

  beforeEach(async () => {
    t = createTestDb();
    root = mkdtempSync(join(tmpdir(), 'agentboard-blind-'));
    repo = join(root, 'repo');
    mkdirSync(repo, { recursive: true });
    git(repo, ['init', '-q', '-b', 'main']);
    git(repo, ['config', 'user.name', 'Fixture User']);
    git(repo, ['config', 'user.email', 'fixture@example.com']);
    writeFileSync(join(repo, 'README.md'), '# fixture\n');
    git(repo, ['add', '--', 'README.md']);
    git(repo, ['commit', '-q', '-m', 'init']);

    const adapter = new FakeAdapter();
    const created = await createApp({
      db: t.db,
      getAdapter: (id: string): AgentAdapter => {
        if (id === 'fake') return adapter;
        throw new Error(`未知适配器 id: ${id}`);
      },
      adapters: [adapter],
      refreshClisOnBoot: false,
    });
    app = created.app;
    workspaceId = createWorkspace(t.db, { name: 'blind 空间', path: repo }).id;
  });
  afterEach(() => {
    t.cleanup();
    rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  });

  it('commitsDeclaredPreExistingFileAndLeavesAnotherCardsFileAlone', async () => {
    // claim 前：A 的 X 与 B 的 Y 都已脏
    writeFileSync(join(repo, 'x-card.txt'), 'A 卡接手前就有的改动\n');
    writeFileSync(join(repo, 'y-other.txt'), 'B 卡的在飞改动\n');

    const cardA = await makeIssue('甲卡收口');
    const cardB = await makeIssue('乙卡在飞');
    await claim(cardA);
    await claim(cardB);

    const res = await done(cardA, ['x-card.txt']);
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('待验收');
    expect(commitCount()).toBe(2);
    expect(lastCommitFiles()).toEqual(['x-card.txt']);
    const status = git(repo, ['status', '--porcelain', '-uall']);
    expect(status).toContain('y-other.txt');
    expect(status).not.toContain('x-card.txt');

    const note = comments(cardA).join('\n');
    expect(note).toContain('已自动提交 1 个文件');
    expect(note).toContain('claim 前就已修改');
    expect(note).toContain('x-card.txt');
  });

  it('commitsDeclaredPreExistingFileWithoutAnyChangeSinceClaim', async () => {
    // DEPS-LOCK 现场：整张卡要交付的就是 claim 前已有的未提交文件
    writeFileSync(join(repo, 'lock.txt'), 'v2\n');
    const issueId = await makeIssue('依赖声明对齐');
    await claim(issueId);

    const res = await done(issueId, ['lock.txt']);
    expect(res.status).toBe(200);
    expect(commitCount()).toBe(2);
    expect(lastCommitFiles()).toEqual(['lock.txt']);
    expect(git(repo, ['status', '--porcelain'])).toBe('');
    expect(comments(issueId).join('\n')).toContain('按声明范围强制提交');
  });

  it('reportsPreExistingFilesInsteadOfSilentlySkippingWhenNoScopeGiven', async () => {
    writeFileSync(join(repo, 'legacy.txt'), '遗留未提交\n');
    const issueId = await makeIssue('未声明范围');
    await claim(issueId);

    const res = await done(issueId);
    expect(res.status).toBe(200);
    expect(commitCount()).toBe(1); // 未产生提交
    expect(git(repo, ['status', '--porcelain'])).toContain('legacy.txt');
    const note = comments(issueId).join('\n');
    expect(note).toContain('未提交 1 个 claim 前就已修改的文件');
    expect(note).toContain('legacy.txt');
    // 给出可直接执行的补救命令
    expect(note).toContain('git add -- legacy.txt');
    expect(note).toContain('git commit -m');
  });

  it('loudlyReportsZeroHitScopeWithCopyPasteRemedy', async () => {
    // SCOPE-GUARD：声明了 scope 但一个都没命中 → 显眼标题 + 可直接执行的补救命令，done 仍成功
    writeFileSync(join(repo, 'dirty.txt'), 'claim 后改动\n');
    const issueId = await makeIssue('零命中卡');
    await claim(issueId);

    const res = await done(issueId, ['nomatch/']);
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('待验收');
    expect(commitCount()).toBe(1); // 没有产生提交

    const note = comments(issueId).join('\n');
    expect(note).toContain('⚠ 声明范围零命中，本次未自动提交');
    expect(note).toContain('声明范围：nomatch');
    expect(note).toContain('未提交的改动（1 个）：dirty.txt');
    expect(note).toContain('git add -- dirty.txt; git commit -m');
    expect(note).toContain('--scope a --scope b');
    // 文件仍在工作树
    expect(git(repo, ['status', '--porcelain'])).toContain('dirty.txt');
  });

  it('keepsPreExistingOutsideDeclaredScopeUncommittedAndListsIt', async () => {
    writeFileSync(join(repo, 'mine.txt'), 'mine\n');
    writeFileSync(join(repo, 'theirs.txt'), 'theirs\n');
    const issueId = await makeIssue('范围收窄');
    await claim(issueId);

    const res = await done(issueId, ['mine.txt']);
    expect(res.status).toBe(200);
    expect(lastCommitFiles()).toEqual(['mine.txt']);
    expect(git(repo, ['status', '--porcelain', '-uall'])).toContain('theirs.txt');
  });

  it('stillCommitsClaimTimeChangesWhenNoScopeGivenAndNoParallelClaim', async () => {
    const issueId = await makeIssue('常规卡');
    await claim(issueId);
    writeFileSync(join(repo, 'work.txt'), '新改动\n');
    await done(issueId);
    expect(lastCommitFiles()).toEqual(['work.txt']);
    expect(comments(issueId).join('\n')).toContain('已自动提交 1 个文件');
  });
});
