import type { Issue } from '@agentboard/shared';
import { request } from '../api.js';
import type { Ctx } from '../io.js';

export interface FailArgs {
  reason: string;
}

export async function fail(ctx: Ctx, id: string, args: FailArgs): Promise<void> {
  const issue = await request<Issue>(ctx.base, 'POST', `/api/issues/${encodeURIComponent(id)}/fail`, {
    agent_id: ctx.agentId,
    reason: args.reason,
  });
  if (ctx.json) {
    ctx.io.write(`${JSON.stringify(issue, null, 2)}\n`);
    return;
  }
  ctx.io.write(`已标记失败: ${issue.id}\n状态: ${issue.status}（占用已释放，reason 落评论流）\n`);
}
