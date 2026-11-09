/**
 * ARCH-01：MCP 侧 `next_tasks` / `workspace_stats` 两个只读视图工具。
 *
 * 与 CLI `kb next` / `kb stats --json` 共用 `@agentboard/shared` 的 boardViews 纯函数，
 * 走同一批 REST 查询，返回与 CLI --json 同形的 `{ items, next_offset: null }` / StatsResult。
 * 不重复实现筛选 / 依赖 / 计数逻辑。
 */
import {
  NEXT_DEFAULT_LIMIT,
  buildNextItems,
  computeStats,
  nextCandidates,
  type DependencyView,
  type Issue,
} from '@agentboard/shared';
import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod/v4';
import type { McpConfig } from '../config.js';
import { McpError, resolveWorkspaceId } from '../config.js';
import { AgentBoardApiClient } from '../apiClient.js';
import { registerBoardTool } from './register.js';

const workspaceField = { workspace_id: z.string().trim().min(1).optional() };

/** 与 CLI `stats.ts::readIssues` 同口径：新服务端裁剪字段，老服务端 400/404 时回落整对象 */
async function readStatsIssues(api: AgentBoardApiClient, workspaceId: string): Promise<Issue[]> {
  try {
    return await api.get<Issue[]>('/issues', {
      workspace: workspaceId,
      fields: 'status,claimed_by,blocked_by_open_count',
    });
  } catch (error) {
    if (error instanceof McpError && (error.code === 'VALIDATION_ERROR' || error.code === 'VALIDATION' || error.code === 'TASK_NOT_FOUND')) {
      return api.get<Issue[]>('/issues', { workspace: workspaceId });
    }
    throw error;
  }
}

export function registerBoardViewTools(server: McpServer, config: McpConfig, api: AgentBoardApiClient): void {
  registerBoardTool(server, {
    name: 'next_tasks',
    description: 'List dispatchable tasks (待规划, unclaimed, all blockers resolved) with the fields needed to dispatch: parent, blockers, blocked, sibling ids. Same shape as `kb next --json`; does not claim.',
    inputSchema: z.object({
      ...workspaceField,
      limit: z.number().int().min(1).default(NEXT_DEFAULT_LIMIT),
    }).strict(),
  }, async ({ workspace_id, limit }) => {
    const workspaceId = resolveWorkspaceId(config, workspace_id);
    const all = await api.get<Issue[]>('/issues', { workspace: workspaceId });
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
    description: 'Summarize one workspace in a single call: five built-in status counts, unclaimed open tasks, blocked open tasks, total tasks. Same shape as `kb stats --json`.',
    inputSchema: z.object({ ...workspaceField }).strict(),
  }, async ({ workspace_id }) => {
    const workspaceId = resolveWorkspaceId(config, workspace_id);
    return computeStats(workspaceId, await readStatsIssues(api, workspaceId));
  });
}
