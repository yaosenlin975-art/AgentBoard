/**
 * DEP-2：MCP 依赖工具（设计 §10）——`list_dependencies` / `add_dependency` / `remove_dependency`（旧名 agentboard_* 保留为 alias）。
 * 参数与 REST 同构；按 `tools/tasks.ts` 既有模式强制 `resolveWorkspaceId`（绑定的工作区优先，拒绝越界）；
 * 错误码由 `apiClient` 透传（`DEPENDENCY_*` / `CROSS_WORKSPACE_DEPENDENCY` / `ISSUE_CLAIMED`），不吞错。
 */
import type { McpServer } from '@modelcontextprotocol/server';
import type { Issue } from '@agentboard/shared';
import { z } from 'zod/v4';
import type { McpConfig } from '../config.js';
import { McpError, requireAgentId, resolveWorkspaceId } from '../config.js';
import { AgentBoardApiClient } from '../apiClient.js';
import { registerBoardTool } from './register.js';
import { requestIdField, taskIdField, workspaceField } from './schemaText.js';
import { resolveTaskId } from './taskRef.js';

const issueIdField = {
  task_id: taskIdField.task_id.describe('Blocked task UUID.'),
};
const blockerIdField = {
  blocker_task_id: z.string().trim().min(1)
    .describe('Blocker task UUID; it must finish before task_id can be claimed.'),
};

/** 依赖视图（与 `Docs/api.md` §6 依赖段同构；由服务端算好 resolved） */
interface DependencyRef { issue_id: string; title: string; status: string; resolved: boolean }
interface DependencyView { blockers: DependencyRef[]; blocked: DependencyRef[] }

export function registerDependencyTools(server: McpServer, config: McpConfig, api: AgentBoardApiClient): void {
  registerBoardTool(server, {
    name: 'list_dependencies',
    description: 'List a task\'s blockers and blocked tasks.',
    inputSchema: z.object({
      ...workspaceField,
      ...issueIdField,
    }).strict(),
  }, async ({ workspace_id, task_id }) => {
    const workspaceId = resolveWorkspaceId(config, workspace_id, 'task');
    const taskId = await resolveTaskId(api, workspaceId, task_id);
    const view = await api.get<DependencyView>(`/issues/${encodeURIComponent(taskId)}/dependencies`, { workspace_id: workspaceId });
    return { ...view, workspace_id: workspaceId };
  });

  registerBoardTool(server, {
    name: 'add_dependency',
    description: 'Add a blocker edge; claimed tasks must be released first.',
    inputSchema: z.object({
      ...workspaceField,
      ...issueIdField,
      ...blockerIdField,
      ...requestIdField,
    }).strict(),
    readOnly: false,
  }, async ({ workspace_id, task_id, blocker_task_id, request_id }) => {
    const workspaceId = resolveWorkspaceId(config, workspace_id, 'task');
    const taskId = await resolveTaskId(api, workspaceId, task_id);
    const blockerTaskId = await resolveTaskId(api, workspaceId, blocker_task_id);
    try {
      const view = await api.mutate<DependencyView>('POST', `/issues/${encodeURIComponent(taskId)}/dependencies`, {
        workspace_id: workspaceId, blocker_issue_id: blockerTaskId,
      }, request_id);
      return { ...view, workspace_id: workspaceId };
    } catch (error) {
      // N4-05：ISSUE_CLAIMED 区分「自己占用」与「他人占用」，别让本人也被告知 another agent
      if (error instanceof McpError && error.code === 'ISSUE_CLAIMED') {
        const claimedBy = await api.get<Issue>(`/issues/${encodeURIComponent(taskId)}`, { workspace_id: workspaceId })
          .then(task => task.claimed_by).catch(() => null);
        if (claimedBy !== null && claimedBy === requireAgentId(config)) {
          throw new McpError('ISSUE_CLAIMED', `The task is claimed by you (${claimedBy}); finish it with complete_task / fail_task, or release_task, before adding a blocker.`);
        }
      }
      throw error;
    }
  });

  registerBoardTool(server, {
    name: 'remove_dependency',
    description: 'Remove a blocker edge (no request_id).',
    inputSchema: z.object({
      ...workspaceField,
      ...issueIdField,
      ...blockerIdField,
    }).strict(),
    readOnly: false,
  }, async ({ workspace_id, task_id, blocker_task_id }) => {
    const workspaceId = resolveWorkspaceId(config, workspace_id, 'task');
    const taskId = await resolveTaskId(api, workspaceId, task_id);
    const blockerTaskId = await resolveTaskId(api, workspaceId, blocker_task_id);
    // DELETE 的 workspace_id 走 query（服务端 `/api/issues/:id` 中间件从 query/body 取并校验归属）
    await api.delete(
      `/issues/${encodeURIComponent(taskId)}/dependencies/${encodeURIComponent(blockerTaskId)}?workspace_id=${encodeURIComponent(workspaceId)}`,
      undefined,
      'NOT_FOUND',
    );
    return { removed: true, task_id, blocker_task_id, workspace_id: workspaceId };
  });
}
