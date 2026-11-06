/**
 * CLI-CLOSE：`kb close` / `kb reopen` / `kb update` 三条收尾命令。
 *
 * - close：待验收 → 已关闭（占用中 409：占用者先 kb release 或 done/fail 再关；已关闭幂等返回）。
 * - reopen：已关闭/已废弃 → `--to`（默认待规划）；目标必须是本工作区已定义状态。
 * - update：改 title/description/priority/labels/due_date/due_time/parent；**不含 status**（流转走 close/reopen/done/fail）。
 *
 * 三条都支持 `--request-id <uuid>`（幂等，同 done/fail 口径）。
 */
import type { Issue } from '@agentboard/shared';
import { CommanderError } from 'commander';
import { CliHttpError, request, verifyIssueStoredText } from '../api.js';
import { releaseAdvice } from '../errors.js';
import type { Ctx } from '../io.js';
import { normalizeIssueIdArg, normalizeIssueRef } from '../issueRef.js';
import { issueLines } from '../render.js';

export interface RequestIdArg { requestId?: string }

/**
 * 409 自带可解释文案（占用中 / 状态不允许），原样透出并退出 2；
 * 否则全局 toExit 会包装成「已被占用（只有「待验收」的任务可以关闭…）」，语义错位。
 */
const mapConflict = (ctx: Ctx, error: unknown): never => {
  if (error instanceof CliHttpError && error.status === 409) {
    ctx.io.writeErr(`${releaseAdvice(error.message)}\n`);
    throw new CommanderError(2, 'agentboard.lifecycle', '');
  }
  throw error;
};

export async function close(ctx: Ctx, id: string, args: RequestIdArg = {}): Promise<void> {
  // CLI-02：允许 ≥8 位前缀
  const target = await normalizeIssueRef(ctx, id);
  const issue = await request<Issue>(ctx.base, 'POST', `/api/issues/${encodeURIComponent(target.id)}/close`, { agent_id: ctx.agentId }, args.requestId)
    .catch(error => mapConflict(ctx, error));
  if (ctx.json) {
    ctx.io.write(`${JSON.stringify(issue, null, 2)}\n`);
    return;
  }
  ctx.io.write(`已关闭: ${issue.id}\n状态: ${issue.status}\n`);
}

export interface ReopenArgs extends RequestIdArg { to?: string }

export async function reopen(ctx: Ctx, id: string, args: ReopenArgs = {}): Promise<void> {
  // CLI-02：允许 ≥8 位前缀
  const target = await normalizeIssueRef(ctx, id);
  const body: { agent_id: string; status?: string } = { agent_id: ctx.agentId };
  if (args.to !== undefined) body.status = args.to;
  const issue = await request<Issue>(ctx.base, 'POST', `/api/issues/${encodeURIComponent(target.id)}/reopen`, body, args.requestId)
    .catch(error => mapConflict(ctx, error));
  if (ctx.json) {
    ctx.io.write(`${JSON.stringify(issue, null, 2)}\n`);
    return;
  }
  ctx.io.write(`已重开: ${issue.id}\n状态: ${issue.status}\n`);
}

export interface UpdateArgs extends RequestIdArg {
  title?: string;
  description?: string;
  /** 从 stdin 读取描述（长文本；与 --description 互斥，优先生效） */
  descriptionStdin?: boolean;
  priority?: string;
  labels?: string;
  dueDate?: string;
  dueTime?: string;
  parent?: string;
  /** 显式清空截止日期/时间 */
  clearDue?: boolean;
  clearParent?: boolean;
}

export async function update(ctx: Ctx, id: string, args: UpdateArgs = {}): Promise<void> {
  // CLI-02：允许 ≥8 位前缀（位置参数与 --parent 都解析）
  const target = await normalizeIssueRef(ctx, id);
  const patch: Record<string, unknown> = {};
  if (args.title !== undefined) patch.title = args.title;
  if (args.descriptionStdin === true) {
    const text = (await ctx.io.readStdin()).replace(/\r\n/g, '\n');
    if (text.trim() === '') throw new Error('--description-stdin 读到空内容');
    patch.description = text.endsWith('\n') ? text.slice(0, -1) : text;
  } else if (args.description !== undefined) {
    patch.description = args.description;
  }
  if (args.priority !== undefined) patch.priority = args.priority;
  if (args.labels !== undefined) patch.labels = args.labels.split(',').map(label => label.trim()).filter(Boolean);
  if (args.clearDue === true) {
    patch.due_date = null;
    patch.due_time = null;
  } else {
    if (args.dueDate !== undefined) patch.due_date = args.dueDate;
    if (args.dueTime !== undefined) patch.due_time = args.dueTime;
  }
  if (args.clearParent === true) patch.parent_issue_id = null;
  else if (args.parent !== undefined) patch.parent_issue_id = await normalizeIssueIdArg(ctx, args.parent);

  if (Object.keys(patch).length === 0) {
    throw new Error('至少提供一个要修改的字段：--title / --description / --description-stdin / --priority / --labels / --due-date / --due-time / --parent / --clear-due / --clear-root');
  }
  const issue = await request<Issue>(ctx.base, 'PATCH', `/api/issues/${encodeURIComponent(target.id)}`, { ...patch, agent_id: ctx.agentId }, args.requestId)
    .catch(error => mapConflict(ctx, error));
  // MOJI-GUARD：回读实际落库文本，中文被替换成 ? 时不再静默通过
  await verifyIssueStoredText(ctx.base, issue.id, {
    ...(patch.title === undefined ? {} : { title: String(patch.title) }),
    ...(patch.description === undefined ? {} : { description: String(patch.description) }),
  });
  if (ctx.json) {
    ctx.io.write(`${JSON.stringify(issue, null, 2)}\n`);
    return;
  }
  ctx.io.write(`已更新: ${issue.id}\n${issueLines(issue).join('\n')}\n`);
}
