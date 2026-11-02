import type { Workspace } from '@agentboard/shared';
import { request } from './api.js';

export function matchWorkspace(spaces: Workspace[], value: string): Workspace {
  const exact = spaces.find(s => s.id === value);
  if (exact) return exact;
  const matches = spaces.filter(s => s.name === value);
  if (matches.length !== 1) throw new Error(matches.length ? `工作空间名称不唯一，请用 id: ${value}` : `工作空间不存在: ${value}`);
  return matches[0]!;
}
export async function resolveWorkspaceId(base: string, value: string): Promise<string> {
  return matchWorkspace(await request<Workspace[]>(base, 'GET', '/api/workspaces'), value).id;
}
