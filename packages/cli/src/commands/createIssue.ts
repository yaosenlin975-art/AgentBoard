import { randomUUID } from 'node:crypto';
import type { Issue } from '@agentboard/shared';
import { request } from '../api.js';
import type { Ctx } from '../io.js';
import { resolveWorkspaceId } from '../workspace.js';

export interface CreateIssueArgs {
  /** 工作空间 id 或名称（先解析为 id） */
  workspace: string;
  title: string;
  description?: string;
  /** 低|中|高（非法值由服务端 400） */
  priority?: string;
  /** 逗号拆分 */
  labels?: string;
  parentIssueId?: string;
  requestId?: string;
}

interface CreateIssueBody {
  workspace_id: string;
  title: string;
  description?: string;
  priority?: string;
  labels?: string[];
  parent_issue_id?: string;
}

export async function createIssue(ctx: Ctx, args: CreateIssueArgs): Promise<void> {
  const workspaceId = await resolveWorkspaceId(ctx.base, args.workspace);
  const body: CreateIssueBody = { workspace_id: workspaceId, title: args.title };
  if (args.description !== undefined) body.description = args.description;
  if (args.priority !== undefined) body.priority = args.priority;
  if (args.labels !== undefined) {
    body.labels = args.labels.split(',').map((s) => s.trim()).filter((s) => s !== '');
  }
  if (args.parentIssueId !== undefined) body.parent_issue_id = args.parentIssueId;
  const issue = await request<Issue>(ctx.base, 'POST', '/api/issues', body, args.requestId ?? randomUUID());
  if (ctx.json) {
    ctx.io.write(`${JSON.stringify(issue, null, 2)}\n`);
    return;
  }
  ctx.io.write(`已创建任务: ${issue.id} ${issue.title}\n状态: ${issue.status}\n`);
}
