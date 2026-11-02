/**
 * GIT-ON-DONE：claim 记基线 → done 只提交本任务改动（失败不阻断，原因进评论）。
 *
 * 口径：
 * - 基线 = claim 时 `git status --porcelain -uall -z` 的 path→指纹；指纹为内容 hash 前 16 位，删除项记 `deleted`。
 *   `.gitignore` 忽略项 porcelain 默认不列，天然不入基线。
 * - done 时重取快照，`基线 ≠ 当前` 的路径即本任务改动；claim 之前就存在的改动不会进入差异集。
 * - 只用 `git add -A -- <paths>`（同时覆盖修改与删除），绝不 `git add -A` 全量。
 * - 提交身份：`git config user.name/email`（局部优先于全局，git 自身解析）都配好则尊重仓库身份；
 *   缺任一才用 `-c user.name=AgentBoard -c user.email=agentboard@local`，并在评论注明。
 * - 全程 `execFile('git', [...])`，标题等动态内容作为单个 `-m` 参数，不经 shell。
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { Db } from '../db/connection.js';
import { getIssue } from '../db/repos/issue.js';
import { getWorkspace } from '../db/repos/workspace.js';
import { withAccountLock } from './accounts/locks.js';

const run = promisify(execFile);
const GIT_TIMEOUT_MS = 15_000;
const MAX_LISTED_FILES = 5;
const DEFAULT_IDENTITY = { name: 'AgentBoard', email: 'agentboard@local' } as const;

interface BaselineRow {
  issue_id: string;
  workspace_id: string;
  head_sha: string | null;
  paths_json: string;
  file_count: number;
  captured_at: number;
}

async function git(cwd: string, args: string[]): Promise<{ stdout: string; stderr: string }> {
  const { stdout, stderr } = await run('git', args, { cwd, timeout: GIT_TIMEOUT_MS, maxBuffer: 8 * 1024 * 1024, windowsHide: true });
  return { stdout, stderr };
}

/** 只在「确实是 git 工作树」时返回 true；其它情况（目录不存在、非仓库、无权限）返回 false */
async function isGitWorkTree(path: string): Promise<boolean> {
  try {
    const { stdout } = await git(path, ['rev-parse', '--is-inside-work-tree']);
    return stdout.trim() === 'true';
  } catch { return false; }
}

interface StatusEntry { path: string; status: string }
const isDeletedStatus = (status: string): boolean => status.includes('D');

function parsePorcelainZ(stdout: string): StatusEntry[] {
  const tokens = stdout.split('\0');
  const entries: StatusEntry[] = [];
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index]!;
    if (token === '') continue;
    const status = token.slice(0, 2);
    entries.push({ path: token.slice(3), status });
    // rename/copy 的下一段是原路径，跳过
    if (status.includes('R') || status.includes('C')) index += 1;
  }
  return entries;
}

/** 一次 hash-object 拿到所有现存改动文件的内容指纹（删除项记 deleted） */
async function snapshotWorkTree(repo: string): Promise<{ head: string | null; files: Record<string, string> }> {
  let head: string | null = null;
  try { head = (await git(repo, ['rev-parse', 'HEAD'])).stdout.trim() || null; } catch { head = null; }
  const entries = parsePorcelainZ((await git(repo, ['status', '--porcelain=v1', '-uall', '-z'])).stdout);
  const live = entries.filter(entry => !isDeletedStatus(entry.status)).map(entry => entry.path);
  const hashes = new Map<string, string>();
  if (live.length > 0) {
    try {
      const { stdout } = await git(repo, ['hash-object', '--', ...live]);
      stdout.split('\n').filter(Boolean).forEach((hash, index) => {
        const path = live[index];
        if (path) hashes.set(path, hash.slice(0, 16));
      });
    } catch {
      // 个别路径不可读（权限/被占用）时退化为状态指纹，仍可比较出变化
    }
  }
  const files: Record<string, string> = {};
  for (const entry of entries) {
    files[entry.path] = isDeletedStatus(entry.status) ? 'deleted' : (hashes.get(entry.path) ?? `status:${entry.status.trim()}`);
  }
  return { head, files };
}

/** claim 后记录基线；任何失败都静默（不阻断领取） */
export async function captureIssueGitBaseline(db: Db, issueId: string): Promise<void> {
  try {
    const issue = getIssue(db, issueId);
    if (!issue) return;
    const workspace = getWorkspace(db, issue.workspace_id);
    if (!workspace) return;
    if (!(await isGitWorkTree(workspace.path))) return;
    const snapshot = await snapshotWorkTree(workspace.path);
    db.prepare(`INSERT OR REPLACE INTO issue_git_baseline
      (issue_id, workspace_id, head_sha, paths_json, file_count, captured_at)
      VALUES (?,?,?,?,?,?)`).run(
      issueId, issue.workspace_id, snapshot.head, JSON.stringify(snapshot.files), Object.keys(snapshot.files).length, Date.now(),
    );
  } catch {
    // 基线缺失只会让 done 跳过自动提交，不影响任务流转
  }
}

