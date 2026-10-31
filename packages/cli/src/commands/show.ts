import type { Issue, IssueComment } from '@agentboard/shared';
import { request } from '../api.js';
import type { Ctx } from '../io.js';
import { commentLines, issueLines } from '../render.js';

export async function show(ctx: Ctx, id: string): Promise<void> {
  const issue = await request<Issue>(ctx.base, 'GET', `/api/issues/${encodeURIComponent(id)}`);
  const comments = await request<IssueComment[]>(
    ctx.base,
    'GET',
    `/api/issues/${encodeURIComponent(id)}/comments`,
  );
  if (ctx.json) {
    ctx.io.write(`${JSON.stringify({ ...issue, comments }, null, 2)}\n`);
    return;
  }
  ctx.io.write(`${[...issueLines(issue), ...commentLines(comments)].join('\n')}\n`);
}
