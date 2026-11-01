import type { Issue, Workspace } from '@agentboard/shared';
import { request } from '../api.js';
import type { Ctx } from '../io.js';
import { table } from '../render.js';

export interface ListTasksArgs {
  /** 工作空间 id 或名称；缺省聚合全部工作空间 */
  workspace?: string;
  /** 按状态过滤：待规划|进行中|待验收|已关闭 */
  status?: string;
}

export async function listTasks(ctx: Ctx, args: ListTasksArgs): Promise<void> {
  const spaces = await request<Workspace[]>(ctx.base, 'GET', '/api/workspaces');
  let issues: Issue[];
  if (args.workspace) {
    const ws = spaces.find((s) => s.id === args.workspace || s.name === args.workspace);
    if (!ws) throw new Error(`工作空间不存在: ${args.workspace}`);
    issues = await request<Issue[]>(
      ctx.base,
      'GET',
      `/api/issues?workspace=${encodeURIComponent(ws.id)}`,
    );
  } else {
    issues = (
      await Promise.all(
        spaces.map((s) =>
          request<Issue[]>(ctx.base, 'GET', `/api/issues?workspace=${encodeURIComponent(s.id)}`),
        ),
      )
    ).flat();
  }
  const filtered = args.status ? issues.filter((i) => i.status === args.status) : issues;
  if (ctx.json) {
    ctx.io.write(`${JSON.stringify(filtered, null, 2)}\n`);
    return;
  }
  if (filtered.length === 0) {
    ctx.io.write('（无任务）\n');
    return;
  }
  ctx.io.write(
    table(
      ['id', '状态', '优先级', 'labels', '占用者', '评论', '标题'],
      filtered.map((i) => [
        i.id,
        i.status,
        i.priority,
        i.labels.length > 0 ? i.labels.join(',') : '-',
        i.claimed_by ?? '-',
        String(i.comment_count),
        i.title,
      ]),
    ),
  );
}
