import { textWindow } from '@agentboard/shared';
import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod/v4';
import type { McpConfig } from '../config.js';
import { McpError, requireAgentId, resolveWorkspaceId } from '../config.js';
import { AgentBoardApiClient } from '../apiClient.js';
import { mcpToolFailure, mcpToolSuccess } from './result.js';

const workspaceField = { workspace_id: z.string().trim().min(1).optional() };
const taskIdField = { task_id: z.string().trim().min(1) };
const decisionIdField = { decision_id: z.string().trim().min(1) };
const requestIdField = { request_id: z.string().uuid() };
const decisionStateSchema = z.enum(['grace', 'open', 'answered', 'withdrawn']);

type JsonObject = Record<string, unknown>;

function boundedText(value: unknown, max = 2000): { text: string; truncated: boolean; next_offset_chars: number | null } {
  const window = textWindow(typeof value === 'string' ? value : '', 0, max);
  return { text: window.content, truncated: window.truncated, next_offset_chars: window.next_offset_chars };
}

/** 列表只回摘要：不含 context / checkpoint / 完整答案，避免单次结果击穿 40k 上限。 */
function summarizeDecision(raw: JsonObject): JsonObject {
  const question = boundedText(raw.question);
  const options = Array.isArray(raw.options) ? raw.options : [];
  return {
    id: raw.id,
    workspace_id: raw.workspace_id,
    workspace_name: raw.workspace_name,
    issue_id: raw.issue_id,
    issue_title: raw.issue_title,
    issue_status: raw.issue_status,
    issue_priority: raw.issue_priority,
    state: raw.state,
    question: question.text,
    question_truncated: question.truncated,
    next_question_offset_chars: question.next_offset_chars,
    trigger: raw.trigger,
    created_by: raw.created_by,
    created_fence: raw.created_fence,
    grace_seconds: raw.grace_seconds,
    grace_until: raw.grace_until,
    remaining_grace_seconds: raw.remaining_grace_seconds,
    waiting_seconds: raw.waiting_seconds,
    answer_revision: raw.answer_revision,
    current_answer_id: raw.current_answer_id,
    current_answer_by: raw.current_answer_by,
    option_count: raw.option_count,
    options: options.map((option) => {
      const item = (option ?? {}) as JsonObject;
      return { id: item.id, ord: item.ord, label: item.label, consequence: item.consequence, is_default: item.is_default };
    }),
    blocked_downstream_count: raw.blocked_downstream_count,
    created_at: raw.created_at,
    updated_at: raw.updated_at,
    expires_at: raw.expires_at,
    on_expire: raw.on_expire,
  };
}

/** 详情回正文与 checkpoint，但都做窗口截断；answers 保留完整 revision 链供修订判断。 */
function detailDecision(raw: JsonObject): JsonObject {
  const context = boundedText(raw.context_md, 12_000);
  const checkpoint = boundedText(raw.checkpoint_json, 4_000);
  return {
    ...summarizeDecision(raw),
    context_md: context.text,
    context_truncated: context.truncated,
    next_context_offset_chars: context.next_offset_chars,
    checkpoint_json: checkpoint.text,
    checkpoint_truncated: checkpoint.truncated,
    answers: raw.answers,
    capabilities: raw.capabilities,
  };
}

function assertWorkspaceMatches(config: McpConfig, decision: JsonObject): void {
  if (config.workspaceId && decision.workspace_id !== config.workspaceId) {
    throw new McpError('WORKSPACE_BOUND', 'This decision belongs to a different workspace.');
  }
}

