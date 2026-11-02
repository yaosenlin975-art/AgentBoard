import { randomUUID } from 'node:crypto';
import type { Issue } from '@agentboard/shared';
import { request } from '../api.js';
import type { Ctx } from '../io.js';

export interface MoveIssueArgs { parentIssueId?: string; root?: boolean; expectedUpdatedAt?: number; requestId?: string }

export async function moveIssue(ctx: Ctx, id: string, args: MoveIssueArgs): Promise<void> {
  if ((args.parentIssueId === undefined) === (args.root !== true)) {
    throw new Error('必须指定 --parent <issue-id> 或 --root');
  }
  const current = await request<Issue>(ctx.base, 'GET', `/api/issues/${encodeURIComponent(id)}`);
  const issue = await request<Issue>(ctx.base, 'PATCH', `/api/issues/${encodeURIComponent(id)}`, {
    workspace_id: current.workspace_id,
    expected_updated_at: args.expectedUpdatedAt ?? current.updated_at,
    parent_issue_id: args.root ? null : args.parentIssueId,
  }, args.requestId ?? randomUUID());
  if (ctx.json) {
    ctx.io.write(`${JSON.stringify(issue, null, 2)}\n`);
    return;
  }
  ctx.io.write(`已移动任务: ${issue.id} ${issue.title}\n父任务: ${issue.parent_issue_id ?? '（根任务）'}\n`);
}
