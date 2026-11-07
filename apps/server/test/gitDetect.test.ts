/**
 * GIT-DETECT：区分「git 未安装」「不是 git 仓库」「仓库不健康」三种情况。
 *
 * 单测用注入的 exec 结果模拟三态（不真的卸载 git），另用真实临时仓库证明健康路径不受影响。
 * 契约：三种情况的原因码与文案必须不同，且都回显声明范围、done 不阻断（函数只返回提示文本）。
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestDb, type TestDb } from './helpers.js';
import { createWorkspace } from '../src/db/repos/workspace.js';
import { createIssue } from '../src/db/repos/issue.js';
import { commitIssueChanges, detectGitRepo, type GitRunner, type IssueCommitResult } from '../src/services/gitBaseline.js';

/** 按调用参数返回预设结果；未预设的命令一律按「成功但空输出」处理 */
const runnerFrom = (table: Array<{ match: (args: string[]) => boolean; result: string | Error }>): GitRunner => {
  return async (_cwd, args) => {
    for (const entry of table) {
      if (entry.match(args)) {
        if (entry.result instanceof Error) throw entry.result;
        return { stdout: entry.result, stderr: '' };
      }
    }
    return { stdout: '', stderr: '' };
  };
};

const isVersion = (args: string[]): boolean => args[0] === '--version';
const isRevParse = (args: string[]): boolean => args[0] === 'rev-parse';
const isStatus = (args: string[]): boolean => args[0] === 'status';

const enoent = (): Error => Object.assign(new Error('spawn git ENOENT'), { code: 'ENOENT' });
const failed = (stderr: string): Error => Object.assign(new Error(`Command failed: git ${stderr}`), { stderr });

describe('detectGitRepo（GIT-DETECT 三态探测）', () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'agentboard-gitdetect-')); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }); });

  it('git 二进制不存在（--version ENOENT）→ git-missing', async () => {
    const state = await detectGitRepo(dir, runnerFrom([{ match: isVersion, result: enoent() }]));
    expect(state.kind).toBe('git-missing');
    expect(state.detail).toContain('ENOENT');
  });

  it('git 已装但目录不是仓库（rev-parse 失败）→ not-a-repo', async () => {
    const state = await detectGitRepo(dir, runnerFrom([
      { match: isVersion, result: 'git version 2.45.0\n' },
      { match: isRevParse, result: failed('fatal: not a git repository (or any of the parent directories): .git') },
    ]));
    expect(state.kind).toBe('not-a-repo');
    expect(state.detail).toContain('not a git repository');
  });

  it('是仓库但不健康（status 失败）→ unhealthy，保留具体错误', async () => {
    const state = await detectGitRepo(dir, runnerFrom([
      { match: isVersion, result: 'git version 2.45.0\n' },
      { match: isRevParse, result: 'true\n' },
      { match: isStatus, result: failed('error: bad signature 0x00000000\nfatal: index file corrupt') },
    ]));
    expect(state.kind).toBe('unhealthy');
    expect(state.detail).toContain('index file corrupt');
  });

  it('三项都正常 → repo', async () => {
    const state = await detectGitRepo(dir, runnerFrom([
      { match: isVersion, result: 'git version 2.45.0\n' },
      { match: isRevParse, result: 'true\n' },
      { match: isStatus, result: '' },
    ]));
    expect(state).toEqual({ kind: 'repo' });
  });

  it('目录不存在 → not-a-repo（不误报成 git 未安装）', async () => {
    const state = await detectGitRepo(join(dir, 'missing'), runnerFrom([{ match: isVersion, result: 'git version 2.45.0\n' }]));
    expect(state.kind).toBe('not-a-repo');
    expect(state.detail).toContain('目录不存在');
  });

  it('真实临时仓库 → repo（真实 git，不注入）', async () => {
    execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: dir, windowsHide: true });
    expect(await detectGitRepo(dir)).toEqual({ kind: 'repo' });
  });
});

describe('commitIssueChanges 三态提示（GIT-DETECT）', () => {
  let t: TestDb;
  let dir: string;
  let workspaceId: string;
  let issueId: string;

  beforeEach(() => {
    t = createTestDb();
    dir = mkdtempSync(join(tmpdir(), 'agentboard-gitdetect-note-'));
    workspaceId = createWorkspace(t.db, { name: 'detect 空间', path: dir }).id;
    issueId = createIssue(t.db, { workspace_id: workspaceId, title: '容器内收尾', description: '' }).id;
  });
  afterEach(() => {
    t.cleanup();
    rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  });

  const result = (runner: GitRunner, declared: string[] = ['apps/server/src']): Promise<IssueCommitResult> =>
    commitIssueChanges(t.db, issueId, declared, { git: runner });
  const note = async (runner: GitRunner, declared: string[] = ['apps/server/src']): Promise<string | null> =>
    (await result(runner, declared)).note;

  it('git 未安装 → GIT_NOT_INSTALLED 文案 + 回显声明范围', async () => {
    const text = await note(runnerFrom([{ match: isVersion, result: enoent() }]));
    expect(text).toContain('环境未安装 git');
    expect(text).toContain('GIT_NOT_INSTALLED');
    expect(text).toContain('声明范围：apps/server/src');
    expect(text).not.toContain('不是 git 仓库');
  });

  it('不是仓库 → NOT_A_GIT_REPO 文案（给 git init 建议）+ 回显声明范围', async () => {
    const text = await note(runnerFrom([
      { match: isVersion, result: 'git version 2.45.0\n' },
      { match: isRevParse, result: failed('fatal: not a git repository') },
    ]));
    expect(text).toContain('NOT_A_GIT_REPO');
    expect(text).toContain('git init');
    expect(text).toContain('声明范围：apps/server/src');
    expect(text).not.toContain('未安装 git');
  });

  it('仓库不健康 → 保留具体错误，不伪装成「不是仓库」', async () => {
    const text = await note(runnerFrom([
      { match: isVersion, result: 'git version 2.45.0\n' },
      { match: isRevParse, result: 'true\n' },
      { match: isStatus, result: failed('fatal: index file corrupt') },
    ]));
    expect(text).toContain('index file corrupt');
    expect(text).toContain('GIT_REPO_UNHEALTHY');
    expect(text).not.toContain('不是 git 仓库');
    expect(text).not.toContain('未安装 git');
  });

  it('三种情况的文案两两不同（合并两态即红）', async () => {
    const missing = await note(runnerFrom([{ match: isVersion, result: enoent() }]));
    const notRepo = await note(runnerFrom([
      { match: isVersion, result: 'git version 2.45.0\n' },
      { match: isRevParse, result: failed('fatal: not a git repository') },
    ]));
    const unhealthy = await note(runnerFrom([
      { match: isVersion, result: 'git version 2.45.0\n' },
      { match: isRevParse, result: 'true\n' },
      { match: isStatus, result: failed('fatal: index file corrupt') },
    ]));
    expect(new Set([missing, notRepo, unhealthy]).size).toBe(3);
  });

  it('真实仓库路径不受影响：探测为 repo，无基线且无脏文件时返回 nothing（不落误导评论）', async () => {
    execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: dir, windowsHide: true });
    const outcome = await result(runnerFrom([
      { match: isVersion, result: 'git version 2.45.0\n' },
      { match: isRevParse, result: 'true\n' },
    ]), []);
    expect(outcome.status).toBe('nothing');
    expect(outcome.note).toBeNull();
  });
});
