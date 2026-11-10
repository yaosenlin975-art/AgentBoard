import { afterEach, describe, expect, it, vi } from 'vitest';
import { createHarness } from './helpers.js';

const WORKSPACE_ID = '5f1b2c34-0000-4000-8000-00000000a001';
const ENTRY_ID = '5f1b2c34-0000-4000-8000-00000000d001';

type Call = { method: string; path: string; query: Record<string, string>; headers: Headers; body: any };
type ToolResult = { isError?: boolean; content?: Array<{ type: string; text?: string }>; structuredContent?: Record<string, any> };

function entry(overrides: Record<string, unknown> = {}) {
  return {
    id: ENTRY_ID,
    workspace_id: WORKSPACE_ID,
    title: 'MCP 收口',
    body_md: '正文'.repeat(300),
    change_type: '新增',
    occurred_at: 1_700_000_000_000,
    created_by: 'kb-cli',
    revision: 1,
    created_at: 1_700_000_000_000,
    updated_at: 1_700_000_000_000,
    ...overrides,
  };
}

function harnessWith(calls: Call[], overrides: { status?: number; body?: unknown } = {}) {
  const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    calls.push({
      method: init?.method ?? 'GET',
      path: url.pathname,
      query: Object.fromEntries(url.searchParams.entries()),
      headers: new Headers(init?.headers),
      body: init?.body === undefined ? null : JSON.parse(String(init.body)),
    });
    if (overrides.status !== undefined) {
      return new Response(JSON.stringify(overrides.body), { status: overrides.status, headers: { 'Content-Type': 'application/json' } });
    }
    if (url.pathname.endsWith('/changelog') && (init?.method ?? 'GET') === 'POST') {
      return new Response(JSON.stringify(entry()), { status: 201, headers: { 'Content-Type': 'application/json' } });
    }
    if (url.pathname.endsWith(`/changelog/${ENTRY_ID}`)) {
      return Response.json(entry());
    }
    return Response.json({ items: [entry()], next_offset: null });
  }) as unknown as typeof fetch;
  const harness = createHarness({ baseUrl: 'http://127.0.0.1:8787', workspaceId: WORKSPACE_ID, agentId: 'codex' }, fetcher);
  const call = (name: string, args: Record<string, unknown>) => harness.request('tools/call', { name, arguments: args });
  return { harness, call };
}

