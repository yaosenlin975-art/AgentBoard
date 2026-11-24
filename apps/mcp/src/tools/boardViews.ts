/**
 * ARCH-01：MCP 侧 `next_tasks` / `workspace_stats` 两个只读视图工具。
 *
 * 与 CLI `kb next` / `kb stats --json` 共用 `@agentboard/shared` 的 boardViews 纯函数，
 * 走同一批 REST 查询，返回与 CLI --json 同形的 `{ items, next_offset: null }` / StatsResult。
 * 不重复实现筛选 / 依赖 / 计数逻辑。
 *
 * FETCHC-2：取数收敛。`next_tasks` 只关心「未完成」卡，`workspace_stats` 的明细只用于
 * `unclaimed_open` / `blocked_open`，两者都带 `kinds=` + `fields=` 投影，不再整区全字段拉取；
 * `workspace_stats` 的五状态计数与 `total` 走 `GET /api/issues/counts`，保持整区口径。
 */
import {
  BUILTIN_STATUSES,
  NEXT_DEFAULT_LIMIT,
  buildNextItems,
  computeStats,
  nextCandidates,
  type BuiltinStatus,
  type DependencyView,
  type Issue,
  type StatsResult,
} from '@agentboard/shared';
import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod/v4';
import type { McpConfig } from '../config.js';
import { McpError, resolveWorkspaceId } from '../config.js';
import { AgentBoardApiClient } from '../apiClient.js';
import { registerBoardTool } from './register.js';
import { workspaceField } from './schemaText.js';

/** 未完成卡口径（与服务端 `STATUS_KINDS` 的开放类同值）；已关闭 / 已废弃不参与两个视图 */
const UNFINISHED_KINDS = 'open,started,review,blocked';

/** `buildNextItems` 需要的列：候选与同标签邻居都只读这些 */
const NEXT_TASK_FIELDS = 'id,title,status,priority,parent_issue_id,labels,claimed_by';

/** `computeStats` 只需要这三列就能算出未完成无主 / 被阻塞 */
const STATS_ROW_FIELDS = 'status,claimed_by,blocked_by_open_count';

/** 旧服务端不认 `fields=` / `kinds=`：400（未知参数）或 counts 路由缺失的 404 */
function isUnsupportedQuery(error: unknown): boolean {
  return error instanceof McpError
    && (error.code === 'VALIDATION_ERROR' || error.code === 'VALIDATION' || error.code === 'TASK_NOT_FOUND');
}

/** 与 CLI `stats.ts::readIssues` 同口径：整区 3 列投影，老服务端 400/404 时回落整对象 */
async function readStatsIssues(api: AgentBoardApiClient, workspaceId: string): Promise<Issue[]> {
  try {
    return await api.get<Issue[]>('/issues', { workspace: workspaceId, fields: STATS_ROW_FIELDS });
  } catch (error) {
    if (isUnsupportedQuery(error)) return api.get<Issue[]>('/issues', { workspace: workspaceId });
    throw error;
  }
}

/**
 * 未完成卡明细（`kinds=` + 3 列投影）。旧服务端不认这些参数时返回 null，
 * 调用方回落到整区投影，计数口径与改前逐字一致。
 */
async function readUnfinishedStatsIssues(api: AgentBoardApiClient, workspaceId: string): Promise<Issue[] | null> {
  try {
    return await api.get<Issue[]>('/issues', {
      workspace: workspaceId,
      kinds: UNFINISHED_KINDS,
      fields: STATS_ROW_FIELDS,
    });
  } catch (error) {
    if (isUnsupportedQuery(error)) return null;
    throw error;
  }
}

interface WorkspaceIssueCounts {
  workspace_id: string;
  total: number;
  counts: Record<string, number>;
}

/**
 * `GET /api/issues/counts` 的整区计数；路由缺失（旧服务端 / `AGENTBOARD_ISSUES_V2=off` 返回 404）
 * 或参数被拒时返回 null，由调用方回落整区投影。
 */
