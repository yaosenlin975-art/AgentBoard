import { textWindow, type Issue, type IssueComment, type IssueTreePage, type KnowledgeHint, type PageResult, type TaskPreview, type Workspace } from '@agentboard/shared';
import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod/v4';
import type { McpConfig } from '../config.js';
import { McpError, requireAgentId, resolveWorkspaceId } from '../config.js';
import { AgentBoardApiClient } from '../apiClient.js';
import { mcpToolFailure, mcpToolSuccess } from './result.js';

const workspaceField = { workspace_id: z.string().trim().min(1).optional() };
const taskIdField = { task_id: z.string().trim().min(1) };
const requestIdField = { request_id: z.string().uuid() };
const pageFields = {
  limit: z.number().int().min(1).max(100).default(50),
  offset: z.number().int().min(0).default(0),
};
const prioritySchema = z.enum(['低', '中', '高']);
const statusSchema = z.enum(['待规划', '进行中', '待验收', '已关闭']);

function boundedMutationData(data: unknown): unknown {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return data;
  const result = { ...data as Record<string, unknown> };
  if (typeof result.description === 'string') {
    const window = textWindow(result.description);
    result.description = window.content;
    result.description_truncated = window.truncated;
    result.next_description_offset_chars = window.next_offset_chars;
  }
  if (result.comment && typeof result.comment === 'object' && !Array.isArray(result.comment)) {
    const comment = { ...result.comment as Record<string, unknown> };
    if (typeof comment.content === 'string') {
      const window = textWindow(comment.content);
      comment.content = window.content;
      comment.truncated = window.truncated;
      comment.next_content_offset_chars = window.next_offset_chars;
    }
    result.comment = comment;
  }
  return result;
}

