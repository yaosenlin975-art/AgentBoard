import { isIP } from 'node:net';

export interface McpConfig {
  baseUrl: string;
  workspaceId?: string;
  agentId?: string;
}

export class McpError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly retryable = false,
    readonly operationState?: 'unknown',
    readonly details?: { current_updated_at?: number; current_revision?: number },
  ) {
    super(message);
    this.name = 'McpError';
  }
}

function loopbackBaseUrl(raw: string | undefined): string {
  const value = raw?.trim() || 'http://127.0.0.1:8787';
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new McpError('INVALID_CONFIG', 'AGENTBOARD_BASE_URL must be a loopback HTTP URL.');
  }
  const hostname = url.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  const loopback = hostname === 'localhost'
    || (isIP(hostname) === 4 && hostname.startsWith('127.'))
    || (isIP(hostname) === 6 && hostname === '::1');
  if (url.protocol !== 'http:' || !loopback || url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
    throw new McpError('INVALID_CONFIG', 'AGENTBOARD_BASE_URL must be a loopback HTTP origin without credentials or path.');
  }
  return url.origin;
}

export function loadMcpConfig(env: NodeJS.ProcessEnv = process.env): McpConfig {
  return {
    baseUrl: loopbackBaseUrl(env.AGENTBOARD_BASE_URL),
    ...(env.AGENTBOARD_WORKSPACE_ID?.trim() ? { workspaceId: env.AGENTBOARD_WORKSPACE_ID.trim() } : {}),
    ...(env.AGENTBOARD_AGENT_ID?.trim() ? { agentId: env.AGENTBOARD_AGENT_ID.trim() } : {}),
  };
}

/**
 * 工具族：决定「未绑定工作区」时 WORKSPACE_REQUIRED 的文案。
 * 原实现所有工具共用一句 `for this task operation`，把知识页/统计/协作类都叫成任务操作，
 * 调用方看不出缺的是哪个上下文（C7）。
 */
export type WorkspaceFamily = 'task' | 'knowledge' | 'stats' | 'collab';

const FAMILY_LABEL: Record<WorkspaceFamily, string> = {
  task: 'a task operation',
  knowledge: 'a knowledge-page operation',
  stats: 'a board statistics operation',
  collab: 'a collaboration operation (next_tasks / stop_check)',
};

export function resolveWorkspaceId(config: McpConfig, inputWorkspaceId?: string, family: WorkspaceFamily = 'task'): string {
  const explicit = inputWorkspaceId?.trim();
  if (config.workspaceId) {
    if (explicit && explicit !== config.workspaceId) {
      throw new McpError('WORKSPACE_BOUND', 'This MCP server is bound to a different workspace.');
    }
    return config.workspaceId;
  }
  if (!explicit) {
    throw new McpError(
      'WORKSPACE_REQUIRED',
      `Specify workspace_id for ${FAMILY_LABEL[family]}. `
      + 'Pass workspace_id explicitly, or set AGENTBOARD_WORKSPACE_ID when launching this MCP server. '
      + 'Until a workspace is bound, task/page ids cannot be validated (a malformed or unknown id also reports this error).',
    );
  }
  return explicit;
}

export function requireAgentId(config: McpConfig): string {
  if (!config.agentId) throw new McpError('AGENT_ID_REQUIRED', 'Set AGENTBOARD_AGENT_ID before using write tools.');
  return config.agentId;
}
