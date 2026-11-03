/**
 * GIT-ON-DONE：claim 记基线 → done（含 CLI/MCP/UI 共用的 /done 端点）只提交本任务改动。
 * 夹具用真实临时 git 仓库（`git init` + 一次初始提交），不 mock git。
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, unlinkSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import type { AgentAdapter } from '@agentboard/adapters';
import { createTestDb, type TestDb } from './helpers.js';
import { FakeAdapter } from './fakeAdapter.js';
import { createApp } from '../src/index.js';
import { initSchema } from '../src/db/schema.js';
import { createWorkspace } from '../src/db/repos/workspace.js';
import { pruneIssueGitBaselines } from '../src/db/migrations/issueGitBaseline.js';

const git = (cwd: string, args: string[]): string =>
  execFileSync('git', args, { cwd, encoding: 'utf8', windowsHide: true }).trim();

describe('git on done', () => {
  let t: TestDb;
  let app: Express;
  let root: string;
  let repo: string;
  let workspaceId: string;

  const commitCount = (): number => Number(git(repo, ['rev-list', '--count', 'HEAD']));
  const lastSubject = (): string => git(repo, ['log', '-1', '--pretty=%s']);
  const lastCommitFiles = (): string[] => git(repo, ['show', '--name-only', '--pretty=format:', '-1']).split('\n').filter(Boolean);

  const makeIssue = async (title: string): Promise<string> => {
    const res = await request(app).post('/api/issues').send({ workspace_id: workspaceId, title, description: '' });
    expect(res.status).toBe(200);
    return res.body.id as string;
  };
  const claim = async (issueId: string) => {
    const res = await request(app).post(`/api/issues/${issueId}/claim`).send({ agent_id: 'fake' });
    expect(res.status).toBe(200);
    return res;
  };
  const done = async (issueId: string, body: Record<string, unknown> = {}) => {
    const res = await request(app).post(`/api/issues/${issueId}/done`).send({ workspace_id: workspaceId, agent_id: 'fake', notes: '', ...body });
    return res;
  };
  const comments = (issueId: string): string[] =>
    (t.db.prepare('SELECT content FROM issue_comment WHERE issue_id=? ORDER BY ts,id').all(issueId) as Array<{ content: string }>).map(row => row.content);

  beforeEach(async () => {
    t = createTestDb();
    root = mkdtempSync(join(tmpdir(), 'agentboard-git-'));
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
    workspaceId = createWorkspace(t.db, { name: 'git 空间', path: repo }).id;
  });
  afterEach(() => {
    t.cleanup();
    rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  });

  it('commitsOnlyTaskFilesAndLeavesPreClaimDirtyFilesAlone', async () => {
    writeFileSync(join(repo, 'legacy-dirty.txt'), 'claim 之前就存在\n');
    const issueId = await makeIssue('派发链路收紧');
    await claim(issueId);

    mkdirSync(join(repo, 'src'), { recursive: true });
    writeFileSync(join(repo, 'src', 'feature.ts'), 'export const value = 1;\n');
    const res = await done(issueId);

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('待验收');
    expect(lastSubject()).toBe(`[${issueId.slice(0, 8)}] 派发链路收紧`);
    expect(lastCommitFiles()).toEqual(['src/feature.ts']);
    expect(git(repo, ['status', '--porcelain'])).toContain('legacy-dirty.txt');
    expect(comments(issueId).join('\n')).toContain('已自动提交 1 个文件');
  });

  it('keepsQuotesAndChineseInCommitMessage', async () => {
    const title = '修复 "引号" 与 中文 标题';
    const issueId = await makeIssue(title);
    await claim(issueId);
    writeFileSync(join(repo, 'note.md'), 'x\n');
    await done(issueId);
    expect(lastSubject()).toBe(`[${issueId.slice(0, 8)}] ${title}`);
  });

  it('keepsNewlineInTitleWithoutShellSplitting', async () => {
    const title = '第一行标题\n第二行继续';
    const issueId = await makeIssue(title);
    await claim(issueId);
    writeFileSync(join(repo, 'multi.md'), 'x\n');
    await done(issueId);
    // 单参数 -m：完整标题（含换行）原样进入提交信息，不被拆成多个参数或截断
    expect(git(repo, ['log', '-1', '--pretty=%B']).trimEnd()).toBe(`[${issueId.slice(0, 8)}] ${title}`);
  });

  it('stagesDeletedFiles', async () => {
    writeFileSync(join(repo, 'to-delete.md'), 'bye\n');
    git(repo, ['add', '--', 'to-delete.md']);
    git(repo, ['commit', '-q', '-m', 'add to-delete']);
    const issueId = await makeIssue('删除冗余文件');
    await claim(issueId);

    unlinkSync(join(repo, 'to-delete.md'));
    await done(issueId);

    expect(git(repo, ['show', '--name-status', '--pretty=format:', '-1']).trim()).toBe('D\tto-delete.md');
  });

  it('nonGitWorkspaceReportsSkipInsteadOfSilence', async () => {
    const plain = join(root, 'plain');
    mkdirSync(plain, { recursive: true });
    const plainWorkspace = createWorkspace(t.db, { name: '非仓库', path: plain }).id;
    const created = await request(app).post('/api/issues').send({ workspace_id: plainWorkspace, title: '非仓库任务', description: '' });
    const issueId = created.body.id as string;
    await request(app).post(`/api/issues/${issueId}/claim`).send({ agent_id: 'fake' });
    writeFileSync(join(plain, 'a.txt'), 'x\n');
    const res = await request(app).post(`/api/issues/${issueId}/done`)
      .send({ workspace_id: plainWorkspace, agent_id: 'fake', scope_paths: ['src/a.ts'] });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('待验收');
    // 非 git 工作区不再静默：留一行跳过提示，并回显本次实际声明的 scope
    const note = comments(issueId).join('\n');
    expect(note).toContain('跳过自动提交：工作区不是 git 仓库');
    expect(note).toContain('声明范围：src/a.ts');
    expect(readFileSync(join(plain, 'a.txt'), 'utf8')).toBe('x\n'); // 磁盘未动
  });

  it('reportsCommitFailureWithoutBlockingDone', async () => {
    const hooksDir = join(repo, '.git', 'hooks');
    mkdirSync(hooksDir, { recursive: true });
    writeFileSync(join(hooksDir, 'pre-commit'), '#!/bin/sh\necho "hook 拒绝提交" >&2\nexit 1\n');
    const issueId = await makeIssue('会被钩子拦下');
    await claim(issueId);
    writeFileSync(join(repo, 'blocked.txt'), 'x\n');

    const res = await done(issueId);
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('待验收');
    expect(comments(issueId).join('\n')).toContain('自动提交失败');
    expect(comments(issueId).join('\n')).toContain('不影响待验收状态');
    expect(commitCount()).toBe(1);
  });

  it('notesParallelClaims', async () => {
    const first = await makeIssue('任务甲');
    const second = await makeIssue('任务乙');
    await claim(first);
    await claim(second);

    writeFileSync(join(repo, 'parallel.txt'), 'x\n');
    await done(first);
    expect(comments(first).join('\n')).toContain('并行占用任务');
  });

  it('commitsOnlyDeclaredPathsWhenAnotherCardIsInFlight', async () => {
    const first = await makeIssue('任务甲');
    const second = await makeIssue('任务乙');
    await claim(first);
    await claim(second);

    writeFileSync(join(repo, 'a-card.txt'), 'A 卡改动\n');
    writeFileSync(join(repo, 'b-card.txt'), 'B 卡在飞改动\n');
    const res = await done(first, { scope_paths: ['a-card.txt'] });

    expect(res.status).toBe(200);
    expect(commitCount()).toBe(2);
    expect(lastCommitFiles()).toEqual(['a-card.txt']);
    // 乙卡文件留在工作树，不进本卡提交
    expect(git(repo, ['status', '--porcelain'])).toContain('b-card.txt');
    const note = comments(first).join('\n');
    expect(note).toContain('已自动提交 1 个文件');
    expect(note).toContain('未提交');
    expect(note).toContain('b-card.txt');
  });

  it('refusesAmbiguousCommitAndListsFilesWhenScopeUndeclared', async () => {
    const first = await makeIssue('任务甲');
    const second = await makeIssue('任务乙');
    await claim(first);
    await claim(second);

    writeFileSync(join(repo, 'a-card.txt'), 'A\n');
    writeFileSync(join(repo, 'b-card.txt'), 'B\n');
    const res = await done(first);

    expect(res.status).toBe(200);
    expect(commitCount()).toBe(1);
    const status = git(repo, ['status', '--porcelain']);
    expect(status).toContain('a-card.txt');
    expect(status).toContain('b-card.txt');
    const note = comments(first).join('\n');
    expect(note).toContain('未自动提交');
    expect(note).toContain('a-card.txt');
    expect(note).toContain('b-card.txt');
    // 基线仍随 done 清理，不残留到下次占用
    expect(t.db.prepare('SELECT COUNT(*) AS n FROM issue_git_baseline WHERE issue_id=?').get(first)).toEqual({ n: 0 });
  });

  it('commitsOnlyFilesUnderDeclaredDirectory', async () => {
    const issueId = await makeIssue('目录范围');
    await claim(issueId);
    mkdirSync(join(repo, 'src'), { recursive: true });
    mkdirSync(join(repo, 'other'), { recursive: true });
    writeFileSync(join(repo, 'src', 'in.ts'), 'in\n');
    writeFileSync(join(repo, 'other', 'out.ts'), 'out\n');

    // `./src/` 同时验证归一化（去 `./` 与尾 `/`）
    await done(issueId, { scope_paths: ['./src/'] });

    expect(lastCommitFiles()).toEqual(['src/in.ts']);
    // 未跟踪目录在 porcelain 里折叠成 `?? other/`，用 -uall 展开到文件
    expect(git(repo, ['status', '--porcelain', '-uall'])).toContain('other/out.ts');
    expect(comments(issueId).join('\n')).toContain('other/out.ts');
  });

  it('writesNoCommentWhenNothingChanged', async () => {
    const issueId = await makeIssue('没有改动的任务');
    await claim(issueId);
    const res = await done(issueId);
    expect(res.status).toBe(200);
    expect(comments(issueId)).toHaveLength(0);
    expect(commitCount()).toBe(1);
  });

  it('idempotentReplayDoesNotCommitTwice', async () => {
    const issueId = await makeIssue('重放只提交一次');
    await claim(issueId);
    writeFileSync(join(repo, 'once.txt'), 'x\n');
    const key = randomUUID();
    const body = { agent_id: 'fake', notes: '', workspace_id: workspaceId };

    const first = await request(app).post(`/api/issues/${issueId}/done`).set('Idempotency-Key', key).send(body);
    expect(first.status).toBe(200);
    const afterFirst = commitCount();
    expect(afterFirst).toBe(2);

    const replay = await request(app).post(`/api/issues/${issueId}/done`).set('Idempotency-Key', key).send(body);
    expect(replay.status).toBe(200);
    expect(replay.body.id).toBe(first.body.id);
    expect(commitCount()).toBe(afterFirst);
  });

  it('usesDefaultIdentityOnlyWhenRepositoryHasNone', async () => {
    const emptyConfig = join(root, 'empty-gitconfig');
    writeFileSync(emptyConfig, '');
    const previousGlobal = process.env.GIT_CONFIG_GLOBAL;
    const previousSystem = process.env.GIT_CONFIG_SYSTEM;
    process.env.GIT_CONFIG_GLOBAL = emptyConfig;
    process.env.GIT_CONFIG_SYSTEM = emptyConfig;
    try {
      git(repo, ['config', '--unset', 'user.name']);
      git(repo, ['config', '--unset', 'user.email']);
      // 夹具自检：局部与全局都已无身份（否则本用例证明不了「无身份时用默认身份」）
      expect(() => git(repo, ['config', 'user.name'])).toThrow();
      expect(() => git(repo, ['config', 'user.email'])).toThrow();
      const issueId = await makeIssue('没有身份配置');
      await claim(issueId);
      writeFileSync(join(repo, 'anonymous.txt'), 'x\n');
      await done(issueId);
      expect(git(repo, ['log', '-1', '--pretty=%an <%ae>'])).toBe('AgentBoard <agentboard@local>');
      expect(comments(issueId).join('\n')).toContain('AgentBoard 默认身份提交');
    } finally {
      process.env.GIT_CONFIG_GLOBAL = previousGlobal ?? '';
      process.env.GIT_CONFIG_SYSTEM = previousSystem ?? '';
      if (previousGlobal === undefined) delete process.env.GIT_CONFIG_GLOBAL;
      if (previousSystem === undefined) delete process.env.GIT_CONFIG_SYSTEM;
    }
  });

  it('prunesBaselinesForIssuesNoLongerInProgress', async () => {
    const issueId = await makeIssue('基线清理');
    await claim(issueId);
    expect(t.db.prepare('SELECT COUNT(*) AS n FROM issue_git_baseline WHERE issue_id=?').get(issueId)).toEqual({ n: 1 });

    // 进行中 → 保留
    expect(pruneIssueGitBaselines(t.db)).toBe(0);
    // 手动改回待规划 → 清理
    t.db.prepare("UPDATE issue SET status='待规划' WHERE id=?").run(issueId);
    expect(pruneIssueGitBaselines(t.db)).toBe(1);
    expect(t.db.prepare('SELECT COUNT(*) AS n FROM issue_git_baseline').get()).toEqual({ n: 0 });
  });

  it('schemaStructureIsStableAcrossFreshAndRepeatedBoot', () => {
    const dump = (db: TestDb['db']): string =>
      (db.prepare("SELECT type,name,sql FROM sqlite_master WHERE name LIKE 'issue_git_baseline%' OR name LIKE 'idx_issue_git_baseline%' ORDER BY type,name").all() as Array<{ sql: string }>)
        .map(row => row.sql).join('\n');
    const fresh = createTestDb();
    try {
      initSchema(fresh.db);
      const first = dump(fresh.db);
      initSchema(fresh.db);
      expect(dump(fresh.db)).toBe(first);
      expect(first).toContain('issue_git_baseline');
      expect(first).toContain('idx_issue_git_baseline_ws');
    } finally {
      fresh.cleanup();
    }
  });

  it('baselineCountsPreClaimDirtyFiles', async () => {
    writeFileSync(join(repo, 'legacy-dirty.txt'), 'x\n');
    const issueId = await makeIssue('基线计数');
    await claim(issueId);
    const row = t.db.prepare('SELECT file_count, head_sha, paths_json FROM issue_git_baseline WHERE issue_id=?').get(issueId) as {
      file_count: number; head_sha: string; paths_json: string;
    };
    expect(row.file_count).toBe(1);
    expect(row.head_sha).toBe(git(repo, ['rev-parse', 'HEAD']));
    expect(JSON.parse(row.paths_json)).toHaveProperty(['legacy-dirty.txt']);
  });
});
