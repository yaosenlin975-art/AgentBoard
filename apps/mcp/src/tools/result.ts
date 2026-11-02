import { McpError } from '../config.js';

export const MCP_TOOL_RESULT_LIMIT = 40_000;

export type McpToolResponse = {
  content: Array<{ type: 'text'; text: string }>;
  structuredContent: Record<string, unknown>;
  isError?: boolean;
};

export function mcpToolSuccess(data: unknown, summary: string): McpToolResponse {
  return { content: [{ type: 'text', text: summary }], structuredContent: { ok: true, data } };
}

export function mcpToolFailure(error: unknown): McpToolResponse {
  const safe = error instanceof McpError ? error : new McpError('UPSTREAM_ERROR', 'The local AgentBoard API request failed.');
  return {
    isError: true,
    content: [{ type: 'text', text: safe.message }],
    structuredContent: {
      ok: false,
      error: {
        code: safe.code,
        message: safe.message,
        retryable: safe.retryable,
        ...safe.details,
        ...(safe.operationState ? { operation_state: safe.operationState } : {}),
      },
    },
  };
}

export function mcpToolResultFits(response: McpToolResponse, maxChars = MCP_TOOL_RESULT_LIMIT): boolean {
  return JSON.stringify(response).length <= maxChars;
}
