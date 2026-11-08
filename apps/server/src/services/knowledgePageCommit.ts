/**
 * BORROW-5.1（决策 c0cb9509 → 选项 A）：知识页每次 create/revise/archive 在 git 里留一次可追溯提交。
 *
 * 知识页正文平时只在库里；这里在写操作成功后额外落一份**每页一份**的可读快照
 * `<ws>/.agentboard/snapshot/knowledge/<page_id>.md`（front matter + 正文），
 * 并只提交这一个路径（`git commit -- <path>`），因此：
 * - 一次写操作 = 一次提交，且提交只含该页路径（卡面验收 1）；
 * - 先写文件再提交，文件内容与提交严格同源（验收 2「快照与提交顺序一致」）；
 * - 文件写入或 git 失败时回滚到改动前（新建的删掉、已有的还原），不留半提交（验收 3）。
 *
 * 状态规则：
 * - active / archived / restore：重写同一路径，front matter 的 `status` 如实反映归档态；
 * - 软删（status='deleted'）：撤掉该页快照并提交删除，避免留一份可读的已删正文；
 * - 批量导入（`/pages/import`）不接线：一次请求会写多页，逐页提交与「只含该页路径」冲突；
 *   响应以 `IMPORT_BATCH_COMMIT_SKIPPED`（committed=false + skipped=true）显式标记该跳过（KB-SNAP-IMPORT 方案 3），不是失败。
 *
 * 该快照是派生物：库仍是唯一事实源，删掉文件不影响数据；提交失败也不影响知识页写入本身。
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative } from 'node:path';
import type { Db } from '../db/connection.js';
import { getWorkspace } from '../db/repos/workspace.js';
import { workspaceStateDir } from '../db/resolver.js';

export interface PageSnapshotContent {
  id: string;
  slug: string;
  title: string;
  scope: string;
  revision: number;
  body_md: string;
  /** 页面状态（active/archived/deleted）：归档后快照保留但 front matter 如实标注，避免被当活跃页读 */
  status?: string | null;
  updated_at?: number | null;
}

export interface PageCommitResult {
  /** 绝对路径（快照文件） */
  path: string;
  /** 相对工作区根，git 用的路径 */
  relative_path: string;
  committed: boolean;
  commit: string | null;
  /** committed=false 时的原因（含没落盘的情况） */
  reason: string | null;
  /**
   * committed=false 但**不是失败**（无快照可提交 / 无变更）：调用方不应报警或判失败。
   * 缺失视为 false（真实失败），保持对旧客户端的兼容语义。
   */
  skipped?: boolean;
  /**
   * KB-SNAP-ROLLBACK：失败回滚自身也失败（还原快照文件 / 清暂存失败），属双重失败——
   * 工作树或索引可能残留该页路径，被后续不带路径限定的提交卷走。原因拼进 `reason`（`；回滚失败（<动作>）：<git stderr>`），
   * 并 console.error 留痕（含 relative_path）。缺失/false 表示回滚成功或无需回滚；不重试，可观测优先。
   */
  rollback_failed?: boolean;
}

/** 每页快照文件路径：`<ws>/.agentboard/snapshot/knowledge/<page_id>.md` */
export function knowledgePageSnapshotPath(workspacePath: string, pageId: string): string {
  return join(workspaceStateDir(workspacePath), 'snapshot', 'knowledge', `${pageId}.md`);
}

/** front matter + 正文；字段顺序固定，保证同一 revision 重复渲染逐字节一致 */
export function renderKnowledgePageSnapshot(page: PageSnapshotContent): string {
  const front = [
    '---',
    `id: ${page.id}`,
    `slug: ${page.slug}`,
    `title: ${page.title}`,
    `scope: ${page.scope}`,
    `revision: ${page.revision}`,
    `status: ${page.status ?? 'active'}`,
    ...(page.updated_at === undefined || page.updated_at === null ? [] : [`updated_at: ${new Date(page.updated_at).toISOString()}`]),
    '---',
  ].join('\n');
  const body = page.body_md.endsWith('\n') ? page.body_md : `${page.body_md}\n`;
  return `${front}\n\n${body}`;
}

const git = (cwd: string, args: string[]): string =>
  execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

/** 原样输出（不 trim）：校验暂存内容时必须逐字节比对，trim 会吃掉首尾空行 */
const gitRaw = (cwd: string, args: string[]): string =>
  execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

