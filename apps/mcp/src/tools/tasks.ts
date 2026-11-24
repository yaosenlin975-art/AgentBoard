import { createHash } from 'node:crypto';
import { textWindow, type Issue, type IssueComment, type IssueTreePage, type KnowledgeHint, type PageResult, type TaskPreview, type Workspace } from '@agentboard/shared';
import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod/v4';
import type { McpConfig } from '../config.js';
import { McpError, requireAgentId, resolveWorkspaceId } from '../config.js';
import { AgentBoardApiClient } from '../apiClient.js';
import { mcpToolSuccess } from './result.js';
import { registerBoardTool } from './register.js';
import {
  compactTask,
  fenceField,
  pageFields,
  priorityField,
  requestIdField,
  taskIdField,
  taskStatusField,
  workspaceField,
} from './schemaText.js';
import { resolveTaskId } from './taskRef.js';

const prioritySchema = priorityField;
/**
 * C6：status 不做客户端枚举。工作区状态字典是动态的——`add_status` 能建自定义状态，
 * 服务端 `requireWorkspaceStatus`（`apps/server/src/services/workspaceStatus.ts:49-59`）
 * 会按本工作区已定义的状态校验，并在报错里列出合法值。MCP 层写死
 * `待规划/进行中/待验收/已关闭` 会拦掉「已废弃」与一切自定义状态。
 */
const statusSchema = taskStatusField;

/** 收尾固定提交的看板产物；与 server 的 WORKSPACE_SNAPSHOT_COMMIT_PATHS 同口径 */
const WORKSPACE_SNAPSHOT_COMMIT_PATHS = [
  '.agentboard/snapshot',
  '.agentboard/.gitignore',
  '.agentboard/README.md',
];

