/**
 * GIT-ON-DONE：claim 记基线 → done 只提交本任务改动（失败不阻断，原因进评论）。
 *
 * 口径：
 * - 基线 = claim 时 `git status --porcelain -uall -z` 的 path→指纹；指纹为内容 hash 前 16 位，删除项记 `deleted`。
 *   `.gitignore` 忽略项 porcelain 默认不列，天然不入基线。
 * - done 时重取快照，`基线 ≠ 当前` 的路径即「本任务期间发生变化」；claim 之前就存在的改动不会进入差异集。
 * - 变化集默认不是提交集：同 workspace 有其它「进行中且被占用」的任务时，变化无法判定归属。
 *   此时只提交本任务显式声明（done body 的 `scope_paths`，文件或目录前缀）范围内的路径，
 *   越界路径一律不提交，改为系统评论列出清单交 owner 决定；未声明则不提交任何路径。
 *   无并行占用时变化集可归属本任务，按变化集提交（保持既有行为）。
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
/** 越界清单要能直接照单确认，列到 20 个后才折叠 */
const MAX_LISTED_SCOPE_VIOLATIONS = 20;
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

/**
 * 声明范围归一化：统一 `/`、去 `./` 段与尾部 `/`（`./src/` → `src`）。
 * 绝对路径、盘符路径、含 `..` 的路径丢弃——git 输出的路径都是仓库内相对路径，这类声明不可能命中。
 */
function normalizeDeclaredPaths(paths: readonly string[]): string[] {
  const normalized = new Set<string>();
  for (const raw of paths) {
    const slash = raw.trim().replace(/\\/g, '/');
    if (slash === '' || slash.startsWith('/') || /^[A-Za-z]:/.test(slash)) continue;
    const segments: string[] = [];
    let escaped = false;
    for (const segment of slash.split('/')) {
      if (segment === '' || segment === '.') continue;
      if (segment === '..') { escaped = true; break; }
      segments.push(segment);
    }
    if (!escaped && segments.length > 0) normalized.add(segments.join('/'));
  }
  return [...normalized].sort();
}

/** 命中声明范围：同路径，或声明的目录前缀（`src` 覆盖 `src/a.ts`，不覆盖 `srcx/a.ts`） */
function withinDeclaredScope(path: string, declared: readonly string[]): boolean {
  return declared.some(entry => path === entry || path.startsWith(`${entry}/`));
}

