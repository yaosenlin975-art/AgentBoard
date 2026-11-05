import type { Issue, IssueComment } from '@agentboard/shared';
import { CliHttpError, request } from '../api.js';
import type { Ctx } from '../io.js';
import { commentLines, issueLines } from '../render.js';
import { resolveIssueByRef } from '../issueRef.js';

interface ConsumeResponse {
  comments: IssueComment[];
  new_comment_ids: string[];
}

export interface ShowArgs {
  /** CLI-24：显式要求推进已读游标；缺省只读，不改别人的「新留言」可见性 */
  markRead?: boolean;
}

/**
 * CLI-24：默认纯读（GET comments），`--mark-read` 才走 POST consume（服务端事务内标注 + 推进游标）。
 * 服务端无 consume 端点等 HTTP 层失败（旧版本兼容）→ 降级 GET comments 纯读，不标注。
 */
async function fetchComments(ctx: Ctx, id: string, markRead: boolean): Promise<Array<IssueComment & { is_new?: boolean }>> {
  const path = `/api/issues/${encodeURIComponent(id)}`;
  if (!markRead) return request<IssueComment[]>(ctx.base, 'GET', `${path}/comments`);
  try {
    const res = await request<ConsumeResponse>(ctx.base, 'POST', `${path}/comments/consume`);
    const fresh = new Set(res.new_comment_ids);
    return res.comments.map((c) => ({ ...c, is_new: fresh.has(c.id) }));
  } catch (err) {
    if (!(err instanceof CliHttpError)) throw err;
    return request<IssueComment[]>(ctx.base, 'GET', `${path}/comments`);
  }
}

/** DEC-4：卡面锁标识——grace 显示剩余秒数，open 显示已等待时长（DEC-2 只读投影） */
function decisionLines(issue: Issue): string[] {
  if (issue.open_decision_id != null && issue.decision_locked === true) {
    const waited = issue.decision_waiting_seconds;
    return [
      `决策: LOCKED decision=${issue.open_decision_id}${waited != null ? `（已等待 ${waited} 秒）` : ''}`,
      `  回答: kb answer ${issue.open_decision_id} --option <序号|label>；或 kb decisions --issue ${issue.id}`,
    ];
  }
  if (issue.decision_grace_until != null) {
    const remaining = Math.max(0, Math.ceil((issue.decision_grace_until - Date.now()) / 1000));
    return [
      `决策: grace decision=${issue.open_decision_id ?? '?'} 剩余 ${remaining} 秒（到期自动落锁）`,
    ];
  }
  return [];
}

export async function show(ctx: Ctx, id: string, args: ShowArgs = {}): Promise<void> {
  const issue = await resolveIssueByRef(ctx, id);
  const comments = await fetchComments(ctx, issue.id, args.markRead === true);
  if (ctx.json) {
    ctx.io.write(`${JSON.stringify({ ...issue, comments }, null, 2)}\n`);
    return;
  }
  ctx.io.write(`${[...issueLines(issue), ...decisionLines(issue), ...commentLines(comments)].join('\n')}\n`);
}
