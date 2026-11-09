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
  // CR2-8：McpError 直通；业务 Error 只透 message 文本（不带堆栈/属性），空 message 或非 Error 保持通用文案
  const safe = error instanceof McpError
    ? error
    : new McpError('UPSTREAM_ERROR', error instanceof Error && error.message !== '' ? error.message : 'The local AgentBoard API request failed.');
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
