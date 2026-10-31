import type { Issue } from '@agentboard/shared';
import { request } from '../api.js';
import type { Ctx } from '../io.js';

export interface DoneArgs {
  notes?: string;
}

export async function done(ctx: Ctx, id: string, args: DoneArgs): Promise<void> {
  const body: { agent_id: string; notes?: string } = { agent_id: ctx.agentId };
  if (args.notes !== undefined) body.notes = args.notes;
  const issue = await request<Issue>(ctx.base, 'POST', `/api/issues/${encodeURIComponent(id)}/done`, body);
  if (ctx.json) {
    ctx.io.write(`${JSON.stringify(issue, null, 2)}\n`);
    return;
  }
  ctx.io.write(`已完成: ${issue.id}\n状态: ${issue.status}（占用已释放，notes 落评论流）\n`);
}
