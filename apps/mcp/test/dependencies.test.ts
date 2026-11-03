/**
 * DEP-2：MCP 三工具（`agentboard_list_dependencies` / `agentboard_add_dependency` / `agentboard_remove_dependency`）。
 * 直接走工具层（真实 MCP stdio 握手 + 注入 fetch），不依赖真实 agent 或真实服务端。
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createHarness } from './helpers.js';

const baseConfig = { baseUrl: 'http://127.0.0.1:8787', workspaceId: 'workspace-a', agentId: 'codex' };
const VIEW = {
  blockers: [{ issue_id: 'blk1', title: '前置卡', status: '待规划', resolved: false }],
  blocked: [{ issue_id: 'dep1', title: '下游卡', status: '已关闭', resolved: true }],
};

describe('AgentBoard dependency MCP tools', () => {
  const harnesses: Array<ReturnType<typeof createHarness>> = [];
  afterEach(async () => {
    await Promise.all(harnesses.splice(0).map(harness => harness.close()));
  });

  it('lists dependencies with the bound workspace and resolved flag', async () => {
    const fetchMock = vi.fn(async () => Response.json(VIEW));
    const harness = createHarness(baseConfig, fetchMock as unknown as typeof fetch);
    harnesses.push(harness);
    await harness.start();

    const response = await harness.request('tools/call', {
      name: 'agentboard_list_dependencies',
      arguments: { task_id: 'iss1' },
    });
    expect(response.result?.structuredContent).toMatchObject({
      ok: true,
      data: { blockers: VIEW.blockers, blocked: VIEW.blocked, workspace_id: 'workspace-a' },
    });
    const [url] = fetchMock.mock.calls[0]!;
    expect(String(url)).toBe('http://127.0.0.1:8787/api/issues/iss1/dependencies?workspace_id=workspace-a');
  });

  it('adds a dependency with request_id as the idempotency key', async () => {
    const fetchMock = vi.fn(async () => Response.json(VIEW, { status: 201 }));
    const harness = createHarness(baseConfig, fetchMock as unknown as typeof fetch);
    harnesses.push(harness);
    await harness.start();
    const requestId = '9f0d3c8a-5b1e-4a26-8c7d-1f2b3a4c5d6e';

    const response = await harness.request('tools/call', {
      name: 'agentboard_add_dependency',
      arguments: { task_id: 'iss1', blocker_task_id: 'blk1', request_id: requestId },
    });
    expect(response.result?.structuredContent).toMatchObject({ ok: true, data: { workspace_id: 'workspace-a' } });
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(String(url)).toBe('http://127.0.0.1:8787/api/issues/iss1/dependencies');
    expect(init?.method).toBe('POST');
    expect(new Headers(init?.headers).get('Idempotency-Key')).toBe(requestId);
    expect(JSON.parse(String(init?.body))).toEqual({ workspace_id: 'workspace-a', blocker_issue_id: 'blk1' });
  });

  it('removes a dependency through DELETE with the workspace query', async () => {
    const fetchMock = vi.fn(async () => new Response(null, { status: 204 }));
    const harness = createHarness(baseConfig, fetchMock as unknown as typeof fetch);
    harnesses.push(harness);
    await harness.start();

    const response = await harness.request('tools/call', {
      name: 'agentboard_remove_dependency',
      arguments: { task_id: 'iss1', blocker_task_id: 'blk1' },
    });
    expect(response.result?.structuredContent).toMatchObject({
      ok: true,
      data: { removed: true, task_id: 'iss1', blocker_task_id: 'blk1' },
    });
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(String(url)).toBe('http://127.0.0.1:8787/api/issues/iss1/dependencies/blk1?workspace_id=workspace-a');
    expect(init?.method).toBe('DELETE');
  });

  it('passes dependency error codes through without swallowing them', async () => {
    // 404 NOT_FOUND 按 apiClient 既有约定落成 TASK_NOT_FOUND（任务或前置不存在），其余码原样透传
    const cases: Array<{ code: string; status: number; expected: string }> = [
      { code: 'DEPENDENCY_CYCLE', status: 409, expected: 'DEPENDENCY_CYCLE' },
      { code: 'DEPENDENCY_EXISTS', status: 409, expected: 'DEPENDENCY_EXISTS' },
      { code: 'ISSUE_CLAIMED', status: 409, expected: 'ISSUE_CLAIMED' },
      { code: 'CROSS_WORKSPACE_DEPENDENCY', status: 400, expected: 'CROSS_WORKSPACE_DEPENDENCY' },
      { code: 'DEPENDENCY_SELF', status: 400, expected: 'DEPENDENCY_SELF' },
      { code: 'NOT_FOUND', status: 404, expected: 'TASK_NOT_FOUND' },
    ];
    for (const item of cases) {
      const serverMessage = `srv-raw-${item.code}`;
      const fetchMock = vi.fn(async () => Response.json({ error: { code: item.code, message: serverMessage } }, { status: item.status }));
      const harness = createHarness(baseConfig, fetchMock as unknown as typeof fetch);
      harnesses.push(harness);
      await harness.start();
      const response = await harness.request('tools/call', {
        name: 'agentboard_add_dependency',
        arguments: { task_id: 'iss1', blocker_task_id: 'blk1', request_id: '9f0d3c8a-5b1e-4a26-8c7d-1f2b3a4c5d6e' },
      });
      expect({ code: item.code, isError: response.result?.isError }).toEqual({ code: item.code, isError: true });
      expect(response.result?.structuredContent).toMatchObject({ ok: false, error: { code: item.expected } });
      // 文案是本地安全文案，不回传服务端原文
      expect(JSON.stringify(response.result?.structuredContent)).not.toContain(serverMessage);
    }
  });

  it('rejects a workspace override when the server is bound', async () => {
    const fetchMock = vi.fn();
    const harness = createHarness(baseConfig, fetchMock as unknown as typeof fetch);
    harnesses.push(harness);
    await harness.start();
    const response = await harness.request('tools/call', {
      name: 'agentboard_list_dependencies',
      arguments: { task_id: 'iss1', workspace_id: 'workspace-b' },
    });
    expect(response.result?.structuredContent).toMatchObject({ ok: false, error: { code: 'WORKSPACE_BOUND' } });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
