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
  /** `YYYY-MM-DD` 或 `YYYY-MM-DDTHH:mm`（DUE-DATE） */
  due?: string;
  requestId?: string;
}

interface CreateIssueBody {
  workspace_id: string;
  title: string;
  description?: string;
  priority?: string;
  labels?: string[];
  parent_issue_id?: string;
  due_date?: string;
  due_time?: string;
}

/**
 * `--due` 解析（DUE-DATE）：接受 `YYYY-MM-DD` 或 `YYYY-MM-DDTHH:mm`；其余格式直接报错，
 * 不发请求（服务端也会 400，但本地先挡能给出更直白的提示）。返回的两字段可独立为 null 的语义由调用方决定。
 */
export function parseDue(value: string): { due_date: string; due_time?: string } {
  const trimmed = value.trim();
  const withTime = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(trimmed);
  const dateOnly = /^(\d{4})-(\d{2})-(\d{2})$/.exec(trimmed);
  const match = withTime ?? dateOnly;
  if (match === null) throw new Error(`--due 需为 YYYY-MM-DD 或 YYYY-MM-DDTHH:mm，收到「${value}」`);
  const [, year, month, day, hour, minute] = match;
  const stamp = new Date(Number(year), Number(month) - 1, Number(day), Number(hour ?? 0), Number(minute ?? 0));
  if (
    stamp.getFullYear() !== Number(year) ||
    stamp.getMonth() !== Number(month) - 1 ||
    stamp.getDate() !== Number(day) ||
    (hour !== undefined && (Number(hour) > 23 || Number(minute) > 59))
  ) {
    throw new Error(`--due 不是有效日期时间：「${value}」`);
  }
  return withTime === null ? { due_date: trimmed } : { due_date: `${year}-${month}-${day}`, due_time: `${hour}:${minute}` };
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
  if (args.due !== undefined) {
    const due = parseDue(args.due);
    body.due_date = due.due_date;
    if (due.due_time !== undefined) body.due_time = due.due_time;
  }
  const issue = await request<Issue>(ctx.base, 'POST', '/api/issues', body, args.requestId ?? randomUUID());
  if (ctx.json) {
    ctx.io.write(`${JSON.stringify(issue, null, 2)}\n`);
    return;
  }
  const dueLine = issue.due_date === null || issue.due_date === undefined
    ? '截止: （未设置）'
    : `截止: ${issue.due_date}${issue.due_time === null || issue.due_time === undefined ? '' : ` ${issue.due_time}`}`;
  ctx.io.write(`已创建任务: ${issue.id} ${issue.title}\n状态: ${issue.status}\n${dueLine}\n`);
}