/**
 * GIT-SNAPSHOT-CHECK（卡 9fa0d16f）：快照正文只能是 DB 权威正文的渲染结果。
 * 多会话共用工作树时，`git stash pop` 等操作可能在「写文件」与「git add/commit」之间把冲突标记写进同一路径
 * （2026-11-07 现场：快照提交里出现了 `<<<<<<<`），因此落盘后与暂存后都要复核。
 */
const CONFLICT_MARKER = /^(<{7}|={7,}|>{7})(\s|$)/;

/** 返回命中的冲突标记行（截断到 40 字符）；无命中返回 null */
export function findConflictMarker(text: string): string | null {
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trimStart();
    if (CONFLICT_MARKER.test(trimmed)) return trimmed.slice(0, 40);
  }
  return null;
}

/** git 可能按 .gitattributes/autocrlf 归一换行；比对前统一成 LF，避免环境差异造成假失败 */
const normalizeNewlines = (text: string): string => text.replace(/\r\n/g, '\n');

/**
 * 仓库没配 user.name / user.email 时补上兜底身份（与 GIT-ON-DONE 同口径：局部/全局都没配才补）。
 * 不覆盖已有身份，避免改写用户的提交署名。
 */
function identityArgs(cwd: string): string[] {
  const has = (key: string): boolean => {
    try { return git(cwd, ['config', key]) !== ''; } catch { return false; }
  };
  return has('user.name') && has('user.email')
    ? []
    : ['-c', 'user.name=AgentBoard', '-c', 'user.email=agentboard@local'];
}

/** 提交失败时尽力把索引恢复原状，避免留下「文件回滚了但内容仍在暂存区」的半状态；失败向上抛，由回滚块并入 rollback_failed 信号 */
function resetIndex(cwd: string, relativePath: string): void {
  git(cwd, ['reset', '-q', 'HEAD', '--', relativePath]);
}

/**
 * KB-SNAP-ROLLBACK：回滚失败的唯一出口——标记 rollback_failed、把原因拼进 reason、console.error 留痕（含 relative_path）。
 * 不重试：双重失败时静默重试只会把问题埋深，可观测优先。
 */
function noteRollbackFailure(result: PageCommitResult, action: string, error: unknown): void {
  result.rollback_failed = true;
  const detail = `回滚失败（${action}）：${failureReason(error)}`;
  result.reason = result.reason === null ? detail : `${result.reason}；${detail}`;
  console.error(
    `[knowledge-snapshot] ${result.relative_path || '(路径未知)'} ${detail}——索引/工作树可能残留该页路径，请人工检查 git status`,
  );
}

/**
 * 失败回滚：新建的删掉、已有的还原，再清掉本 run 暂存的路径。
 * 任一步失败都经 noteRollbackFailure 显式留痕（不抛）；`added=false`（git add 尚未成功）时索引里没有本 run 的内容，
 * 不调 reset 也不把 reset 失败算回滚失败——此时 reset 失败（如 index.lock 未释放）是噪音，不能污染「单失败」语义。
 */
function rollbackSnapshot(result: PageCommitResult, options: {
  path: string;
  previous: string | null;
  workspacePath: string;
  relativePath: string;
  added: boolean;
}): void {
  const { path, previous, workspacePath, relativePath, added } = options;
  try {
    if (previous === null) rmSync(path, { force: true });
    else writeFileSync(path, previous, 'utf8');
  } catch (error) {
    noteRollbackFailure(result, '还原快照文件', error);
  }
  if (!added) return;
  try {
    resetIndex(workspacePath, relativePath);
  } catch (error) {
    noteRollbackFailure(result, '清暂存', error);
  }
}

/** 提交后回读 HEAD 简写；取不到时返回 null 而不是伪装成功 */
function headShort(cwd: string): string | null {
  try { return git(cwd, ['rev-parse', '--short', 'HEAD']); } catch { return null; }
}

/**
 * 失败原因：优先取 git stderr 的首行（如 `fatal: Unable to create '...index.lock': File exists`）。
 * `execFileSync` 抛出的 Error.message 首行是 `Command failed: git add ...`，只取 message 会丢掉真正原因
 * （2026-11-07 现场：快照没落盘时 reason 只有命令行，看不出 index.lock 冲突）。
 */
function failureReason(error: unknown): string {
  const stderr = (error as { stderr?: unknown } | null)?.stderr;
  const text = typeof stderr === 'string' ? stderr : Buffer.isBuffer(stderr) ? stderr.toString('utf8') : '';
  const first = text.split('\n').map((line) => line.trim()).filter(Boolean)[0];
  if (first) return first;
  const message = error instanceof Error ? error.message : String(error);
  return message.split('\n')[0]!.trim();
}

