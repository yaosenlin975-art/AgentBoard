import { textWindow } from '@agentboard/shared';
import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod/v4';
import type { McpConfig } from '../config.js';
import { requireAgentId, resolveWorkspaceId } from '../config.js';
import { AgentBoardApiClient } from '../apiClient.js';
import { mcpToolFailure, mcpToolSuccess } from './result.js';

type JsonObject = Record<string, unknown>;

/**
 * MCP-C2：工作区变更日志（list / show / create）。
 * 只消费 LOG01 的 REST：GET/POST `/workspaces/:workspaceId/changelog`。
 * 列表只回摘要（正文窗口 300），详情才回正文（窗口 12000）。
 */

const workspaceField = {
  workspace_id: z.string().trim().min(1).optional()
    .describe('Workspace UUID. Omit to use the workspace this MCP server is bound to.'),
};
const requestIdField = {
  request_id: z.string({ error: 'request_id is required by this write tool: pass a UUID idempotency key, e.g. 00000000-0000-4000-8000-000000000000. Reuse the SAME key only when retrying the identical call — it returns the original result; a different payload gets 409 IDEMPOTENCY_KEY_REUSED. Read-only tools and deletes (delete_task / remove_dependency) take no request_id.' }).uuid()
    .describe('Idempotency key (UUID). Replaying the same request_id returns the original result; reusing it with different arguments fails with a conflict.'),
};
const changeTypeSchema = z.enum(['新增', '修复', '调整'])
  .describe('Change type: 新增 (added) / 修复 (fixed) / 调整 (changed).');

function boundedBody(value: unknown, max: number) {
  const window = textWindow(typeof value === 'string' ? value : '', 0, max);
  return { body_md: window.content, body_truncated: window.truncated, next_offset_chars: window.next_offset_chars };
}

function summarizeEntry(entry: JsonObject): JsonObject {
  const body = boundedBody(entry.body_md, 300);
  return {
    id: entry.id,
    workspace_id: entry.workspace_id,
    title: entry.title,
    change_type: entry.change_type,
    occurred_at: entry.occurred_at,
    created_by: entry.created_by,
    revision: entry.revision,
    ...body,
  };
}

export function registerChangelogTools(server: McpServer, config: McpConfig, api: AgentBoardApiClient): void {
  const register = (
    name: string,
    description: string,
    inputSchema: z.ZodTypeAny,
    run: (input: any) => Promise<unknown>,
    readOnly = true,
  ) => {
    const handler = async (input: any) => {
      try {
        return mcpToolSuccess(await run(input), `${name} succeeded.`);
      } catch (error) {
        return mcpToolFailure(error);
      }
    };
    const meta = { description, inputSchema, annotations: { readOnlyHint: readOnly } };
    server.registerTool(name, meta, handler);
    server.registerTool(`agentboard_${name}`, meta, handler);
  };

  register(
    'list_changelog',
    'List workspace change-log entries (newest first). Each entry carries title/type/actor/revision and a 300-character body preview; use get_changelog for the full body.',
    z.object({
      ...workspaceField,
      limit: z.number().int().min(1).max(100).default(20).describe('Max entries, 1-100 (default 20).'),
      offset: z.number().int().min(0).default(0).describe('Zero-based row offset (default 0).'),
      change_type: changeTypeSchema.optional(),
      q: z.string().trim().max(200).optional().describe('Optional case-insensitive substring filter over title and body.'),
    }).strict(),
    async ({ workspace_id, limit, offset, change_type, q }) => {
      const workspaceId = resolveWorkspaceId(config, workspace_id);
      const page = await api.get<{ items: JsonObject[]; next_offset: number | null }>(
        `/workspaces/${encodeURIComponent(workspaceId)}/changelog`,
        { limit, offset, ...(change_type === undefined ? {} : { change_type }), ...(q === undefined ? {} : { q }) },
        'WORKSPACE_NOT_FOUND',
      );
      return {
        workspace_id: workspaceId,
        items: (page.items ?? []).map(summarizeEntry),
        next_offset: page.next_offset ?? null,
      };
    },
  );

  register(
    'get_changelog',
    'Read one change-log entry, including the body windowed at 12000 characters (continuation offset returned when truncated).',
    z.object({
      ...workspaceField,
      changelog_id: z.string().trim().min(1).describe('Change-log entry UUID from list_changelog.'),
      body_offset: z.number().int().min(0).default(0).describe('Character offset into body_md (default 0).'),
      body_max_chars: z.number().int().min(1).max(20000).default(12000)
        .describe('Max body characters, 1-20000 (default 12000). Continue from next_offset_chars.'),
    }).strict(),
    async ({ workspace_id, changelog_id, body_offset, body_max_chars }) => {
      const workspaceId = resolveWorkspaceId(config, workspace_id);
      const entry = await api.get<JsonObject>(
        `/workspaces/${encodeURIComponent(workspaceId)}/changelog/${encodeURIComponent(changelog_id)}`,
        {},
        'CHANGELOG_NOT_FOUND',
      );
      const window = textWindow(String(entry.body_md ?? ''), body_offset, body_max_chars);
      return {
        entry: {
          ...entry,
          body_md: window.content,
          body_truncated: window.truncated,
          next_offset_chars: window.next_offset_chars,
        },
      };
    },
  );

  register(
    'create_changelog',
    'Append a workspace change-log entry (title + body_md + change_type 新增/修复/调整). Pass issue_id to attribute it to a task — the done changelog gate then recognises it without skip_changelog. request_id is the idempotency key.',
    z.object({
      ...workspaceField,
      ...requestIdField,
      title: z.string().trim().min(1).max(200).describe('Entry title, one line.'),
      body_md: z.string().min(1).max(100000)
        .describe('Entry body in Markdown: what changed and why, from the user\'s point of view.'),
      change_type: changeTypeSchema.default('新增'),
      occurred_at: z.number().int().nonnegative().optional()
        .describe('When the change happened, epoch milliseconds (defaults to now).'),
      issue_id: z.string().uuid().optional()
        .describe('Task UUID this entry belongs to. Set it so complete_task can pass the changelog gate for that task.'),
    }).strict(),
    async ({ workspace_id, request_id, title, body_md, change_type, occurred_at, issue_id }) => {
      const workspaceId = resolveWorkspaceId(config, workspace_id);
      const actor = requireAgentId(config);
      const entry = await api.mutate<JsonObject>(
        'POST',
        `/workspaces/${encodeURIComponent(workspaceId)}/changelog`,
        {
          title,
          body_md,
          change_type,
          actor,
          ...(occurred_at === undefined ? {} : { occurred_at }),
          ...(issue_id === undefined ? {} : { issue_id }),
        },
        request_id,
        undefined,
        'WORKSPACE_NOT_FOUND',
      );
      return { entry: summarizeEntry(entry) };
    },
    false,
  );
}