export function registerTaskTools(server: McpServer, config: McpConfig, api: AgentBoardApiClient): void {
  // ponytail: SDK schemas validate inputs; this wrapper keeps every tool's result and error shape identical.
  const register = (name: string, description: string, inputSchema: z.ZodObject<any>, run: (input: any) => Promise<unknown>, readOnly = true) => {
    const handler = async (input: any) => {
      try {
        const data = await run(input);
        return mcpToolSuccess(readOnly ? data : boundedMutationData(data), `${name} succeeded.`);
      } catch (error) {
        return mcpToolFailure(error);
      }
    };
    // 向后兼容：旧名 agentboard_<name> 保留为 alias，下个大版本移除
    const meta = { description, inputSchema, annotations: { readOnlyHint: readOnly } };
    server.registerTool(name, meta, handler);
    server.registerTool(`agentboard_${name}`, meta, handler);
  };

  register('list_workspaces', 'List workspaces by page. Local filesystem paths are omitted.', z.object(pageFields).strict(), async ({ limit, offset }) => {
    const page = await api.get<PageResult<Workspace>>('/workspaces', { limit, offset });
    return { items: page.items.map(({ id, name }) => ({ id, name })), next_offset: page.next_offset };
  });

  register('list_tasks', 'List flat tasks or one cursor-paginated level of the task tree in one effective workspace.', z.object({
    ...workspaceField,
    status: statusSchema.optional(),
    tree: z.boolean().default(false),
    parent_issue_id: z.string().trim().min(1).nullable().optional(),
    cursor: z.string().min(1).max(4096).optional(),
    ...pageFields,
  }).strict()
    .refine((input) => input.tree || (input.parent_issue_id === undefined && input.cursor === undefined), {
      message: 'parent_issue_id and cursor require tree mode.',
    })
    .refine((input) => !input.tree || input.offset === 0, { message: 'Tree mode uses cursor pagination, not offset.' }),
  async ({ workspace_id, status, tree, parent_issue_id, cursor, limit, offset }) => {
    const workspaceId = resolveWorkspaceId(config, workspace_id);
    if (tree) {
      const page = await api.get<IssueTreePage>('/issues/tree', {
        workspace: workspaceId,
        status,
        parent_issue_id: parent_issue_id ?? undefined,
        limit,
        cursor,
      });
      const boundIssue = (issue: Issue) => {
        const window = textWindow(issue.description);
        return { ...issue, description: window.content, description_truncated: window.truncated, next_description_offset_chars: window.next_offset_chars };
      };
      return { ...page, items: page.items.map(boundIssue), ancestors: page.ancestors.map(boundIssue), workspace_id: workspaceId };
    }
    const page = await api.get<PageResult<TaskPreview>>('/issues', { workspace: workspaceId, status, limit, offset });
    return { ...page, workspace_id: workspaceId };
  });

  register('get_task', 'Read a task description window from one effective workspace.', z.object({
    ...workspaceField,
    ...taskIdField,
    description_offset_chars: z.number().int().min(0).default(0),
    description_max_chars: z.number().int().min(1).max(40000).default(12000),
  }).strict(), async ({ workspace_id, task_id, description_offset_chars, description_max_chars }) => {
    const workspaceId = resolveWorkspaceId(config, workspace_id);
    return api.get<TaskPreview>(`/issues/${encodeURIComponent(task_id)}`, {
      workspace_id: workspaceId,
      description_offset_chars,
      description_max_chars,
    });
  });

  register('get_task_comments', 'Read a paged comment list without advancing the shared unread cursor.', z.object({
    ...workspaceField,
    ...taskIdField,
    ...pageFields,
  }).strict(), async ({ workspace_id, task_id, limit, offset }) => {
    const workspaceId = resolveWorkspaceId(config, workspace_id);
    const page = await api.get<PageResult<{ id: string; author: string; ts: number; snippet: string; has_more: boolean; attachments?: IssueComment['attachments'] }>>(
      `/issues/${encodeURIComponent(task_id)}/comments`, { workspace_id: workspaceId, limit, offset },
    );
    return { ...page, workspace_id: workspaceId };
  });

  register('get_task_comment', 'Read a comment body window without changing comment read state.', z.object({
    ...workspaceField,
    ...taskIdField,
    comment_id: z.string().trim().min(1),
    content_offset_chars: z.number().int().min(0).default(0),
    content_max_chars: z.number().int().min(1).max(40000).default(12000),
  }).strict(), async ({ workspace_id, task_id, comment_id, content_offset_chars, content_max_chars }) => {
    const workspaceId = resolveWorkspaceId(config, workspace_id);
    const comment = await api.get<IssueComment & { truncated: boolean; next_content_offset_chars: number | null }>(
      `/issues/${encodeURIComponent(task_id)}/comments/${encodeURIComponent(comment_id)}`,
      { workspace_id: workspaceId, content_offset_chars, content_max_chars },
    );
    return {
      id: comment.id,
      issue_id: comment.issue_id,
      author: comment.author,
      ts: comment.ts,
      content: comment.content,
      ...(comment.attachments ? { attachments: comment.attachments } : {}),
      truncated: comment.truncated,
      next_content_offset_chars: comment.next_content_offset_chars,
    };
  });

  register('create_task', 'Create a task in one effective workspace.', z.object({
    ...workspaceField,
    title: z.string().trim().min(1),
    description: z.string().default(''),
    priority: prioritySchema.default('中'),
    labels: z.array(z.string()).default([]),
    parent_issue_id: z.string().trim().min(1).nullable().optional(),
    ...requestIdField,
  }).strict(), async ({ workspace_id, title, description, priority, labels, parent_issue_id, request_id }) => {
    const workspaceId = resolveWorkspaceId(config, workspace_id);
    const agentId = requireAgentId(config);
    const issue = await api.mutate<Issue>('POST', '/issues', {
      workspace_id: workspaceId, agent_id: agentId, title, description, priority, labels, parent_issue_id,
    }, request_id);
    return issue;
  }, false);

  register('update_task', 'Update task fields with the expected task timestamp.', z.object({
    ...workspaceField,
    ...taskIdField,
    expected_updated_at: z.number().int().nonnegative(),
    title: z.string().trim().min(1).optional(),
    description: z.string().optional(),
    priority: prioritySchema.optional(),
    labels: z.array(z.string()).optional(),
    sort_order: z.number().int().optional(),
    parent_issue_id: z.string().trim().min(1).nullable().optional(),
    ...requestIdField,
  }).strict().refine((input) => ['title', 'description', 'priority', 'labels', 'sort_order', 'parent_issue_id'].some((key) => input[key as keyof typeof input] !== undefined), {
    message: 'At least one task field must be provided.',
  }), async ({ workspace_id, task_id, expected_updated_at, request_id, ...patch }) => {
    const workspaceId = resolveWorkspaceId(config, workspace_id);
    const agentId = requireAgentId(config);
    return api.mutate<Issue>('PATCH', `/issues/${encodeURIComponent(task_id)}`, {
      workspace_id: workspaceId, agent_id: agentId, expected_updated_at, ...patch,
    }, request_id);
  }, false);

  register('claim_task', 'Atomically claim an eligible task; the configured agent ID is an audit label.', z.object({
    ...workspaceField,
    ...taskIdField,
    ...requestIdField,
  }).strict(), async ({ workspace_id, task_id, request_id }) => {
    const workspaceId = resolveWorkspaceId(config, workspace_id);
    const agentId = requireAgentId(config);
    return api.mutate<Issue>('POST', `/issues/${encodeURIComponent(task_id)}/claim`, {
      workspace_id: workspaceId, agent_id: agentId, knowledge_enabled: false,
    }, request_id, 'TASK_CLAIMED');
  }, false);

  register('release_task', 'Release a task owned by the configured agent.', z.object({
    ...workspaceField,
    ...taskIdField,
    ...requestIdField,
  }).strict(), async ({ workspace_id, task_id, request_id }) => {
    const workspaceId = resolveWorkspaceId(config, workspace_id);
    const agentId = requireAgentId(config);
    return api.mutate<Issue & { comment: IssueComment | null }>('POST', `/issues/${encodeURIComponent(task_id)}/release`, {
      workspace_id: workspaceId, agent_id: agentId,
    }, request_id);
  }, false);

  register('add_task_comment', 'Add a task comment under the configured agent audit label.', z.object({
    ...workspaceField,
    ...taskIdField,
    content: z.string().min(1),
    ...requestIdField,
  }).strict(), async ({ workspace_id, task_id, content, request_id }) => {
    const workspaceId = resolveWorkspaceId(config, workspace_id);
    const agentId = requireAgentId(config);
    return api.mutate<{ comment: IssueComment; woke: boolean }>('POST', `/issues/${encodeURIComponent(task_id)}/comments`, {
      workspace_id: workspaceId, content, agent_id: agentId,
    }, request_id);
  }, false);

  register('complete_task', 'Complete a task owned by the configured agent.', z.object({
    ...workspaceField,
    ...taskIdField,
    notes: z.string().default(''),
    ...requestIdField,
  }).strict(), async ({ workspace_id, task_id, notes, request_id }) => {
    const workspaceId = resolveWorkspaceId(config, workspace_id);
    const agentId = requireAgentId(config);
    return api.mutate<Issue & { comment: IssueComment | null; knowledge_hint: KnowledgeHint | null }>('POST', `/issues/${encodeURIComponent(task_id)}/done`, {
      workspace_id: workspaceId, agent_id: agentId, notes,
    }, request_id);
  }, false);

  register('delete_task', 'Permanently delete a task. Irreversible; rejected while the task is claimed or when it still has child tasks.', z.object({
    ...workspaceField,
    ...taskIdField,
  }).strict(), async ({ workspace_id, task_id }) => {
    resolveWorkspaceId(config, workspace_id);
    await api.delete(`/issues/${encodeURIComponent(task_id)}`, 'TASK_CONFLICT', 'TASK_NOT_FOUND');
    return { deleted: true, task_id };
  }, false);

  register('fail_task', 'Return a task to planning with a required failure reason.', z.object({
    ...workspaceField,
    ...taskIdField,
    reason: z.string().trim().min(1),
    ...requestIdField,
  }).strict(), async ({ workspace_id, task_id, reason, request_id }) => {
    const workspaceId = resolveWorkspaceId(config, workspace_id);
    const agentId = requireAgentId(config);
    return api.mutate<Issue & { comment: IssueComment | null }>('POST', `/issues/${encodeURIComponent(task_id)}/fail`, {
      workspace_id: workspaceId, agent_id: agentId, reason,
    }, request_id);
  }, false);
}
