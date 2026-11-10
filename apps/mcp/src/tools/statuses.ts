/**
 * STATUS-2：MCP 状态字典工具（设计 §3.2 / D3）——
 * `list_statuses` / `add_status` / `remove_status`（旧名 agentboard_* 保留为 alias）。
 * 参数与 REST 同构；按 `tools/tasks.ts` 既有模式强制 `resolveWorkspaceId`（绑定的工作区优先，越界 `WORKSPACE_BOUND`）；
 * 错误码由 `apiClient` 透传（`WORKSPACE_STATUS_EXISTS` / `WORKSPACE_STATUS_BUILTIN` / `MIGRATION_TARGET_REQUIRED` / `MIGRATION_TARGET_INVALID`）。
 */
import type { WorkspaceStatus } from '@agentboard/shared';
import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod/v4';
import type { McpConfig } from '../config.js';
import { resolveWorkspaceId } from '../config.js';
import { AgentBoardApiClient } from '../apiClient.js';
import { registerBoardTool } from './register.js';

const workspaceField = {
  workspace_id: z.string().trim().min(1).optional()
    .describe('Workspace UUID. Omit to use the workspace this MCP server is bound to.'),
};
const requestIdField = {
  request_id: z.string().uuid()
    .describe('Idempotency key (UUID). Replaying the same request_id returns the original result; reusing it with different arguments fails with a conflict.'),
};
const kindSchema = z.enum(['open', 'started', 'review', 'done', 'deprecated', 'blocked'])
  .describe('Behaviour class of the status: open / started / review / done / deprecated / blocked.');

export function registerStatusTools(server: McpServer, config: McpConfig, api: AgentBoardApiClient): void {
  registerBoardTool(server, {
    name: 'list_statuses',
    description: 'List one workspace\'s status dictionary (name, kind, sort order, builtin flag).',
    inputSchema: z.object({
      ...workspaceField,
    }).strict(),
  }, async ({ workspace_id }) => {
    const workspaceId = resolveWorkspaceId(config, workspace_id);
    const rows = await api.get<WorkspaceStatus[]>(`/workspaces/${encodeURIComponent(workspaceId)}/statuses`);
    return { workspace_id: workspaceId, items: rows };
  });

  registerBoardTool(server, {
    name: 'add_status',
    description: 'Add a custom status to one workspace. Builtin statuses cannot be duplicated (409); kind drives behaviour.',
    inputSchema: z.object({
      ...workspaceField,
      name: z.string().trim().min(1).max(50)
        .describe('Status name shown on the board, up to 50 chars, e.g. 等评审. Must be unique in this workspace.'),
      kind: kindSchema.default('open'),
      sort_order: z.number().int().optional()
        .describe('Position in the status list; lower shows first. Omit to append.'),
      ...requestIdField,
    }).strict(),
    readOnly: false,
  }, async ({ workspace_id, name, kind, sort_order, request_id }) => {
    const workspaceId = resolveWorkspaceId(config, workspace_id);
    const created = await api.mutate<WorkspaceStatus>('POST', `/workspaces/${encodeURIComponent(workspaceId)}/statuses`, {
      workspace_id: workspaceId, name, kind, ...(sort_order === undefined ? {} : { sort_order }),
    }, request_id);
    return created;
  });

  registerBoardTool(server, {
    name: 'remove_status',
    description: 'Remove a custom status. migrate_to is required: tasks in that status are moved to it in the same transaction. Builtin statuses are rejected.',
    inputSchema: z.object({
      ...workspaceField,
      status_id: z.string().trim().min(1)
        .describe('Status id (or its name) to remove. Builtin statuses are rejected with WORKSPACE_STATUS_BUILTIN.'),
      migrate_to: z.string().trim().min(1)
        .describe('Status name that receives every task currently in status_id, applied in the same transaction. Required.'),
    }).strict(),
    readOnly: false,
  }, async ({ workspace_id, status_id, migrate_to }) => {
    const workspaceId = resolveWorkspaceId(config, workspace_id);
    // DELETE 走 query 传 migrate_to（REST 侧同样不套幂等键）
    const path = `/workspaces/${encodeURIComponent(workspaceId)}/statuses/${encodeURIComponent(status_id)}?migrate_to=${encodeURIComponent(migrate_to)}`;
    return api.delete<{ removed: WorkspaceStatus; migrate_to: string; migrated_issue_count: number }>(path, 'WORKSPACE_STATUS_BUILTIN', 'NOT_FOUND');
  });
}
