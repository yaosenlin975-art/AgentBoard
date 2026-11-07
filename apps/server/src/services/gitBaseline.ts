/**
 * GIT-ON-DONE：claim 记基线 → done 只提交本任务改动（失败不阻断，原因进评论）。
 *
 * 口径：
 * - 基线 = claim 时 `git status --porcelain -uall -z` 的 path→指纹；指纹为内容 hash 前 16 位，删除项记 `deleted`。
 *   `.gitignore` 忽略项 porcelain 默认不列，天然不入基线。
 * - done 时重取快照，`基线 ≠ 当前` 的路径即「本任务期间发生变化」；claim 之前就存在的改动不会进入差异集。
 * - 提交集只看本任务声明的目标文件集（done body 的 `scope_paths`，文件或目录前缀）：
 *   与当前未提交路径取交集，卡外改动一律不提交，改为系统评论列出清单交 owner 处理；
 *   要连同卡外改动一起入库，必须显式声明工作区根（`--all` → `.`）。
 *   未声明范围（老卡）时只提交 claim 基线变化集，并在评论里显式警告「无法排除他人同期改动」
 *   （claim 前就已脏且未变化的文件仍不纳入）；同 workspace 有其它并行占用时仍一律不提交。
 *   本卡声明范围内、claim 前就已脏且未变化的文件按声明强制提交（否则接手遗留脏文件的卡会静默丢提交）。
 * - 只用 `git add -A -- <paths>`（同时覆盖修改与删除）并配合**路径限定 commit**（`git commit -- <paths>`），
 *   绝不 `git add -A` 全量，也绝不整索引提交（避免把别的卡已暂存的改动卷进来）。
 * - 提交身份：`git config user.name/email`（局部优先于全局，git 自身解析）都配好则尊重仓库身份；
 *   缺任一才用 `-c user.name=AgentBoard -c user.email=agentboard@local`，并在评论注明。
 * - 全程 `execFile('git', [...])`，标题等动态内容作为单个 `-m` 参数，不经 shell。
 */
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
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
  /** BORROW-2.3：claim 时捕获的领取者；done 已清空 issue.claimed_by 后仍可写入 trailer */
  claimed_by: string | null;
}

/** BORROW-2.3：提交信息里的可解析 trailer（旧提交没有这两行，解析为 null 而不是报错） */
export interface CommitTrailers {
  issueId: string | null;
  claim: string | null;
}

export function parseCommitTrailers(message: string): CommitTrailers {
  let issueId: string | null = null;
  let claim: string | null = null;
  for (const rawLine of message.split('\n')) {
    const match = /^(AgentBoard-Issue|AgentBoard-Claim):\s*(.*)$/.exec(rawLine.trim());
    if (match === null) continue;
    const value = match[2]!.trim();
    if (value === '') continue;
    if (match[1] === 'AgentBoard-Issue') issueId = value;
    else claim = value;
  }
  return { issueId, claim };
}

async function git(cwd: string, args: string[]): Promise<{ stdout: string; stderr: string }> {
  const { stdout, stderr } = await run('git', args, { cwd, timeout: GIT_TIMEOUT_MS, maxBuffer: 8 * 1024 * 1024, windowsHide: true });
  return { stdout, stderr };
}

/**
 * GIT-DETECT：三种「不能自动提交」的原因必须分开报，否则容器里缺 git 会被误诊成「不是仓库」。
 * - git-missing：`git --version` 失败（ENOENT 等）→ 环境未安装 git
 * - not-a-repo：git 有，但 `rev-parse --is-inside-work-tree` 不成立 / 目录不存在 → 需要 git init
 * - unhealthy：是仓库，但 `git status` 失败（HEAD/index 损坏、权限）→ 保留具体错误
 */
export type GitRepoKind = 'repo' | 'git-missing' | 'not-a-repo' | 'unhealthy';

export interface GitRepoState {
  kind: GitRepoKind;
  detail?: string;
}

/** 可注入的 git 执行器（单测注入模拟结果，不真的卸载 git） */
export type GitRunner = (cwd: string, args: string[]) => Promise<{ stdout: string; stderr: string }>;

const defaultGitRunner: GitRunner = (cwd, args) => git(cwd, args);

/** 从 execFile 的失败里取可读原因（优先 stderr，截断避免超长评论） */
function gitErrorText(error: unknown): string {
  const shaped = error as { code?: string; stderr?: string; message?: string };
  const text = (shaped?.stderr ?? '').trim() || shaped?.message || String(error);
  return text.replace(/\s+/g, ' ').slice(0, 300);
}