function listPaths(paths: readonly string[], limit: number): string {
  const listed = paths.slice(0, limit).join('、');
  return paths.length > limit ? `${listed} 等 ${paths.length} 个` : listed;
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

/** 并行占用提示：同 workspace 还有其它「进行中且被占用」的任务（>0 即改动归属不可判定） */
function parallelClaimCount(db: Db, workspaceId: string, issueId: string): number {
  const row = db.prepare(`SELECT COUNT(*) AS n FROM issue
    WHERE workspace_id=? AND id<>? AND claimed_by IS NOT NULL AND status='进行中'`).get(workspaceId, issueId) as { n: number };
  return row.n;
}

/**
 * 基线内且当前仍未提交的路径 = claim 之前就已修改的文件。
 * 这类路径指纹在基线与当前快照里相同，`changedPaths` 天然看不见（GIT-BASELINE-BLIND）。
 */
function preexistingDirtyPaths(baseline: Record<string, string>, current: Record<string, string>): string[] {
  return Object.keys(baseline).filter(path => current[path] !== undefined).sort();
}

/**
 * done 阶段：按基线 diff 提交本任务改动，返回要落地为评论的文本（null = 不写评论）。
 * declaredPaths 为本任务显式声明的路径（done body 的 `scope_paths`），文件或目录前缀皆可。
 *
 * 三类路径分开处理：
 * - `changed`：claim 以来指纹变化 → 本任务改动；
 * - `preexisting`：claim 前就已未提交、现在仍未提交 → 指纹相同；只有**声明范围内**的才强制提交
 *   （否则「接手遗留脏文件并收口」的卡会静默丢提交），评论里标注为强制提交；
 * - 越界或无法判定的路径一律不提交，只列清单（附可直接执行的补救命令）。
 * 非仓库 / 无基线 / 既无变化也无历史脏文件才返回 null。
 */
export async function commitIssueChanges(db: Db, issueId: string, declaredPaths: readonly string[] = []): Promise<string | null> {
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
      const changed = changedPaths(baseline, current.files);
      const declared = normalizeDeclaredPaths(declaredPaths);
      const parallel = parallelClaimCount(db, issue.workspace_id, issueId);
      const preexisting = preexistingDirtyPaths(baseline, current.files);
      const forced = declared.length === 0 ? [] : preexisting.filter(path => withinDeclaredScope(path, declared));
      const shortId = issueId.slice(0, 8);

      /** 可复制的补救命令（PowerShell / bash 都能直接粘贴执行，不使用行连接符） */
      const remedyCommand = (paths: readonly string[]): string => {
        const listed = paths.slice(0, MAX_LISTED_SCOPE_VIOLATIONS);
        const quoted = listed.map(path => (/\s|["']/.test(path) ? JSON.stringify(path) : path));
        const title = `[${shortId}] ${issue.title.replace(/"/g, '\\"')}`;
        // 用 `;` 连接：PowerShell 5.1 不支持 `&&`，bash 里 `;` 同样可用
        return `git add -- ${quoted.join(' ')}; git commit -m "${title}" -- ${quoted.join(' ')}`;
      };

      /**
       * SCOPE-GUARD：声明了 scope 但一个路径都没命中——最容易「看着 done、其实没提交」的场景。
       * 评论升级成显眼标题 + 可直接执行的补救命令；done 本身仍然成功（不把已完成的工作卡住）。
       */
      const zeroHitNote = (declaredScopes: readonly string[], pending: readonly string[]): string => [
        '⚠ 声明范围零命中，本次未自动提交（done 已生效，工作树未改动）',
        `- 声明范围：${declaredScopes.join(' / ')}`,
        `- 未提交的改动（${pending.length} 个）：${listPaths(pending, MAX_LISTED_SCOPE_VIOLATIONS)}`,
        `- 补救（可直接复制执行）：${pending.length > 0 ? remedyCommand(pending) : '（无待提交文件）'}`,
        '- 常见原因：`--scope` 用逗号串被 PowerShell 拆成多个参数、只识别到其中一段；请改成重复传参（`--scope a --scope b`）',
      ].join('\n');

      /** 未声明范围时的补救提示：给可直接执行的命令，不再静默 */
      const undeclaredNote = (paths: readonly string[]): string => {
        const listed = paths.slice(0, MAX_LISTED_SCOPE_VIOLATIONS);
        return `未提交 ${paths.length} 个 claim 前就已修改的文件（指纹未变、不在本次变化集，且未声明范围；仍在工作树）：${listPaths(paths, MAX_LISTED_SCOPE_VIOLATIONS)}\n`
          + `如需入库：git add -- ${listed.join(' ')} && git commit -m "[${shortId}] ${issue.title}" -- ${listed.join(' ')}`
          + '；或重新 done 时用 scope_paths 声明这些路径';
      };

      // 并行占用且未声明范围：改动归属不可判定，任何路径都不提交，只把清单交 owner
      if (declared.length === 0 && parallel > 0) {
        const pending = [...new Set([...changed, ...preexisting])].sort();
        if (pending.length === 0) return finish(null);
        return finish(`检测到 ${parallel} 个并行占用任务，无法判定 ${pending.length} 个改动的归属，本次未自动提交（改动仍在工作树，需 owner 确认；done 时用 scope_paths 声明本任务路径即可按范围提交）：${listPaths(pending, MAX_LISTED_SCOPE_VIOLATIONS)}`);
      }

      // 无并行占用 → 变化集即本任务改动；有声明 → 只认声明范围内的路径
      const inScope = declared.length === 0 ? changed : changed.filter(path => withinDeclaredScope(path, declared));
      const violations = declared.length === 0 ? [] : changed.filter(path => !withinDeclaredScope(path, declared));
      const violationNote = violations.length === 0
        ? null
        : `未提交 ${violations.length} 个不在本任务声明范围内的改动（仍在工作树，需 owner 确认）：${listPaths(violations, MAX_LISTED_SCOPE_VIOLATIONS)}`;
      const paths = [...new Set([...inScope, ...forced])].sort();

      if (paths.length === 0) {
        // 没有可提交路径时也必须开口：基线内未提交文件不得再静默跳过
        if (declared.length === 0) return finish(preexisting.length > 0 ? undeclaredNote(preexisting) : null);
        // SCOPE-GUARD：声明了范围却零命中 → 显眼标题 + 可复制的补救命令
        const outOfScopePreexisting = preexisting.filter(path => !withinDeclaredScope(path, declared));
        const pending = [...new Set([...violations, ...outOfScopePreexisting])].sort();
        return finish(zeroHitNote(declared, pending));
      }

      await git(repo, ['add', '-A', '--', ...paths]);
      const identityOk = await identityConfigured(repo);
      const message = `[${shortId}] ${issue.title}`;
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
      const commitNote = `已自动提交 ${paths.length} 个文件：${listed}${more}（commit ${sha.slice(0, 8)}）${notes.length > 0 ? `；${notes.join('；')}` : ''}`;
      const forcedNote = forced.length === 0
        ? null
        : `其中 ${forced.length} 个是 claim 前就已修改（基线内未提交）、按声明范围强制提交：${listPaths(forced, MAX_LISTED_SCOPE_VIOLATIONS)}`;
      return finish([commitNote, forcedNote, violationNote].filter(Boolean).join('\n'));
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