/**
 * 落盘 + 提交该页快照；任一步失败都把文件回滚到改动前，并写明原因。
 * 不抛错（调用方是知识页写操作的收尾动作，不能因为派生物失败让数据写失败）。
 */
export function commitKnowledgePageSnapshot(workspacePath: string, page: PageSnapshotContent): PageCommitResult {
  const path = knowledgePageSnapshotPath(workspacePath, page.id);
  const relativePath = relative(workspacePath, path).split('\\').join('/');
  const previous = existsSync(path) ? readFileSync(path, 'utf8') : null;
  const result: PageCommitResult = { path, relative_path: relativePath, committed: false, commit: null, reason: null };
  const content = renderKnowledgePageSnapshot(page);
  let stage = '权威正文自检';
  // KB-SNAP-ROLLBACK：git add 是否已成功（成功后才需要在回滚时清暂存；失败时索引里没有本 run 的内容）
  let added = false;

  // 正文来源只能是 DB 行（page.body_md）；先自检再落盘，避免把库里的脏正文写成快照
  const bodyMarker = findConflictMarker(page.body_md);
  if (bodyMarker !== null) {
    result.reason = `${stage} 失败：DB 正文含冲突标记「${bodyMarker}」，拒绝落盘`;
    return result;
  }

  try {
    stage = '写入快照文件';
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, content, 'utf8');
    // 落盘后回读：确认工作树上的文件就是权威正文渲染结果（防写盘后被并发改写）
    stage = '快照回读校验';
    const readBack = readFileSync(path, 'utf8');
    const readMarker = findConflictMarker(readBack);
    if (readMarker !== null) throw new Error(`落盘快照含冲突标记「${readMarker}」，疑似多会话并发改写`);
    if (readBack !== content) throw new Error('落盘快照与 DB 权威正文不一致（疑似多会话并发改写）');
    stage = 'git add';
    git(workspacePath, ['add', '-A', '--', relativePath]);
    added = true;
    // 暂存后复核：commit -- <path> 提交的是索引内容，必须与权威正文逐字节一致
    stage = '暂存内容校验';
    const stagedBlob = gitRaw(workspacePath, ['show', `:${relativePath}`]);
    const stagedMarker = findConflictMarker(stagedBlob);
    if (stagedMarker !== null) throw new Error(`暂存快照含冲突标记「${stagedMarker}」，拒绝提交`);
    if (normalizeNewlines(stagedBlob) !== normalizeNewlines(content)) throw new Error('暂存快照与 DB 权威正文不一致（索引被并发改写）');
    // 内容没变化（例如只改了不进快照的分类字段）时不强行造空提交
    stage = 'git status';
    const staged = git(workspacePath, ['status', '--porcelain', '--', relativePath]);
    if (staged === '' && git(workspacePath, ['log', '-1', '--format=%H', '--', relativePath]) !== '') {
      result.committed = true;
      result.commit = headShort(workspacePath);
      return result;
    }
    stage = 'git commit';
    git(workspacePath, ['commit', ...identityArgs(workspacePath), '-m', `knowledge(${page.slug}): r${page.revision} ${page.title}`, '--', relativePath]);
    result.committed = true;
    result.commit = headShort(workspacePath);
    return result;
  } catch (error) {
    result.reason = `${stage} 失败：${failureReason(error)}`;
    // KB-SNAP-ROLLBACK：回滚（新建的删掉、已有的还原、清掉本 run 暂存）自身失败时显式留痕，不再空吞
    rollbackSnapshot(result, { path, previous, workspacePath, relativePath, added });
    return result;
  }
}

/**
 * 软删（status='deleted'）时撤掉该页快照：库已把页面视为不存在，留一份可读正文等于泄漏已删内容。
 * 文件先删、再提交删除；git 失败不回滚文件（库是事实源，删除态优先），只在 reason 里说明。
 */
