/**
 * STATUS-2：MCP 状态字典工具（设计 §3.2 / D3）——
 * `agentboard_list_statuses` / `agentboard_add_status` / `agentboard_remove_status`。
 * 参数与 REST 同构；按 `tools/tasks.ts` 既有模式强制 `resolveWorkspaceId`（绑定的工作区优先，越界 `WORKSPACE_BOUND`）；
 * 错误码由 `apiClient` 透传（`WORKSPACE_STATUS_EXISTS` / `WORKSPACE_STATUS_BUILTIN` / `MIGRATION_TARGET_REQUIRED` / `MIGRATION_TARGET_INVALID`）。
 */
import type { WorkspaceStatus } from '@agentboard/shared';
import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod/v4';
import type { McpConfig } from '../config.js';
import { resolveWorkspaceId } from '../config.js';
import { AgentBoardApiClient } from '../apiClient.js';
import { mcpToolFailure, mcpToolSuccess } from './result.js';

const workspaceField = { workspace_id: z.string().trim().min(1).optional() };
const requestIdField = { request_id: z.string().uuid() };
const kindSchema = z.enum(['open', 'started', 'review', 'done', 'deprecated']);

export function registerStatusTools(server: McpServer, config: McpConfig, api: AgentBoardApiClient): void {
  const register = (name: string, description: string, inputSchema: z.ZodObject<any>, run: (input: any) => Promise<unknown>, readOnly = true) => {
    server.registerTool(name, { description, inputSchema, annotations: { readOnlyHint: readOnly } }, async (input) => {
      try {
        return mcpToolSuccess(await run(input), `${name} succeeded.`);
      } catch (error) {
        return mcpToolFailure(error);
      }
    });
  };

  register('agentboard_list_statuses', 'List one workspace\'s status dictionary (name, kind, sort order, builtin flag).', z.object({
    ...workspaceField,
  }).strict(), async ({ workspace_id }) => {
    const workspaceId = resolveWorkspaceId(config, workspace_id);
    const rows = await api.get<WorkspaceStatus[]>(`/workspaces/${encodeURIComponent(workspaceId)}/statuses`);
    return { workspace_id: workspaceId, items: rows };
  });

  register('agentboard_add_status', 'Add a custom status to one workspace. Builtin statuses cannot be duplicated (409); kind drives behaviour.', z.object({
    ...workspaceField,
    name: z.string().trim().min(1).max(50),
    kind: kindSchema.default('open'),
    sort_order: z.number().int().optional(),
    ...requestIdField,
  }).strict(), async ({ workspace_id, name, kind, sort_order, request_id }) => {
    const workspaceId = resolveWorkspaceId(config, workspace_id);
    const created = await api.mutate<WorkspaceStatus>('POST', `/workspaces/${encodeURIComponent(workspaceId)}/statuses`, {
      workspace_id: workspaceId, name, kind, ...(sort_order === undefined ? {} : { sort_order }),
    }, request_id);
    return created;
  }, false);

  register('agentboard_remove_status', 'Remove a custom status. migrate_to is required: tasks in that status are moved to it in the same transaction. Builtin statuses are rejected.', z.object({
    ...workspaceField,
    status_id: z.string().trim().min(1),
    migrate_to: z.string().trim().min(1),
  }).strict(), async ({ workspace_id, status_id, migrate_to }) => {
    const workspaceId = resolveWorkspaceId(config, workspace_id);
    // DELETE 走 query 传 migrate_to（REST 侧同样不套幂等键）
    const path = `/workspaces/${encodeURIComponent(workspaceId)}/statuses/${encodeURIComponent(status_id)}?migrate_to=${encodeURIComponent(migrate_to)}`;
    return api.delete<{ removed: WorkspaceStatus; migrate_to: string; migrated_issue_count: number }>(path, 'WORKSPACE_STATUS_BUILTIN', 'NOT_FOUND');
  }, false);
}
