import type { Issue, IssueComment } from '@agentboard/shared';
import { request } from '../api.js';
import { clearClaimedFence, loadClaimedFence } from '../claimStore.js';
import type { Ctx } from '../io.js';
import { normalizeIssueRef } from '../issueRef.js';

export interface ReleaseArgs {
  /** 幂等请求 id：与 workspace_id 一起才能命中服务端的 owner 幂等包装；重试必须复用同一 uuid */
  requestId?: string;
}

/**
 * REL-3：释放当前占用（退回「待规划」，不是失败）。
 * 必须带 workspace_id：服务端据此走「占用者释放」语义（非当前占用者 409 NOT_TASK_OWNER）；
 * 不带 workspace_id 会退化成用户强制释放，绕过占用者校验。
 */
export async function release(ctx: Ctx, id: string, args: ReleaseArgs): Promise<void> {
  const target = await normalizeIssueRef(ctx, id);
  const issueId = target.id;
  const body: { agent_id: string; workspace_id: string; fence?: number } = {
    agent_id: ctx.agentId,
    workspace_id: target.issue?.workspace_id
      ?? (await request<Issue>(ctx.base, 'GET', `/api/issues/${encodeURIComponent(issueId)}`)).workspace_id,
  };
  // BORROW-0.3：本地有 claim 记录就自动带 fence（软模式：无记录不带，服务端放行）
  const storedFence = loadClaimedFence(issueId);
  if (storedFence !== undefined) body.fence = storedFence;
  const issue = await request<Issue & { comment?: IssueComment | null }>(
    ctx.base, 'POST', `/api/issues/${encodeURIComponent(issueId)}/release`, body, args.requestId,
  );
  clearClaimedFence(issueId);
  if (ctx.json) {
    ctx.io.write(`${JSON.stringify(issue, null, 2)}\n`);
    return;
  }
  ctx.io.write(`已释放: ${issue.id}\n状态: ${issue.status}（占用已清空，退回待规划，不是失败）\n`);
}
