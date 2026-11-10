/**
 * CLI-CLOSE：`kb close` / `kb reopen` / `kb update` 三条收尾命令。
 *
 * - close：待验收 → 已关闭（占用中 409：占用者先 kb release 或 done/fail 再关；已关闭幂等返回）。
 * - reopen：已关闭/已废弃 → `--to`（默认待规划）；目标必须是本工作区已定义状态。
 * - update：改 title/description/priority/labels/due_date/due_time/parent/status（内置流转仍优先走 close/reopen/done/fail）。
 *
 * 三条都支持 `--request-id <uuid>`（幂等，同 done/fail 口径）。
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { Issue } from '@agentboard/shared';
import { CommanderError } from 'commander';
import { CliHttpError, request, verifyIssueStoredText } from '../api.js';
import { clearClaimedFence, loadClaimedFence } from '../claimStore.js';
import { releaseAdvice } from '../errors.js';
import type { Ctx } from '../io.js';
import { normalizeIssueIdArg, normalizeIssueRef, shortIssueId, withNotFoundSuggestion } from '../issueRef.js';
import { issueLines } from '../render.js';

export interface RequestIdArg { requestId?: string }

/**
 * 409 自带可解释文案（占用中 / 状态不允许），原样透出并退出 2；
 * 否则全局 toExit 会包装成「已被占用（只有「待验收」的任务可以关闭…）」，语义错位。
 */
const mapConflict = (ctx: Ctx, error: unknown): never => {
  if (error instanceof CliHttpError && error.status === 409) {
    // B7：close 撞状态门禁时补下一步（原先只说「只有待验收可以关闭」，不说怎么到待验收）
    const message = error.message.includes('只有「待验收」的任务可以关闭')
      ? `${error.message}；若卡仍在待规划/进行中，请先 kb done <issue-id> 提交验收`
      : error.message;
    ctx.io.writeErr(`${releaseAdvice(message)}\n`);
    throw new CommanderError(2, 'agentboard.lifecycle', '');
  }
  throw error;
};

function postClose(ctx: Ctx, issueId: string, requestId?: string): Promise<Issue> {
  return request<Issue>(ctx.base, 'POST', `/api/issues/${encodeURIComponent(issueId)}/close`, { agent_id: ctx.agentId }, requestId);
}

/** 读当前卡；读不到返回 null（占用判定失败时按原始冲突透出，不改变语义） */
async function getIssueOrNull(ctx: Ctx, issueId: string): Promise<Issue | null> {
  try {
    return await request<Issue>(ctx.base, 'GET', `/api/issues/${encodeURIComponent(issueId)}`);
  } catch {
    return null;
  }
}

/** 释放自有占用：必须带 workspace_id（服务端据此走占用者释放语义，不降级成强制释放） */
async function releaseOwnClaim(ctx: Ctx, issue: Issue): Promise<void> {
  const body: { agent_id: string; workspace_id: string; fence?: number } = {
    agent_id: ctx.agentId,
    workspace_id: issue.workspace_id,
  };
  const storedFence = loadClaimedFence(issue.id);
  if (storedFence !== undefined) body.fence = storedFence;
  // 不传 close 的 --request-id：幂等键按 (resource, payload) 校验，跨端点复用会 409 IDEMPOTENCY_KEY_REUSED
  await request<Issue>(ctx.base, 'POST', `/api/issues/${encodeURIComponent(issue.id)}/release`, body);
  clearClaimedFence(issue.id);
}

export interface CloseOutcome {
  issue: Issue;
  /** true = 命中自有占用，先自动 release 一次再关 */
  released: boolean;
}

/**
 * CLOSE-FLOW：close 的共用流程（kb close 与 done --close 都走这里）。
 * 仅当服务端 409 ISSUE_CLAIMED 且占用者等于当前 agent 时自动 release 一次再关；
 * 他人占用、未关闭后代、状态不允许等冲突一律不重试，原样透出。
 */
