import type { Workspace } from '@agentboard/shared';
import { request } from '../api.js';
import type { Ctx } from '../io.js';
import { matchWorkspace } from '../workspace.js';

export interface DeleteSpaceArgs {
  /** 必填：删除不可逆，非 TTY 也不推断「默认同意」 */
  yes?: boolean;
}

/**
 * 删除工作空间（不可逆；只删登记，不动磁盘目录）。
 * 缺 `--yes` 时先回显名称/路径并以非 0 退出，**不发 DELETE**；
 * 占用校验在服务端：有知识页 / 运行中会话 / 未解除的子任务 → 409，原样透传原因（退出码 2）。
 */
export async function deleteSpace(ctx: Ctx, workspace: string, args: DeleteSpaceArgs): Promise<void> {
  const spaces = await request<Workspace[]>(ctx.base, 'GET', '/api/workspaces');
  const match = matchWorkspace(spaces, workspace);
  if (args.yes !== true) {
    throw new Error(
      `将删除工作空间 ${match.id}「${match.name}」（${match.path}）：只删看板登记，不动磁盘目录。`
      + '删除不可恢复（该空间的任务与评论一并移除），确认请重新执行并加 --yes',
    );
  }
  await request<void>(ctx.base, 'DELETE', `/api/workspaces/${encodeURIComponent(match.id)}`);
  if (ctx.json) {
    ctx.io.write(`${JSON.stringify({ deleted: true, id: match.id, name: match.name, path: match.path }, null, 2)}\n`);
    return;
  }
  ctx.io.write(`已删除工作空间: ${match.id} ${match.name}（${match.path}；磁盘目录未动）\n`);
}