export async function detectGitRepo(path: string, runner: GitRunner = defaultGitRunner): Promise<GitRepoState> {
  if (!existsSync(path)) return { kind: 'not-a-repo', detail: `目录不存在：${path}` };
  try {
    await runner(path, ['--version']);
  } catch (error) {
    return { kind: 'git-missing', detail: gitErrorText(error) };
  }
  try {
    const { stdout } = await runner(path, ['rev-parse', '--is-inside-work-tree']);
    if (stdout.trim() !== 'true') return { kind: 'not-a-repo', detail: 'rev-parse --is-inside-work-tree 未返回 true' };
  } catch (error) {
    return { kind: 'not-a-repo', detail: gitErrorText(error) };
  }
  try {
    await runner(path, ['status', '--porcelain=v1', '-uall', '-z']);
  } catch (error) {
    return { kind: 'unhealthy', detail: gitErrorText(error) };
  }
  return { kind: 'repo' };
}

/** 只在「确实是健康 git 工作树」时返回 true */
async function isGitWorkTree(path: string): Promise<boolean> {
  return (await detectGitRepo(path)).kind === 'repo';
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
      (issue_id, workspace_id, head_sha, paths_json, file_count, captured_at, claimed_by)
      VALUES (?,?,?,?,?,?,?)`).run(
      issueId, issue.workspace_id, snapshot.head, JSON.stringify(snapshot.files), Object.keys(snapshot.files).length, Date.now(),
      issue.claimed_by ?? null,
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
 * 工作区根声明标记：`--all` 由 CLI 映射成 `.`，归一化后记为 `ROOT_SCOPE`，表示「整个工作区」。
 * 空串不是合法路径，不会与真实文件冲突。
 */
const ROOT_SCOPE = '';

/**
 * 声明范围归一化：统一 `/`、去 `./` 段与尾部 `/`（`./src/` → `src`）。
 * 绝对路径、盘符路径、含 `..` 的路径丢弃——git 输出的路径都是仓库内相对路径，这类声明不可能命中。
 * 只声明 `.` / `./` 视为工作区根（`--all` 口径）。
 */
function normalizeDeclaredPaths(paths: readonly string[]): string[] {
  const normalized = new Set<string>();
  let root = false;
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
    if (escaped) continue;
    if (segments.length === 0) root = true;
    else normalized.add(segments.join('/'));
  }
  const list = [...normalized].sort();
  return root ? [ROOT_SCOPE, ...list] : list;
}

/** 命中声明范围：工作区根声明命中一切；否则同路径，或声明的目录前缀（`src` 覆盖 `src/a.ts`，不覆盖 `srcx/a.ts`） */
function withinDeclaredScope(path: string, declared: readonly string[]): boolean {
  if (declared.includes(ROOT_SCOPE)) return true;
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
 * 基线内且当前指纹完全一致的路径 = claim 之前就已修改、本任务期间没再动过的文件。
 * 这类路径 `changedPaths` 天然看不见（GIT-BASELINE-BLIND），只有在本卡声明范围内才强制提交。
 */
function preexistingDirtyPaths(baseline: Record<string, string>, current: Record<string, string>): string[] {
  return Object.keys(baseline).filter(path => current[path] === baseline[path]).sort();
}

/**
 * GIT-OBSERVABLE（卡 9fa0d16f）：done 自动提交的结果必须让调用方可感知。
 * - committed：本次确有变动并已提交（卡外改动只列清单，不影响本状态）；
 * - nothing：无基线变动、无声明范围内脏文件，或有前置条件不满足但没有待提交内容；
 * - not-committed：有声明范围内的改动但本次没提交（无基线 / 提交失败 / scope 零命中 / 并行占用未声明）；
 * - unavailable：仓库不可用（未装 git / 非仓库 / 仓库损坏），自动提交不适用，与「提交失败」分开报。
 */
export type IssueCommitStatus = 'committed' | 'nothing' | 'not-committed' | 'unavailable';

export type IssueCommitReason =
  | 'NO_BASELINE'
  | 'COMMIT_FAILED'
  | 'ZERO_HIT'
  | 'PARALLEL_UNDECLARED'
  | 'UNDECLARED_PREEXISTING'
  | 'GIT_NOT_INSTALLED'
  | 'NOT_A_GIT_REPO'
  | 'GIT_REPO_UNHEALTHY';

export interface IssueCommitResult {
  status: IssueCommitStatus;
  reason: IssueCommitReason | null;
  /** 要落成系统评论的文本（null = 不写评论） */
  note: string | null;
  /** not-committed 时仍未提交的路径（声明范围内；未声明=全部脏文件；ZERO_HIT=声明范围外的脏文件） */
  pending: string[];
}

const NOTHING: IssueCommitResult = { status: 'nothing', reason: null, note: null, pending: [] };

/** 本任务 git 处理收尾：清基线（不存在时 DELETE 为 no-op），返回结构化结果 */
function dropAndNull(db: Db, issueId: string, result: Partial<IssueCommitResult> = {}): IssueCommitResult {
  db.prepare('DELETE FROM issue_git_baseline WHERE issue_id=?').run(issueId);
  return { ...NOTHING, ...result };
}

/** 读取基线（不存在时 exists=false，调用方据此区分「无基线」与「无改动」） */
function baselineRowOf(db: Db, issueId: string): {
  exists: boolean;
  paths: Record<string, string>;
  claimedBy: string | null;
  headSha: string | null;
} {
  const row = db.prepare('SELECT * FROM issue_git_baseline WHERE issue_id=?').get(issueId) as BaselineRow | undefined;
  if (!row) return { exists: false, paths: {}, claimedBy: null, headSha: null };
  return {
    exists: true,
    paths: JSON.parse(row.paths_json) as Record<string, string>,
    claimedBy: row.claimed_by,
    headSha: row.head_sha,
  };
}
/**
 * done 阶段：按基线 diff 提交本任务改动，返回结构化结果（调用方据此判断「是否真的提交了」）。
 * declaredPaths 为本任务显式声明的路径（done body 的 `scope_paths`），文件或目录前缀皆可。
 *
 * 三类路径分开处理：
 * - `changed`：claim 以来指纹变化 → 本任务改动；
 * - `preexisting`：claim 前就已未提交、现在仍未提交 → 指纹相同；只有**声明范围内**的才强制提交
 *   （否则「接手遗留脏文件并收口」的卡会静默丢提交），评论里标注为强制提交；
 * - 越界或无法判定的路径一律不提交，只列清单（附可直接执行的补救命令）。
 * 无基线 / 有改动但提交失败 / scope 零命中 / 并行占用未声明 → `not-committed` + 原因码 + 补救命令。
 */
export async function commitIssueChanges(
  db: Db,
  issueId: string,
  declaredPaths: readonly string[] = [],
  options: { git?: GitRunner } = {},
): Promise<IssueCommitResult> {
  const issue = getIssue(db, issueId);
  if (!issue) return dropAndNull(db, issueId);
  const workspace = getWorkspace(db, issue.workspace_id);
  if (!workspace) return dropAndNull(db, issueId);
  const repo = workspace.path;
  const declared = normalizeDeclaredPaths(declaredPaths);
  /** `--all`（CLI 映射成 `.`）：显式声明工作区根，才允许纳入卡外改动 */
  const declaredAll = declared.includes(ROOT_SCOPE);
  const scopeLine = `声明范围：${declaredAll ? '（工作区根 .）' : declared.length > 0 ? declared.join(' / ') : '（未声明）'}`;
  const shortId = issueId.slice(0, 8);

  /** 可复制的补救命令（PowerShell / bash 都能直接粘贴执行，不使用行连接符） */
  const remedyCommand = (paths: readonly string[]): string => {
    const listed = paths.slice(0, MAX_LISTED_SCOPE_VIOLATIONS);
    const quoted = listed.map(path => (/\s|["']/.test(path) ? JSON.stringify(path) : path));
    const title = `[${shortId}] ${issue.title.replace(/"/g, '\\"')}`;
    // 用 `;` 连接：PowerShell 5.1 不支持 `&&`，bash 里 `;` 同样可用
    return `git add -- ${quoted.join(' ')}; git commit -m "${title}" -- ${quoted.join(' ')}`;
  };

  // 不能自动提交：不再静默跳过，落一行系统评论并回显声明范围（否则「done 成功但没提交」无从判断）。
  // GIT-DETECT：三种原因分开报——容器里缺 git 与「目录没 git init」的处置方式完全不同。
  const gitState = await detectGitRepo(repo, options.git ?? defaultGitRunner);
  if (gitState.kind !== 'repo') {
    const detail = gitState.detail !== undefined ? `：${gitState.detail}` : '';
    const reasonCode: IssueCommitReason = gitState.kind === 'git-missing'
      ? 'GIT_NOT_INSTALLED'
      : gitState.kind === 'not-a-repo'
        ? 'NOT_A_GIT_REPO'
        : 'GIT_REPO_UNHEALTHY';
    const reason = gitState.kind === 'git-missing'
      ? `跳过自动提交：环境未安装 git（GIT_NOT_INSTALLED，${repo}）`
      : gitState.kind === 'not-a-repo'
        ? `跳过自动提交：工作区不是 git 仓库（NOT_A_GIT_REPO，${repo}），如需自动提交请在该目录 git init`
        : `跳过自动提交：git 仓库状态异常（GIT_REPO_UNHEALTHY，${repo}）${detail}`;
    return dropAndNull(db, issueId, { status: 'unavailable', reason: reasonCode, note: `${reason}；${scopeLine}` });
  }

  return withAccountLock('git-commit', repo, async () => {
    /** 提交失败时用于补救的候选路径（声明范围内仍脏的路径） */
    let pendingOnFailure: string[] = [];
    try {
      const current = await snapshotWorkTree(repo);
      const baselineRow = baselineRowOf(db, issueId);
      /** 当前全部未提交路径（porcelain -uall，含删除项）＝ 卡内/卡外比对的基准 */
      const dirty = Object.keys(current.files).sort();
      pendingOnFailure = declaredAll || declared.length === 0
        ? dirty
        : dirty.filter(path => withinDeclaredScope(path, declared));

      if (!baselineRow.exists) {
        // GIT-OBSERVABLE：无基线不再静默早退——有脏文件就必须让调用方知道「这次没提交」
        if (pendingOnFailure.length === 0) return dropAndNull(db, issueId);
        return dropAndNull(db, issueId, {
          status: 'not-committed',
          reason: 'NO_BASELINE',
          pending: pendingOnFailure,
          note: [
            '⚠ 无 claim 基线，本次未自动提交（done 已生效，工作树未改动）',
            `- ${scopeLine}`,
            `- 未提交的改动（${pendingOnFailure.length} 个）：${listPaths(pendingOnFailure, MAX_LISTED_SCOPE_VIOLATIONS)}`,
            '- 原因：claim 时未记录基线（仓库不可用 / 写入失败），或该卡曾被租约清扫（清扫不再删基线，历史卡仍可能缺失）；done 无法判断哪些改动属于本卡，故跳过提交。',
            `- 补救（可直接复制执行）：${remedyCommand(pendingOnFailure)}`,
          ].join('\n'),
        });
      }
      const baseline = baselineRow.paths;
      const changed = changedPaths(baseline, current.files);
      const parallel = parallelClaimCount(db, issue.workspace_id, issueId);
      const preexisting = preexistingDirtyPaths(baseline, current.files);
      const forced = declared.length === 0 ? [] : preexisting.filter(path => withinDeclaredScope(path, declared));

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
          + `如需入库：git add -- ${listed.join(' ')}; git commit -m "[${shortId}] ${issue.title}" -- ${listed.join(' ')}`
          + '；或重新 done 时用 scope_paths 声明这些路径';
      };

      // 并行占用且未声明范围：改动归属不可判定，任何路径都不提交，只把清单交 owner
      if (declared.length === 0 && !declaredAll && parallel > 0) {
        const pending = [...new Set([...changed, ...preexisting])].sort();
        if (pending.length === 0) return dropAndNull(db, issueId);
        return dropAndNull(db, issueId, {
          status: 'not-committed',
          reason: 'PARALLEL_UNDECLARED',
          pending,
          note: `检测到 ${parallel} 个并行占用任务，无法判定 ${pending.length} 个改动的归属，本次未自动提交（改动仍在工作树，需 owner 确认；done 时用 scope_paths 声明本任务路径即可按范围提交）：${listPaths(pending, MAX_LISTED_SCOPE_VIOLATIONS)}`,
        });
      }

      // 提交集 = 本卡目标文件集 ∩ 当前未提交路径；卡外改动只列清单，默认不纳入
      const outsideNote = (paths: readonly string[]): string =>
        `卡外改动未提交（${paths.length} 个，仍在工作树，需 owner 处理；要一并纳入请显式 --all）：${listPaths(paths, MAX_LISTED_SCOPE_VIOLATIONS)}`;
      const undeclaredWarn = (committed: readonly string[], skipped: readonly string[]): string =>
        `⚠ 未声明目标文件集（旧卡口径）：已按 claim 基线变化集提交 ${committed.length} 个文件，无法排除他人同期改动`
        + `；另有 ${skipped.length} 个未提交${skipped.length > 0 ? `：${listPaths(skipped, MAX_LISTED_SCOPE_VIOLATIONS)}` : ''}`
        + '。下次收尾请用 --scope 声明本卡文件集';

      let paths: string[];
      let policyNotes: string[];
      if (declaredAll) {
        // 显式 --all：只影响「纳入全部未提交改动」，仍然按路径限定提交
        paths = dirty;
        policyNotes = [`⚠ --all：显式纳入工作区全部未提交改动 ${dirty.length} 个：${listPaths(dirty, MAX_LISTED_SCOPE_VIOLATIONS)}`];
      } else if (declared.length > 0) {
        const outside = dirty.filter(path => !withinDeclaredScope(path, declared));
        paths = dirty.filter(path => withinDeclaredScope(path, declared));
        // SCOPE-GUARD：声明了范围却零命中 → 显眼标题 + 可复制的补救命令
        if (paths.length === 0) {
          return dropAndNull(db, issueId, {
            status: 'not-committed',
            reason: 'ZERO_HIT',
            note: zeroHitNote(declared, outside),
            pending: outside,
          });
        }
        policyNotes = outside.length === 0 ? [] : [outsideNote(outside)];
      } else {
        // 老卡无声明：只提交 claim 基线变化集（claim 前就已脏且未变化的文件仍不纳入），并显式警告
        paths = changed;
        if (paths.length === 0) {
          return dropAndNull(db, issueId, preexisting.length > 0
            ? { status: 'not-committed', reason: 'UNDECLARED_PREEXISTING', note: undeclaredNote(preexisting), pending: preexisting }
            : {});
        }
        policyNotes = [undeclaredWarn(paths, dirty.filter(path => !changed.includes(path)))];
      }
      pendingOnFailure = paths;

      await git(repo, ['add', '-A', '--', ...paths]);
      const identityOk = await identityConfigured(repo);
      // BORROW-2.3：trailer 记录卡片与领取者；领取者取 claim 时写入基线的值（done 流转已清空 issue.claimed_by）
      const trailerLines = [`AgentBoard-Issue: ${issueId}`];
      const claimer = (baselineRow.claimedBy ?? '').trim();
      if (claimer !== '') trailerLines.push(`AgentBoard-Claim: ${claimer}`);
      const message = `[${shortId}] ${issue.title}\n\n${trailerLines.join('\n')}`;
      // 路径限定 commit：只提交本次 stage 的 paths，不把其它卡已暂存（但未被本卡处理）的改动卷进来
      const commitArgs = identityOk
        ? ['commit', '-m', message, '--', ...paths]
        : ['-c', `user.name=${DEFAULT_IDENTITY.name}`, '-c', `user.email=${DEFAULT_IDENTITY.email}`, 'commit', '-m', message, '--', ...paths];
      const { stdout } = await git(repo, commitArgs);
      const sha = /\[[^\]]+ ([0-9a-f]{7,40})\]/.exec(stdout)?.[1] ?? (await git(repo, ['rev-parse', '--short', 'HEAD'])).stdout.trim();

      const notes: string[] = [];
      const listed = paths.slice(0, MAX_LISTED_FILES).join('、');
      const more = paths.length > MAX_LISTED_FILES ? ` 等 ${paths.length} 个` : '';
      if (!identityOk) notes.push(`使用 ${DEFAULT_IDENTITY.name} 默认身份提交`);
      if (baselineRow.headSha && current.head && baselineRow.headSha !== current.head) notes.push('任务期间仓库 HEAD 已变化');
      const commitNote = `已自动提交 ${paths.length} 个文件：${listed}${more}（commit ${sha.slice(0, 8)}）${notes.length > 0 ? `；${notes.join('；')}` : ''}`;
      const forcedNote = forced.length === 0
        ? null
        : `其中 ${forced.length} 个是 claim 前就已修改（基线内未提交）、按声明范围强制提交：${listPaths(forced, MAX_LISTED_SCOPE_VIOLATIONS)}`;
      const lines = [commitNote, forcedNote, ...policyNotes].filter((line): line is string => typeof line === 'string');
      return dropAndNull(db, issueId, { status: 'committed', note: lines.join('\n') });
    } catch (error) {
      const detail = firstLine((error as { stderr?: string; message?: string }).stderr ?? (error as Error).message ?? '');
      return dropAndNull(db, issueId, {
        status: 'not-committed',
        reason: 'COMMIT_FAILED',
        pending: pendingOnFailure,
        note: `自动提交失败：${detail}（不影响待验收状态）`
          + (pendingOnFailure.length > 0
            ? `\n- 未提交的改动（${pendingOnFailure.length} 个）：${listPaths(pendingOnFailure, MAX_LISTED_SCOPE_VIOLATIONS)}\n- 补救（可直接复制执行）：${remedyCommand(pendingOnFailure)}`
            : ''),
      });
    }
  });
}

/** fail / release 分支：基线作废 */
export function dropIssueGitBaseline(db: Db, issueId: string): void {
  db.prepare('DELETE FROM issue_git_baseline WHERE issue_id=?').run(issueId);
}
