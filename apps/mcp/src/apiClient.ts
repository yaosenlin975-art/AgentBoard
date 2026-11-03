import type { McpConfig } from './config.js';
import { McpError } from './config.js';

type Query = Record<string, string | number | undefined>;

const SAFE_MESSAGES: Record<string, string> = {
  TASK_NOT_FOUND: 'The task does not exist in this workspace.',
  COMMENT_NOT_FOUND: 'The comment does not exist on this task.',
  TASK_CLAIMED: 'The task is already claimed or cannot be claimed.',
  TASK_CONFLICT: 'The task state conflicts with this operation.',
  NOT_TASK_OWNER: 'Only the current task owner can perform this operation.',
  TASK_REVISION_CONFLICT: 'The task changed; read it again before updating.',
  DEPENDENCY_SELF: 'A task cannot depend on itself.',
  CROSS_WORKSPACE_DEPENDENCY: 'Dependencies across workspaces are not supported.',
  DEPENDENCY_CYCLE: 'This dependency would create a cycle and was rejected.',
  DEPENDENCY_EXISTS: 'This dependency already exists.',
  ISSUE_CLAIMED: 'The task is currently claimed; release it before adding a blocker.',
  KNOWLEDGE_NOT_FOUND: 'The knowledge page does not exist in this scope.',
  KNOWLEDGE_REVISION_CONFLICT: 'The knowledge page changed; read it again before updating.',
  KNOWLEDGE_UNAVAILABLE: 'The local AgentBoard knowledge API is unavailable.',
  KNOWLEDGE_RESULT_TOO_LARGE: 'The knowledge response exceeds the 40,000-character limit; reduce the requested text or page sizes and continue with the returned offsets.',
  INVALID_ARGUMENT: 'The knowledge scope or input is invalid.',
  IDEMPOTENCY_KEY_REUSED: 'request_id was already used for a different operation.',
  VALIDATION_ERROR: 'AgentBoard rejected the request input.',
  SERVER_UNREACHABLE: 'The local AgentBoard API is unavailable.',
  OPERATION_UNKNOWN: 'The request timed out after sending; inspect or retry with the same request_id.',
  UPSTREAM_ERROR: 'The local AgentBoard API request failed.',
};

function safeCode(code: unknown, status: number, conflictCode?: string, notFoundCode?: string): string {
  if (status === 409 && code === 'CONFLICT') return conflictCode ?? 'TASK_CONFLICT';
  if (status === 404 && code === 'NOT_FOUND') return notFoundCode ?? 'TASK_NOT_FOUND';
  if (status === 404 && typeof code !== 'string') return notFoundCode ?? 'TASK_NOT_FOUND';
  if (typeof code === 'string' && /^[A-Z][A-Z0-9_]{1,60}$/.test(code)) return code;
  return 'UPSTREAM_ERROR';
}

function definitelyNotSent(error: unknown): boolean {
  const known = new Set(['ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'EHOSTUNREACH', 'ENETUNREACH']);
  let current = error as { code?: unknown; cause?: unknown } | null;
  for (let depth = 0; current && depth < 5; depth++, current = current.cause as typeof current) {
    if (typeof current.code === 'string' && known.has(current.code)) return true;
  }
  return false;
}

function safeDetails(code: string, raw: unknown): { current_updated_at?: number; current_revision?: number } | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const details = raw as Record<string, unknown>;
  if (code === 'TASK_REVISION_CONFLICT' && typeof details.current_updated_at === 'number' && Number.isFinite(details.current_updated_at)) {
    return { current_updated_at: details.current_updated_at };
  }
  if (code === 'KNOWLEDGE_REVISION_CONFLICT' && typeof details.current_revision === 'number' && Number.isSafeInteger(details.current_revision) && details.current_revision > 0) {
    return { current_revision: details.current_revision };
  }
  return undefined;
}

export class AgentBoardApiClient {
  constructor(private readonly config: McpConfig, private readonly fetcher: typeof fetch = fetch) {}

  get<T>(path: string, query: Query = {}, notFoundCode?: string): Promise<T> {
    return this.request<T>('GET', path, query, undefined, undefined, undefined, notFoundCode);
  }

  mutate<T>(method: 'POST' | 'PUT' | 'PATCH', path: string, body: unknown, requestId: string, conflictCode?: string, notFoundCode?: string): Promise<T> {
    return this.request<T>(method, path, {}, body, requestId, conflictCode, notFoundCode);
  }

  /** DELETE（无 body、无幂等键）：204 返回 undefined */
  delete<T = void>(path: string, conflictCode?: string, notFoundCode?: string): Promise<T> {
    return this.request<T>('DELETE', path, {}, undefined, undefined, conflictCode, notFoundCode);
  }

  private async request<T>(method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE', path: string, query: Query = {}, body?: unknown, requestId?: string, conflictCode?: string, notFoundCode?: string): Promise<T> {
    const url = new URL(`/api${path}`, `${this.config.baseUrl}/`);
    for (const [key, value] of Object.entries(query)) {
      if (value !== undefined) url.searchParams.set(key, String(value));
    }
    const headers = new Headers();
    if (body !== undefined) headers.set('Content-Type', 'application/json');
    if (requestId) headers.set('Idempotency-Key', requestId);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10_000);
    try {
      const response = await this.fetcher(url, {
        method,
        headers,
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
        signal: controller.signal,
      });
      if (response.status === 204) return undefined as T;
      let payload: unknown;
      try {
        payload = await response.json();
      } catch {
        if (response.status === 404 && notFoundCode) {
          throw new McpError(notFoundCode, SAFE_MESSAGES[notFoundCode] ?? SAFE_MESSAGES.UPSTREAM_ERROR!);
        }
        if (response.ok && requestId) {
          throw new McpError('OPERATION_UNKNOWN', SAFE_MESSAGES.OPERATION_UNKNOWN!, true, 'unknown');
        }
        throw new McpError('UPSTREAM_ERROR', SAFE_MESSAGES.UPSTREAM_ERROR!, response.status >= 500);
      }
      if (!response.ok) {
        const record = payload && typeof payload === 'object' ? payload as Record<string, unknown> : {};
        const error = record.error && typeof record.error === 'object' ? record.error as Record<string, unknown> : {};
        const code = safeCode(error.code, response.status, conflictCode, notFoundCode);
        const message = SAFE_MESSAGES[code] ?? SAFE_MESSAGES.UPSTREAM_ERROR!;
        if (code === 'OPERATION_UNKNOWN') throw new McpError(code, message, true, 'unknown');
        throw new McpError(code, message, response.status >= 500, undefined, safeDetails(code, error.details));
      }
      return payload as T;
    } catch (error) {
      if (error instanceof McpError) throw error;
      if (requestId && !definitelyNotSent(error)) {
        throw new McpError('OPERATION_UNKNOWN', SAFE_MESSAGES.OPERATION_UNKNOWN!, true, 'unknown');
      }
      throw new McpError('SERVER_UNREACHABLE', SAFE_MESSAGES.SERVER_UNREACHABLE!);
    } finally {
      clearTimeout(timer);
    }
  }
}