export async function closeIssueWithOwnRelease(ctx: Ctx, issueId: string, requestId?: string): Promise<CloseOutcome> {
  try {
    return { issue: await postClose(ctx, issueId, requestId), released: false };
  } catch (error) {
    if (!(error instanceof CliHttpError) || error.status !== 409 || error.code !== 'ISSUE_CLAIMED') throw error;
    const current = await getIssueOrNull(ctx, issueId);
    if (current === null || current.claimed_by !== ctx.agentId) throw error;
    await releaseOwnClaim(ctx, current);
    return { issue: await postClose(ctx, issueId, requestId), released: true };
  }
}

export async function close(ctx: Ctx, id: string, args: RequestIdArg = {}): Promise<void> {
  // CLI-02：允许 ≥8 位前缀
  const target = await normalizeIssueRef(ctx, id);
  const outcome = await closeIssueWithOwnRelease(ctx, target.id, args.requestId)
    .catch(error => mapConflict(ctx, error));
  if (ctx.json) {
    ctx.io.write(`${JSON.stringify(outcome.issue, null, 2)}\n`);
    return;
  }
  if (outcome.released) ctx.io.write('已释放自有占用后关闭\n');
  ctx.io.write(`已关闭: ${outcome.issue.id}\n状态: ${outcome.issue.status}\n`);
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
  /** CLI-STATUS-SET：目标状态名（本工作区已定义状态，含自定义；占用中的卡由服务端 409 拒绝） */
  status?: string;
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
  // CLI-STATUS-SET：状态合法性与占用门禁由服务端判定（400 列可用状态 / 409 占用中禁止修改状态）
  if (args.status !== undefined) patch.status = args.status;

  if (Object.keys(patch).length === 0) {
    throw new Error('至少提供一个要修改的字段：--title / --description / --description-stdin / --priority / --labels / --due-date / --due-time / --parent / --clear-due / --clear-root / --status');
  }
  const issue = await withNotFoundSuggestion(ctx, id, () =>
    request<Issue>(ctx.base, 'PATCH', `/api/issues/${encodeURIComponent(target.id)}`, { ...patch, agent_id: ctx.agentId }, args.requestId))
    .catch((error: unknown) => {
      // CLI-STATUS-SET：服务端只回「占用中禁止修改状态」，补一行释放办法，避免用户不知道下一步
      if (args.status !== undefined && error instanceof CliHttpError && error.status === 409) {
        ctx.io.writeErr('提示：改状态前需先释放占用（kb done / kb fail / kb release）\n');
      }
      return mapConflict(ctx, error);
    });
  // MOJI-GUARD：回读实际落库文本，中文被替换成 ? 时不再静默通过
  await verifyIssueStoredText(ctx.base, issue.id, {
    ...(patch.title === undefined ? {} : { title: String(patch.title) }),
    ...(patch.description === undefined ? {} : { description: String(patch.description) }),
  });
  if (ctx.json) {
    ctx.io.write(`${JSON.stringify(issue, null, 2)}\n`);
    return;
  }
  ctx.io.write(`已更新: ${issue.id}\n卡：${shortIssueId(issue.id)} ${issue.title}（${issue.status}）\n${issueLines(issue).join('\n')}\n`);
}

/**
 * BULK-OPS：读取 `--ids-file`。每行一个任务引用（完整 UUID 或 ≥8 位前缀）；
 * 空行与 `#` 注释忽略；编辑器/管道写出的 UTF-8 BOM 先剥离，避免首条 id 被污染。
 */
export function readIdsFile(path: string): string[] {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch (error) {
    throw new Error(`--ids-file 读取失败（${path}）：${(error as Error).message}`);
  }
  const entries = text
    .replace(/^\uFEFF/, '')
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(line => line !== '' && !line.startsWith('#'));
  if (entries.length === 0) {
    throw new Error(`--ids-file 未读到任何任务 id（${path}）：每行一个 id，空行与 # 注释会被忽略`);
  }
  return entries;
}

