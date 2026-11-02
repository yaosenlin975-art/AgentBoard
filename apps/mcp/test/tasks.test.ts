import { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AgentBoardApiClient } from '../src/apiClient.js';
import { createHarness } from './helpers.js';

const baseConfig = { baseUrl: 'http://127.0.0.1:8787', workspaceId: 'workspace-a', agentId: 'codex' };

describe('AgentBoard task MCP server', () => {
  const harnesses: Array<ReturnType<typeof createHarness>> = [];
  afterEach(async () => {
    await Promise.all(harnesses.splice(0).map((harness) => harness.close()));
  });

  it('mcpTaskServerInitializesAndListsTools', async () => {
    const harness = createHarness(baseConfig);
    harnesses.push(harness);
    const initialized = await harness.start();
    expect(initialized.result?.protocolVersion).toBe('2025-11-25');
    const response = await harness.request('tools/list');
    expect(response.result?.tools.map((tool: { name: string }) => tool.name).sort()).toEqual([
      'agentboard_add_task_comment',
      'agentboard_archive_knowledge',
      'agentboard_claim_task',
      'agentboard_complete_task',
      'agentboard_create_knowledge',
      'agentboard_create_task',
      'agentboard_delete_task',
      'agentboard_fail_task',
      'agentboard_get_task',
      'agentboard_get_task_comment',
      'agentboard_get_task_comments',
      'agentboard_list_tasks',
      'agentboard_list_workspaces',
      'agentboard_read_knowledge',
      'agentboard_release_task',
      'agentboard_restore_knowledge',
      'agentboard_revise_knowledge',
      'agentboard_search_knowledge',
      'agentboard_update_task',
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
      name: 'agentboard_list_tasks',
      arguments: { limit: 101 },
    });
    expect(response.result?.isError).toBe(true);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('boundWorkspaceRejectsOverride', async () => {
    const fetcher = vi.fn() as unknown as typeof fetch;
    const harness = createHarness(baseConfig, fetcher);
    harnesses.push(harness);
    await harness.start();
    const response = await harness.request('tools/call', {
      name: 'agentboard_list_tasks',
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
      name: 'agentboard_claim_task',
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
    const response = await harness.request('tools/call', { name: 'agentboard_delete_task', arguments: { task_id: 'task-1' } });
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
    const response = await harness.request('tools/call', { name: 'agentboard_delete_task', arguments: { task_id: 'task-1' } });
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
      name: 'agentboard_update_task',
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
      name: 'agentboard_list_workspaces',
      arguments: {},
    });
    expect(response.result?.isError).toBe(true);
    expect(response.result?.structuredContent).toMatchObject({ ok: false, error: { code: 'SERVER_UNREACHABLE' } });
    const mutation = await harness.request('tools/call', {
      name: 'agentboard_claim_task',
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

    const workspaces = (await harness.request('tools/call', { name: 'agentboard_list_workspaces', arguments: {} })).result?.structuredContent;
    expect(workspaces?.data.items).toEqual([{ id: 'workspace-a', name: 'A' }]);

    const tasks = (await harness.request('tools/call', { name: 'agentboard_list_tasks', arguments: {} })).result?.structuredContent;
    expect(tasks?.data).toMatchObject({ items: [], next_offset: null, workspace_id: 'workspace-a' });
    expect(calls[1]?.url.searchParams.get('workspace')).toBe('workspace-a');
    expect(calls[1]?.url.searchParams.get('limit')).toBe('50');
    expect(calls[1]?.url.searchParams.get('offset')).toBe('0');

    const task = (await harness.request('tools/call', {
      name: 'agentboard_get_task',
      arguments: { task_id: 'task-1', description_offset_chars: 12, description_max_chars: 5 },
    })).result?.structuredContent;
    expect(task?.data).toMatchObject({ description: 'window', description_truncated: true, next_description_offset_chars: 17 });
    expect(calls[2]?.url.searchParams.get('workspace_id')).toBe('workspace-a');
    expect(calls[2]?.url.searchParams.get('description_offset_chars')).toBe('12');
    expect(calls[2]?.url.searchParams.get('description_max_chars')).toBe('5');

    const comments = (await harness.request('tools/call', {
      name: 'agentboard_get_task_comments',
      arguments: { task_id: 'task-1', limit: 1, offset: 0 },
    })).result?.structuredContent;
    expect(comments?.data.items[0]?.has_more).toBe(true);
    expect(comments?.data.items[0]?.attachments[0]).toMatchObject({ id: 'attachment-1', mime_type: 'image/png' });
    expect(calls[3]?.url.pathname).toBe('/api/issues/task-1/comments');
    expect(calls.some(({ url }) => url.pathname.endsWith('/comments/consume'))).toBe(false);

    const comment = (await harness.request('tools/call', {
      name: 'agentboard_get_task_comment',
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
      ['agentboard_create_task', { title: 'New task', request_id: requestIds[0] }],
      ['agentboard_update_task', { task_id: 'task-1', expected_updated_at: 123, title: 'Updated', request_id: requestIds[1] }],
      ['agentboard_claim_task', { task_id: 'task-1', request_id: requestIds[2] }],
      ['agentboard_release_task', { task_id: 'task-1', request_id: requestIds[3] }],
      ['agentboard_add_task_comment', { task_id: 'task-1', content: 'note', request_id: requestIds[4] }],
      ['agentboard_complete_task', { task_id: 'task-1', request_id: requestIds[5] }],
      ['agentboard_fail_task', { task_id: 'task-1', reason: 'blocked', request_id: requestIds[6] }],
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
    expect(JSON.parse(String(requests[0]?.init?.body))).toMatchObject({ workspace_id: 'workspace-a', agent_id: 'codex', title: 'New task', description: '', priority: '中', labels: [] });
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
    const missingWorkspace = await unbound.request('tools/call', { name: 'agentboard_list_tasks', arguments: {} });
    expect(missingWorkspace.result?.structuredContent).toMatchObject({ ok: false, error: { code: 'WORKSPACE_REQUIRED' } });

    const noAgent = createHarness({ baseUrl: 'http://127.0.0.1:8787', workspaceId: 'workspace-a' }, fetcher);
    harnesses.push(noAgent);
    await noAgent.start();
    const missingAgent = await noAgent.request('tools/call', {
      name: 'agentboard_create_task',
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

  it('bounds mutation result bodies and returns offsets for the matching read tools', async () => {
    const longBody = '🙂'.repeat(12005);
    const issue = { id: 'task-1', workspace_id: 'workspace-a', title: 'Long', description: longBody, updated_at: 1 };
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
      name: 'agentboard_create_task',
      arguments: { title: 'Long', request_id: '00000000-0000-4000-8000-000000000010' },
    })).result?.structuredContent?.data;
    expect(Array.from(created.description)).toHaveLength(12000);
    expect(created).toMatchObject({ description_truncated: true, next_description_offset_chars: 12000 });

    const added = (await harness.request('tools/call', {
      name: 'agentboard_add_task_comment',
      arguments: { task_id: 'task-1', content: longBody, request_id: '00000000-0000-4000-8000-000000000011' },
    })).result?.structuredContent?.data;
    expect(Array.from(added.comment.content)).toHaveLength(12000);
    expect(added.comment).toMatchObject({ truncated: true, next_content_offset_chars: 12000 });

    const completed = (await harness.request('tools/call', {
      name: 'agentboard_complete_task',
      arguments: { task_id: 'task-1', request_id: '00000000-0000-4000-8000-000000000012' },
    })).result?.structuredContent?.data;
    expect(Array.from(completed.description)).toHaveLength(12000);
    expect(Array.from(completed.comment.content)).toHaveLength(12000);
    expect(completed.comment.next_content_offset_chars).toBe(12000);
  });

  it('lists a task-tree child page through the scoped tree endpoint', async () => {
    const child = {
      id: 'child-1', workspace_id: 'workspace-a', title: 'Child', description: '', priority: '中', labels: [],
      status: '待规划', sort_order: 1, parent_issue_id: 'root-1', claimed_by: null, claimed_at: null,
      session_id: null, comment_count: 0, created_at: 1, updated_at: 1,
      child_count: 0, descendant_count: 0, descendants_closed_count: 0,
    };
    const fetcher = vi.fn(async () => Response.json({ items: [child], ancestors: [], next_cursor: 'next' }));
    const harness = createHarness(baseConfig, fetcher as typeof fetch);
    harnesses.push(harness);
    await harness.start();
    const response = await harness.request('tools/call', {
      name: 'agentboard_list_tasks',
      arguments: { tree: true, parent_issue_id: 'root-1', limit: 10 },
    });
    expect(response.result?.structuredContent).toMatchObject({ ok: true, data: { items: [child], next_cursor: 'next', workspace_id: 'workspace-a' } });
    expect(String(fetcher.mock.calls[0]?.[0])).toContain('/api/issues/tree?');
    const url = new URL(String(fetcher.mock.calls[0]?.[0]));
    expect(url.searchParams.get('parent_issue_id')).toBe('root-1');
    expect(url.searchParams.get('workspace')).toBe('workspace-a');
  });

  it('passes parent fields through MCP task create and update mutations', async () => {
    const fetcher = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => Response.json(JSON.parse(String(init?.body))));
    const harness = createHarness(baseConfig, fetcher as typeof fetch);
    harnesses.push(harness);
    await harness.start();
    await harness.request('tools/call', {
      name: 'agentboard_create_task',
      arguments: { title: 'Child', parent_issue_id: 'parent-1', request_id: '00000000-0000-4000-8000-000000000101' },
    });
    await harness.request('tools/call', {
      name: 'agentboard_update_task',
      arguments: { task_id: 'child-1', expected_updated_at: 1, parent_issue_id: null, request_id: '00000000-0000-4000-8000-000000000102' },
    });
    expect(JSON.parse(String(fetcher.mock.calls[0]?.[1]?.body))).toMatchObject({ parent_issue_id: 'parent-1' });
    expect(JSON.parse(String(fetcher.mock.calls[1]?.[1]?.body))).toMatchObject({ parent_issue_id: null });
  });
});