export function removeKnowledgePageSnapshot(workspacePath: string, page: Pick<PageSnapshotContent, 'id' | 'slug' | 'title'>): PageCommitResult {
  const path = knowledgePageSnapshotPath(workspacePath, page.id);
  const relativePath = relative(workspacePath, path).split('\\').join('/');
  const result: PageCommitResult = { path, relative_path: relativePath, committed: false, commit: null, reason: null };
  if (!existsSync(path)) {
    result.reason = '快照文件不存在，无需提交删除';
    result.skipped = true;
    return result;
  }
  let stage = '删除快照文件';
  // KB-SNAP-ROLLBACK：git add 是否已成功（删除提交失败时索引里有已暂存的删除，回滚要清掉）
  let added = false;
  try {
    rmSync(path, { force: true });
    stage = 'git add';
    git(workspacePath, ['add', '-A', '--', relativePath]);
    added = true;
    stage = 'git status';
    const staged = git(workspacePath, ['status', '--porcelain', '--', relativePath]);
    if (staged === '') {
      // 从未入库的本地文件（例如入库前的遗留）：删掉即可，没有可提交的变更
      result.reason = '快照未入库，已删除本地文件';
      result.skipped = true;
      return result;
    }
    stage = 'git commit';
    git(workspacePath, ['commit', ...identityArgs(workspacePath), '-m', `knowledge(${page.slug}): 删除快照 ${page.title}`, '--', relativePath]);
    result.committed = true;
    result.commit = headShort(workspacePath);
    return result;
  } catch (error) {
    result.reason = `${stage} 失败：${failureReason(error)}`;
    // KB-SNAP-ROLLBACK：清暂存失败时显式留痕；previous 语义不适用（删除路径文件已删，无需还原文件）
    if (added) {
      try {
        resetIndex(workspacePath, relativePath);
      } catch (rollbackError) {
        noteRollbackFailure(result, '清暂存', rollbackError);
      }
    }
    return result;
  }
}

const INVALID_WORKSPACE_PATH = '工作区路径不是绝对路径，跳过每页快照（相对路径会落到服务进程 cwd 下的仓库）';

/**
 * KB-SNAP-IMPORT（方案 3）：批量导入端点不接线每页快照的显式信号。
 * 一次导入写多页，逐页/批量提交与 BORROW-5.1「一次提交只含该页路径」冲突，属既定决策的跳过：
 * `committed=false && skipped=true` 沿用 KB-SNAP-SILENT 语义 = 不是失败；调用方据此可判断
 * 「已接线但显式跳过」而不是「端点根本不落快照」。
 */
export const IMPORT_BATCH_COMMIT_SKIPPED: PageCommitResult = {
  path: '',
  relative_path: '',
  committed: false,
  commit: null,
  reason: '批量导入不落每页快照（BORROW-5.1 一次提交只含该页路径，与逐页/批量提交冲突）；导入页在 git 审计链里无对应提交，属既定决策',
  skipped: true,
};

/** 路由侧接线：按 workspace_id 从中心库解析工作区路径后落盘 + 提交；任何异常都吞成 reason */
export function commitKnowledgePageRevision(
  centerDb: Db,
  workspaceId: string | null | undefined,
  page: PageSnapshotContent,
): PageCommitResult | null {
  if (page.scope !== 'workspace' || !workspaceId) return null;
  const workspace = getWorkspace(centerDb, workspaceId);
  if (!workspace) return null;
  // 只认绝对路径：相对路径（如测试里的占位 'A'）会以服务进程 cwd 为基准，写进无关仓库
  if (!isAbsolute(workspace.path)) {
    return { path: '', relative_path: '', committed: false, commit: null, reason: INVALID_WORKSPACE_PATH };
  }
  try {
    return commitKnowledgePageSnapshot(workspace.path, page);
  } catch (error) {
    return {
      path: knowledgePageSnapshotPath(workspace.path, page.id),
      relative_path: '',
      committed: false,
      commit: null,
      reason: error instanceof Error ? error.message : String(error),
    };
  }
}

/** 路由侧接线（软删）：解析工作区路径后撤掉该页快照并提交删除 */
export function removeKnowledgePageRevision(
  centerDb: Db,
  workspaceId: string | null | undefined,
  page: Pick<PageSnapshotContent, 'id' | 'slug' | 'title' | 'scope'>,
): PageCommitResult | null {
  if (page.scope !== 'workspace' || !workspaceId) return null;
  const workspace = getWorkspace(centerDb, workspaceId);
  if (!workspace) return null;
  if (!isAbsolute(workspace.path)) {
    return { path: '', relative_path: '', committed: false, commit: null, reason: INVALID_WORKSPACE_PATH };
  }
  try {
    return removeKnowledgePageSnapshot(workspace.path, page);
  } catch (error) {
    return {
      path: knowledgePageSnapshotPath(workspace.path, page.id),
      relative_path: '',
      committed: false,
      commit: null,
      reason: error instanceof Error ? error.message : String(error),
    };
  }
}