describe('MCP 变更日志工具', () => {
  const harnesses: Array<ReturnType<typeof createHarness>> = [];
  afterEach(async () => {
    await Promise.all(harnesses.splice(0).map((harness) => harness.close()));
  });

  it('list_changelog 打工作区日志路径并只回 300 字正文摘要', async () => {
    const calls: Call[] = [];
    const { harness, call } = harnessWith(calls);
    harnesses.push(harness);
    await harness.start();
    const result = (await call('list_changelog', { limit: 5, offset: 10, change_type: '修复' })).result as ToolResult;
    expect(result.isError).toBeFalsy();
    const item = result.structuredContent!.data.items[0];
    expect(item).toMatchObject({ id: ENTRY_ID, title: 'MCP 收口', change_type: '新增' });
    expect(item.body_md).toHaveLength(300);
    expect(item.body_truncated).toBe(true);
    expect(Array.from(item.body_md).length).toBe(300);
    expect(calls[0].path).toBe(`/api/workspaces/${WORKSPACE_ID}/changelog`);
    expect(calls[0].query).toEqual({ limit: '5', offset: '10', change_type: '修复' });
  });

  it('get_changelog 按 offset 窗口读正文并回续读偏移', async () => {
    const calls: Call[] = [];
    const { harness, call } = harnessWith(calls);
    harnesses.push(harness);
    await harness.start();
    const result = (await call('get_changelog', { changelog_id: ENTRY_ID, body_offset: 100, body_max_chars: 50 })).result as ToolResult;
    expect(result.isError).toBeFalsy();
    expect(calls[0].path).toBe(`/api/workspaces/${WORKSPACE_ID}/changelog/${ENTRY_ID}`);
    const data = result.structuredContent!.data.entry;
    expect(Array.from(data.body_md)).toHaveLength(50);
    expect(data.body_truncated).toBe(true);
    expect(data.next_offset_chars).toBe(150);
  });

  it('create_changelog 带幂等键与 actor 写日志', async () => {
    const calls: Call[] = [];
    const { harness, call } = harnessWith(calls);
    harnesses.push(harness);
    await harness.start();
    const requestId = '6f1b2c34-0000-4000-8000-00000000f001';
    const result = (await call('create_changelog', {
      title: '新增工具',
      body_md: 'MCP 增加变更日志工具',
      change_type: '新增',
      request_id: requestId,
    })).result as ToolResult;
    expect(result.isError).toBeFalsy();
    expect(result.structuredContent!.data.entry).toMatchObject({ id: ENTRY_ID, title: 'MCP 收口' });
    expect(calls[0].method).toBe('POST');
    expect(calls[0].path).toBe(`/api/workspaces/${WORKSPACE_ID}/changelog`);
    expect(calls[0].headers.get('Idempotency-Key')).toBe(requestId);
    expect(calls[0].body).toEqual({ title: '新增工具', body_md: 'MCP 增加变更日志工具', change_type: '新增', actor: 'codex' });
  });

  it('create_changelog 传 issue_id 时随请求体透传（done 门禁认本卡日志）', async () => {
    const calls: Call[] = [];
    const { harness, call } = harnessWith(calls);
    harnesses.push(harness);
    await harness.start();
    const issueId = '11111111-2222-4333-8444-555555555555';
    const result = (await call('create_changelog', {
      title: '本卡变更',
      body_md: '正文',
      change_type: '修复',
      issue_id: issueId,
      request_id: '6f1b2c34-0000-4000-8000-00000000f003',
    })).result as ToolResult;
    expect(result.isError).toBeFalsy();
    expect(calls[0].body).toMatchObject({ issue_id: issueId });
  });

  it('create_changelog 缺 agent id 时本地拒绝', async () => {
    const calls: Call[] = [];
    const fetcher = vi.fn() as unknown as typeof fetch;
    const harness = createHarness({ baseUrl: 'http://127.0.0.1:8787', workspaceId: WORKSPACE_ID }, fetcher);
    harnesses.push(harness);
    await harness.start();
    const result = (await harness.request('tools/call', {
      name: 'create_changelog',
      arguments: { title: 't', body_md: 'b', request_id: '6f1b2c34-0000-4000-8000-00000000f002' },
    })).result as ToolResult;
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({ ok: false, error: { code: 'AGENT_ID_REQUIRED' } });
    expect(fetcher).not.toHaveBeenCalled();
    expect(calls).toHaveLength(0);
  });

  it('把 404/400 映射成结构化安全错误码', async () => {
    for (const item of [
      { status: 404, body: { error: { code: 'CHANGELOG_NOT_FOUND', message: '变更日志不存在' } }, expected: 'CHANGELOG_NOT_FOUND' },
      { status: 400, body: { error: { code: 'VALIDATION_ERROR', message: 'change_type: 取值非法' } }, expected: 'VALIDATION_ERROR' },
    ]) {
      const calls: Call[] = [];
      const { harness, call } = harnessWith(calls, item);
      harnesses.push(harness);
      await harness.start();
      const result = (await call('get_changelog', { changelog_id: ENTRY_ID })).result as ToolResult;
      expect(result.isError).toBe(true);
      expect(result.structuredContent).toMatchObject({ ok: false, error: { code: item.expected } });
      expect(result.content?.[0]?.text).not.toContain('取值非法');
    }
  });

  it('agentboard_ 别名与主名行为一致', async () => {
    const calls: Call[] = [];
    const { harness, call } = harnessWith(calls);
    harnesses.push(harness);
    await harness.start();
    const result = (await call('agentboard_list_changelog', { limit: 1 })).result as ToolResult;
    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toMatchObject({ ok: true });
  });
});
