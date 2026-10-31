import type { Issue, IssueComment, Workspace } from '@agentboard/shared';
import { request } from '../api.js';
import type { Ctx } from '../io.js';
import { commentLines, issueLines } from '../render.js';

/** 原子领取；409（已被占用）由 index.ts 统一映射退出码 2 */
export async function claim(ctx: Ctx, id: string): Promise<void> {
  const issue = await request<Issue>(ctx.base, 'POST', `/api/issues/${encodeURIComponent(id)}/claim`, {
    agent_id: ctx.agentId,
  });
  if (ctx.json) {
    ctx.io.write(`${JSON.stringify(issue, null, 2)}\n`);
    return;
  }
  const comments = await request<IssueComment[]>(
    ctx.base,
    'GET',
    `/api/issues/${encodeURIComponent(id)}/comments`,
  );
  const spaces = await request<Workspace[]>(ctx.base, 'GET', '/api/workspaces');
  const ws = spaces.find((s) => s.id === issue.workspace_id);
  ctx.io.write(`领取成功（agent: ${ctx.agentId}）\n`);
  ctx.io.write(`${issueLines(issue).join('\n')}\n`);
  ctx.io.write(`工作空间路径: ${ws?.path ?? '（未知）'}\n`);
  ctx.io.write(`${commentLines(comments).join('\n')}\n`);
}