async function readWorkspaceCounts(api: AgentBoardApiClient, workspaceId: string): Promise<WorkspaceIssueCounts | null> {
  try {
    const response = await api.get<{ items?: WorkspaceIssueCounts[] }>('/issues/counts', { workspace_ids: workspaceId });
    if (!Array.isArray(response?.items)) return null;
    const item = response.items.find(entry => entry?.workspace_id === workspaceId);
    if (item === undefined || typeof item.total !== 'number' || typeof item.counts !== 'object' || item.counts === null) return null;
    return item;
  } catch (error) {
    if (isUnsupportedQuery(error)) return null;
    throw error;
  }
}

/** 五状态行与 total 取整区 counts，其余两列取未完成明细（`total` 不随过滤缩小） */
function assembleStats(workspaceId: string, counts: WorkspaceIssueCounts, rows: Issue[]): StatsResult {
  const scoped = computeStats(workspaceId, rows);
  const statuses = Object.fromEntries(
    BUILTIN_STATUSES.map(status => [status, counts.counts[status] ?? 0]),
  ) as Record<BuiltinStatus, number>;
  return { ...scoped, statuses, total: counts.total };
}

export function registerBoardViewTools(server: McpServer, config: McpConfig, api: AgentBoardApiClient): void {
  registerBoardTool(server, {
    name: 'next_tasks',
    description: 'List dispatchable tasks with parent, blockers, blocked and sibling ids; does not claim.',
    inputSchema: z.object({
      ...workspaceField,
      limit: z.number().int().min(1).default(NEXT_DEFAULT_LIMIT)
        .describe(`Maximum number of dispatchable tasks to return (default ${NEXT_DEFAULT_LIMIT}).`),
    }).strict(),
  }, async ({ workspace_id, limit }) => {
    const workspaceId = resolveWorkspaceId(config, workspace_id, 'collab');
    // 候选只可能是未完成卡；同标签邻居同为未完成卡，因此 kinds= 过滤前后候选与邻居集合等价
    const all = await readBoardIssues(api, workspaceId);
    const candidates = nextCandidates(all);
    const views = await Promise.all(candidates.map(issue => api.get<DependencyView>(
      `/issues/${encodeURIComponent(issue.id)}/dependencies`,
      { workspace_id: workspaceId },
    )));
    const { items } = buildNextItems(all, candidates, views, limit);
    return { items, next_offset: null };
  });

  registerBoardTool(server, {
    name: 'workspace_stats',
    description: 'Summarize status counts, unclaimed open tasks, blocked tasks and total tasks.',
    inputSchema: z.object({ ...workspaceField }).strict(),
  }, async ({ workspace_id }) => {
    const workspaceId = resolveWorkspaceId(config, workspace_id, 'stats');
    // 先取整区 counts：它缺失说明服务端不支持新契约，直接整区投影一次，不做无用的过滤请求
    const counts = await readWorkspaceCounts(api, workspaceId);
    if (counts === null) return computeStats(workspaceId, await readStatsIssues(api, workspaceId));
    const rows = await readUnfinishedStatsIssues(api, workspaceId);
    // 明细过滤被拒（老服务端不认 kinds=）：整区投影一次算完
    if (rows === null) return computeStats(workspaceId, await readStatsIssues(api, workspaceId));
    return assembleStats(workspaceId, counts, rows);
  });
}

/** `next_tasks` 取数：未完成卡 + 投影；旧服务端不认时回落整区全字段（行为与改前一致） */
async function readBoardIssues(api: AgentBoardApiClient, workspaceId: string): Promise<Issue[]> {
  try {
    return await api.get<Issue[]>('/issues', {
      workspace: workspaceId,
      kinds: UNFINISHED_KINDS,
      fields: NEXT_TASK_FIELDS,
    });
  } catch (error) {
    if (isUnsupportedQuery(error)) return api.get<Issue[]>('/issues', { workspace: workspaceId });
    throw error;
  }
}
