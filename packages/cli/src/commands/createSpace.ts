import type { Workspace } from '@agentboard/shared';
import { CliHttpError, request } from '../api.js';
import type { Ctx } from '../io.js';

export interface CreateSpaceArgs {
  name: string;
  path: string;
}

/** POST /api/workspaces {name, path}；path 不存在等 400 由 index.ts 统一透传 */
export async function createSpace(ctx: Ctx, args: CreateSpaceArgs): Promise<void> {
  let ws: Workspace;
  try {
    ws = await request<Workspace>(ctx.base, 'POST', '/api/workspaces', {
      name: args.name,
      path: args.path,
    });
  } catch (error) {
    // CLI-22：路径唯一性不是「占用」，换成登记语义，别用 claim 术语
    if (error instanceof CliHttpError && error.status === 409) {
      const existing = error.message.replace(/^该路径已存在工作空间：/, '').trim();
      const message = existing === '' || existing === error.message
        ? '该路径已登记为工作区，不能重复登记'
        : `该路径已登记为工作区「${existing}」，不能重复登记`;
      // 语义是登记冲突：保留退出码 2
      throw new CliHttpError(409, 'CONFLICT', message);
    }
    throw error;
  }
  if (ctx.json) {
    ctx.io.write(`${JSON.stringify(ws, null, 2)}\n`);
    return;
  }
  ctx.io.write(`已创建工作空间: ${ws.id} ${ws.name}（${ws.path}）\n`);
}
