/**
 * OPT-11：`kb stats` —— 一次输出工作区汇总计数（五状态 / 未完成无主 / 被阻塞）。
 *
 * 取数只走一次 `GET /api/issues?workspace=<id>`，计数在本地做；不落库、不加缓存、不改列表命令。
 * 目的：替代技能里「每个数字后面各附一行复算命令」的多轮 shell 调用，同时保留可复核性
 * （输出带 workspace id 与生成本地时间，数字可用同一条命令重算）。
 * ARCH-01：计数/时间戳/结果类型抽到 `@agentboard/shared` 的 boardViews，与 MCP `workspace_stats` 共用。
 */
import {
  BUILTIN_STATUSES,
  computeStats,
  localTimestamp,
  type BuiltinStatus,
  type Issue,
  type StatsResult,
} from '@agentboard/shared';
import { CliHttpError, request } from '../api.js';
import type { Ctx } from '../io.js';
import { resolveWorkspaceWithHint } from '../workspace.js';

export { BUILTIN_STATUSES, computeStats, localTimestamp, type BuiltinStatus, type StatsResult } from '@agentboard/shared';

export interface StatsArgs {
  /** 工作区 id / 名称 / ≥8 位唯一前缀；缺省按 cwd 解析 */
  workspace?: string;
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
