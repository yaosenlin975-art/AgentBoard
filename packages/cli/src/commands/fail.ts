import type { Issue } from '@agentboard/shared';
import { request } from '../api.js';
import type { Ctx } from '../io.js';

export interface FailArgs {
  reason: string;
  /** 幂等请求 id：与 workspace_id 一起才能命中服务端的 owner 幂等包装；重试必须复用同一 uuid */
  requestId?: string;
}

export async function fail(ctx: Ctx, id: string, args: FailArgs): Promise<void> {
  const body: { agent_id: string; reason: string; workspace_id?: string } = {
    agent_id: ctx.agentId,
    reason: args.reason,
  };
  if (args.requestId !== undefined) {
    const target = await request<Issue>(ctx.base, 'GET', `/api/issues/${encodeURIComponent(id)}`);
    body.workspace_id = target.workspace_id;
  }
  const issue = await request<Issue>(
    ctx.base, 'POST', `/api/issues/${encodeURIComponent(id)}/fail`, body, args.requestId,
  );
  if (ctx.json) {
    ctx.io.write(`${JSON.stringify(issue, null, 2)}\n`);
    return;
  }
  ctx.io.write(`已标记失败: ${issue.id}\n状态: ${issue.status}（占用已释放，reason 落评论流）\n`);
}
