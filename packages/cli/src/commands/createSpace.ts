import type { Workspace } from '@agentboard/shared';
import { CliHttpError, request } from '../api.js';
import type { Ctx } from '../io.js';
import { autoEnableWorkspaceDb } from './workspaceDb.js';

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
  // 下沉默认化：新建区自动启用独享库。复用 enable 的八阶段状态机（建库 + meta.localized=1 +
  // 中心 db_mode=localized），因此状态机自洽、status 回 localized、磁盘库文件真实存在。
  // 登记已成功，enable 失败只降级提示、不推翻登记（用户可稍后 enable --all 补做）。
  try {
    await autoEnableWorkspaceDb(ctx, ws.id);
  } catch (error) {
    const reason = error instanceof Error && error.message !== '' ? error.message : String(error);
    ctx.io.writeErr(
      `提示：工作区已登记，但自动启用工作区库失败，该工作区暂为中心库模式；可稍后执行 kb workspace-db enable ${ws.id} 或 kb workspace-db enable --all。原因：${reason}\n`,
    );
  }
  if (ctx.json) {
    ctx.io.write(`${JSON.stringify(ws, null, 2)}\n`);
    return;
  }
  ctx.io.write(`已创建工作空间: ${ws.id} ${ws.name}（${ws.path}）\n`);
}
