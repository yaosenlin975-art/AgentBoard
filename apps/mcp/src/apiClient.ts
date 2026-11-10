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
  ISSUE_CLAIMED: 'The task is currently claimed by another agent; do not retry — pick another task or wait until it is released. Changing dependencies on a claimed task also requires releasing it first.',
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
  STALE_FENCE: 'The occupancy fence is stale; claim the task again to get a fresh fence before finishing.',
  DECISION_NOT_FOUND: 'The decision does not exist or is not visible to this workspace.',
  DECISION_ALREADY_OPEN: 'The task already has an in-flight decision; answer or withdraw it first.',
  DECISION_ALREADY_ANSWERED: 'The decision was already answered or withdrawn; read it again.',
  DECISION_REVISION_CONFLICT: 'The decision answer changed; read it again before revising.',
  DECISION_NOT_ACTIVE: 'The decision is no longer active; read it again before acting.',
  DECISION_WITHDRAWN: 'The decision was withdrawn and can no longer be answered.',
  DECISION_NOT_GRACE: 'The decision is not in its grace window; only grace decisions can be extended.',
  // 与 CLI（服务端 DECISION_HUMAN_ONLY）同句：agent 不得自答，只有人类能回答
  DECISION_HUMAN_ONLY: '仅人类可回答决策（answered_by=user）：由人在看板「待决策」回答，或 kb decision withdraw <decision_id> --reason "…" 撤回后重新 claim。',
  ASK_TOO_FEW_OPTIONS: 'At least two options with non-empty label and consequence are required.',
  ASK_RATE_LIMITED: 'Too many in-flight or recent decisions for this agent; wait before asking again.',
  ISSUE_STATUS_NOT_RUNNING: 'Only a running task owned by this agent can ask a decision.',
  INVALID_GRACE: 'grace_seconds must be an integer between 0 and 600.',
  INVALID_SECONDS: 'seconds must be an integer between 1 and 300.',
  EXTEND_LIMIT_EXCEEDED: 'The grace window cannot be extended further; the 600-second total is reached.',
  FORBIDDEN: 'The current identity is not allowed to perform this operation.',
  INVALID_TRANSITION: 'The task status does not allow this transition.',
  ACCEPT_STATUS_NOT_ACCEPTABLE: 'Only tasks in review (待验收) can receive an acceptance record.',
  CHANGELOG_NOT_FOUND: 'The change-log entry does not exist in this workspace.',
  WORKSPACE_NOT_FOUND: 'The workspace does not exist.',
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

  mutate<T>(method: 'POST' | 'PUT' | 'PATCH', path: string, body: unknown, requestId: string, conflictCode?: string, notFoundCode?: string, fence?: number): Promise<T> {
    return this.request<T>(method, path, {}, body, requestId, conflictCode, notFoundCode, fence);
  }

  /** DELETE（无 body、无幂等键）：204 返回 undefined */
  delete<T = void>(path: string, conflictCode?: string, notFoundCode?: string): Promise<T> {
    return this.request<T>('DELETE', path, {}, undefined, undefined, conflictCode, notFoundCode);
  }

  private async request<T>(method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE', path: string, query: Query = {}, body?: unknown, requestId?: string, conflictCode?: string, notFoundCode?: string, fence?: number): Promise<T> {
    const url = new URL(`/api${path}`, `${this.config.baseUrl}/`);
    for (const [key, value] of Object.entries(query)) {
      if (value !== undefined) url.searchParams.set(key, String(value));
    }
    const headers = new Headers();
    if (body !== undefined) headers.set('Content-Type', 'application/json');
    if (requestId) headers.set('Idempotency-Key', requestId);
    // BORROW-0.3：占用代次走 x-claim-fence 头（服务端 body.fence 优先、头回退，两通道等价）
    if (fence !== undefined) headers.set('x-claim-fence', String(fence));
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