type DependencyRef = { issue_id: string; title: string; status: string; resolved: boolean };
type DependencyView = { blockers: DependencyRef[]; blocked: DependencyRef[] };
type GitCommitInfo = { status: string; reason: string | null; note: string | null; pending: string[] };
type CompletionResult = Issue & {
  comment: IssueComment | null;
  knowledge_hint: KnowledgeHint | null;
  git_commit?: GitCommitInfo | null;
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

/**
 * FETCHC-2：「未完成」kind 集合，与服务端 `STATUS_KINDS`（`apps/server/src/services/workspaceStatus.ts:31`）同值。
 * 缺省过滤即这个集合 + `unclaimed=1`，把「已关闭 / 已废弃」挡在首页之外。
 */
const UNFINISHED_KINDS = ['open', 'started', 'review', 'blocked'] as const;
const UNFINISHED_KINDS_QUERY = UNFINISHED_KINDS.join(',');

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

/**
 * FETCHC-2：`list_tasks` 的状态收敛过滤。
 *
 * 优先级：`all_status` → 无过滤（改前行为）；显式 `status` → 只按 status（不叠加 kind/unclaimed，
 * 否则 `status=进行中` 会被 `unclaimed=1` 收窄成「进行中且无主」）；其余 → 缺省未完成 + 无主，
 * 除非调用方显式关掉（`unfinished:false` / `unclaimed:false`）或给了自己的 `kinds`。
 */
function listTaskScopeFilters(input: {
  status?: string;
  kinds?: readonly string[];
  unclaimed?: boolean;
  unfinished?: boolean;
  all_status?: boolean;
}): Record<string, string | undefined> {
  if (input.all_status === true || input.status !== undefined) return {};
  const filters: Record<string, string | undefined> = {};
  const kinds = input.kinds ?? (input.unfinished === false ? undefined : UNFINISHED_KINDS);
  if (kinds !== undefined && kinds.length > 0) filters.kinds = kinds.join(',');
  if (input.unclaimed ?? (input.unfinished !== false)) filters.unclaimed = '1';
  return filters;
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

function derivedRequestId(base: string, purpose: string): string {
  const hex = createHash('sha256').update(`${base}:${purpose}`).digest('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

/** Write receipts expose only state needed for the next decision. */
function compactMutationReceipt(data: unknown): Record<string, unknown> {
  const source = data && typeof data === 'object' ? data as Record<string, unknown> : {};
  // Non-task mutations (delete/accept) keep their own compact result shape.
  if (source.id === undefined) return source;
  const keys = [
    'id', 'workspace_id', 'title', 'status', 'priority', 'parent_issue_id',
    'claimed_by', 'claimed_at', 'claim_fence', 'updated_at',
    'git_commit', 'knowledge_hint', 'comment', 'claim', 'changelog', 'skipped',
  ];
  const result = Object.fromEntries(keys.filter(key => source[key] !== undefined).map(key => [key, source[key]]));
  if (result.comment && typeof result.comment === 'object' && !Array.isArray(result.comment)) {
    const comment = result.comment as Record<string, unknown>;
    const window = textWindow(typeof comment.content === 'string' ? comment.content : '', 0, 12000);
    result.comment = {
      id: comment.id,
      issue_id: comment.issue_id,
      author: comment.author,
      ts: comment.ts,
      content: window.content,
      truncated: window.truncated,
      next_content_offset_chars: window.next_offset_chars,
      ...(comment.attachments ? { attachments: comment.attachments } : {}),
    };
  }
  return result;
}

function compactComments(page: PageResult<{ id: string; author: string; ts: number; snippet: string; has_more: boolean; attachments?: IssueComment['attachments'] }>) {
  return {
    items: page.items.map(item => ({
      id: item.id,
      author: item.author,
      ts: item.ts,
      snippet: item.snippet,
      has_more: item.has_more,
      ...(item.attachments ? { attachments: item.attachments } : {}),
    })),
    next_offset: page.next_offset,
  };
}

async function claimForWork(api: AgentBoardApiClient, config: McpConfig, workspaceId: string, taskId: string, requestId: string) {
  const agentId = requireAgentId(config);
  return api.mutate<Issue & { claim_fence: number }>('POST', `/issues/${encodeURIComponent(taskId)}/claim`, {
    workspace_id: workspaceId, agent_id: agentId, knowledge_enabled: false,
  }, requestId, 'TASK_CLAIMED');
}

async function completeForFinish(
  api: AgentBoardApiClient,
  config: McpConfig,
  workspaceId: string,
  taskId: string,
  input: {
    notes: string; scope?: string[]; changelog_id?: string; skip_changelog?: boolean;
    board_only?: boolean; request_id: string; fence?: number;
  },
) {
  if (input.board_only === true && (input.scope?.length ?? 0) > 0) {
    throw new McpError('BOARD_ONLY_SCOPE_CONFLICT', 'board_only 与 scope 不能同时使用。');
  }
  const agentId = requireAgentId(config);
  const scopePaths = input.board_only === true || input.scope === undefined || input.scope.length === 0
    ? [...WORKSPACE_SNAPSHOT_COMMIT_PATHS]
    : input.scope;
  return api.mutate<CompletionResult>('POST', `/issues/${encodeURIComponent(taskId)}/done`, {
    workspace_id: workspaceId,
    agent_id: agentId,
    notes: input.notes,
    scope_paths: scopePaths,
    client: 'mcp',
    changelog_ack: input.skip_changelog === true,
    ...(input.changelog_id === undefined ? {} : { changelog_id: input.changelog_id }),
  }, input.request_id, undefined, undefined, input.fence);
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
      ...(readOnly
        ? {}
        : { onResult: (data: unknown, summary: string) => mcpToolSuccess(compactMutationReceipt(boundedMutationData(data)), summary) }),
    }, run);

  register('list_workspaces', 'List workspaces; paths are omitted.', z.object(pageFields).strict(), async ({ limit, offset }) => {
    const page = await api.get<PageResult<Workspace>>('/workspaces', { limit, offset });
    return { items: page.items.map(({ id, name }) => ({ id, name })), next_offset: page.next_offset };
  });

  register('list_tasks', 'List compact task rows or one task-tree level; descriptions are omitted. Defaults to unfinished unclaimed rows; pass all_status for every row.', z.object({
    ...workspaceField,
    status: statusSchema.optional(),
    kinds: z.array(z.enum(['open', 'started', 'review', 'done', 'deprecated', 'blocked'])).min(1).optional()
      .describe('Status kinds to include (open/started/review/done/deprecated/blocked); default keeps open,started,review,blocked.'),
    unclaimed: z.boolean().optional()
      .describe('Only rows with no owner; default true unless all_status or status is given.'),
    unfinished: z.boolean().optional()
      .describe('Default true: only unfinished rows (ignored when all_status or status is given).'),
    all_status: z.boolean().default(false)
      .describe('True lists every status with no derived filters (pre-FETCHC-2 behavior).'),
    tree: z.boolean().default(false)
      .describe('Use task-tree cursor pagination (default false).'),
    parent_issue_id: z.string().trim().min(1).nullable().optional()
      .describe('Tree mode parent UUID; null lists roots.'),
    cursor: z.string().min(1).max(4096).optional()
      .describe('Tree mode cursor from next_cursor.'),
    ...pageFields,
  }).strict()
    .refine((input) => input.tree || (input.parent_issue_id === undefined && input.cursor === undefined), {
      message: 'parent_issue_id and cursor require tree mode.',
    })
    .refine((input) => !input.tree || input.offset === 0, { message: 'Tree mode uses cursor pagination, not offset.' })
    .refine((input) => !input.tree || (input.kinds === undefined && input.unclaimed === undefined
      && input.unfinished === undefined && input.all_status !== true), {
      message: 'kinds/unclaimed/unfinished/all_status apply to the flat list only; drop them in tree mode.',
    }),
  async ({ workspace_id, status, kinds, unclaimed, unfinished, all_status, tree, parent_issue_id, cursor, limit, offset }) => {
    const workspaceId = resolveWorkspaceId(config, workspace_id, 'task');
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
        items: page.items.map(item => ({
          ...compactTask(omitTaskDescription(item)),
          child_count: item.child_count,
          descendant_count: item.descendant_count,
          descendants_closed_count: item.descendants_closed_count,
        })),
        ancestors: page.ancestors.map(item => compactTask(omitTaskDescription(item))),
        workspace_id: workspaceId,
      };
    }
    const page = await getTaskListPage<PageResult<TaskPreview>>(api, {
      workspace: workspaceId,
      status,
      ...listTaskScopeFilters({ status, kinds, unclaimed, unfinished, all_status }),
      limit,
      offset,
    });
    return { ...page, items: page.items.map(item => compactTask(omitTaskDescription(item))), workspace_id: workspaceId };
  });

  register('get_task', 'Read one task and a bounded description window.', z.object({
    ...workspaceField,
    ...taskIdField,
    description_offset_chars: z.number().int().min(0).default(0)
      .describe('Description character offset (default 0).'),
    description_max_chars: z.number().int().min(1).max(40000).default(12000)
      .describe('Max description chars, 1-40000 (default 12000).'),
  }).strict(), async ({ workspace_id, task_id, description_offset_chars, description_max_chars }) => {
    const workspaceId = resolveWorkspaceId(config, workspace_id, 'task');
    const taskId = await resolveTaskId(api, workspaceId, task_id);
    return api.get<TaskPreview>(`/issues/${encodeURIComponent(taskId)}`, {
      workspace_id: workspaceId,
      description_offset_chars,
      description_max_chars,
    });
  });

  register('get_task_comments', 'List task comments without advancing the unread cursor.', z.object({
    ...workspaceField,
    ...taskIdField,
    ...pageFields,
  }).strict(), async ({ workspace_id, task_id, limit, offset }) => {
    const workspaceId = resolveWorkspaceId(config, workspace_id, 'task');
    const taskId = await resolveTaskId(api, workspaceId, task_id);
    const page = await api.get<PageResult<{ id: string; author: string; ts: number; snippet: string; has_more: boolean; attachments?: IssueComment['attachments'] }>>(
      `/issues/${encodeURIComponent(taskId)}/comments`, { workspace_id: workspaceId, limit, offset },
    );
    return { ...compactComments(page), workspace_id: workspaceId };
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
    const workspaceId = resolveWorkspaceId(config, workspace_id, 'task');
    const taskId = await resolveTaskId(api, workspaceId, task_id);
    const comment = await api.get<IssueComment & { truncated: boolean; next_content_offset_chars: number | null }>(
      `/issues/${encodeURIComponent(taskId)}/comments/${encodeURIComponent(comment_id)}`,
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
    const workspaceId = resolveWorkspaceId(config, workspace_id, 'task');
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
    const workspaceId = resolveWorkspaceId(config, workspace_id, 'task');
    const taskId = await resolveTaskId(api, workspaceId, task_id);
    const agentId = requireAgentId(config);
    return api.mutate<Issue>('PATCH', `/issues/${encodeURIComponent(taskId)}`, {
      workspace_id: workspaceId, agent_id: agentId, expected_updated_at, ...patch,
    }, request_id, undefined, undefined, fence);
  }, false);

  register('claim_task', 'Atomically claim an eligible task.', z.object({
    ...workspaceField,
    ...taskIdField,
    ...requestIdField,
  }).strict(), async ({ workspace_id, task_id, request_id }) => {
    const workspaceId = resolveWorkspaceId(config, workspace_id, 'task');
    const taskId = await resolveTaskId(api, workspaceId, task_id);
    const agentId = requireAgentId(config);
    return api.mutate<Issue & { claim_fence: number }>('POST', `/issues/${encodeURIComponent(taskId)}/claim`, {
      workspace_id: workspaceId, agent_id: agentId, knowledge_enabled: false,
    }, request_id, 'TASK_CLAIMED');
  }, false);

  register('start_task', 'Atomically claim a task and return its bounded work package (task, description, blockers, recent comments).', z.object({
    ...workspaceField,
    ...taskIdField,
    comments: z.number().int().min(0).max(20).default(5)
      .describe('Recent comments to include, 0-20 (default 5).'),
    ...requestIdField,
  }).strict(), async ({ workspace_id, task_id, comments, request_id }) => {
    const workspaceId = resolveWorkspaceId(config, workspace_id, 'task');
    const taskId = await resolveTaskId(api, workspaceId, task_id);
    const claimed = await claimForWork(api, config, workspaceId, taskId, request_id);
    // A post-claim read failure leaves the task claimed; return the error instead of fabricating a package.
    const task = await api.get<TaskPreview>(`/issues/${encodeURIComponent(taskId)}`, {
      workspace_id: workspaceId,
      description_offset_chars: 0,
      description_max_chars: 12000,
    });
    const deps = await api.get<DependencyView>(`/issues/${encodeURIComponent(taskId)}/dependencies`, { workspace_id: workspaceId });
    const recent = comments === 0
      ? { items: [], next_offset: null }
      : compactComments(await api.get<PageResult<{ id: string; author: string; ts: number; snippet: string; has_more: boolean }>>(
        `/issues/${encodeURIComponent(taskId)}/comments`,
        { workspace_id: workspaceId, limit: comments, offset: Math.max(0, Number(task.comment_count ?? 0) - comments) },
      ));
    return {
      issue: compactTask(task),
      description: task.description,
      description_truncated: task.description_truncated,
      next_description_offset_chars: task.next_description_offset_chars,
      blockers: deps.blockers,
      blocked: deps.blocked,
      claim_fence: claimed.claim_fence,
      comments: recent.items,
      comments_next_offset: recent.next_offset,
    };
  }, false);

  register('release_task', 'Release a task owned by the configured agent.', z.object({
    ...workspaceField,
    ...taskIdField,
    ...requestIdField,
    ...fenceField,
  }).strict(), async ({ workspace_id, task_id, request_id, fence }) => {
    const workspaceId = resolveWorkspaceId(config, workspace_id, 'task');
    const taskId = await resolveTaskId(api, workspaceId, task_id);
    const agentId = requireAgentId(config);
    return api.mutate<Issue & { comment: IssueComment | null }>('POST', `/issues/${encodeURIComponent(taskId)}/release`, {
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
    const workspaceId = resolveWorkspaceId(config, workspace_id, 'task');
    const taskId = await resolveTaskId(api, workspaceId, task_id);
    const agentId = requireAgentId(config);
    return api.mutate<{ comment: IssueComment; woke: boolean }>('POST', `/issues/${encodeURIComponent(taskId)}/comments`, {
      workspace_id: workspaceId, content, agent_id: agentId,
    }, request_id, undefined, undefined, fence);
  }, false);

  register('complete_task', 'Complete a task. Provide a card changelog, changelog_id, or skip_changelog=true.', z.object({
    ...workspaceField,
    ...taskIdField,
    notes: z.string().default('')
      .describe('Completion notes: what changed, verification commands and results, knowledge page / changelog ids. Prefer a short self-contained summary.'),
    scope: z.array(z.string().min(1)).optional()
      .describe('Repo-relative business files or directory prefixes this task changed (e.g. ["apps/server/src", "README.md"]). The .agentboard dashboard snapshot is committed too. Omit for a board-only task: only the dashboard snapshot is committed. Pass ["."] only when you intentionally include all dirty files.'),
    changelog_id: z.string().uuid().optional()
      .describe('UUID of an EXISTING change-log entry of this workspace that covers this task. Not the same as CLI --close-record (that CREATES a new entry); use this to reference one you already created via create_changelog. Takes precedence over the issue_id auto-match.'),
    skip_changelog: z.boolean().optional()
      .describe('Set true only when this task has no user-visible change (pure internal refactor / board-only operation). Without a changelog and without this flag the server rejects the call with 400 CHANGELOG_ACK_REQUIRED.'),
    board_only: z.boolean().optional()
      .describe('Set true for board-only tasks: commits only the .agentboard dashboard snapshot and no business files. Mutually exclusive with scope.'),
    ...requestIdField,
    ...fenceField,
  }).strict(), async ({ workspace_id, task_id, notes, scope, changelog_id, skip_changelog, board_only, request_id, fence }) => {
    const workspaceId = resolveWorkspaceId(config, workspace_id, 'task');
    const taskId = await resolveTaskId(api, workspaceId, task_id);
    return completeForFinish(api, config, workspaceId, taskId, {
      notes, scope, changelog_id, skip_changelog, board_only, request_id, fence,
    });
  }, false);

  register('finish_task', 'Create a card changelog (unless skipped), then complete the task and return commit/gate status.', z.object({
    ...workspaceField,
    ...taskIdField,
    notes: z.string().default('')
      .describe('Completion notes: changes, verification, knowledge/changelog ids.'),
    scope: z.array(z.string().min(1)).optional()
      .describe('Repo-relative files/directories to commit; omit for board-only snapshot.'),
    changelog_title: z.string().trim().min(1).max(200).optional()
      .describe('New change-log title; required unless no_changelog=true.'),
    change_type: z.enum(['新增', '修复', '调整']).default('调整')
      .describe('New change-log type (default 调整).'),
    changelog_body: z.string().min(1).max(100000).optional()
      .describe('New change-log body; defaults to notes.'),
    no_changelog: z.boolean().optional()
      .describe('Set true only when this task has no user-visible change.'),
    board_only: z.boolean().optional()
      .describe('Commit only the dashboard snapshot; mutually exclusive with scope.'),
    ...requestIdField,
    ...fenceField,
  }).strict(), async ({ workspace_id, task_id, notes, scope, changelog_title, change_type, changelog_body, no_changelog, board_only, request_id, fence }) => {
    if (board_only === true && (scope?.length ?? 0) > 0) {
      throw new McpError('BOARD_ONLY_SCOPE_CONFLICT', 'board_only 与 scope 不能同时使用。');
    }
    if (no_changelog !== true && (changelog_title === undefined || changelog_title.trim() === '')) {
      throw new McpError('VALIDATION_ERROR', 'finish_task requires changelog_title unless no_changelog=true.');
    }
    const workspaceId = resolveWorkspaceId(config, workspace_id, 'task');
    const taskId = await resolveTaskId(api, workspaceId, task_id);
    const agentId = requireAgentId(config);
    let changelogId: string | undefined;
    if (no_changelog !== true) {
      const rawChangelogBody = changelog_body ?? notes;
      const entry = await api.mutate<{ id: string }>(
        'POST',
        `/workspaces/${encodeURIComponent(workspaceId)}/changelog`,
        {
          title: changelog_title,
          body_md: rawChangelogBody.trim() === '' ? '本轮无用户可见变更' : rawChangelogBody,
          change_type,
          actor: agentId,
          issue_id: taskId,
        },
        derivedRequestId(request_id, 'changelog'),
        undefined,
        'WORKSPACE_NOT_FOUND',
      );
      changelogId = entry.id;
    }
    const completed = await completeForFinish(api, config, workspaceId, taskId, {
      notes: changelogId === undefined
        ? notes
        : `${notes}${notes === '' ? '' : '\n\n'}close-record: changelog=${changelogId}`,
      scope,
      changelog_id: changelogId,
      skip_changelog: no_changelog,
      board_only,
      request_id,
      fence,
    });
    return {
      issue: compactTask(completed),
      changelog_id: changelogId ?? null,
      git_commit: completed.git_commit ?? null,
      knowledge_hint: completed.knowledge_hint ?? null,
    };
  }, false);

  register('delete_task', 'Permanently delete a task. Irreversible; rejected while the task is claimed or when it still has child tasks. This is a DELETE call and takes no request_id (idempotency key).', z.object({
    ...workspaceField,
    ...taskIdField,
  }).strict(), async ({ workspace_id, task_id }) => {
    const workspaceId = resolveWorkspaceId(config, workspace_id, 'task');
    const taskId = await resolveTaskId(api, workspaceId, task_id);
    await api.delete(`/issues/${encodeURIComponent(taskId)}`, 'TASK_CONFLICT', 'TASK_NOT_FOUND');
    return { deleted: true, task_id: taskId };
  }, false);

  register('fail_task', 'Return a task to planning with a required failure reason.', z.object({
    ...workspaceField,
    ...taskIdField,
    reason: z.string().trim().min(1)
      .describe('Why the task could not be finished; required. Be specific (blocked by what, what was verified).'),
    ...requestIdField,
    ...fenceField,
  }).strict(), async ({ workspace_id, task_id, reason, request_id, fence }) => {
    const workspaceId = resolveWorkspaceId(config, workspace_id, 'task');
    const taskId = await resolveTaskId(api, workspaceId, task_id);
    const agentId = requireAgentId(config);
    return api.mutate<Issue & { comment: IssueComment | null }>('POST', `/issues/${encodeURIComponent(taskId)}/fail`, {
      workspace_id: workspaceId, agent_id: agentId, reason,
    }, request_id, undefined, undefined, fence);
  }, false);

  register('close_task', 'Close a task that is in review (待验收). Rejected while the task is claimed or while any descendant task is still open.', z.object({
    ...workspaceField,
    ...taskIdField,
    ...requestIdField,
    ...fenceField,
  }).strict(), async ({ workspace_id, task_id, request_id, fence }) => {
    const workspaceId = resolveWorkspaceId(config, workspace_id, 'task');
    const taskId = await resolveTaskId(api, workspaceId, task_id);
    const agentId = requireAgentId(config);
    return api.mutate<Issue>('POST', `/issues/${encodeURIComponent(taskId)}/close`, {
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
    const workspaceId = resolveWorkspaceId(config, workspace_id, 'task');
    const taskId = await resolveTaskId(api, workspaceId, task_id);
    const agentId = requireAgentId(config);
    return api.mutate<Issue>('POST', `/issues/${encodeURIComponent(taskId)}/reopen`, {
      workspace_id: workspaceId, agent_id: agentId, ...(status === undefined ? {} : { status }),
    }, request_id, 'INVALID_TRANSITION', 'TASK_NOT_FOUND', fence);
  }, false);

  const registerTaskMutation = (
    name: string,
    description: string,
    inputSchema: z.ZodObject<any>,
    run: (input: any) => Promise<unknown>,
  ) => registerBoardTool(server, {
    name,
    description,
    inputSchema,
    readOnly: false,
    onResult: (data: unknown, summary: string) => mcpToolSuccess(compactMutationReceipt(boundedMutationData(data)), summary),
  }, run);

  registerTaskMutation('accept_task', 'Record a structured acceptance verdict on a task waiting for review (待验收); status does not change.', z.object({
    ...workspaceField,
    ...taskIdField,
    verdict: z.enum(['pass', 'fail']).default('pass').describe('Acceptance verdict: pass or fail (default pass).'),
    note: z.string().default('').describe('Optional reviewer note appended to the 【验收记录】 comment.'),
    reviewer: z.string().trim().min(1).optional()
      .describe('Reviewer label recorded in the comment; defaults to the configured agent id.'),
    ...requestIdField,
    ...fenceField,
  }).strict(), async ({ workspace_id, task_id, verdict, note, reviewer, request_id, fence }) => {
    const workspaceId = resolveWorkspaceId(config, workspace_id, 'task');
    const taskId = await resolveTaskId(api, workspaceId, task_id);
    const agentId = requireAgentId(config);
    const issue = await api.get<Issue>(`/issues/${encodeURIComponent(taskId)}`, {}, 'TASK_NOT_FOUND');
    if (issue.workspace_id !== workspaceId) throw new McpError('WORKSPACE_BOUND', 'The task belongs to a different workspace.');
    if (issue.status !== '待验收') {
      throw new McpError('ACCEPT_STATUS_NOT_ACCEPTABLE', 'Only tasks in review (待验收) can receive an acceptance record.');
    }
    const record = `【验收记录】verdict=${verdict}; reviewer=${reviewer ?? agentId}; at=${new Date().toISOString()}`;
    const content = note.trim() === '' ? record : `${record}\n${note}`;
    const response = await api.mutate<{ comment: IssueComment; woke: boolean }>('POST', `/issues/${encodeURIComponent(taskId)}/comments`, {
      workspace_id: workspaceId, content, agent_id: agentId,
    }, request_id, undefined, undefined, fence);
    return { task_id: taskId, verdict, reviewer: reviewer ?? agentId, comment: response.comment };
  });
}
