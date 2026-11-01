import type { Issue, IssueComment } from '@agentboard/shared';
import { CliHttpError, request } from '../api.js';
import type { Ctx } from '../io.js';
import { commentLines, issueLines } from '../render.js';

interface ConsumeResponse {
  comments: IssueComment[];
  new_comment_ids: string[];
}

/**
 * 拉评论并标注新留言：优先 POST consume（服务端事务内标注 + 推进游标，恰好一次）；
 * 服务端无该端点等 HTTP 层失败（旧版本兼容）→ 降级 GET comments 纯读，不标注。
 */
async function fetchComments(ctx: Ctx, id: string): Promise<Array<IssueComment & { is_new?: boolean }>> {
  const path = `/api/issues/${encodeURIComponent(id)}`;
  try {
    const res = await request<ConsumeResponse>(ctx.base, 'POST', `${path}/comments/consume`);
    const fresh = new Set(res.new_comment_ids);
    return res.comments.map((c) => ({ ...c, is_new: fresh.has(c.id) }));
  } catch (err) {
    if (!(err instanceof CliHttpError)) throw err;
    return request<IssueComment[]>(ctx.base, 'GET', `${path}/comments`);
  }
}

export async function show(ctx: Ctx, id: string): Promise<void> {
  const issue = await request<Issue>(ctx.base, 'GET', `/api/issues/${encodeURIComponent(id)}`);
  const comments = await fetchComments(ctx, id);
  if (ctx.json) {
    ctx.io.write(`${JSON.stringify({ ...issue, comments }, null, 2)}\n`);
    return;
  }
  ctx.io.write(`${[...issueLines(issue), ...commentLines(comments)].join('\n')}\n`);
}
