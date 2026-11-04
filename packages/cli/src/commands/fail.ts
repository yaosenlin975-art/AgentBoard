import type { Issue } from '@agentboard/shared';
import { request } from '../api.js';
import { clearClaimedFence, loadClaimedFence } from '../claimStore.js';
import type { Ctx } from '../io.js';
import { normalizeIssueRef } from '../issueRef.js';

export interface FailArgs {
  reason: string;
  /** 幂等请求 id：与 workspace_id 一起才能命中服务端的 owner 幂等包装；重试必须复用同一 uuid */
  requestId?: string;
}

export async function fail(ctx: Ctx, id: string, args: FailArgs): Promise<void> {
  // CLI-02：允许 ≥8 位前缀；fence 与接口都用解析后的真实 id
  const target = await normalizeIssueRef(ctx, id);
  const issueId = target.id;
  const body: { agent_id: string; reason: string; workspace_id?: string; fence?: number } = {
    agent_id: ctx.agentId,
    reason: args.reason,
  };
  // BORROW-0.3：本地有 claim 记录就自动带 fence（软模式：无记录不带，服务端放行）
  const storedFence = loadClaimedFence(issueId);
  if (storedFence !== undefined) body.fence = storedFence;
  if (args.requestId !== undefined) {
    body.workspace_id = target.issue?.workspace_id
      ?? (await request<Issue>(ctx.base, 'GET', `/api/issues/${encodeURIComponent(issueId)}`)).workspace_id;
  }
  const issue = await request<Issue>(
    ctx.base, 'POST', `/api/issues/${encodeURIComponent(issueId)}/fail`, body, args.requestId,
  );
  clearClaimedFence(issueId);
  if (ctx.json) {
    ctx.io.write(`${JSON.stringify(issue, null, 2)}\n`);
    return;
  }
  ctx.io.write(`已标记失败: ${issue.id}\n状态: ${issue.status}（占用已释放，reason 落评论流）\n`);
}
