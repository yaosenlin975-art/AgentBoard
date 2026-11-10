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
import { createTestDb, type TestDb, issuePayload } from './helpers.js';
import { FakeAdapter } from './fakeAdapter.js';
import { createApp } from '../src/index.js';
import { initSchema } from '../src/db/schema.js';
import { createWorkspace } from '../src/db/repos/workspace.js';
import { pruneIssueGitBaselines } from '../src/db/migrations/issueGitBaseline.js';
import { captureIssueGitBaseline, commitIssueChanges, parseCommitTrailers } from '../src/services/gitBaseline.js';
import { sweepExpiredLeases } from '../src/services/claim.js';

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
    const res = await request(app).post('/api/issues').send(issuePayload(workspaceId, { title }));
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
    const res = await done(issueId, { scope_paths: ['src/feature.ts'] });

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
    await done(issueId, { scope_paths: ['note.md'] });
    expect(lastSubject()).toBe(`[${issueId.slice(0, 8)}] ${title}`);
  });

  it('keepsNewlineInTitleWithoutShellSplitting', async () => {
    const title = '第一行标题\n第二行继续';
    const issueId = await makeIssue(title);
    await claim(issueId);
    writeFileSync(join(repo, 'multi.md'), 'x\n');
    await done(issueId, { scope_paths: ['multi.md'] });
    // 单参数 -m：完整标题（含换行）原样进入提交信息，不被拆成多个参数或截断
    expect(git(repo, ['log', '-1', '--pretty=%B']).trimEnd()).toBe(
      `[${issueId.slice(0, 8)}] ${title}\n\nAgentBoard-Issue: ${issueId}\nAgentBoard-Claim: fake`,
    );
  });

  it('stagesDeletedFiles', async () => {
    writeFileSync(join(repo, 'to-delete.md'), 'bye\n');
    git(repo, ['add', '--', 'to-delete.md']);
    git(repo, ['commit', '-q', '-m', 'add to-delete']);
    const issueId = await makeIssue('删除冗余文件');
    await claim(issueId);

    unlinkSync(join(repo, 'to-delete.md'));
    await done(issueId, { scope_paths: ['to-delete.md'] });

    expect(git(repo, ['show', '--name-status', '--pretty=format:', '-1']).trim()).toBe('D\tto-delete.md');
  });

  it('nonGitWorkspaceReportsSkipInsteadOfSilence', async () => {
    const plain = join(root, 'plain');
    mkdirSync(plain, { recursive: true });
    const plainWorkspace = createWorkspace(t.db, { name: '非仓库', path: plain }).id;
    const created = await request(app).post('/api/issues').send(issuePayload(plainWorkspace, { title: '非仓库任务' }));
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

    const res = await done(issueId, { scope_paths: ['blocked.txt'] });
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
    // NO_SCOPE：并行时同样不猜归属，一个文件都不提交
    expect(comments(first).join('\n')).toContain('未声明目标文件集');
    expect(commitCount()).toBe(1);
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

  // N3-10：纯看板任务显式跳过提交，脏工作区也不列他人文件、不产生 NO_SCOPE
  it('boardOnlySkipsCommitEvenInDirtyWorktree', async () => {
    const issueId = await makeIssue('纯看板任务');
    writeFileSync(join(repo, 'someone-else.txt'), 'dirty\n');
    const before = commitCount();
    await claim(issueId);
    const res = await done(issueId, { board_only: true, client: 'cli', changelog_ack: true });
    expect(res.status).toBe(200);
    expect(res.body.git_commit).toMatchObject({ status: 'skipped', reason: 'BOARD_ONLY', pending: [] });
    expect(commitCount()).toBe(before);
    expect(git(repo, ['status', '--porcelain'])).toContain('someone-else.txt');
    expect(comments(issueId).join('\n')).not.toContain('NO_SCOPE');
  });


  // KB-DONE-STAGE：卡外脏文件（含被别的卡预暂存的）不得卷进本卡提交
  it('commitsOnlyCardScopeEvenWhenOutsideFileIsPreStaged', async () => {
    const issueId = await makeIssue('本卡范围收尾');
    await claim(issueId);

    writeFileSync(join(repo, 'a-card.txt'), 'A 卡本次改动\n');
    writeFileSync(join(repo, 'b-card.txt'), 'B 卡遗留的未提交改动\n');
    // 模拟另一张卡已经 git add、但还没提交
    git(repo, ['add', '--', 'b-card.txt']);

    const res = await done(issueId, { scope_paths: ['a-card.txt'] });
    expect(res.status).toBe(200);
    expect(lastCommitFiles()).toEqual(['a-card.txt']);
    // 卡外文件仍在工作树，且仍是「已暂存」状态：路径限定 commit 没有把它卷进来
    expect(git(repo, ['status', '--porcelain'])).toContain('b-card.txt');

    const note = comments(issueId).join('\n');
    expect(note).toContain('已自动提交 1 个文件');
    expect(note).toContain('卡外改动未提交');
    expect(note).toContain('b-card.txt');
    // N3-03：MCP 没有 --all，提示里给出 MCP 可用的 scope 写法
    expect(note).toContain('MCP 传 `scope: ["."]`');
    // N3-04：committed 时 pending 仍是「仍未提交的路径」，与 note 列出的卡外文件一致
    expect(res.body.git_commit).toMatchObject({ status: 'committed', pending: ['b-card.txt'] });
  });

  it('commitsEveryFileInsideDeclaredScope', async () => {
    const issueId = await makeIssue('卡内多文件');
    await claim(issueId);
    mkdirSync(join(repo, 'src'), { recursive: true });
    writeFileSync(join(repo, 'src', 'a.ts'), 'a\n');
    writeFileSync(join(repo, 'src', 'b.ts'), 'b\n');
    writeFileSync(join(repo, 'outside.txt'), 'other\n');

    await done(issueId, { scope_paths: ['src'] });

    expect(lastCommitFiles().sort()).toEqual(['src/a.ts', 'src/b.ts']);
    expect(git(repo, ['status', '--porcelain'])).toContain('outside.txt');
  });

  it('includesOutsideChangesOnlyWhenAllIsExplicit', async () => {
    const issueId = await makeIssue('显式全量');
    await claim(issueId);
    writeFileSync(join(repo, 'a-card.txt'), 'A\n');
    writeFileSync(join(repo, 'b-card.txt'), 'B\n');

    // CLI 的 --all 映射成声明工作区根 `.`
    await done(issueId, { scope_paths: ['.'] });

    expect(lastCommitFiles().sort()).toEqual(['a-card.txt', 'b-card.txt']);
    expect(git(repo, ['status', '--porcelain'])).toBe('');
    expect(comments(issueId).join('\n')).toContain('--all：显式纳入工作区全部未提交改动');
  });

  it('refusesBroadCommitWhenNoTargetFileSetDeclared', async () => {
    writeFileSync(join(repo, 'preexisting.txt'), 'claim 前就脏\n');
    const issueId = await makeIssue('无声明不宽提交');
    await claim(issueId);
    writeFileSync(join(repo, 'work.txt'), '本次改动\n');

    const res = await done(issueId);

    // N-01：未声明范围时一个文件都不提交（曾把 claim 前脏文件/他人文件一起卷进提交）
    expect(res.body.git_commit).toMatchObject({ status: 'not-committed', reason: 'NO_SCOPE' });
    expect(commitCount()).toBe(1);
    const status = git(repo, ['status', '--porcelain']);
    expect(status).toContain('preexisting.txt');
    expect(status).toContain('work.txt');
    const note = comments(issueId).join('\n');
    expect(note).toContain('未声明目标文件集');
    expect(note).toContain('preexisting.txt');
    expect(note).toContain('scope');
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
    const body = { agent_id: 'fake', notes: '', workspace_id: workspaceId, scope_paths: ['once.txt'] };

    const first = await request(app).post(`/api/issues/${issueId}/done`).set('Idempotency-Key', key).send(body);
    expect(first.status).toBe(200);
    const afterFirst = commitCount();
    expect(afterFirst).toBe(2);

    const replay = await request(app).post(`/api/issues/${issueId}/done`).set('Idempotency-Key', key).send(body);
    expect(replay.status).toBe(200);
    expect(replay.body.id).toBe(first.body.id);
    // GIT-OBSERVABLE：重放必须逐字一致，git_commit 取首次结果（不重新提交，也不退化成 null）
    expect(replay.body.git_commit).toEqual(first.body.git_commit);
    expect(replay.body.git_commit).toMatchObject({ status: 'committed' });
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
      await done(issueId, { scope_paths: ['anonymous.txt'] });
      expect(git(repo, ['log', '-1', '--pretty=%an <%ae>'])).toBe('AgentBoard <agentboard@local>');
      expect(comments(issueId).join('\n')).toContain('AgentBoard 默认身份提交');
    } finally {
      process.env.GIT_CONFIG_GLOBAL = previousGlobal ?? '';
      process.env.GIT_CONFIG_SYSTEM = previousSystem ?? '';
      if (previousGlobal === undefined) delete process.env.GIT_CONFIG_GLOBAL;
      if (previousSystem === undefined) delete process.env.GIT_CONFIG_SYSTEM;
    }
  });

  it('commitTrailerRecordsIssueAndClaimerAtCaptureTime', async () => {
    const issueId = await makeIssue('trailer 记录领取者');
    await claim(issueId);
    writeFileSync(join(repo, 'trailer.txt'), 'x\n');
    await done(issueId, { scope_paths: ['trailer.txt'] });

    const body = git(repo, ['log', '-1', '--pretty=%B']);
    expect(body).toContain(`AgentBoard-Issue: ${issueId}`);
    expect(body).toContain('AgentBoard-Claim: fake');
    expect(parseCommitTrailers(body)).toEqual({ issueId, claim: 'fake' });

    // 流转后 issue 的 claimed_by 已清空，但基线里捕获的值仍用于 trailer
    const after = t.db.prepare('SELECT claimed_by FROM issue WHERE id=?').get(issueId) as { claimed_by: string | null };
    expect(after.claimed_by).toBeNull();
  });

  it('omitsClaimTrailerWhenClaimedByIsEmpty', async () => {
    const issueId = await makeIssue('无领取者');
    // 无领取者也能进入进行中（清扫残留场景），基线 captured_by 为空
    t.db.prepare("UPDATE issue SET status='进行中', claimed_by=NULL WHERE id=?").run(issueId);
    await captureIssueGitBaseline(t.db, issueId);
    writeFileSync(join(repo, 'no-claimer.txt'), 'x\n');
    await commitIssueChanges(t.db, issueId, ['no-claimer.txt']);

    const body = git(repo, ['log', '-1', '--pretty=%B']);
    expect(body).toContain(`AgentBoard-Issue: ${issueId}`);
    expect(body).not.toContain('AgentBoard-Claim');
  });

  it('parsesLegacyCommitWithoutTrailers', () => {
    // 旧提交（无 trailer）解析不报错，两个字段均为 null
    expect(parseCommitTrailers('[abc] 旧标题')).toEqual({ issueId: null, claim: null });
    // 空值 trailer 视同缺失
    expect(parseCommitTrailers('AgentBoard-Issue:   \nAgentBoard-Claim:')).toEqual({ issueId: null, claim: null });
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

  // —— 卡 9fa0d16f：自动提交必须可观测（四条验收里的「无基线」「stub git 失败」「租约过期 + 脏树」） ——

  it('noBaselineIsObservableInsteadOfSilentSkip', async () => {
    const issueId = await makeIssue('无基线收尾');
    await claim(issueId);
    mkdirSync(join(repo, 'src'), { recursive: true });
    writeFileSync(join(repo, 'src', 'feature.ts'), 'export const v = 1;\n');
    const before = commitCount();
    // 模拟基线被清扫/丢失：done 不能再静默跳过
    t.db.prepare('DELETE FROM issue_git_baseline WHERE issue_id=?').run(issueId);

    const res = await done(issueId, { scope_paths: ['src/feature.ts'] });

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('待验收');
    expect(res.body.git_commit).toMatchObject({
      status: 'not-committed',
      reason: 'NO_BASELINE',
      pending: ['src/feature.ts'],
    });
    expect(commitCount()).toBe(before);
    const text = comments(issueId).join('\n');
    expect(text).toContain('无 claim 基线');
    expect(text).toContain('git add -- src/feature.ts');
    expect(git(repo, ['status', '--porcelain', '--untracked-files=all'])).toContain('src/feature.ts');
  });

  it('commitFailureIsReportedWithRemedy', async () => {
    const issueId = await makeIssue('提交失败可观测');
    await claim(issueId);
    writeFileSync(join(repo, 'fail.ts'), 'x\n');
    // 真实失败注入：pre-commit 钩子 exit 1（Git for Windows 同样会执行 hooks）
    mkdirSync(join(repo, '.git', 'hooks'), { recursive: true });
    writeFileSync(join(repo, '.git', 'hooks', 'pre-commit'), '#!/bin/sh\nexit 1\n');
    const before = commitCount();

    const res = await done(issueId, { scope_paths: ['fail.ts'] });

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('待验收');
    expect(res.body.git_commit).toMatchObject({
      status: 'not-committed',
      reason: 'COMMIT_FAILED',
      pending: ['fail.ts'],
    });
    expect(commitCount()).toBe(before);
    const text = comments(issueId).join('\n');
    expect(text).toContain('自动提交失败');
    expect(text).toContain('git add -- fail.ts');
  });

  it('leaseExpiredKeepsBaselineAndStillCommits', async () => {
    const issueId = await makeIssue('租约过期后收尾');
    const claimed = await claim(issueId);
    const fence = claimed.body.claim_fence as number;
    writeFileSync(join(repo, 'late.ts'), 'export const late = 1;\n');

    // 清扫只清占用，基线保留（否则 LEASE-GAP 的 done 必然变成「无基线」丢提交）
    expect(sweepExpiredLeases(t.db, Date.now() + 60 * 60 * 1000)).toBe(1);
    expect(t.db.prepare('SELECT COUNT(*) AS n FROM issue_git_baseline WHERE issue_id=?').get(issueId)).toEqual({ n: 1 });

    const res = await done(issueId, { scope_paths: ['late.ts'], fence });

    expect(res.status).toBe(200);
    expect(res.body.git_commit).toMatchObject({ status: 'committed' });
    expect(lastCommitFiles()).toEqual(['late.ts']);
    expect(lastSubject()).toBe(`[${issueId.slice(0, 8)}] 租约过期后收尾`);
  });
});
