import { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AgentBoardApiClient } from '../src/apiClient.js';
import { resetListFieldsFallback } from '../src/tools/tasks.js';
import { createHarness } from './helpers.js';

const baseConfig = { baseUrl: 'http://127.0.0.1:8787', workspaceId: 'workspace-a', agentId: 'codex' };
const FULL_TASK_ID = '5f1b2c34-0000-4000-8000-00000000b001';

describe('AgentBoard task MCP server', () => {
  const harnesses: Array<ReturnType<typeof createHarness>> = [];
  // PERF-4d：fields= 回落标志是进程级状态，每个用例前置复位
  beforeEach(() => resetListFieldsFallback());
  afterEach(async () => {
    vi.useRealTimers();
    await Promise.all(harnesses.splice(0).map((harness) => harness.close()));
  });

  it('mcpTaskServerInitializesAndListsTools', async () => {
    const harness = createHarness(baseConfig);
    harnesses.push(harness);
    const initialized = await harness.start();
    expect(initialized.result?.protocolVersion).toBe('2025-11-25');
    const response = await harness.request('tools/list');
    // MCP-NAMING：主名不带 agentboard_ 前缀；旧名作为 alias 另注册（下个大版本移除），此处只断言主名集合
    const primaryNames = (response.result?.tools ?? [])
      .map((tool: { name: string }) => tool.name)
      .filter((name: string) => !name.startsWith('agentboard_'))
      .sort();
    expect(primaryNames).toEqual([
      'accept_task',
      'add_dependency',
      'add_status',
      'add_task_comment',
      'answer_decision',
      'archive_knowledge',
      'ask_decision',
      'claim_task',
      'close_task',
      'complete_task',
      'create_changelog',
      'create_knowledge',
      'create_task',
      'delete_task',
      'extend_decision_grace',
      'fail_task',
      'find_knowledge_sources',
      'finish_task',
      'get_changelog',
      'get_decision',
      'get_task',
      'get_task_comment',
      'get_task_comments',
      'list_changelog',
      'list_decisions',
      'list_dependencies',
      'list_knowledge',
      'list_statuses',
      'list_tasks',
      'list_workspaces',
      'next_tasks',
      'read_knowledge',
      'release_task',
      'remove_dependency',
      'remove_status',
      'reopen_task',
      'restore_knowledge',
      'revise_knowledge',
      'search_knowledge',
      'start_task',
      'stop_check',
      'update_task',
      'withdraw_decision',
      'workspace_stats',
    ]);
    expect(harness.stdoutMessages).toHaveLength(2);
    expect(harness.stdoutMessages.every((message) => message.jsonrpc === '2.0')).toBe(true);
  });

  it('validates tool input before making an API request', async () => {
    const fetcher = vi.fn() as unknown as typeof fetch;
    const harness = createHarness(baseConfig, fetcher);
    harnesses.push(harness);
    await harness.start();
    const response = await harness.request('tools/call', {
      name: 'list_tasks',
      arguments: { limit: 101 },
    });
    expect(response.result?.isError).toBe(true);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('N-07: missing request_id explains what an idempotency key is (not raw zod text)', async () => {
    const fetcher = vi.fn() as unknown as typeof fetch;
    const harness = createHarness(baseConfig, fetcher);
    harnesses.push(harness);
    await harness.start();
    const response = await harness.request('tools/call', {
      name: 'claim_task',
      arguments: { task_id: 'task-1' },
    });
    expect(response.result?.isError).toBe(true);
    const text = JSON.stringify(response.result?.content ?? '');
    expect(text).toContain('request_id is required');
    expect(text).toContain('idempotency key');
    expect(text).toContain('00000000-0000-4000-8000-000000000000');
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('boundWorkspaceRejectsOverride', async () => {
    const fetcher = vi.fn() as unknown as typeof fetch;
    const harness = createHarness(baseConfig, fetcher);
    harnesses.push(harness);
    await harness.start();
    const response = await harness.request('tools/call', {
      name: 'list_tasks',
      arguments: { workspace_id: 'workspace-b' },
    });
    expect(response.result?.isError).toBe(true);
    expect(response.result?.structuredContent).toMatchObject({ ok: false, error: { code: 'WORKSPACE_BOUND' } });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('taskConflictUsesIsErrorStructuredContent', async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => Response.json({ error: { code: 'CONFLICT', message: 'claimed' } }, { status: 409 }));
    const harness = createHarness(baseConfig, fetchMock as typeof fetch);
    harnesses.push(harness);
    await harness.start();
    const requestId = '2280a9a4-409b-44e2-a1fb-7e8f8862b1a0';
    const response = await harness.request('tools/call', {
      name: 'claim_task',
      arguments: { task_id: 'task-1', request_id: requestId },
    });
    expect(response.result?.isError).toBe(true);
    expect(response.result?.structuredContent).toMatchObject({ ok: false, error: { code: 'TASK_CLAIMED' } });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [, init] = fetchMock.mock.calls[0]!;
    expect(new Headers(init?.headers).get('Idempotency-Key')).toBe(requestId);
    expect(JSON.parse(String(init?.body))).toEqual({ workspace_id: 'workspace-a', agent_id: 'codex', knowledge_enabled: false });
  });

  it('deletes a task through DELETE without an idempotency key', async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => new Response(null, { status: 204 }));
    const harness = createHarness(baseConfig, fetchMock as typeof fetch);
    harnesses.push(harness);
    await harness.start();
    const response = await harness.request('tools/call', { name: 'delete_task', arguments: { task_id: 'task-1' } });
    expect(response.result?.isError).not.toBe(true);
    expect(response.result?.structuredContent).toMatchObject({ ok: true, data: { deleted: true, task_id: 'task-1' } });
    const [input, init] = fetchMock.mock.calls[0]!;
    expect(String(input)).toBe('http://127.0.0.1:8787/api/issues/task-1');
    expect(init?.method).toBe('DELETE');
    expect(init?.body).toBeUndefined();
    expect(new Headers(init?.headers).get('Idempotency-Key')).toBeNull();
  });

  it('surfaces delete conflicts as isError without retrying', async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
      Response.json({ error: { code: 'CONFLICT', message: '占用中禁止删除' } }, { status: 409 }));
    const harness = createHarness(baseConfig, fetchMock as typeof fetch);
    harnesses.push(harness);
    await harness.start();
    const response = await harness.request('tools/call', { name: 'delete_task', arguments: { task_id: 'task-1' } });
    expect(response.result?.isError).toBe(true);
    expect(response.result?.structuredContent).toMatchObject({ ok: false, error: { code: 'TASK_CONFLICT' } });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('preserves only the numeric task CAS revision metadata', async () => {
    const fetcher = vi.fn(async () => Response.json({ error: {
      code: 'TASK_REVISION_CONFLICT',
      details: { current_updated_at: 42, secret: 'private server detail' },
    } }, { status: 409 }));
    const harness = createHarness(baseConfig, fetcher as typeof fetch);
    harnesses.push(harness);
    await harness.start();
    const response = await harness.request('tools/call', {
      name: 'update_task',
      arguments: { task_id: 'task-1', expected_updated_at: 1, title: 'Update', request_id: '00000000-0000-4000-8000-000000000032' },
    });
    expect(response.result?.structuredContent).toMatchObject({ ok: false, error: { code: 'TASK_REVISION_CONFLICT', current_updated_at: 42 } });
    expect(JSON.stringify(response.result)).not.toContain('private server detail');
  });

  it('returns SERVER_UNREACHABLE when the loopback API is unavailable', async () => {
    const probe = await import('node:net').then(({ createServer }) => new Promise<number>((resolve) => {
      const server = createServer();
      server.listen(0, '127.0.0.1', () => {
        const port = (server.address() as AddressInfo).port;
        server.close(() => resolve(port));
      });
    }));
    const harness = createHarness({ ...baseConfig, baseUrl: `http://127.0.0.1:${probe}` });
    harnesses.push(harness);
    await harness.start();
    const response = await harness.request('tools/call', {
      name: 'list_workspaces',
      arguments: {},
    });
    expect(response.result?.isError).toBe(true);
    expect(response.result?.structuredContent).toMatchObject({ ok: false, error: { code: 'SERVER_UNREACHABLE' } });
    const mutation = await harness.request('tools/call', {
      name: 'claim_task',
      arguments: { task_id: 'task-1', request_id: '00000000-0000-4000-8000-000000000001' },
    });
    expect(mutation.result?.structuredContent).toMatchObject({ ok: false, error: { code: 'SERVER_UNREACHABLE' } });
  });

  it('pages task reads, preserves continuation offsets, and omits workspace paths', async () => {
    const calls: Array<{ url: URL; method: string }> = [];
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input));
      calls.push({ url, method: init?.method ?? 'GET' });
      if (url.pathname === '/api/workspaces') {
        return Response.json({ items: [{ id: 'workspace-a', name: 'A', path: 'C:\\private' }], next_offset: null });
      }
      if (url.pathname === '/api/issues') return Response.json({ items: [], next_offset: null });
      if (url.pathname === '/api/issues/task-1') {
        return Response.json({ id: 'task-1', workspace_id: 'workspace-a', description: 'window', description_truncated: true, next_description_offset_chars: 17 });
      }
      if (url.pathname === '/api/issues/task-1/comments') {
        return Response.json({ items: [{
          id: 'comment-1', author: 'agent:codex', ts: 1, snippet: 'note', has_more: true,
          attachments: [{ id: 'attachment-1', file_name: 'screen.png', mime_type: 'image/png', size_bytes: 64, url: '/api/issues/task-1/attachments/attachment-1' }],
        }], next_offset: 1 });
      }
      return Response.json({
        id: 'comment-1', issue_id: 'task-1', author: 'agent:codex', ts: 1, content: 'body',
        attachments: [{ id: 'attachment-1', file_name: 'screen.png', mime_type: 'image/png', size_bytes: 64, url: '/api/issues/task-1/attachments/attachment-1' }],
        truncated: true, next_offset_chars: 700, next_content_offset_chars: 700,
      });
    }) as typeof fetch;
    const harness = createHarness(baseConfig, fetchMock);
    harnesses.push(harness);
    await harness.start();

    const workspaces = (await harness.request('tools/call', { name: 'list_workspaces', arguments: {} })).result?.structuredContent;
    expect(workspaces?.data.items).toEqual([{ id: 'workspace-a', name: 'A' }]);

    const tasks = (await harness.request('tools/call', { name: 'list_tasks', arguments: {} })).result?.structuredContent;
    expect(tasks?.data).toMatchObject({ items: [], next_offset: null, workspace_id: 'workspace-a' });
    expect(calls[1]?.url.searchParams.get('workspace')).toBe('workspace-a');
    expect(calls[1]?.url.searchParams.get('limit')).toBe('50');
    expect(calls[1]?.url.searchParams.get('offset')).toBe('0');
    // FETCHC-2：缺省收敛为「未完成 · 无主」，不叠加 status
    expect(calls[1]?.url.searchParams.get('kinds')).toBe('open,started,review,blocked');
    expect(calls[1]?.url.searchParams.get('unclaimed')).toBe('1');
    expect(calls[1]?.url.searchParams.has('status')).toBe(false);
    // PERF-4d：平铺列表走 fields= 白名单，且白名单里不含 description
    const requestedFields = calls[1]?.url.searchParams.get('fields')?.split(',') ?? [];
    expect(requestedFields).toContain('title');
    expect(requestedFields).not.toContain('description');

    const task = (await harness.request('tools/call', {
      name: 'get_task',
      arguments: { task_id: 'task-1', description_offset_chars: 12, description_max_chars: 5 },
    })).result?.structuredContent;
    expect(task?.data).toMatchObject({ description: 'window', description_truncated: true, next_description_offset_chars: 17 });
    expect(calls[2]?.url.searchParams.get('workspace_id')).toBe('workspace-a');
    expect(calls[2]?.url.searchParams.get('description_offset_chars')).toBe('12');
    expect(calls[2]?.url.searchParams.get('description_max_chars')).toBe('5');

    const comments = (await harness.request('tools/call', {
      name: 'get_task_comments',
      arguments: { task_id: 'task-1', limit: 1, offset: 0 },
    })).result?.structuredContent;
    expect(comments?.data.items[0]?.has_more).toBe(true);
    expect(comments?.data.items[0]?.attachments[0]).toMatchObject({ id: 'attachment-1', mime_type: 'image/png' });
    expect(calls[3]?.url.pathname).toBe('/api/issues/task-1/comments');
    expect(calls.some(({ url }) => url.pathname.endsWith('/comments/consume'))).toBe(false);

    const comment = (await harness.request('tools/call', {
      name: 'get_task_comment',
      arguments: { task_id: 'task-1', comment_id: 'comment-1', content_offset_chars: 500, content_max_chars: 200 },
    })).result?.structuredContent;
    expect(comment?.data).toMatchObject({ content: 'body', truncated: true, next_content_offset_chars: 700 });
    expect(comment?.data.attachments[0]).toMatchObject({ id: 'attachment-1', file_name: 'screen.png' });
    expect(calls[4]?.url.searchParams.get('content_offset_chars')).toBe('500');
    expect(calls[4]?.url.searchParams.get('content_max_chars')).toBe('200');
  });

  it('routes every task mutation through one idempotency key and the configured audit label', async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => Response.json({ id: 'task-1' }));
    const harness = createHarness(baseConfig, fetchMock as typeof fetch);
    harnesses.push(harness);
    await harness.start();
    const requestIds = Array.from({ length: 7 }, (_, index) => `00000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`);
    const calls = [
      ['create_task', { title: 'New task', description: '正文与验收', request_id: requestIds[0] }],
      ['update_task', { task_id: 'task-1', expected_updated_at: 123, title: 'Updated', request_id: requestIds[1] }],
      ['claim_task', { task_id: 'task-1', request_id: requestIds[2] }],
      ['release_task', { task_id: 'task-1', request_id: requestIds[3] }],
      ['add_task_comment', { task_id: 'task-1', content: 'note', request_id: requestIds[4] }],
      ['complete_task', { task_id: 'task-1', request_id: requestIds[5] }],
      ['fail_task', { task_id: 'task-1', reason: 'blocked', request_id: requestIds[6] }],
    ] as const;
    for (const [name, args] of calls) {
      const response = await harness.request('tools/call', { name, arguments: args });
      expect(response.result?.isError).not.toBe(true);
    }
    expect(fetchMock).toHaveBeenCalledTimes(7);
    const requests = fetchMock.mock.calls.map(([input, init]) => ({ url: String(input), init }));
    for (const [index, request] of requests.entries()) {
      expect(new Headers(request.init?.headers).get('Idempotency-Key')).toBe(requestIds[index]);
    }
    expect(JSON.parse(String(requests[0]?.init?.body))).toMatchObject({ workspace_id: 'workspace-a', agent_id: 'codex', title: 'New task', description: '正文与验收', priority: '中', labels: [] });
    expect(JSON.parse(String(requests[1]?.init?.body))).toMatchObject({ workspace_id: 'workspace-a', agent_id: 'codex', expected_updated_at: 123, title: 'Updated' });
    expect(JSON.parse(String(requests[2]?.init?.body))).toMatchObject({ workspace_id: 'workspace-a', agent_id: 'codex', knowledge_enabled: false });
    expect(requests.map(({ url }) => new URL(url).pathname)).toEqual([
      '/api/issues',
      '/api/issues/task-1',
      '/api/issues/task-1/claim',
      '/api/issues/task-1/release',
      '/api/issues/task-1/comments',
      '/api/issues/task-1/done',
      '/api/issues/task-1/fail',
    ]);
  });

  it('requires explicit workspace scope when unbound and an audit label before writes', async () => {
    const fetcher = vi.fn() as unknown as typeof fetch;
    const unbound = createHarness({ baseUrl: 'http://127.0.0.1:8787', agentId: 'codex' }, fetcher);
    harnesses.push(unbound);
    await unbound.start();
    const missingWorkspace = await unbound.request('tools/call', { name: 'list_tasks', arguments: {} });
    expect(missingWorkspace.result?.structuredContent).toMatchObject({ ok: false, error: { code: 'WORKSPACE_REQUIRED' } });

    const noAgent = createHarness({ baseUrl: 'http://127.0.0.1:8787', workspaceId: 'workspace-a' }, fetcher);
    harnesses.push(noAgent);
    await noAgent.start();
    const missingAgent = await noAgent.request('tools/call', {
      name: 'create_task',
      arguments: { title: 'No actor', request_id: '00000000-0000-4000-8000-000000000099' },
    });
    expect(missingAgent.result?.structuredContent).toMatchObject({ ok: false, error: { code: 'AGENT_ID_REQUIRED' } });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('keeps one deadline through response body reads and reports a sent mutation as unknown', async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => new Response(new ReadableStream({
      start(controller) {
        init?.signal?.addEventListener('abort', () => controller.error(new DOMException('aborted', 'AbortError')), { once: true });
      },
    }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
    const api = new AgentBoardApiClient(baseConfig, fetchMock as typeof fetch);
    vi.useFakeTimers();
    try {
      const pending = api.mutate('POST', '/issues', { workspace_id: 'workspace-a' }, '00000000-0000-4000-8000-000000000002');
      const rejection = expect(pending).rejects.toMatchObject({ code: 'OPERATION_UNKNOWN', operationState: 'unknown' });
      await vi.advanceTimersByTimeAsync(10_000);
      await rejection;
      expect(fetchMock).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('treats a mutation connection reset as unknown and does not retry', async () => {
    const reset = new TypeError('fetch failed') as TypeError & { cause: Error & { code: string } };
    reset.cause = Object.assign(new Error('connection reset'), { code: 'ECONNRESET' });
    const fetchMock = vi.fn(async () => { throw reset; });
    const api = new AgentBoardApiClient(baseConfig, fetchMock as typeof fetch);
    await expect(api.mutate('POST', '/issues', { workspace_id: 'workspace-a' }, '00000000-0000-4000-8000-000000000003'))
      .rejects.toMatchObject({ code: 'OPERATION_UNKNOWN', operationState: 'unknown' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('keeps task mutation receipts compact while detail reads keep full windows', async () => {
    const longBody = '🙂'.repeat(12005);
    const issue = { id: 'task-1', workspace_id: 'workspace-a', title: 'Long', description: longBody, status: '待规划', updated_at: 1 };
    const comment = { id: 'comment-1', issue_id: 'task-1', author: 'agent:codex', ts: 1, content: longBody };
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = new URL(String(input)).pathname;
      if (path.endsWith('/comments') && init?.method === 'POST') return Response.json({ comment, woke: false });
      if (path.endsWith('/done')) return Response.json({ ...issue, comment });
      return Response.json(issue);
    });
    const harness = createHarness(baseConfig, fetchMock as typeof fetch);
    harnesses.push(harness);
    await harness.start();

    const created = (await harness.request('tools/call', {
      name: 'create_task',
      arguments: { title: 'Long', description: '长正文测试', request_id: '00000000-0000-4000-8000-000000000010' },
    })).result?.structuredContent?.data;
    expect(created).toMatchObject({ id: 'task-1', status: '待规划' });
    expect(created).not.toHaveProperty('description');

    const added = (await harness.request('tools/call', {
      name: 'add_task_comment',
      arguments: { task_id: 'task-1', content: longBody, request_id: '00000000-0000-4000-8000-000000000011' },
    })).result?.structuredContent?.data;
    expect(Array.from(added.comment.content)).toHaveLength(12000);
    expect(added.comment).toMatchObject({ truncated: true, next_content_offset_chars: 12000 });

    const completed = (await harness.request('tools/call', {
      name: 'complete_task',
      arguments: { task_id: 'task-1', request_id: '00000000-0000-4000-8000-000000000012' },
    })).result?.structuredContent?.data;
    expect(Array.from(completed.comment.content)).toHaveLength(12000);
    expect(completed.comment.next_content_offset_chars).toBeNull();
  });

  it('start_task claims atomically and returns a bounded work package', async () => {
    const requests: Array<{ path: string; method: string; query: URLSearchParams; body: any; fence: string | null }> = [];
    const task = {
      id: FULL_TASK_ID, workspace_id: 'workspace-a', title: 'Task', description: 'body', priority: '高', labels: ['cli'],
      status: '进行中', parent_issue_id: null, claimed_by: 'codex', claimed_at: 1, comment_count: 7,
      blocked_by_count: 1, blocked_by_open_count: 0, decision_locked: false, open_decision_id: null,
      updated_at: 2, description_truncated: false, next_description_offset_chars: null,
    };
    const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input));
      requests.push({
        path: url.pathname, method: init?.method ?? 'GET', query: url.searchParams,
        body: init?.body === undefined ? null : JSON.parse(String(init.body)),
        fence: new Headers(init?.headers).get('x-claim-fence'),
      });
      if (url.pathname.endsWith('/claim')) return Response.json({ ...task, claim_fence: 12 });
      if (url.pathname === `/api/issues/${FULL_TASK_ID}`) return Response.json(task);
      if (url.pathname.endsWith('/dependencies')) return Response.json({
        blockers: [{ issue_id: 'blocker-1', title: 'Done blocker', status: '待验收', resolved: true }], blocked: [],
      });
      if (url.pathname.endsWith('/comments')) return Response.json({
        items: [{ id: 'c1', author: 'agent:codex', ts: 1, snippet: 'note', has_more: false }], next_offset: null,
      });
      return Response.json({ error: { code: 'NOT_FOUND' } }, { status: 404 });
    }) as typeof fetch;
    const harness = createHarness(baseConfig, fetcher);
    harnesses.push(harness);
    await harness.start();

    const result = (await harness.request('tools/call', {
      name: 'start_task',
      arguments: { task_id: FULL_TASK_ID, comments: 2, request_id: '00000000-0000-4000-8000-000000000401' },
    })).result;
    expect(result?.isError).toBeFalsy();
    expect(result?.structuredContent?.data).toMatchObject({
      issue: { id: FULL_TASK_ID, status: '进行中', claimed_by: 'codex' },
      description: 'body',
      claim_fence: 12,
      blockers: [{ issue_id: 'blocker-1', resolved: true }],
    });
    expect(requests[0]).toMatchObject({
      path: `/api/issues/${FULL_TASK_ID}/claim`, method: 'POST',
      body: { workspace_id: 'workspace-a', agent_id: 'codex', knowledge_enabled: false },
    });
    expect(requests[1]?.query.get('description_max_chars')).toBe('12000');
    expect(requests[3]?.query.get('offset')).toBe('5');
    expect(requests[3]?.query.get('limit')).toBe('2');
  });

  it('start_task preserves claim conflicts as a structured error without post-claim reads', async () => {
    const calls: string[] = [];
    const fetcher = vi.fn(async (input: RequestInfo | URL) => {
      const path = new URL(String(input)).pathname;
      calls.push(path);
      if (path.endsWith('/claim')) return Response.json({ error: { code: 'ISSUE_CLAIMED' } }, { status: 409 });
      return Response.json({ id: 'task-1' });
    }) as typeof fetch;
    const harness = createHarness(baseConfig, fetcher);
    harnesses.push(harness);
    await harness.start();
    const response = await harness.request('tools/call', {
      name: 'start_task',
      arguments: { task_id: FULL_TASK_ID, request_id: '00000000-0000-4000-8000-000000000402' },
    });
    expect(response.result?.isError).toBe(true);
    expect(response.result?.structuredContent).toMatchObject({ ok: false, error: { code: 'ISSUE_CLAIMED' } });
    expect(calls).toEqual([`/api/issues/${FULL_TASK_ID}/claim`]);
  });

  it('finish_task creates an attributed changelog then completes with fence and scope', async () => {
    const calls: Array<{ path: string; body: any; requestId: string | null; fence: string | null }> = [];
    const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = new URL(String(input)).pathname;
      calls.push({
        path,
        body: init?.body === undefined ? null : JSON.parse(String(init.body)),
        requestId: new Headers(init?.headers).get('Idempotency-Key'),
        fence: new Headers(init?.headers).get('x-claim-fence'),
      });
      if (path.endsWith('/changelog')) return Response.json({ id: 'log-1', title: 'Done', body_md: 'Body' }, { status: 201 });
      return Response.json({
        id: FULL_TASK_ID, workspace_id: 'workspace-a', title: 'Task', status: '待验收', priority: '高', labels: [],
        claimed_by: null, comment: null, knowledge_hint: null, updated_at: 3,
        git_commit: { status: 'committed', reason: null, note: null, pending: [] },
      });
    }) as typeof fetch;
    const harness = createHarness(baseConfig, fetcher);
    harnesses.push(harness);
    await harness.start();
    const requestId = '00000000-0000-4000-8000-000000000403';
    const result = (await harness.request('tools/call', {
      name: 'finish_task',
      arguments: {
        task_id: FULL_TASK_ID, notes: 'verified', scope: ['apps/mcp/src'], changelog_title: 'MCP tools',
        change_type: '调整', request_id: requestId, fence: 9,
      },
    })).result;
    expect(result?.isError).toBeFalsy();
    expect(result?.structuredContent?.data).toMatchObject({
      issue: { id: FULL_TASK_ID, status: '待验收' },
      changelog_id: 'log-1',
      git_commit: { status: 'committed' },
    });
    expect(calls[0]).toMatchObject({
      path: '/api/workspaces/workspace-a/changelog',
      body: { title: 'MCP tools', body_md: 'verified', change_type: '调整', actor: 'codex', issue_id: FULL_TASK_ID },
      fence: null,
    });
    expect(calls[0]?.requestId).toMatch(/^[0-9a-f-]{36}$/);
    expect(calls[1]).toMatchObject({
      path: `/api/issues/${FULL_TASK_ID}/done`, requestId, fence: '9',
      body: {
        workspace_id: 'workspace-a', agent_id: 'codex', scope_paths: ['apps/mcp/src'],
        client: 'mcp', changelog_ack: false, changelog_id: 'log-1',
      },
    });
    expect(calls[1]?.body.notes).toContain('close-record: changelog=log-1');
  });

  it('finish_task defaults an empty changelog body to non-empty text', async () => {
    const calls: Array<{ path: string; body: any }> = [];
    const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = new URL(String(input)).pathname;
      calls.push({ path, body: JSON.parse(String(init?.body)) });
      if (path.endsWith('/changelog')) return Response.json({ id: 'log-default' }, { status: 201 });
      return Response.json({
        id: FULL_TASK_ID, workspace_id: 'workspace-a', status: '待验收', priority: '中', labels: [],
        claimed_by: null, git_commit: null, knowledge_hint: null,
      });
    }) as typeof fetch;
    const harness = createHarness(baseConfig, fetcher);
    harnesses.push(harness);
    await harness.start();

    const result = (await harness.request('tools/call', {
      name: 'finish_task',
      arguments: {
        task_id: FULL_TASK_ID, changelog_title: 'Default body',
        request_id: '00000000-0000-4000-8000-000000000406',
      },
    })).result;
    expect(result?.isError).toBeFalsy();
    expect(calls[0]?.body.body_md).toBe('本轮无用户可见变更');
    expect(calls[1]).toMatchObject({
      path: `/api/issues/${FULL_TASK_ID}/done`,
      body: { changelog_id: 'log-default' },
    });
  });

  it('finish_task preserves the changelog gate error without pretending the task completed', async () => {
    const fetcher = vi.fn(async (input: RequestInfo | URL) => {
      const path = new URL(String(input)).pathname;
      if (path.endsWith('/changelog')) return Response.json({ id: 'log-1' }, { status: 201 });
      return Response.json({ error: { code: 'CHANGELOG_ACK_REQUIRED' } }, { status: 400 });
    }) as typeof fetch;
    const harness = createHarness(baseConfig, fetcher);
    harnesses.push(harness);
    await harness.start();
    const response = await harness.request('tools/call', {
      name: 'finish_task',
      arguments: { task_id: FULL_TASK_ID, changelog_title: 'Done', request_id: '00000000-0000-4000-8000-000000000404' },
    });
    expect(response.result?.isError).toBe(true);
    expect(response.result?.structuredContent).toMatchObject({ ok: false, error: { code: 'CHANGELOG_ACK_REQUIRED' } });
  });

  it('finish_task no_changelog skips the changelog write and uses the board snapshot', async () => {
    const calls: Array<{ path: string; body: any }> = [];
    const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ path: new URL(String(input)).pathname, body: JSON.parse(String(init?.body)) });
      return Response.json({ id: FULL_TASK_ID, workspace_id: 'workspace-a', status: '待验收', labels: [], priority: '中' });
    }) as typeof fetch;
    const harness = createHarness(baseConfig, fetcher);
    harnesses.push(harness);
    await harness.start();
    const result = (await harness.request('tools/call', {
      name: 'finish_task',
      arguments: {
        task_id: FULL_TASK_ID, no_changelog: true, board_only: true,
        request_id: '00000000-0000-4000-8000-000000000405',
      },
    })).result;
    expect(result?.isError).toBeFalsy();
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      path: `/api/issues/${FULL_TASK_ID}/done`,
      body: {
        changelog_ack: true,
        scope_paths: ['.agentboard/snapshot', '.agentboard/.gitignore', '.agentboard/README.md'],
      },
    });
  });

  it('lists a task-tree child page through the scoped tree endpoint', async () => {
    const child = {
      id: 'child-1', workspace_id: 'workspace-a', title: 'Child', description: '', priority: '中', labels: [],
      status: '待规划', sort_order: 1, parent_issue_id: 'root-1', claimed_by: null, claimed_at: null,
      session_id: null, comment_count: 0, created_at: 1, updated_at: 1,
      child_count: 1, descendant_count: 2, descendants_closed_count: 1,
    };
    const fetcher = vi.fn(async () => Response.json({ items: [child], ancestors: [], next_cursor: 'next' }));
    const harness = createHarness(baseConfig, fetcher as typeof fetch);
    harnesses.push(harness);
    await harness.start();
    const response = await harness.request('tools/call', {
      name: 'list_tasks',
      arguments: { tree: true, parent_issue_id: 'root-1', limit: 10 },
    });
    expect(response.result?.structuredContent).toMatchObject({ ok: true, data: { items: [{ id: 'child-1', title: 'Child' }], next_cursor: 'next', workspace_id: 'workspace-a' } });
    expect(response.result?.structuredContent?.data.items[0]).toMatchObject({
      child_count: 1, descendant_count: 2, descendants_closed_count: 1,
    });
    // PERF-4d：树列表同样剔除正文（树端点无 fields=，在 MCP 侧裁剪）
    expect(response.result?.structuredContent?.data.items[0]).not.toHaveProperty('description');
    expect(String(fetcher.mock.calls[0]?.[0])).toContain('/api/issues/tree?');
    const url = new URL(String(fetcher.mock.calls[0]?.[0]));
    expect(url.searchParams.get('parent_issue_id')).toBe('root-1');
    expect(url.searchParams.get('workspace')).toBe('workspace-a');
    // FETCHC-2 的收敛参数只作用于平铺列表，树端点不带
    expect(url.searchParams.has('kinds')).toBe(false);
    expect(url.searchParams.has('unclaimed')).toBe(false);
  });

  it('list_tasks 拒绝在树模式下混用收敛参数（避免静默忽略）', async () => {
    const fetcher = vi.fn() as unknown as typeof fetch;
    const harness = createHarness(baseConfig, fetcher);
    harnesses.push(harness);
    await harness.start();
    const response = await harness.request('tools/call', {
      name: 'list_tasks',
      arguments: { tree: true, kinds: ['open'], unclaimed: true },
    });
    expect(response.result?.isError).toBe(true);
    expect(fetcher).not.toHaveBeenCalled();
  });

  // PERF-4d（用户拍板选项 A）：列表不含正文、get_task 含正文，对偶断言
  it('omits descriptions from task listings while get_task keeps them', async () => {
    const task = {
      id: 'task-1', workspace_id: 'workspace-a', title: 'Task', description: '正文', priority: '中', labels: [],
      status: '待规划', sort_order: 1, comment_count: 0, created_at: 1, updated_at: 1,
      description_truncated: true, next_description_offset_chars: 2,
    };
    const fetcher = vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input));
      // 模拟服务端仍回正文（例如旧服务端忽略 fields=），MCP 侧必须自行剔除
      if (url.pathname === '/api/issues') return Response.json({ items: [task], next_offset: null });
      return Response.json(task);
    });
    const harness = createHarness(baseConfig, fetcher as typeof fetch);
    harnesses.push(harness);
    await harness.start();

    const listed = (await harness.request('tools/call', { name: 'list_tasks', arguments: {} })).result?.structuredContent?.data;
    expect(listed.items[0]).toMatchObject({ id: 'task-1', title: 'Task' });
    expect(listed.items[0]).not.toHaveProperty('description');
    expect(listed.items[0]).not.toHaveProperty('description_truncated');
    expect(listed.items[0]).not.toHaveProperty('next_description_offset_chars');

    const read = (await harness.request('tools/call', {
      name: 'get_task',
      arguments: { task_id: 'task-1' },
    })).result?.structuredContent?.data;
    expect(read).toMatchObject({ id: 'task-1', description: '正文' });
  });

  // FETCHC-2：缺省收敛为「未完成 · 无主」；all_status 退回改前的全量行为；显式 status 不叠加推导过滤
  it('list_tasks 缺省只取未完成无主卡，all_status 与显式 status 各自退回', async () => {
    const calls: URL[] = [];

    for (const [label, args] of [
      ['default', {}],
      ['all_status', { all_status: true }],
      ['status', { status: '进行中' }],
    ] as const) {
      calls.length = 0;
      const fetcher = vi.fn(async (input: RequestInfo | URL) => {
        calls.push(new URL(String(input)));
        return Response.json({ items: [], next_offset: null });
      });
      const harness = createHarness(baseConfig, fetcher as typeof fetch);
      harnesses.push(harness);
      await harness.start();
      const response = await harness.request('tools/call', { name: 'list_tasks', arguments: args });
      expect(response.result?.isError, label).not.toBe(true);
      expect(calls, label).toHaveLength(1);

      const sent = calls[0]!;
      if (label === 'default') {
        expect(sent.searchParams.get('kinds')).toBe('open,started,review,blocked');
        expect(sent.searchParams.get('unclaimed')).toBe('1');
        expect(sent.searchParams.has('status')).toBe(false);
      }
      if (label === 'all_status') {
        expect(sent.searchParams.has('kinds')).toBe(false);
        expect(sent.searchParams.has('unclaimed')).toBe(false);
        expect(sent.searchParams.has('status')).toBe(false);
      }
      if (label === 'status') {
        expect(sent.searchParams.get('status')).toBe('进行中');
        expect(sent.searchParams.has('unclaimed')).toBe(false);
        expect(sent.searchParams.has('kinds')).toBe(false);
      }
    }
  });

  it('list_tasks 显式 kinds / unclaimed=false 覆盖缺省值', async () => {
    const calls: URL[] = [];
    const fetcher = vi.fn(async (input: RequestInfo | URL) => {
      calls.push(new URL(String(input)));
      return Response.json({ items: [], next_offset: null });
    });
    const harness = createHarness(baseConfig, fetcher as typeof fetch);
    harnesses.push(harness);
    await harness.start();

    await harness.request('tools/call', { name: 'list_tasks', arguments: { kinds: ['review'], unclaimed: false } });
    expect(calls[0]?.searchParams.get('kinds')).toBe('review');
    expect(calls[0]?.searchParams.has('unclaimed')).toBe(false);

    await harness.request('tools/call', { name: 'list_tasks', arguments: { unfinished: false } });
    expect(calls[1]?.searchParams.has('kinds')).toBe(false);
    expect(calls[1]?.searchParams.has('unclaimed')).toBe(false);
  });

  it('falls back to an unfiltered request when the server rejects fields= and still omits descriptions', async () => {
    const calls: URL[] = [];
    const fetcher = vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input));
      calls.push(url);
      if (url.searchParams.has('fields')) {
        return Response.json({ error: { code: 'VALIDATION_ERROR', message: 'fields 含未知字段' } }, { status: 400 });
      }
      return Response.json({ items: [{ id: 'task-1', title: 'Task', description: '旧服务端正文' }], next_offset: null });
    });
    const harness = createHarness(baseConfig, fetcher as typeof fetch);
    harnesses.push(harness);
    await harness.start();

    const listed = (await harness.request('tools/call', { name: 'list_tasks', arguments: {} })).result?.structuredContent?.data;
    expect(listed.items[0]).toMatchObject({ id: 'task-1', title: 'Task' });
    expect(listed.items[0]).not.toHaveProperty('description');
    expect(calls).toHaveLength(2);
    expect(calls[0]?.searchParams.has('fields')).toBe(true);
    expect(calls[1]?.searchParams.has('fields')).toBe(false);
  });

  it('passes parent fields through MCP task create and update mutations', async () => {
    const fetcher = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => Response.json(JSON.parse(String(init?.body))));
    const harness = createHarness(baseConfig, fetcher as typeof fetch);
    harnesses.push(harness);
    await harness.start();
    await harness.request('tools/call', {
      name: 'create_task',
      arguments: { title: 'Child', description: '子卡正文', parent_issue_id: 'parent-1', request_id: '00000000-0000-4000-8000-000000000101' },
    });
    await harness.request('tools/call', {
      name: 'update_task',
      arguments: { task_id: 'child-1', expected_updated_at: 1, parent_issue_id: null, request_id: '00000000-0000-4000-8000-000000000102' },
    });
    expect(JSON.parse(String(fetcher.mock.calls[0]?.[1]?.body))).toMatchObject({ parent_issue_id: 'parent-1' });
    expect(JSON.parse(String(fetcher.mock.calls[1]?.[1]?.body))).toMatchObject({ parent_issue_id: null });
  });

  // BORROW-0.3：收尾工具的 fence 走 x-claim-fence 头透传；旧 fence 错误映射 STALE_FENCE 安全文案
  it('passes the occupancy fence as the x-claim-fence header and maps STALE_FENCE', async () => {
    const fetcher = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => Response.json({ id: 'task-1', status: '待验收' }));
    const harness = createHarness(baseConfig, fetcher as typeof fetch);
    harnesses.push(harness);
    await harness.start();
    const response = await harness.request('tools/call', {
      name: 'complete_task',
      arguments: { task_id: 'task-1', notes: '', request_id: '00000000-0000-4000-8000-000000000201', fence: 5 },
    });
    expect(response.result?.structuredContent).toMatchObject({ ok: true });
    const headers = new Headers((fetcher.mock.calls[0]?.[1] as RequestInit | undefined)?.headers);
    expect(headers.get('x-claim-fence')).toBe('5');
  });

  it('omits the x-claim-fence header when fence is absent (soft mode)', async () => {
    const fetcher = vi.fn(async () => Response.json({ id: 'task-1', status: '待验收' }));
    const harness = createHarness(baseConfig, fetcher as typeof fetch);
    harnesses.push(harness);
    await harness.start();
    await harness.request('tools/call', {
      name: 'complete_task',
      arguments: { task_id: 'task-1', notes: '', request_id: '00000000-0000-4000-8000-000000000202' },
    });
    const headers = new Headers((fetcher.mock.calls[0]?.[1] as RequestInit | undefined)?.headers);
    expect(headers.get('x-claim-fence')).toBeNull();
  });

  it('forwards complete_task scope as scope_paths (N-01: no broad commit by default)', async () => {
    const fetcher = vi.fn(async () => Response.json({ id: 'task-1', status: '待验收' }));
    const harness = createHarness(baseConfig, fetcher as typeof fetch);
    harnesses.push(harness);
    await harness.start();
    await harness.request('tools/call', {
      name: 'complete_task',
      arguments: { task_id: 'task-1', notes: '', scope: ['apps/server/src', 'README.md'], request_id: '00000000-0000-4000-8000-000000000203' },
    });
    const body = JSON.parse(String((fetcher.mock.calls[0]?.[1] as RequestInit | undefined)?.body));
    expect(body.scope_paths).toEqual(['apps/server/src', 'README.md']);
    expect(body.scope_paths).not.toContain('.agentboard/snapshot');
  });

  it('complete_task sends changelog gate fields and defaults to the dashboard snapshot', async () => {
    const fetcher = vi.fn(async () => Response.json({ id: 'task-1', status: '待验收' }));
    const harness = createHarness(baseConfig, fetcher as typeof fetch);
    harnesses.push(harness);
    await harness.start();
    await harness.request('tools/call', {
      name: 'complete_task',
      arguments: { task_id: 'task-1', notes: '', request_id: '00000000-0000-4000-8000-000000000204' },
    });
    await harness.request('tools/call', {
      name: 'complete_task',
      arguments: { task_id: 'task-1', notes: '', skip_changelog: true, request_id: '00000000-0000-4000-8000-000000000205' },
    });
    const bodies = fetcher.mock.calls.map(([, init]) => JSON.parse(String((init as RequestInit | undefined)?.body)));
    expect(bodies[0]).toMatchObject({
      client: 'mcp',
      changelog_ack: false,
      scope_paths: ['.agentboard/snapshot', '.agentboard/.gitignore', '.agentboard/README.md'],
    });
    expect(bodies[1]).toMatchObject({ client: 'mcp', changelog_ack: true });
  });

  it('complete_task forwards changelog_id as the --close-record equivalent', async () => {
    const fetcher = vi.fn(async () => Response.json({ id: 'task-1', status: '待验收' }));
    const harness = createHarness(baseConfig, fetcher as typeof fetch);
    harnesses.push(harness);
    await harness.start();
    await harness.request('tools/call', {
      name: 'complete_task',
      arguments: {
        task_id: 'task-1', notes: '', changelog_id: '00000000-0000-4000-8000-000000000777',
        request_id: '00000000-0000-4000-8000-000000000207',
      },
    });
    const body = JSON.parse(String((fetcher.mock.calls[0]![1] as RequestInit | undefined)?.body));
    expect(body).toMatchObject({ client: 'mcp', changelog_ack: false, changelog_id: '00000000-0000-4000-8000-000000000777' });
  });

  it('complete_task maps board_only to the dashboard snapshot', async () => {
    const fetcher = vi.fn(async () => Response.json({ id: 'task-1', status: '待验收' }));
    const harness = createHarness(baseConfig, fetcher as typeof fetch);
    harnesses.push(harness);
    await harness.start();
    await harness.request('tools/call', {
      name: 'complete_task',
      arguments: {
        task_id: 'task-1', notes: '', board_only: true, skip_changelog: true,
        request_id: '00000000-0000-4000-8000-000000000208',
      },
    });
    const body = JSON.parse(String((fetcher.mock.calls[0]![1] as RequestInit | undefined)?.body));
    expect(body).toMatchObject({
      client: 'mcp',
      changelog_ack: true,
      scope_paths: ['.agentboard/snapshot', '.agentboard/.gitignore', '.agentboard/README.md'],
    });
    expect(body).not.toHaveProperty('board_only');
  });

  it('complete_task rejects board_only combined with scope (N4-04)', async () => {
    const fetcher = vi.fn(async () => Response.json({ id: 'task-1', status: '待验收' }));
    const harness = createHarness(baseConfig, fetcher as typeof fetch);
    harnesses.push(harness);
    await harness.start();
    const response = await harness.request('tools/call', {
      name: 'complete_task',
      arguments: {
        task_id: 'task-1', notes: '', board_only: true, scope: ['declared.txt'], skip_changelog: true,
        request_id: '00000000-0000-4000-8000-000000000209',
      },
    });
    expect(response.result?.isError).toBe(true);
    expect(response.result?.structuredContent).toMatchObject({ ok: false, error: { code: 'BOARD_ONLY_SCOPE_CONFLICT' } });
    expect(JSON.stringify(response.result?.content ?? '')).toContain('board_only 与 scope 不能同时使用');
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('maps CHANGELOG_ACK_REQUIRED to an actionable changelog message', async () => {
    const fetcher = vi.fn(async () => Response.json({ error: { code: 'CHANGELOG_ACK_REQUIRED', message: '变更日志门禁：…' } }, { status: 400 }));
    const harness = createHarness(baseConfig, fetcher as typeof fetch);
    harnesses.push(harness);
    await harness.start();
    const response = await harness.request('tools/call', {
      name: 'complete_task',
      arguments: { task_id: 'task-1', notes: '', request_id: '00000000-0000-4000-8000-000000000206' },
    });
    const text = JSON.stringify(response.result?.content ?? '');
    expect(text).toContain('Changelog gate');
    expect(text).toContain('skip_changelog=true');
    expect(text).not.toContain('变更日志门禁：');
  });

  it('maps a stale fence rejection to the safe STALE_FENCE message', async () => {
    const fetcher = vi.fn(async () => Response.json({ error: { code: 'STALE_FENCE', message: '占用代次已过期（请求 fence=1，当前=2）' } }, { status: 409 }));
    const harness = createHarness(baseConfig, fetcher as typeof fetch);
    harnesses.push(harness);
    await harness.start();
    const response = await harness.request('tools/call', {
      name: 'fail_task',
      arguments: { task_id: 'task-1', reason: 'blocked', request_id: '00000000-0000-4000-8000-000000000203', fence: 1 },
    });
    expect(response.result?.isError).toBe(true);
    expect(response.result?.structuredContent).toMatchObject({ ok: false, error: { code: 'STALE_FENCE' } });
    expect(JSON.stringify(response.result)).toContain('claim the task again');
    expect(JSON.stringify(response.result)).not.toContain('请求 fence=1');
  });

  it('closes and reopens a task through the lifecycle endpoints', async () => {
    const calls: Array<{ path: string; method: string; body: unknown; fence: string | null }> = [];
    const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = new URL(String(input)).pathname;
      calls.push({
        path,
        method: init?.method ?? 'GET',
        body: init?.body === undefined ? null : JSON.parse(String(init.body)),
        fence: new Headers(init?.headers).get('x-claim-fence'),
      });
      return Response.json({ id: 'task-1', status: path.endsWith('/close') ? '已关闭' : '待规划' });
    });
    const harness = createHarness(baseConfig, fetcher as typeof fetch);
    harnesses.push(harness);
    await harness.start();

    const closed = await harness.request('tools/call', {
      name: 'close_task',
      arguments: { task_id: 'task-1', request_id: '00000000-0000-4000-8000-000000000301', fence: 2 },
    });
    expect(closed.result?.isError).toBeFalsy();
    expect(closed.result?.structuredContent).toMatchObject({ ok: true, data: { status: '已关闭' } });

    const reopened = await harness.request('tools/call', {
      name: 'reopen_task',
      arguments: { task_id: 'task-1', status: '待规划', request_id: '00000000-0000-4000-8000-000000000302' },
    });
    expect(reopened.result?.isError).toBeFalsy();

    expect(calls).toEqual([
      { path: '/api/issues/task-1/close', method: 'POST', body: { workspace_id: 'workspace-a', agent_id: 'codex' }, fence: '2' },
      { path: '/api/issues/task-1/reopen', method: 'POST', body: { workspace_id: 'workspace-a', agent_id: 'codex', status: '待规划' }, fence: null },
    ]);
  });

  it('maps lifecycle conflicts to INVALID_TRANSITION without leaking server text', async () => {
    const fetcher = vi.fn(async () => Response.json({ error: { code: 'INVALID_TRANSITION', message: '只有「待验收」的任务可以关闭（当前：进行中）' } }, { status: 409 }));
    const harness = createHarness(baseConfig, fetcher as typeof fetch);
    harnesses.push(harness);
    await harness.start();
    const response = await harness.request('tools/call', {
      name: 'close_task',
      arguments: { task_id: 'task-1', request_id: '00000000-0000-4000-8000-000000000303' },
    });
    expect(response.result?.isError).toBe(true);
    expect(response.result?.structuredContent).toMatchObject({ ok: false, error: { code: 'INVALID_TRANSITION' } });
    expect(JSON.stringify(response.result)).not.toContain('当前：进行中');
  });

  it('accept_task 只在待验收卡上写结构化验收记录', async () => {
    const calls: Array<{ path: string; method: string; body: any }> = [];
    const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = new URL(String(input)).pathname;
      calls.push({ path, method: init?.method ?? 'GET', body: init?.body === undefined ? null : JSON.parse(String(init.body)) });
      if (path.endsWith('/comments')) {
        return Response.json({ comment: { id: 'comment-9', issue_id: 'task-1', author: 'agent:codex', ts: 1, content: 'x' }, woke: false });
      }
      return Response.json({ id: 'task-1', workspace_id: 'workspace-a', status: '待验收' });
    });
    const harness = createHarness(baseConfig, fetcher as typeof fetch);
    harnesses.push(harness);
    await harness.start();

    const accepted = await harness.request('tools/call', {
      name: 'accept_task',
      arguments: { task_id: 'task-1', verdict: 'pass', note: '自验通过', request_id: '00000000-0000-4000-8000-000000000304' },
    });
    expect(accepted.result?.isError).toBeFalsy();
    expect(accepted.result?.structuredContent).toMatchObject({ ok: true, data: { task_id: 'task-1', verdict: 'pass', reviewer: 'codex' } });

    const posted = calls.find((call) => call.method === 'POST')!;
    expect(posted.path).toBe('/api/issues/task-1/comments');
    expect(posted.body.content).toMatch(/^【验收记录】verdict=pass; reviewer=codex; at=\d{4}-\d{2}-\d{2}T/);
    expect(posted.body.content).toContain('自验通过');
    expect(posted.body.agent_id).toBe('codex');
  });

  it('accept_task 在非待验收卡上直接拒绝，不发写请求', async () => {
    const fetcher = vi.fn(async () => Response.json({ id: 'task-1', workspace_id: 'workspace-a', status: '进行中' }));
    const harness = createHarness(baseConfig, fetcher as typeof fetch);
    harnesses.push(harness);
    await harness.start();
    const response = await harness.request('tools/call', {
      name: 'accept_task',
      arguments: { task_id: 'task-1', request_id: '00000000-0000-4000-8000-000000000305' },
    });
    expect(response.result?.isError).toBe(true);
    expect(response.result?.structuredContent).toMatchObject({ ok: false, error: { code: 'ACCEPT_STATUS_NOT_ACCEPTABLE' } });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
});
