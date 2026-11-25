import { expect, it } from 'vitest';
import { createHarness } from './helpers.js';

it('MCP 任务列表、派发与统计使用对应的请求过滤和投影', async () => {
  const baseUrl = 'http://127.0.0.1:8787';
  const workspaceId = 'workspace-a';
  const calls: URL[] = [];
  const harness = createHarness({ baseUrl, workspaceId }, async (input) => {
    const url = new URL(String(input));
    calls.push(url);
    if (url.pathname === '/api/issues/counts') {
      return Response.json({ items: [{ workspace_id: workspaceId, total: 0, counts: {} }] });
    }
    if (url.pathname !== '/api/issues') return new Response(null, { status: 404 });
    return Response.json(url.searchParams.has('limit')
      ? { items: [], limit: 50, offset: 0, total: 0, next_offset: null }
      : []);
  });
  const kinds = 'open,started,review,blocked';
  try {
    await harness.start();
    const call = async (name: string, args: Record<string, unknown> = {}) => {
      calls.length = 0;
      const result = await harness.request('tools/call', { name, arguments: args });
      expect(result.error).toBeUndefined();
      expect(result.result?.isError).not.toBe(true);
      const list = calls.filter(url => url.pathname === '/api/issues');
      expect(list).toHaveLength(1);
      return list[0]!.searchParams;
    };

    const defaults = await call('list_tasks');
    expect(defaults.get('kinds')).toBe(kinds);
    expect(defaults.get('unclaimed')).toBe('1');
    const all = await call('list_tasks', { all_status: true });
    expect(all.has('kinds')).toBe(false);
    expect(all.has('unclaimed')).toBe(false);

    const next = await call('next_tasks');
    expect(next.get('kinds')).toBe(kinds);
    expect(next.get('fields')?.split(',')).toContain('labels');
    expect(next.get('fields')?.split(',')).not.toContain('description');

    const stats = await call('workspace_stats');
    expect(calls[0]?.pathname).toBe('/api/issues/counts');
    expect(stats.get('kinds')).toBe(kinds);
    expect(stats.get('fields')).toBe('status,claimed_by,blocked_by_open_count');
  } finally {
    await harness.close();
  }
});
