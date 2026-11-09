import { realpathSync } from 'node:fs';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import type { Workspace } from '@agentboard/shared';
import { request } from './api.js';
import { CliExitError } from './errors.js';

/** CLI-WS-REF：工作区 id 前缀最少位数（与任务 id / 知识页 resolve 口径一致） */
export const MIN_WORKSPACE_PREFIX = 8;

/** 像 id 的引用：十六进制与连字符（完整 UUID 会先在上面的精确匹配命中） */
const WORKSPACE_ID_LIKE = /^[0-9a-f-]+$/i;

/** 不存在时的候选提示：短 id + 名称，避免用户再跑一次 list-spaces 手抄 */
function availableWorkspaces(spaces: Workspace[]): string {
  if (spaces.length === 0) return '当前没有任何工作空间';
  return `现有工作空间：${spaces.map(space => `${space.id.slice(0, 8)} ${space.name}`).join(' / ')}`;
}

/**
 * CLI-WS-REF：`--workspace` 支持完整 id / 名称 / ≥8 位唯一 id 前缀，与任务 id 的引用口径对齐。
 * 前缀多命中 → exit 2 并列出候选（不猜第一条）；不足 8 位或不存在 → exit 1，文案给出可用形式与候选。
 */
export function matchWorkspace(spaces: Workspace[], value: string): Workspace {
  const exact = spaces.find(s => s.id === value);
  if (exact) return exact;
  const matches = spaces.filter(s => s.name === value);
  if (matches.length > 1) throw new Error(`工作空间名称不唯一，请用 id: ${value}`);
  if (matches.length === 1) return matches[0]!;

  const raw = value.trim();
  if (WORKSPACE_ID_LIKE.test(raw)) {
    if (raw.length < MIN_WORKSPACE_PREFIX) {
      throw new Error(
        `工作空间不存在: ${raw}（可用完整 id、≥${MIN_WORKSPACE_PREFIX} 位 id 前缀或名称；当前 ${raw.length} 位不足 ${MIN_WORKSPACE_PREFIX} 位）`,
      );
    }
    const hits = spaces.filter(s => s.id.toLowerCase().startsWith(raw.toLowerCase()));
    if (hits.length === 1) return hits[0]!;
    if (hits.length > 1) {
      throw new CliExitError(
        'AMBIGUOUS_WORKSPACE_REF',
        `工作空间 id 前缀「${raw}」命中 ${hits.length} 个，请改用更长前缀或完整 id：\n`
          + hits.map(space => `  - ${space.id} ${space.name}（${space.path}）`).join('\n'),
        2,
      );
    }
  }
  throw new Error(`工作空间不存在: ${raw}（可用完整 id、≥${MIN_WORKSPACE_PREFIX} 位 id 前缀或名称；${availableWorkspaces(spaces)}）`);
}

function realPath(value: string): string | undefined {
  if (!isAbsolute(value)) return undefined;
  try {
    return resolve(realpathSync.native(value));
  } catch {
    return undefined;
  }
}

function relativePath(root: string, target: string): string {
  if (process.platform === 'win32') return relative(root.toLowerCase(), target.toLowerCase());
  return relative(root, target);
}

function isWithin(root: string, target: string): boolean {
  const rel = relativePath(root, target);
  return rel === '' || (rel !== '..' && !rel.startsWith('..' + sep) && !isAbsolute(rel));
}

/**
 * OPT-02：按 cwd 找当前工作区；找不到返回 undefined（供单工作区回退用）。
 * 匹配规则与 `matchCurrentWorkspace` 完全一致：目录等价优先，其次包含关系命中；多命中仍抛错。
 */
export function findCurrentWorkspace(spaces: Workspace[], cwd = process.cwd()): Workspace | undefined {
  const current = realPath(cwd);
  if (!current) return undefined;

  const roots = spaces.flatMap(space => {
    const path = realPath(space.path);
    return path ? [{ space, path }] : [];
  });
  const exact = roots.filter(root => relativePath(root.path, current) === '');
  const matches = exact.length > 0 ? exact : roots.filter(root => isWithin(root.path, current));
  if (matches.length === 1) return matches[0]!.space;
  if (matches.length > 1) {
    const candidates = matches.map(({ space }) => space.name + ' (' + space.id + ')').join(' / ');
    throw new Error('当前目录匹配多个工作区：' + candidates + '；请显式指定 --workspace <id|名>');
  }
  return undefined;
}

export function matchCurrentWorkspace(spaces: Workspace[], cwd = process.cwd()): Workspace {
  const found = findCurrentWorkspace(spaces, cwd);
  if (found) return found;
  throw new Error('当前目录不属于任何可解析的工作区，请显式指定 --workspace <id|名>');
}

/** OPT-02：命令入口的工作区解析结果；`hint` 非空时由调用方写到 stderr */
export interface ResolvedWorkspace {
  id: string;
  hint?: string;
}

/**
 * OPT-02：工作区相关入口的缺省解析。
 * - 显式传 workspace（位置参数或 `--workspace`）→ 与 matchWorkspace 同口径，可跨区；
 * - 缺省 → 按 cwd 解析；cwd 不属于任何工作区且全库只有一个工作区时用它并给出提示；
 *   多个工作区时报错并列候选（不猜）。
 * 不改变 `resolveWorkspaceId` 的匹配规则，供「缺省按 cwd」的新入口使用。
 */
export async function resolveWorkspaceRef(base: string, value?: string, cwd = process.cwd()): Promise<ResolvedWorkspace> {
  const spaces = await request<Workspace[]>(base, 'GET', '/api/workspaces');
  if (value !== undefined) return { id: matchWorkspace(spaces, value).id };
  const current = findCurrentWorkspace(spaces, cwd);
  if (current) return { id: current.id };
  if (spaces.length === 1) {
    const only = spaces[0]!;
    return { id: only.id, hint: `当前目录不属于任何工作区，已使用唯一的工作空间：${only.name}（${only.id.slice(0, 8)}）` };
  }
  throw new Error(`当前目录不属于任何工作区，请显式指定工作区（位置参数或 --workspace）：${availableWorkspaces(spaces)}`);
}

export async function resolveWorkspaceId(base: string, value?: string): Promise<string> {
  const spaces = await request<Workspace[]>(base, 'GET', '/api/workspaces');
  return (value === undefined ? matchCurrentWorkspace(spaces) : matchWorkspace(spaces, value)).id;
}

/** OPT-02：解析工作区并把「单工作区回退」提示写到 stderr（无提示时不写） */
export async function resolveWorkspaceWithHint(
  base: string,
  value: string | undefined,
  writeErr: (text: string) => void,
): Promise<string> {
  const resolved = await resolveWorkspaceRef(base, value);
  if (resolved.hint !== undefined) writeErr(`提示：${resolved.hint}\n`);
  return resolved.id;
}
