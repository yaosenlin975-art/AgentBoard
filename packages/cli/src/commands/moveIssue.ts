import { randomUUID } from 'node:crypto';
import type { Issue } from '@agentboard/shared';
import { request } from '../api.js';
import type { Ctx } from '../io.js';
import { normalizeIssueIdArg, resolveIssueByRef } from '../issueRef.js';

export interface MoveIssueArgs { parentIssueId?: string; root?: boolean; expectedUpdatedAt?: number; requestId?: string }

export async function moveIssue(ctx: Ctx, id: string, args: MoveIssueArgs): Promise<void> {
  // CLI-17：两个都给时给出「不能同时指定」，而不是误导为「必须指定其一」
  if (args.parentIssueId !== undefined && args.root === true) {
    throw new Error('--parent 与 --root 不能同时指定');
  }
  if ((args.parentIssueId === undefined) === (args.root !== true)) {
    throw new Error('必须指定 --parent <issue-id> 或 --root');
  }
  // CLI-02：位置参数与 --parent 都允许 ≥8 位前缀
  const current = await resolveIssueByRef(ctx, id);
  const parentId = args.parentIssueId === undefined ? undefined : await normalizeIssueIdArg(ctx, args.parentIssueId);
  const issue = await request<Issue>(ctx.base, 'PATCH', `/api/issues/${encodeURIComponent(current.id)}`, {
    workspace_id: current.workspace_id,
    expected_updated_at: args.expectedUpdatedAt ?? current.updated_at,
    parent_issue_id: args.root ? null : parentId,
  }, args.requestId ?? randomUUID());
  if (ctx.json) {
    ctx.io.write(`${JSON.stringify(issue, null, 2)}\n`);
    return;
  }
  ctx.io.write(`已移动任务: ${issue.id} ${issue.title}\n父任务: ${issue.parent_issue_id ?? '（根任务）'}\n`);
}
