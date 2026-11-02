import type { Workspace } from '@agentboard/shared';
import { request } from '../api.js';
import type { Ctx } from '../io.js';

export interface CreateSpaceArgs {
  name: string;
  path: string;
}

/** POST /api/workspaces {name, path}；path 不存在等 400 由 index.ts 统一透传 */
export async function createSpace(ctx: Ctx, args: CreateSpaceArgs): Promise<void> {
  const ws = await request<Workspace>(ctx.base, 'POST', '/api/workspaces', {
    name: args.name,
    path: args.path,
  });
  if (ctx.json) {
    ctx.io.write(`${JSON.stringify(ws, null, 2)}\n`);
    return;
  }
  ctx.io.write(`已创建工作空间: ${ws.id} ${ws.name}（${ws.path}）\n`);
}
