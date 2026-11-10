import { textWindow } from '@agentboard/shared';
import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod/v4';
import type { McpConfig } from '../config.js';
import { McpError, requireAgentId, resolveWorkspaceId } from '../config.js';
import { AgentBoardApiClient } from '../apiClient.js';
import { registerBoardTool } from './register.js';

const workspaceField = {
  workspace_id: z.string().trim().min(1).optional()
    .describe('Workspace UUID. Omit to use the workspace this MCP server is bound to.'),
};
const taskIdField = {
  task_id: z.string().trim().min(1).describe('Task UUID of the task you own and are blocked on.'),
};
const decisionIdField = {
  decision_id: z.string().trim().min(1).describe('Decision UUID (36-char full id; an 8+ char unique prefix is also accepted).'),
};
const requestIdField = {
  request_id: z.string().uuid()
    .describe('Idempotency key (UUID). Replaying the same request_id returns the original result; reusing it with different arguments fails with a conflict.'),
};
const decisionStateSchema = z.enum(['grace', 'open', 'answered', 'withdrawn'])
  .describe('Decision state: grace (waiting window) / open (locked) / answered / withdrawn.');

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

/**
 * MCP 不发送身份头，服务端按 `user` 计算 capabilities，会返回 can_answer=true。
 * 但本进程配置了 AGENTBOARD_AGENT_ID 时它就是 agent，agent 不能回答决策——
 * 这里按同一口径覆写，避免 capability 继续误导调用方。
 */
function agentCapabilities(config: McpConfig, raw: unknown): unknown {
  if (!config.agentId || !raw || typeof raw !== 'object') return raw;
  return { ...(raw as Record<string, unknown>), can_answer: false };
}