export function registerDecisionTools(server: McpServer, config: McpConfig, api: AgentBoardApiClient): void {
  const register = (name: string, description: string, inputSchema: z.ZodObject<any>, run: (input: any) => Promise<unknown>, readOnly = true) => {
    const handler = async (input: any) => {
      try {
        const data = await run(input);
        return mcpToolSuccess(data, `${name} succeeded.`);
      } catch (error) {
        return mcpToolFailure(error);
      }
    };
    const meta = { description, inputSchema, annotations: { readOnlyHint: readOnly } };
    server.registerTool(name, meta, handler);
    server.registerTool(`agentboard_${name}`, meta, handler);
  };

  register(
    'list_decisions',
    'List pending decisions in one workspace with state/issue filters and counts. Use get_decision for full context and answer revisions.',
    z.object({
      ...workspaceField,
      issue_id: z.string().trim().min(1).optional(),
      state: decisionStateSchema.optional(),
      stale: z.boolean().optional(),
      limit: z.number().int().min(1).max(100).default(50),
    }).strict(),
    async ({ workspace_id, issue_id, state, stale, limit }) => {
      const workspaceId = resolveWorkspaceId(config, workspace_id);
      const page = await api.get<{ decisions: JsonObject[]; counts: unknown; capabilities: unknown }>(
        '/decisions',
        {
          workspace_id: workspaceId,
          ...(issue_id === undefined ? {} : { issue_id }),
          ...(state === undefined ? {} : { state }),
          ...(stale === true ? { stale: 'true' } : {}),
          limit,
        },
        'DECISION_NOT_FOUND',
      );
      return {
        items: page.decisions.map(summarizeDecision),
        counts: page.counts,
        capabilities: page.capabilities,
      };
    },
  );

  register(
    'get_decision',
    'Read one decision with options, answer revisions, checkpoint and remaining grace. Text fields are windowed.',
    z.object(decisionIdField).strict(),
    async ({ decision_id }) => {
      const response = await api.get<{ decision: JsonObject }>(
        `/decisions/${encodeURIComponent(decision_id)}`,
        {},
        'DECISION_NOT_FOUND',
      );
      assertWorkspaceMatches(config, response.decision);
      return { decision: detailDecision(response.decision) };
    },
  );

  register(
    'stop_check',
    'Check whether the agent was asked to stop on a task. Read-only; it does not acknowledge the stop signal.',
    z.object(taskIdField).strict(),
    async ({ task_id }) => api.get(`/issues/${encodeURIComponent(task_id)}/stop`, {}, 'TASK_NOT_FOUND'),
  );

  register(
    'ask_decision',
    'Create a pending decision (ask the user) on a running task owned by the configured agent. Does not wait for an answer; revisit with get_decision or stop_check. grace_seconds=0 locks immediately.',
    z.object({
      ...taskIdField,
      ...requestIdField,
      question: z.string().trim().min(1),
      options: z.array(
        z.object({
          label: z.string().trim().min(1),
          consequence: z.string().trim().min(1),
          is_default: z.boolean().optional(),
        }).strict(),
      ).min(2),
      context_md: z.string().optional(),
      trigger: z.enum(['blocked', 'scope_change', 'irreversible', 'missing_input']).optional(),
      grace_seconds: z.number().int().min(0).max(600).optional(),
      checkpoint: z.unknown().optional(),
      on_expire: z.enum(['stay_locked', 'unlock_default']).optional(),
      fence: z.number().int().optional(),
    }).strict(),
    async ({ task_id, request_id, question, options, context_md, trigger, grace_seconds, checkpoint, on_expire, fence }) => {
      const agentId = requireAgentId(config);
      const response = await api.mutate<{ decision: JsonObject }>(
        'POST',
        `/issues/${encodeURIComponent(task_id)}/ask`,
        {
          agent_id: agentId,
          question,
          options,
          ...(context_md === undefined ? {} : { context_md }),
          ...(trigger === undefined ? {} : { trigger }),
          ...(grace_seconds === undefined ? {} : { grace_seconds }),
          ...(checkpoint === undefined ? {} : { checkpoint }),
          ...(on_expire === undefined ? {} : { on_expire }),
          ...(fence === undefined ? {} : { fence }),
        },
        request_id,
        'DECISION_ALREADY_OPEN',
        'TASK_NOT_FOUND',
        fence,
      );
      assertWorkspaceMatches(config, response.decision);
      return {
        decision: summarizeDecision(response.decision),
        locked: response.decision.state === 'open',
        stop_requested: response.decision.state === 'open',
      };
    },
    false,
  );
}
