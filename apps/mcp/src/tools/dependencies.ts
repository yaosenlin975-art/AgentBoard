/**
 * DEP-2：MCP 依赖工具（设计 §10）——`list_dependencies` / `add_dependency` / `remove_dependency`（旧名 agentboard_* 保留为 alias）。
 * 参数与 REST 同构；按 `tools/tasks.ts` 既有模式强制 `resolveWorkspaceId`（绑定的工作区优先，拒绝越界）；
 * 错误码由 `apiClient` 透传（`DEPENDENCY_*` / `CROSS_WORKSPACE_DEPENDENCY` / `ISSUE_CLAIMED`），不吞错。
 */
import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod/v4';
import type { McpConfig } from '../config.js';
import { resolveWorkspaceId } from '../config.js';
import { AgentBoardApiClient } from '../apiClient.js';
import { mcpToolFailure, mcpToolSuccess } from './result.js';

const workspaceField = { workspace_id: z.string().trim().min(1).optional() };
const issueIdField = { task_id: z.string().trim().min(1) };
const blockerIdField = { blocker_task_id: z.string().trim().min(1) };
const requestIdField = { request_id: z.string().uuid() };

/** 依赖视图（与 `Docs/api.md` §6 依赖段同构；由服务端算好 resolved） */
interface DependencyRef { issue_id: string; title: string; status: string; resolved: boolean }
interface DependencyView { blockers: DependencyRef[]; blocked: DependencyRef[] }

export function registerDependencyTools(server: McpServer, config: McpConfig, api: AgentBoardApiClient): void {
  const register = (name: string, description: string, inputSchema: z.ZodObject<any>, run: (input: any) => Promise<unknown>, readOnly = true) => {
    const handler = async (input: any) => {
      try {
        return mcpToolSuccess(await run(input), `${name} succeeded.`);
      } catch (error) {
        return mcpToolFailure(error);
      }
    };
    // 向后兼容：旧名 agentboard_<name> 保留为 alias，下个大版本移除
    const meta = { description, inputSchema, annotations: { readOnlyHint: readOnly } };
    server.registerTool(name, meta, handler);
    server.registerTool(`agentboard_${name}`, meta, handler);
  };

  register('list_dependencies', 'List a task\'s blockers and blocked tasks in one effective workspace, with the server-side resolved flag.', z.object({
    ...workspaceField,
    ...issueIdField,
  }).strict(), async ({ workspace_id, task_id }) => {
    const workspaceId = resolveWorkspaceId(config, workspace_id);
    const view = await api.get<DependencyView>(`/issues/${encodeURIComponent(task_id)}/dependencies`, { workspace_id: workspaceId });
    return { ...view, workspace_id: workspaceId };
  });

  register('add_dependency', 'Add a blocker edge: the blocked task cannot be claimed until the blocker is resolved (acceptance or closed).', z.object({
    ...workspaceField,
    ...issueIdField,
    ...blockerIdField,
    ...requestIdField,
  }).strict(), async ({ workspace_id, task_id, blocker_task_id, request_id }) => {
    const workspaceId = resolveWorkspaceId(config, workspace_id);
    const view = await api.mutate<DependencyView>('POST', `/issues/${encodeURIComponent(task_id)}/dependencies`, {
      workspace_id: workspaceId, blocker_issue_id: blocker_task_id,
    }, request_id);
    return { ...view, workspace_id: workspaceId };
  }, false);

  register('remove_dependency', 'Remove a blocker edge from a task.', z.object({
    ...workspaceField,
    ...issueIdField,
    ...blockerIdField,
  }).strict(), async ({ workspace_id, task_id, blocker_task_id }) => {
    const workspaceId = resolveWorkspaceId(config, workspace_id);
    // DELETE 的 workspace_id 走 query（服务端 `/api/issues/:id` 中间件从 query/body 取并校验归属）
    await api.delete(
      `/issues/${encodeURIComponent(task_id)}/dependencies/${encodeURIComponent(blocker_task_id)}?workspace_id=${encodeURIComponent(workspaceId)}`,
      undefined,
      'NOT_FOUND',
    );
    return { removed: true, task_id, blocker_task_id, workspace_id: workspaceId };
  }, false);
}