export function registerDecisionTools(server: McpServer, config: McpConfig, api: AgentBoardApiClient): void {
  registerBoardTool(server, {
    name: 'list_decisions',
    description: 'List pending decisions in one workspace with state/issue filters and counts. Use get_decision for full context and answer revisions.',
    inputSchema: z.object({
      ...workspaceField,
      issue_id: z.string().trim().min(1).optional()
        .describe('Only decisions raised on this task UUID.'),
      state: decisionStateSchema.optional(),
      stale: z.boolean().optional()
        .describe('Set true to list only decisions waiting longer than 72 hours.'),
      limit: z.number().int().min(1).max(100).default(50)
        .describe('Maximum decisions to return, 1-100 (default 50).'),
    }).strict(),
  }, async ({ workspace_id, issue_id, state, stale, limit }) => {
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
      items: page.decisions.map(d => {
        const item = summarizeDecision(d);
        return config.agentId ? { ...item, capabilities: agentCapabilities(config, item.capabilities) } : item;
      }),
      counts: page.counts,
      capabilities: agentCapabilities(config, page.capabilities),
    };
  });

  registerBoardTool(server, {
    name: 'get_decision',
    description: 'Read one decision with options, answer revisions, checkpoint and remaining grace. Text fields are windowed.',
    inputSchema: z.object(decisionIdField).strict(),
  }, async ({ decision_id }) => {
    const response = await api.get<{ decision: JsonObject }>(
      `/decisions/${encodeURIComponent(decision_id)}`,
      {},
      'DECISION_NOT_FOUND',
    );
    assertWorkspaceMatches(config, response.decision);
    const detail = detailDecision(response.decision);
    return { decision: { ...detail, capabilities: agentCapabilities(config, detail.capabilities) } };
  });

  registerBoardTool(server, {
    name: 'stop_check',
    description: 'Check whether the agent was asked to stop on a task. Read-only; it does not acknowledge the stop signal.',
    inputSchema: z.object(taskIdField).strict(),
  }, async ({ task_id }) => api.get(`/issues/${encodeURIComponent(task_id)}/stop`, {}, 'TASK_NOT_FOUND'));

  registerBoardTool(
    server,
    {
      name: 'ask_decision',
      description: 'Create a pending decision (ask the user) on a running task owned by the configured agent. Does not wait for an answer; revisit with get_decision or stop_check. grace_seconds=0 locks immediately.',
      inputSchema: z.object({
        ...taskIdField,
        ...requestIdField,
        question: z.string().trim().min(1)
          .describe('The single question you need a human to decide, phrased so one option is clearly pickable.'),
        options: z.array(
          z.object({
            label: z.string().trim().min(1)
              .describe('Short option name shown to the human, e.g. "改用方案 B".'),
            consequence: z.string().trim().min(1)
              .describe('What happens if this option is chosen — concrete effect on scope, data or schedule.'),
            is_default: z.boolean().optional()
              .describe('Mark at most one option as the default taken when on_expire=unlock_default.'),
          }).strict(),
        ).min(2)
          .describe('At least 2 mutually exclusive options. Shape: [{"label":"方案 A","consequence":"…"},{"label":"方案 B","consequence":"…"}]. Not an array of strings.'),
        context_md: z.string().optional()
          .describe('Markdown context the human needs to decide (what was tried, why it is blocked). Keep it short.'),
        trigger: z.enum(['blocked', 'scope_change', 'irreversible', 'missing_input']).optional()
          .describe('Why you are asking: blocked / scope_change / irreversible / missing_input.'),
        grace_seconds: z.number().int().min(0).max(600).optional()
          .describe('How long the task stays claimable while waiting. 0 locks immediately; default 180; max 600.'),
        checkpoint: z.unknown().optional()
          .describe('Optional resume state, e.g. {"tool":"…","completed":["…"],"pending":["…"],"next_step":"…"} so the next agent can continue after unlock.'),
        on_expire: z.enum(['stay_locked', 'unlock_default']).optional()
          .describe('After grace expires: stay_locked keeps the task blocked, unlock_default applies the option marked is_default.'),
        fence: z.number().int().optional()
          .describe('Claim fence/epoch from claim_task; a stale fence fails with 409 STALE_FENCE.'),
      }).strict(),
      readOnly: false,
    },
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
  );

  registerBoardTool(
    server,
    {
      name: 'answer_decision',
      description: 'Answer a pending decision. Only a human may answer: with AGENTBOARD_AGENT_ID configured this tool is rejected (DECISION_HUMAN_ONLY) — the agent must wait or withdraw the decision instead. Revising an existing answer requires expected_revision (CAS).',
      inputSchema: z.object({
        ...decisionIdField,
        ...requestIdField,
        option: z.union([z.number().int().min(1), z.string().trim().min(1)]).optional()
          .describe('Pick an option: 1-based ordinal (number or numeric string) or the exact option label. Provide exactly one of option / text.'),
        text: z.string().min(1).optional()
          .describe('Free-text answer, used when no listed option fits. Provide exactly one of option / text.'),
        expected_revision: z.number().int().min(0).optional()
          .describe('CAS guard for revise=true: answer_revision you last read. Mismatch → conflict, re-read with get_decision.'),
        revise: z.boolean().optional()
          .describe('Set true to overwrite an existing answer; requires expected_revision.'),
      }).strict(),
      readOnly: false,
    },
    async ({ decision_id, request_id, option, text, expected_revision, revise }) => {
      if ((option === undefined) === (text === undefined)) {
        throw new McpError('VALIDATION_ERROR', 'Provide exactly one of option or text.');
      }
      if (revise === true && expected_revision === undefined) {
        throw new McpError('VALIDATION_ERROR', 'revise requires expected_revision.');
      }
      const detail = await api.get<{ decision: JsonObject }>(
        `/decisions/${encodeURIComponent(decision_id)}`,
        {},
        'DECISION_NOT_FOUND',
      );
      assertWorkspaceMatches(config, detail.decision);
      // 与 CLI 同口径：带 agent 身份时服务端拒绝（仅有 answered_by=user 放行）；未配置身份才按人类操作
      const body: JsonObject = { answered_by: config.agentId ?? 'user', source: 'cli' };
      if (option !== undefined) {
        if (typeof option === 'number' || /^\d+$/.test(option)) {
          body.option_ord = typeof option === 'number' ? option : Number(option);
        } else {
          const options = Array.isArray(detail.decision.options) ? (detail.decision.options as JsonObject[]) : [];
          const match = options.find((item) => item.label === option);
          if (!match) throw new McpError('VALIDATION_ERROR', 'No option has that label; call get_decision first.');
          body.option_id = match.id;
        }
      }
      if (text !== undefined) body.answer_text = text;
      if (expected_revision !== undefined) body.expected_revision = expected_revision;
      const response = await api.mutate<{ decision: JsonObject }>(
        'POST',
        `/decisions/${encodeURIComponent(decision_id)}/answer`,
        body,
        request_id,
        'DECISION_ALREADY_ANSWERED',
        'DECISION_NOT_FOUND',
      );
      const revision = Number(response.decision.answer_revision ?? 0);
      const answers = Array.isArray(response.decision.answers) ? (response.decision.answers as JsonObject[]) : [];
      const latest = answers.find((item) => item.revision === revision) ?? null;
      return {
        decision: summarizeDecision(response.decision),
        outcome: revision > 1 ? 'revised' : 'answered',
        answer: latest,
      };
    },
  );

  registerBoardTool(
    server,
    {
      name: 'extend_decision_grace',
      description: 'Extend the grace window of a decision that is still in grace. 1-300 seconds per call; original grace plus extensions cannot exceed 600 seconds. Not available after the decision locks.',
      inputSchema: z.object({
        ...decisionIdField,
        ...requestIdField,
        seconds: z.number().int().min(1).max(300).default(60)
          .describe('Additional grace seconds, 1-300 (default 60). Original grace plus all extensions cannot exceed 600.'),
        by: z.string().trim().min(1).optional()
          .describe('Audit actor recorded for the extension; defaults to the configured agent id.'),
        fence: z.number().int().min(0).optional()
          .describe('Claim fence/epoch from claim_task; stale fence → 409 STALE_FENCE.'),
        ...workspaceField,
      }).strict(),
      readOnly: false,
    },
    async ({ decision_id, request_id, seconds, by, fence, workspace_id }) => {
      const workspaceId = config.workspaceId ? resolveWorkspaceId(config, workspace_id) : workspace_id?.trim();
      const response = await api.mutate<JsonObject>(
        'POST',
        `/decisions/${encodeURIComponent(decision_id)}/extend`,
        {
          seconds,
          by: by ?? config.agentId ?? 'user',
          ...(workspaceId === undefined ? {} : { workspace_id: workspaceId }),
          ...(fence === undefined ? {} : { fence }),
        },
        request_id,
        'DECISION_NOT_GRACE',
        'DECISION_NOT_FOUND',
        fence,
      );
      return { extension: response };
    },
  );

  registerBoardTool(
    server,
    {
      name: 'withdraw_decision',
      description: 'Withdraw a pending decision with a required reason. The audit actor defaults to AGENTBOARD_AGENT_ID; the workspace owner permission is granted by the local server identity.',
      inputSchema: z.object({
        ...decisionIdField,
        ...requestIdField,
        reason: z.string().trim().min(1)
          .describe('Why the question is withdrawn (recorded in the audit trail). Withdrawing releases the decision lock and bumps the claim fence — claim again afterwards.'),
        by: z.string().trim().min(1).optional()
          .describe('Audit actor recorded for the withdrawal; defaults to the configured agent id.'),
      }).strict(),
      readOnly: false,
    },
    async ({ decision_id, request_id, reason, by }) => {
      const detail = await api.get<{ decision: JsonObject }>(
        `/decisions/${encodeURIComponent(decision_id)}`,
        {},
        'DECISION_NOT_FOUND',
      );
      assertWorkspaceMatches(config, detail.decision);
      const response = await api.mutate<{ decision: JsonObject }>(
        'POST',
        `/decisions/${encodeURIComponent(decision_id)}/withdraw`,
        { reason, by: by ?? config.agentId ?? 'user' },
        request_id,
        'DECISION_NOT_ACTIVE',
        'DECISION_NOT_FOUND',
      );
      return { decision: summarizeDecision(response.decision) };
    },
  );
}
