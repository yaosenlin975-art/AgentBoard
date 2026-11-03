/**
 * STATUS-2：MCP 状态字典三工具（list / add / remove）。
 * 直接走工具层（真实 MCP stdio 握手 + 注入 fetch），不依赖真实服务端。
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createHarness } from './helpers.js';

const baseConfig = { baseUrl: 'http://127.0.0.1:8787', workspaceId: 'workspace-a', agentId: 'codex' };
const STATUSES = [
  { id: 's-open', workspace_id: 'workspace-a', name: '待规划', kind: 'open', sort_order: 0, is_builtin: 1 },
  { id: 's-custom', workspace_id: 'workspace-a', name: '待复测', kind: 'review', sort_order: 50, is_builtin: 0 },
];

describe('AgentBoard status MCP tools', () => {
  const harnesses: Array<ReturnType<typeof createHarness>> = [];
  afterEach(async () => {
    await Promise.all(harnesses.splice(0).map(harness => harness.close()));
  });

  it('lists the workspace status dictionary', async () => {
    const fetchMock = vi.fn(async () => Response.json(STATUSES));
    const harness = createHarness(baseConfig, fetchMock as unknown as typeof fetch);
    harnesses.push(harness);
    await harness.start();

    const response = await harness.request('tools/call', { name: 'agentboard_list_statuses', arguments: {} });
    expect(response.result?.structuredContent).toMatchObject({ ok: true, data: { workspace_id: 'workspace-a', items: STATUSES } });
    const [url] = fetchMock.mock.calls[0]!;
    expect(String(url)).toBe('http://127.0.0.1:8787/api/workspaces/workspace-a/statuses');
  });

  it('adds a custom status with kind and idempotency key', async () => {
    const fetchMock = vi.fn(async () => Response.json(
      { id: 's-new', workspace_id: 'workspace-a', name: '待复测', kind: 'review', sort_order: 60, is_builtin: 0 },
      { status: 201 },
    ));
    const harness = createHarness(baseConfig, fetchMock as unknown as typeof fetch);
    harnesses.push(harness);
    await harness.start();
    const requestId = '9f0d3c8a-5b1e-4a26-8c7d-1f2b3a4c5d6e';

    const response = await harness.request('tools/call', {
      name: 'agentboard_add_status',
      arguments: { name: '待复测', kind: 'review', request_id: requestId },
    });
    expect(response.result?.structuredContent).toMatchObject({ ok: true, data: { name: '待复测', kind: 'review' } });
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(String(url)).toBe('http://127.0.0.1:8787/api/workspaces/workspace-a/statuses');
    expect(init?.method).toBe('POST');
    expect(new Headers(init?.headers).get('Idempotency-Key')).toBe(requestId);
    expect(JSON.parse(String(init?.body))).toEqual({ workspace_id: 'workspace-a', name: '待复测', kind: 'review' });
  });

  it('removes a custom status with migrate_to in the query', async () => {
    const fetchMock = vi.fn(async () => Response.json(
      { removed: STATUSES[1], migrate_to: '进行中', migrated_issue_count: 3 },
      { status: 200 },
    ));
    const harness = createHarness(baseConfig, fetchMock as unknown as typeof fetch);
    harnesses.push(harness);
    await harness.start();

    const response = await harness.request('tools/call', {
      name: 'agentboard_remove_status',
      arguments: { status_id: 's-custom', migrate_to: '进行中' },
    });
    expect(response.result?.structuredContent).toMatchObject({ ok: true, data: { migrate_to: '进行中', migrated_issue_count: 3 } });
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(String(url)).toBe('http://127.0.0.1:8787/api/workspaces/workspace-a/statuses/s-custom?migrate_to=%E8%BF%9B%E8%A1%8C%E4%B8%AD');
    expect(init?.method).toBe('DELETE');
  });

  it('passes builtin-rejection and migration-required codes through', async () => {
    const cases: Array<{ code: string; status: number; expected: string }> = [
      { code: 'WORKSPACE_STATUS_BUILTIN', status: 409, expected: 'WORKSPACE_STATUS_BUILTIN' },
      { code: 'MIGRATION_TARGET_REQUIRED', status: 400, expected: 'MIGRATION_TARGET_REQUIRED' },
      { code: 'MIGRATION_TARGET_INVALID', status: 400, expected: 'MIGRATION_TARGET_INVALID' },
    ];
    for (const item of cases) {
      const fetchMock = vi.fn(async () => Response.json({ error: { code: item.code, message: `srv-raw-${item.code}` } }, { status: item.status }));
      const harness = createHarness(baseConfig, fetchMock as unknown as typeof fetch);
      harnesses.push(harness);
      await harness.start();
      const response = await harness.request('tools/call', {
        name: 'agentboard_remove_status',
        arguments: { status_id: 's-custom', migrate_to: '进行中' },
      });
      expect(response.result?.isError).toBe(true);
      expect(response.result?.structuredContent).toMatchObject({ ok: false, error: { code: item.expected } });
      expect(JSON.stringify(response.result?.structuredContent)).not.toContain(`srv-raw-${item.code}`);
    }
  });

  it('rejects a workspace override when the server is bound', async () => {
    const fetchMock = vi.fn();
    const harness = createHarness(baseConfig, fetchMock as unknown as typeof fetch);
    harnesses.push(harness);
    await harness.start();
    const response = await harness.request('tools/call', {
      name: 'agentboard_list_statuses',
      arguments: { workspace_id: 'workspace-b' },
    });
    expect(response.result?.structuredContent).toMatchObject({ ok: false, error: { code: 'WORKSPACE_BOUND' } });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
