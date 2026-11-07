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
 * - 批量导入（`/pages/import`）不接线：一次请求会写多页，逐页提交与「只含该页路径」冲突。
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

/** 提交失败时尽力把索引恢复原状，避免留下「文件回滚了但内容仍在暂存区」的半状态 */
function resetIndex(cwd: string, relativePath: string): void {
  try { git(cwd, ['reset', '-q', 'HEAD', '--', relativePath]); } catch { /* 无 HEAD / 非仓库：忽略 */ }
}

/** 提交后回读 HEAD 简写；取不到时返回 null 而不是伪装成功 */
function headShort(cwd: string): string | null {
  try { return git(cwd, ['rev-parse', '--short', 'HEAD']); } catch { return null; }
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

  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, renderKnowledgePageSnapshot(page), 'utf8');
    git(workspacePath, ['add', '-A', '--', relativePath]);
    // 内容没变化（例如只改了不进快照的分类字段）时不强行造空提交
    const staged = git(workspacePath, ['status', '--porcelain', '--', relativePath]);
    if (staged === '' && git(workspacePath, ['log', '-1', '--format=%H', '--', relativePath]) !== '') {
      result.committed = true;
      result.commit = headShort(workspacePath);
      return result;
    }
    git(workspacePath, ['commit', ...identityArgs(workspacePath), '-m', `knowledge(${page.slug}): r${page.revision} ${page.title}`, '--', relativePath]);
    result.committed = true;
    result.commit = headShort(workspacePath);
    return result;
  } catch (error) {
    // 回滚：新建的删掉、已有的还原，保证不留半提交
    try {
      if (previous === null) rmSync(path, { force: true });
      else writeFileSync(path, previous, 'utf8');
      resetIndex(workspacePath, relativePath);
    } catch { /* 回滚失败也不再抛：原因里已能看出 */ }
    result.reason = error instanceof Error ? error.message.split('\n')[0]!.trim() : String(error);
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
    return result;
  }
  try {
    rmSync(path, { force: true });
    git(workspacePath, ['add', '-A', '--', relativePath]);
    const staged = git(workspacePath, ['status', '--porcelain', '--', relativePath]);
    if (staged === '') {
      // 从未入库的本地文件（例如入库前的遗留）：删掉即可，没有可提交的变更
      result.reason = '快照未入库，已删除本地文件';
      return result;
    }
    git(workspacePath, ['commit', ...identityArgs(workspacePath), '-m', `knowledge(${page.slug}): 删除快照 ${page.title}`, '--', relativePath]);
    result.committed = true;
    result.commit = headShort(workspacePath);
    return result;
  } catch (error) {
    resetIndex(workspacePath, relativePath);
    result.reason = error instanceof Error ? error.message.split('\n')[0]!.trim() : String(error);
    return result;
  }
}

const INVALID_WORKSPACE_PATH = '工作区路径不是绝对路径，跳过每页快照（相对路径会落到服务进程 cwd 下的仓库）';

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
