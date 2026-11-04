import { realpathSync } from 'node:fs';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import type { Workspace } from '@agentboard/shared';
import { request } from './api.js';

export function matchWorkspace(spaces: Workspace[], value: string): Workspace {
  const exact = spaces.find(s => s.id === value);
  if (exact) return exact;
  const matches = spaces.filter(s => s.name === value);
  if (matches.length !== 1) throw new Error(matches.length ? `工作空间名称不唯一，请用 id: ${value}` : `工作空间不存在: ${value}`);
  return matches[0]!;
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

export function matchCurrentWorkspace(spaces: Workspace[], cwd = process.cwd()): Workspace {
  const current = realPath(cwd);
  if (!current) throw new Error('无法解析本机当前目录，请显式指定 --workspace <id|名>');

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
  throw new Error('当前目录不属于任何可解析的工作区，请显式指定 --workspace <id|名>');
}

export async function resolveWorkspaceId(base: string, value?: string): Promise<string> {
  const spaces = await request<Workspace[]>(base, 'GET', '/api/workspaces');
  return (value === undefined ? matchCurrentWorkspace(spaces) : matchWorkspace(spaces, value)).id;
}
