import { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AgentBoardApiClient } from '../src/apiClient.js';
import { resetListFieldsFallback } from '../src/tools/tasks.js';
import { createHarness } from './helpers.js';

const baseConfig = { baseUrl: 'http://127.0.0.1:8787', workspaceId: 'workspace-a', agentId: 'codex' };

describe('AgentBoard task MCP server', () => {
  const harnesses: Array<ReturnType<typeof createHarness>> = [];
  // PERF-4d：fields= 回落标志是进程级状态，每个用例前置复位
  beforeEach(() => resetListFieldsFallback());
  afterEach(async () => {
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
      name: 'create_task',
      arguments: { title: 'Long', description: '长正文测试', request_id: '00000000-0000-4000-8000-000000000010' },
    })).result?.structuredContent?.data;
    expect(Array.from(created.description)).toHaveLength(12000);
    expect(created).toMatchObject({ description_truncated: true, next_description_offset_chars: 12000 });

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
      name: 'list_tasks',
      arguments: { tree: true, parent_issue_id: 'root-1', limit: 10 },
    });
    expect(response.result?.structuredContent).toMatchObject({ ok: true, data: { items: [{ id: 'child-1', title: 'Child' }], next_cursor: 'next', workspace_id: 'workspace-a' } });
    // PERF-4d：树列表同样剔除正文（树端点无 fields=，在 MCP 侧裁剪）
    expect(response.result?.structuredContent?.data.items[0]).not.toHaveProperty('description');
    expect(String(fetcher.mock.calls[0]?.[0])).toContain('/api/issues/tree?');
    const url = new URL(String(fetcher.mock.calls[0]?.[0]));
    expect(url.searchParams.get('parent_issue_id')).toBe('root-1');
    expect(url.searchParams.get('workspace')).toBe('workspace-a');
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
  });

  it('complete_task always sends the changelog gate fields (SK-05 / MCP-09)', async () => {
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
    expect(bodies[0]).toMatchObject({ client: 'mcp', changelog_ack: false });
    expect(bodies[1]).toMatchObject({ client: 'mcp', changelog_ack: true });
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
