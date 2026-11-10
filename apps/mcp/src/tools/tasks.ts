import { textWindow, type Issue, type IssueComment, type IssueTreePage, type KnowledgeHint, type PageResult, type TaskPreview, type Workspace } from '@agentboard/shared';
import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod/v4';
import type { McpConfig } from '../config.js';
import { McpError, requireAgentId, resolveWorkspaceId } from '../config.js';
import { AgentBoardApiClient } from '../apiClient.js';
import { mcpToolSuccess } from './result.js';
import { registerBoardTool } from './register.js';

const workspaceField = {
  workspace_id: z.string().trim().min(1).optional()
    .describe('Workspace UUID. Omit to use the workspace this MCP server is bound to (AGENTBOARD_WORKSPACE_ID).'),
};
const taskIdField = {
  task_id: z.string().trim().min(1)
    .describe('Task UUID (36-char full id; an 8+ char unique prefix is also accepted).'),
};
const requestIdField = {
  request_id: z.string({ error: 'request_id is required by this write tool: pass a UUID idempotency key, e.g. 00000000-0000-4000-8000-000000000000. Reuse the SAME key only when retrying the identical call — it returns the original result; a different payload gets 409 IDEMPOTENCY_KEY_REUSED. Read-only tools and deletes (delete_task / remove_dependency) take no request_id.' }).uuid()
    .describe('Idempotency key (UUID) for this write. Replaying the same request_id returns the original result; reusing it with different arguments fails with a conflict.'),
};
const pageFields = {
  limit: z.number().int().min(1).max(100).default(50).describe('Page size, 1-100 (default 50).'),
  offset: z.number().int().min(0).default(0).describe('Zero-based row offset for flat pagination (default 0).'),
};
const prioritySchema = z.enum(['低', '中', '高']).describe('Priority label: 低 (low) / 中 (medium) / 高 (high).');
const statusSchema = z.enum(['待规划', '进行中', '待验收', '已关闭'])
  .describe('Task status: 待规划 (planning) / 进行中 (started) / 待验收 (in review) / 已关闭 (closed).');
const fenceField = {
  fence: z.number().int().min(0).optional()
    .describe('Claim fence/epoch from claim_task. If the task was re-claimed by someone else since, the write fails with 409 STALE_FENCE; omit to skip the check.'),
};

/**
 * PERF-4d（用户拍板选项 A）：列表类出参不再包含正文，正文由 `get_task` 提供。
 * 这里请求服务端的 `fields=` 白名单与 CLI 同序（对齐 `rowToIssue` 键序），只是不含 `description`。
 */
const LIST_TASK_FIELDS = [
  'id', 'workspace_id', 'title', 'priority', 'labels', 'status', 'sort_order',
  'claimed_by', 'claimed_at', 'session_id', 'parent_issue_id', 'due_date', 'due_time',
  'comment_count', 'dependency_violation', 'decision_locked', 'open_decision_id',
  'decision_grace_until', 'decision_waiting_seconds',
  'blocked_by_count', 'blocked_by_open_count', 'resolved',
  'created_at', 'updated_at', 'children_total', 'children_closed',
].join(',');

/** 旧服务端不认 `fields`（400）或路由缺失（404）命中一次后，进程内不再尝试 */
let listFieldsUnsupported = false;

/** 单测复位回落标志 */
export function resetListFieldsFallback(): void {
  listFieldsUnsupported = false;
}

/** 列表出参统一剔除正文与其窗口标记（回落旧服务端时服务端仍会带正文） */
function omitTaskDescription<T extends object>(task: T): Record<string, unknown> {
  const copy = { ...(task as Record<string, unknown>) };
  delete copy.description;
  delete copy.description_truncated;
  delete copy.next_description_offset_chars;
  return copy;
}

/** 平铺列表：默认带 `fields=`；服务端不认时静默回落（回落结果同样会在调用处剔除正文） */
async function getTaskListPage<T>(api: AgentBoardApiClient, query: Record<string, string | number | undefined>): Promise<T> {
  if (listFieldsUnsupported) return api.get<T>('/issues', query);
  try {
    return await api.get<T>('/issues', { ...query, fields: LIST_TASK_FIELDS });
  } catch (error) {
    if (!(error instanceof McpError) || (error.code !== 'VALIDATION_ERROR' && error.code !== 'TASK_NOT_FOUND')) throw error;
    listFieldsUnsupported = true;
    return api.get<T>('/issues', query);
  }
}

