/**
 * ARCH-01：MCP `next_tasks` / `workspace_stats` 与 CLI `kb next --json` / `kb stats --json` 同形。
 * 期望值按 CLI 的 JSON 契约逐字段写死（字段名、排序、null/数组），两路共用 shared boardViews。
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createHarness } from './helpers.js';

const baseConfig = { baseUrl: 'http://127.0.0.1:8787', workspaceId: 'workspace-a', agentId: 'codex' };

const issue = (id: string, over: Record<string, unknown> = {}): Record<string, unknown> => ({
  id, workspace_id: 'workspace-a', title: `标题-${id}`, description: '', priority: '中', labels: [],
  status: '待规划', sort_order: 0, parent_issue_id: null, claimed_by: null, claimed_at: null,
  session_id: null, comment_count: 0, created_at: 1, updated_at: 1, ...over,
});

const ref = (id: string, resolved: boolean, status = resolved ? '已关闭' : '进行中') => ({
  issue_id: id, title: `标题-${id}`, status, resolved, relation: 'blocks',
});

const NEXT_ISSUES = [
  issue('a1', { parent_issue_id: 'p1', labels: ['cli'] }),
  issue('a2', { claimed_by: 'trae', labels: ['cli'] }),
  issue('a3', { labels: ['cli'] }),
  issue('a4', { status: '待验收' }),
];

const NEXT_DEPS: Record<string, { blockers: unknown[]; blocked: unknown[] }> = {
  a1: {
    blockers: [ref('b1', true, '待验收')],
    blocked: [ref('d1', false)],
  },
  a3: {
    blockers: [ref('b2', false)],
    blocked: [],
  },
};

const STATS_ISSUES = [
  issue('s1', { status: '待规划', blocked_by_open_count: 1 }),
  issue('s2', { status: '待规划', claimed_by: 'trae' }),
  issue('s3', { status: '进行中', claimed_by: 'trae' }),
  issue('s4', { status: '待验收' }),
  issue('s5', { status: '已关闭' }),
  issue('s6', { status: '已废弃' }),
  issue('s7', { status: '自定义状态' }),
];

describe('MCP board views (ARCH-01)', () => {
  const harnesses: Array<ReturnType<typeof createHarness>> = [];
  afterEach(async () => {
    await Promise.all(harnesses.splice(0).map((harness) => harness.close()));
  });

  it('next_tasks 返回与 kb next --json 同形的 items/next_offset', async () => {
    const calls: URL[] = [];
    const fetcher = vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input));
      calls.push(url);
      if (url.pathname === '/api/issues') return Response.json(NEXT_ISSUES);
      const match = /^\/api\/issues\/([^/]+)\/dependencies$/.exec(url.pathname);
      if (match) return Response.json(NEXT_DEPS[match[1]!] ?? { blockers: [], blocked: [] });
      return Response.json({ error: { code: 'NOT_FOUND', message: 'unexpected' } }, { status: 404 });
    });
    const harness = createHarness(baseConfig, fetcher as typeof fetch);
    harnesses.push(harness);
    await harness.start();

    const response = await harness.request('tools/call', { name: 'next_tasks', arguments: { limit: 5 } });
    expect(response.result?.isError).not.toBe(true);
    const data = response.result?.structuredContent?.data;

    // 与 CLI --json 信封逐字段一致
    expect(data).toEqual({
      items: [{
        id: 'a1',
        title: '标题-a1',
        status: '待规划',
        priority: '中',
        parent_issue_id: 'p1',
        labels: ['cli'],
        blockers: [ref('b1', true, '待验收')],
        blocks: [ref('d1', false)],
        siblings_by_label: ['a2', 'a3'],
      }],
      next_offset: null,
    });
    expect(Object.keys(data.items[0])).toEqual([
      'id', 'title', 'status', 'priority', 'parent_issue_id', 'labels',
      'blockers', 'blocks', 'siblings_by_label',
    ]);

    // 只对候选卡（a1/a3）取依赖；已占用/非待规划卡不发请求
    const depCalls = calls.filter(({ pathname }) => pathname.endsWith('/dependencies'));
    expect(depCalls.map(({ pathname }) => pathname)).toEqual([
      '/api/issues/a1/dependencies',
      '/api/issues/a3/dependencies',
    ]);
    expect(calls[0]?.searchParams.get('workspace')).toBe('workspace-a');
  });

  it('workspace_stats 返回与 kb stats --json 同形的 StatsResult', async () => {
    const calls: URL[] = [];
    const fetcher = vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input));
      calls.push(url);
      return Response.json(STATS_ISSUES);
    });
    const harness = createHarness(baseConfig, fetcher as typeof fetch);
    harnesses.push(harness);
    await harness.start();

    const response = await harness.request('tools/call', { name: 'workspace_stats', arguments: {} });
    expect(response.result?.isError).not.toBe(true);
    const data = response.result?.structuredContent?.data;

    expect(Object.keys(data)).toEqual([
      'workspace_id', 'generated_at', 'statuses', 'unclaimed_open', 'blocked_open', 'total',
    ]);
    expect(Object.keys(data.statuses)).toEqual(['待规划', '进行中', '待验收', '已关闭', '已废弃']);
    expect(data).toMatchObject({
      workspace_id: 'workspace-a',
      statuses: { 待规划: 2, 进行中: 1, 待验收: 1, 已关闭: 1, 已废弃: 1 },
      unclaimed_open: 2,
      blocked_open: 1,
      total: 7,
    });
    expect(data.generated_at).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}[+-]\d{2}:\d{2}$/);

    expect(calls).toHaveLength(1);
    expect(calls[0]?.searchParams.get('workspace')).toBe('workspace-a');
    expect(calls[0]?.searchParams.get('fields')).toBe('status,claimed_by,blocked_by_open_count');
  });

  it('workspace_stats 在老服务端拒绝 fields 时回落整对象，计数口径不变', async () => {
    const calls: URL[] = [];
    const fetcher = vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input));
      calls.push(url);
      if (url.searchParams.has('fields')) {
        return Response.json({ error: { code: 'VALIDATION_ERROR', message: 'unknown field' } }, { status: 400 });
      }
      return Response.json(STATS_ISSUES);
    });
    const harness = createHarness(baseConfig, fetcher as typeof fetch);
    harnesses.push(harness);
    await harness.start();

    const data = (await harness.request('tools/call', { name: 'workspace_stats', arguments: {} }))
      .result?.structuredContent?.data;
    expect(data).toMatchObject({ total: 7, statuses: { 待规划: 2 } });
    expect(calls).toHaveLength(2);
    expect(calls[0]?.searchParams.has('fields')).toBe(true);
    expect(calls[1]?.searchParams.has('fields')).toBe(false);
  });
});
