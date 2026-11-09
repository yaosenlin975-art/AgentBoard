/**
 * OPT-11：`kb stats` —— 一次输出工作区汇总计数（五状态 / 未完成无主 / 被阻塞）。
 *
 * 取数只走一次 `GET /api/issues?workspace=<id>`，计数在本地做；不落库、不加缓存、不改列表命令。
 * 目的：替代技能里「每个数字后面各附一行复算命令」的多轮 shell 调用，同时保留可复核性
 * （输出带 workspace id 与生成本地时间，数字可用同一条命令重算）。
 */
import { CliHttpError, request } from '../api.js';
import type { Issue } from '@agentboard/shared';
import type { Ctx } from '../io.js';
import { resolveWorkspaceWithHint } from '../workspace.js';

/** 内置五状态（自定义状态不计入这五行，避免和 list-tasks --status 口径打架） */
export const BUILTIN_STATUSES = ['待规划', '进行中', '待验收', '已关闭', '已废弃'] as const;
export type BuiltinStatus = (typeof BUILTIN_STATUSES)[number];

/** 「未完成」口径与服务端收敛参数 kinds=open,started,review 一致 */
const UNFINISHED = new Set<string>(['待规划', '进行中', '待验收']);

export interface StatsArgs {
  /** 工作区 id / 名称 / ≥8 位唯一前缀；缺省按 cwd 解析 */
  workspace?: string;
}

export interface StatsResult {
  workspace_id: string;
  generated_at: string;
  statuses: Record<BuiltinStatus, number>;
  /** 未完成（待规划/进行中/待验收）且 claimed_by 为空的卡数 */
  unclaimed_open: number;
  /** 未完成且存在未解除前置（blocked_by_open_count > 0）的卡数 */
  blocked_open: number;
  /** 本次统计覆盖的卡总数（含自定义状态） */
  total: number;
}

/** 本地时间戳：YYYY-MM-DD HH:mm:ss±HH:mm（便于人读与事后复算） */
export function localTimestamp(date: Date = new Date()): string {
  const pad = (value: number): string => String(value).padStart(2, '0');
  const offsetMinutes = -date.getTimezoneOffset();
  const sign = offsetMinutes >= 0 ? '+' : '-';
  const abs = Math.abs(offsetMinutes);
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} `
    + `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
    + `${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`;
}

/** fields 裁剪：老服务端不认则回落整对象（口径不变，只是多传几列） */
async function readIssues(ctx: Ctx, workspaceId: string): Promise<Issue[]> {
  const path = `/api/issues?workspace=${encodeURIComponent(workspaceId)}`;
  try {
    return await request<Issue[]>(ctx.base, 'GET', `${path}&fields=status,claimed_by,blocked_by_open_count`);
  } catch (error) {
    if (error instanceof CliHttpError && (error.status === 400 || error.status === 404)) {
      return request<Issue[]>(ctx.base, 'GET', path);
    }
    throw error;
  }
}

export function computeStats(workspaceId: string, issues: Issue[], now: Date = new Date()): StatsResult {
  const statuses = Object.fromEntries(BUILTIN_STATUSES.map(status => [status, 0])) as Record<BuiltinStatus, number>;
  let unclaimedOpen = 0;
  let blockedOpen = 0;
  for (const issue of issues) {
    if ((BUILTIN_STATUSES as readonly string[]).includes(issue.status)) {
      statuses[issue.status as BuiltinStatus] += 1;
    }
    if (!UNFINISHED.has(issue.status)) continue;
    if (issue.claimed_by === null || issue.claimed_by === undefined || issue.claimed_by === '') unclaimedOpen += 1;
    const openCount = (issue as Issue & { blocked_by_open_count?: number | null }).blocked_by_open_count ?? 0;
    if (openCount > 0) blockedOpen += 1;
  }
  return {
    workspace_id: workspaceId,
    generated_at: localTimestamp(now),
    statuses,
    unclaimed_open: unclaimedOpen,
    blocked_open: blockedOpen,
    total: issues.length,
  };
}

export async function stats(ctx: Ctx, args: StatsArgs = {}): Promise<number> {
  const workspaceId = await resolveWorkspaceWithHint(ctx.base, args.workspace, ctx.io.writeErr);
  const result = computeStats(workspaceId, await readIssues(ctx, workspaceId));
  if (ctx.json) {
    ctx.io.write(`${JSON.stringify(result, null, 2)}\n`);
    return 0;
  }
  ctx.io.write(`工作区: ${result.workspace_id}\n`);
  ctx.io.write(`生成时间: ${result.generated_at}\n`);
  for (const status of BUILTIN_STATUSES) ctx.io.write(`${status}: ${result.statuses[status]}\n`);
  ctx.io.write(`无主（未完成）: ${result.unclaimed_open}\n`);
  ctx.io.write(`被阻塞（未完成，有未解除前置）: ${result.blocked_open}\n`);
  ctx.io.write(`覆盖卡总数: ${result.total}\n`);
  ctx.io.write(`复算：kb list-tasks --workspace ${result.workspace_id} --status <状态> --json | node -pe "JSON.parse(require('fs').readFileSync(0,'utf8')).items.length"\n`);
  return 0;
}