/** CARD-FACE：与服务端同口径的空描述判定（MCP 只做提前提示，服务端仍是唯一权威）。 */
function isBlankDescription(text: string | undefined): boolean {
  if (text === undefined) return true;
  const stripped = text
    .replace(/^#{1,6}\s*/gm, '')
    .replace(/^\s*(目标|范围|验收|验收标准|边界)\s*[:：]?\s*$/gm, '')
    .replace(/^\s*[-*+]\s*$/gm, '')
    .trim();
  return stripped === '';
}

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
  // CR2-8：注册样板收敛到 registerBoardTool；这里只剩写工具的结果裁剪（boundedMutationData）
  const register = (name: string, description: string, inputSchema: z.ZodObject<any>, run: (input: any) => Promise<unknown>, readOnly = true) =>
    registerBoardTool(server, {
      name,
      description,
      inputSchema,
      readOnly,
      ...(readOnly ? {} : { onResult: (data: unknown, summary: string) => mcpToolSuccess(boundedMutationData(data), summary) }),
    }, run);

  register('list_workspaces', 'List workspaces by page. Local filesystem paths are omitted.', z.object(pageFields).strict(), async ({ limit, offset }) => {
    const page = await api.get<PageResult<Workspace>>('/workspaces', { limit, offset });
    return { items: page.items.map(({ id, name }) => ({ id, name })), next_offset: page.next_offset };
  });

  register('list_tasks', 'List flat tasks or one cursor-paginated level of the task tree in one effective workspace. Listings omit task descriptions (description, description_truncated, next_description_offset_chars are absent to keep responses small); call get_task to read one task with its description.', z.object({
    ...workspaceField,
    status: statusSchema.optional(),
    tree: z.boolean().default(false)
      .describe('Set true to page one level of the task tree with cursor pagination instead of a flat list (default false).'),
    parent_issue_id: z.string().trim().min(1).nullable().optional()
      .describe('Tree mode only: list children of this task UUID; null lists root tasks. Requires tree=true.'),
    cursor: z.string().min(1).max(4096).optional()
      .describe('Tree mode only: opaque cursor from the previous response next_cursor. Tree mode ignores offset.'),
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
      return {
        ...page,
        items: page.items.map(omitTaskDescription),
        ancestors: page.ancestors.map(omitTaskDescription),
        workspace_id: workspaceId,
      };
    }
    const page = await getTaskListPage<PageResult<TaskPreview>>(api, { workspace: workspaceId, status, limit, offset });
    return { ...page, items: page.items.map(omitTaskDescription), workspace_id: workspaceId };
  });

  register('get_task', 'Read one task including a description window from one effective workspace. list_tasks omits descriptions, so use this tool for a task body.', z.object({
    ...workspaceField,
    ...taskIdField,
    description_offset_chars: z.number().int().min(0).default(0)
      .describe('Character offset into the description for windowed reads (default 0). Continue from next_description_offset_chars when description_truncated is true.'),
    description_max_chars: z.number().int().min(1).max(40000).default(12000)
      .describe('Maximum description characters to return, 1-40000 (default 12000).'),
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
    comment_id: z.string().trim().min(1).describe('Comment UUID under the given task.'),
    content_offset_chars: z.number().int().min(0).default(0)
      .describe('Character offset into the comment body (default 0); continue from next_content_offset_chars.'),
    content_max_chars: z.number().int().min(1).max(40000).default(12000)
      .describe('Maximum comment characters to return, 1-40000 (default 12000).'),
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
    title: z.string().trim().min(1).describe('Task title shown on the board (1 line).'),
    description: z.string().optional()
      .describe('Task body in Markdown. Should state 目标 / 范围 / 验收 / 边界; blank bodies are rejected unless allow_empty=true.'),
    allow_empty: z.boolean().optional()
      .describe('Set true to skip the blank-description check (batch-created cards or pure parent cards).'),
    priority: prioritySchema.default('中'),
    labels: z.array(z.string()).default([])
      .describe('Label list, up to 4. Use short domain words (web / server / cli / 知识库 / 缺陷); no dates, no spaces.'),
    parent_issue_id: z.string().trim().min(1).nullable().optional()
      .describe('Parent task UUID to nest this task under; omit or null for a root task.'),
    ...requestIdField,
  }).strict(), async ({ workspace_id, title, description, allow_empty, priority, labels, parent_issue_id, request_id }) => {
    const workspaceId = resolveWorkspaceId(config, workspace_id);
    const agentId = requireAgentId(config);
    if (allow_empty !== true && isBlankDescription(description)) {
      throw new Error('描述不能为空：请写清正文与验收标准（最小模板：目标 / 范围 / 验收 / 边界）；批量建卡或纯父卡可传 allow_empty=true 跳过空面校验');
    }
    const issue = await api.mutate<Issue>('POST', '/issues', {
      workspace_id: workspaceId, agent_id: agentId, title, description, priority, labels, parent_issue_id,
      ...(allow_empty === true ? { allow_empty: true } : {}),
    }, request_id);
    return issue;
  }, false);

  register('update_task', 'Update task fields with the expected task timestamp.', z.object({
    ...workspaceField,
    ...taskIdField,
    expected_updated_at: z.number().int().nonnegative()
      .describe('CAS guard: updated_at of the task as you last read it (epoch milliseconds). If the task changed since, the write fails with a conflict — re-read with get_task and retry.'),
    // BORROW-0.3：占用代次软校验（缺席放行；旧 fence → 409 STALE_FENCE）
    fence: z.number().int().min(0).optional()
      .describe('Claim fence/epoch from claim_task. If another agent re-claimed the task since, the write fails with 409 STALE_FENCE. Omit to skip the check.'),
    title: z.string().trim().min(1).optional().describe('New task title.'),
    description: z.string().optional().describe('New task body (Markdown); replaces the current description.'),
    priority: prioritySchema.optional(),
    labels: z.array(z.string()).optional().describe('New label list (replaces all labels); up to 4 short domain words.'),
    sort_order: z.number().int().optional().describe('Manual ordering key among siblings; lower sorts first.'),
    parent_issue_id: z.string().trim().min(1).nullable().optional()
      .describe('Move the task under this parent UUID; null moves it back to root.'),
    ...requestIdField,
  }).strict().refine((input) => ['title', 'description', 'priority', 'labels', 'sort_order', 'parent_issue_id'].some((key) => input[key as keyof typeof input] !== undefined), {
    message: 'At least one task field must be provided.',
  }), async ({ workspace_id, task_id, expected_updated_at, request_id, fence, ...patch }) => {
    const workspaceId = resolveWorkspaceId(config, workspace_id);
    const agentId = requireAgentId(config);
    return api.mutate<Issue>('PATCH', `/issues/${encodeURIComponent(task_id)}`, {
      workspace_id: workspaceId, agent_id: agentId, expected_updated_at, ...patch,
    }, request_id, undefined, undefined, fence);
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
    ...fenceField,
  }).strict(), async ({ workspace_id, task_id, request_id, fence }) => {
    const workspaceId = resolveWorkspaceId(config, workspace_id);
    const agentId = requireAgentId(config);
    return api.mutate<Issue & { comment: IssueComment | null }>('POST', `/issues/${encodeURIComponent(task_id)}/release`, {
      workspace_id: workspaceId, agent_id: agentId,
    }, request_id, undefined, undefined, fence);
  }, false);

  register('add_task_comment', 'Add a task comment under the configured agent audit label.', z.object({
    ...workspaceField,
    ...taskIdField,
    content: z.string().min(1).describe('Comment body (Markdown plain text). Long text is fine — it is stored whole.'),
    ...requestIdField,
    fence: z.number().int().min(0).optional()
      .describe('Claim fence/epoch from claim_task; stale fence → 409 STALE_FENCE. Omit to skip the check.'),
  }).strict(), async ({ workspace_id, task_id, content, request_id, fence }) => {
    const workspaceId = resolveWorkspaceId(config, workspace_id);
    const agentId = requireAgentId(config);
    return api.mutate<{ comment: IssueComment; woke: boolean }>('POST', `/issues/${encodeURIComponent(task_id)}/comments`, {
      workspace_id: workspaceId, content, agent_id: agentId,
    }, request_id, undefined, undefined, fence);
  }, false);

  register('complete_task', 'Complete a task owned by the configured agent. Changelog gate: write a user-visible changelog first (create_changelog), or pass skip_changelog=true when nothing user-visible changed — otherwise the call fails with CHANGELOG_ACK_REQUIRED. Pass scope to declare which files this task changed; without scope nothing is auto-committed (the server refuses broad commits).', z.object({
    ...workspaceField,
    ...taskIdField,
    notes: z.string().default('')
      .describe('Completion notes: what changed, verification commands and results, knowledge page / changelog ids. Prefer a short self-contained summary.'),
    scope: z.array(z.string().min(1)).optional()
      .describe('Repo-relative files or directory prefixes this task changed (e.g. ["apps/server/src", "README.md"]). Only these paths are auto-committed. Omit → no auto-commit at all: the response lists every dirty file plus a copy-paste remedy command. Pass ["."] only when you intentionally include all dirty files.'),
    skip_changelog: z.boolean().optional()
      .describe('Set true only when this task has no user-visible change (pure internal refactor / board-only operation). Without a changelog and without this flag the server rejects the call with 400 CHANGELOG_ACK_REQUIRED.'),
    ...requestIdField,
    ...fenceField,
  }).strict(), async ({ workspace_id, task_id, notes, scope, skip_changelog, request_id, fence }) => {
    const workspaceId = resolveWorkspaceId(config, workspace_id);
    const agentId = requireAgentId(config);
    return api.mutate<Issue & { comment: IssueComment | null; knowledge_hint: KnowledgeHint | null }>('POST', `/issues/${encodeURIComponent(task_id)}/done`, {
      workspace_id: workspaceId, agent_id: agentId, notes, scope_paths: scope,
      client: 'mcp', changelog_ack: skip_changelog === true,
    }, request_id, undefined, undefined, fence);
  }, false);

  register('delete_task', 'Permanently delete a task. Irreversible; rejected while the task is claimed or when it still has child tasks. This is a DELETE call and takes no request_id (idempotency key).', z.object({
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
    reason: z.string().trim().min(1)
      .describe('Why the task could not be finished; required. Be specific (blocked by what, what was verified).'),
    ...requestIdField,
    ...fenceField,
  }).strict(), async ({ workspace_id, task_id, reason, request_id, fence }) => {
    const workspaceId = resolveWorkspaceId(config, workspace_id);
    const agentId = requireAgentId(config);
    return api.mutate<Issue & { comment: IssueComment | null }>('POST', `/issues/${encodeURIComponent(task_id)}/fail`, {
      workspace_id: workspaceId, agent_id: agentId, reason,
    }, request_id, undefined, undefined, fence);
  }, false);

  register('close_task', 'Close a task that is in review (待验收). Rejected while the task is claimed or while any descendant task is still open.', z.object({
    ...workspaceField,
    ...taskIdField,
    ...requestIdField,
    ...fenceField,
  }).strict(), async ({ workspace_id, task_id, request_id, fence }) => {
    const workspaceId = resolveWorkspaceId(config, workspace_id);
    const agentId = requireAgentId(config);
    return api.mutate<Issue>('POST', `/issues/${encodeURIComponent(task_id)}/close`, {
      workspace_id: workspaceId, agent_id: agentId,
    }, request_id, 'INVALID_TRANSITION', 'TASK_NOT_FOUND', fence);
  }, false);

  register('reopen_task', 'Reopen a closed or deprecated task into the given workspace status (default 待规划). Rejected while the task is claimed.', z.object({
    ...workspaceField,
    ...taskIdField,
    ...requestIdField,
    status: z.string().trim().min(1).optional()
      .describe('Target status to reopen into; must be a status defined in this workspace. Defaults to 待规划.'),
    ...fenceField,
  }).strict(), async ({ workspace_id, task_id, request_id, status, fence }) => {
    const workspaceId = resolveWorkspaceId(config, workspace_id);
    const agentId = requireAgentId(config);
    return api.mutate<Issue>('POST', `/issues/${encodeURIComponent(task_id)}/reopen`, {
      workspace_id: workspaceId, agent_id: agentId, ...(status === undefined ? {} : { status }),
    }, request_id, 'INVALID_TRANSITION', 'TASK_NOT_FOUND', fence);
  }, false);

  register('accept_task', 'Record a structured acceptance verdict on a task waiting for review (待验收). Writes a 【验收记录】 comment; it does not change the task status.', z.object({
    ...workspaceField,
    ...taskIdField,
    verdict: z.enum(['pass', 'fail']).default('pass').describe('Acceptance verdict: pass or fail (default pass).'),
    note: z.string().default('').describe('Optional reviewer note appended to the 【验收记录】 comment.'),
    reviewer: z.string().trim().min(1).optional()
      .describe('Reviewer label recorded in the comment; defaults to the configured agent id.'),
    ...requestIdField,
    ...fenceField,
  }).strict(), async ({ workspace_id, task_id, verdict, note, reviewer, request_id, fence }) => {
    const workspaceId = resolveWorkspaceId(config, workspace_id);
    const agentId = requireAgentId(config);
    const issue = await api.get<Issue>(`/issues/${encodeURIComponent(task_id)}`, {}, 'TASK_NOT_FOUND');
    if (issue.workspace_id !== workspaceId) throw new McpError('WORKSPACE_BOUND', 'The task belongs to a different workspace.');
    if (issue.status !== '待验收') {
      throw new McpError('ACCEPT_STATUS_NOT_ACCEPTABLE', 'Only tasks in review (待验收) can receive an acceptance record.');
    }
    const record = `【验收记录】verdict=${verdict}; reviewer=${reviewer ?? agentId}; at=${new Date().toISOString()}`;
    const content = note.trim() === '' ? record : `${record}\n${note}`;
    const response = await api.mutate<{ comment: IssueComment; woke: boolean }>('POST', `/issues/${encodeURIComponent(task_id)}/comments`, {
      workspace_id: workspaceId, content, agent_id: agentId,
    }, request_id, undefined, undefined, fence);
    return { task_id, verdict, reviewer: reviewer ?? agentId, comment: response.comment };
  }, false);
}