function changedPaths(baseline: Record<string, string>, current: Record<string, string>): string[] {
  const paths = new Set([...Object.keys(baseline), ...Object.keys(current)]);
  return [...paths].filter(path => baseline[path] !== current[path]).sort();
}

async function identityConfigured(repo: string): Promise<boolean> {
  for (const key of ['user.name', 'user.email']) {
    try {
      const { stdout } = await git(repo, ['config', key]);
      if (stdout.trim() === '') return false;
    } catch { return false; }
  }
  return true;
}

const firstLine = (text: string): string => text.split('\n').map(line => line.trim()).filter(Boolean)[0] ?? '未知错误';

/** 并行占用提示：同 workspace 还有其它「进行中且被占用」的任务 */
function hasParallelClaims(db: Db, workspaceId: string, issueId: string): boolean {
  const row = db.prepare(`SELECT COUNT(*) AS n FROM issue
    WHERE workspace_id=? AND id<>? AND claimed_by IS NOT NULL AND status='进行中'`).get(workspaceId, issueId) as { n: number };
  return row.n > 0;
}

/**
 * done 阶段：按基线 diff 提交本任务改动，返回要落地为评论的文本（null = 不写评论）。
 * 非仓库 / 无基线 / 无差异都返回 null 且不写评论。
 */
export async function commitIssueChanges(db: Db, issueId: string): Promise<string | null> {
  const baselineRow = db.prepare('SELECT * FROM issue_git_baseline WHERE issue_id=?').get(issueId) as BaselineRow | undefined;
  if (!baselineRow) return null;
  const finish = (text: string | null): string | null => {
    db.prepare('DELETE FROM issue_git_baseline WHERE issue_id=?').run(issueId);
    return text;
  };
  const issue = getIssue(db, issueId);
  if (!issue) return finish(null);
  const workspace = getWorkspace(db, issue.workspace_id);
  if (!workspace) return finish(null);
  const repo = workspace.path;
  if (!(await isGitWorkTree(repo))) return finish(null);

  return withAccountLock('git-commit', repo, async () => {
    try {
      const baseline = JSON.parse(baselineRow.paths_json) as Record<string, string>;
      const current = await snapshotWorkTree(repo);
      const paths = changedPaths(baseline, current.files);
      if (paths.length === 0) return finish(null);

      await git(repo, ['add', '-A', '--', ...paths]);
      const identityOk = await identityConfigured(repo);
      const message = `[${issueId.slice(0, 8)}] ${issue.title}`;
      const commitArgs = identityOk
        ? ['commit', '-m', message]
        : ['-c', `user.name=${DEFAULT_IDENTITY.name}`, '-c', `user.email=${DEFAULT_IDENTITY.email}`, 'commit', '-m', message];
      const { stdout } = await git(repo, commitArgs);
      const sha = /\[[^\]]+ ([0-9a-f]{7,40})\]/.exec(stdout)?.[1] ?? (await git(repo, ['rev-parse', '--short', 'HEAD'])).stdout.trim();

      const notes: string[] = [];
      const listed = paths.slice(0, MAX_LISTED_FILES).join('、');
      const more = paths.length > MAX_LISTED_FILES ? ` 等 ${paths.length} 个` : '';
      if (!identityOk) notes.push(`使用 ${DEFAULT_IDENTITY.name} 默认身份提交`);
      if (baselineRow.head_sha && current.head && baselineRow.head_sha !== current.head) notes.push('任务期间仓库 HEAD 已变化');
      if (hasParallelClaims(db, issue.workspace_id, issueId)) notes.push('检测到并行占用任务，本次提交可能包含并行改动');
      return finish(`已自动提交 ${paths.length} 个文件：${listed}${more}（commit ${sha.slice(0, 8)}）${notes.length > 0 ? `；${notes.join('；')}` : ''}`);
    } catch (error) {
      const detail = firstLine((error as { stderr?: string; message?: string }).stderr ?? (error as Error).message ?? '');
      return finish(`自动提交失败：${detail}（不影响待验收状态）`);
    }
  });
}

/** fail / release 分支：基线作废 */
export function dropIssueGitBaseline(db: Db, issueId: string): void {
  db.prepare('DELETE FROM issue_git_baseline WHERE issue_id=?').run(issueId);
}