/**
 * BULK-OPS：每条操作的幂等键由 `--request-id` 基底派生（确定性 UUID）。
 * 把动作与任务引用一起混入，避免同一次批量里 close/release/fail 互相撞键；
 * 同一（基底, 动作, 引用）重跑得到同一个键，服务端幂等回放，不重复写。
 */
export function deriveBulkRequestId(base: string, action: string, issueRef: string): string {
  const hex = createHash('sha256').update(`${base}:${action}:${issueRef.trim().toLowerCase()}`).digest('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

export interface BulkRunArgs {
  /** 动作名（close / release / fail）：用于汇总文案与幂等键派生 */
  action: string;
  idsFile: string;
  dryRun?: boolean;
  /** 幂等键基底；给定时每条按（基底, action, 引用）派生 */
  requestId?: string;
  /** 单条执行：失败以异常表达，批量层负责汇总与退出码 */
  run: (ref: string, requestId?: string) => Promise<unknown>;
}

export interface BulkItemResult {
  ref: string;
  outcome: '成功' | '失败' | '跳过';
  reason?: string;
}

function bulkFailureReason(error: unknown): string {
  if (error instanceof CliHttpError) return error.message;
  return error instanceof Error ? error.message : String(error);
}

/**
 * BULK-OPS：串行执行批量动作，末尾打印汇总（成功/失败/跳过 + 每条失败原因）。
 * - 任一失败 → exit 1；条目间的失败不中断后续条目。
 * - `--dry-run` 只打印清单，零请求、零写入。
 * - 重复行只执行一次，第二次计入「跳过」。
 */
export async function runBulk(ctx: Ctx, args: BulkRunArgs): Promise<void> {
  const entries = readIdsFile(args.idsFile);
  if (args.dryRun === true) {
    if (ctx.json) {
      ctx.io.write(`${JSON.stringify({ action: args.action, dry_run: true, count: entries.length, ids: entries }, null, 2)}\n`);
      return;
    }
    ctx.io.write(`[dry-run] ${args.action}：将处理 ${entries.length} 张（未写入任何数据）\n`);
    for (const ref of entries) ctx.io.write(`  - ${ref}\n`);
    return;
  }

  const results: BulkItemResult[] = [];
  const seen = new Set<string>();
  for (const ref of entries) {
    const key = ref.toLowerCase();
    if (seen.has(key)) {
      results.push({ ref, outcome: '跳过', reason: '重复 id' });
      continue;
    }
    seen.add(key);
    const requestId = args.requestId === undefined ? undefined : deriveBulkRequestId(args.requestId, args.action, ref);
    try {
      await args.run(ref, requestId);
      results.push({ ref, outcome: '成功' });
    } catch (error) {
      results.push({ ref, outcome: '失败', reason: bulkFailureReason(error) });
    }
  }

  const succeeded = results.filter(item => item.outcome === '成功').length;
  const failed = results.filter(item => item.outcome === '失败');
  const skipped = results.filter(item => item.outcome === '跳过');

  if (ctx.json) {
    ctx.io.write(`${JSON.stringify({ action: args.action, success: succeeded, failed: failed.length, skipped: skipped.length, results }, null, 2)}\n`);
  } else {
    ctx.io.write(`批量 ${args.action}：成功 ${succeeded} / 失败 ${failed.length} / 跳过 ${skipped.length}\n`);
    if (failed.length > 0) {
      ctx.io.write('失败：\n');
      for (const item of failed) ctx.io.write(`  - ${item.ref}：${item.reason ?? '未知错误'}\n`);
    }
    if (skipped.length > 0) {
      ctx.io.write('跳过：\n');
      for (const item of skipped) ctx.io.write(`  - ${item.ref}：${item.reason ?? ''}\n`);
    }
  }
  if (failed.length > 0) throw new CommanderError(1, 'agentboard.bulk', '');
}
