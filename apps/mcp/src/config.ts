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

export function resolveWorkspaceId(config: McpConfig, inputWorkspaceId?: string): string {
  const explicit = inputWorkspaceId?.trim();
  if (config.workspaceId) {
    if (explicit && explicit !== config.workspaceId) {
      throw new McpError('WORKSPACE_BOUND', 'This MCP server is bound to a different workspace.');
    }
    return config.workspaceId;
  }
  if (!explicit) throw new McpError('WORKSPACE_REQUIRED', 'Specify workspace_id for this task operation.');
  return explicit;
}

export function requireAgentId(config: McpConfig): string {
  if (!config.agentId) throw new McpError('AGENT_ID_REQUIRED', 'Set AGENTBOARD_AGENT_ID before using write tools.');
  return config.agentId;
}
