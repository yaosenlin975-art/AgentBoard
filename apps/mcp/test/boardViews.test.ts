/**
 * ARCH-01：MCP `next_tasks` / `workspace_stats` 与 CLI `kb next --json` / `kb stats --json` 同形。
 * 期望值按 CLI 的 JSON 契约逐字段写死（字段名、排序、null/数组），两路共用 shared boardViews。
 *
 * FETCHC-2：两个工具的取数都收敛为 `kinds=` + `fields=` 投影；`workspace_stats` 的
 * 五状态计数与 total 改走 `GET /api/issues/counts`（明细只用于未完成两列）。
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

/** 整区 counts 出参（自定义状态只计入 total，不占内置五行） */
const STATS_COUNTS = {
  workspace_id: 'workspace-a',
  total: 7,
  counts: { 待规划: 2, 进行中: 1, 待验收: 1, 已关闭: 1, 已废弃: 1, 自定义状态: 1 },
};

/** 未完成明细：与 STATS_ISSUES 中 kinds=open,started,review,blocked 的行一致 */
const STATS_UNFINISHED = [STATS_ISSUES[0]!, STATS_ISSUES[1]!, STATS_ISSUES[2]!, STATS_ISSUES[3]!];

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
    const listCall = calls.find(({ pathname }) => pathname === '/api/issues')!;
    expect(listCall.searchParams.get('workspace')).toBe('workspace-a');
  });

  // FETCHC-2：next_tasks 取数只拉未完成卡的三列投影，不再整区全字段
  it('next_tasks 取数带 kinds 与 fields 投影', async () => {
    const calls: URL[] = [];
    const fetcher = vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input));
      calls.push(url);
      if (url.pathname === '/api/issues') return Response.json(NEXT_ISSUES);
      return Response.json(NEXT_DEPS[(/([^/]+)\/dependencies$/.exec(url.pathname)?.[1]) ?? ''] ?? { blockers: [], blocked: [] });
    });
    const harness = createHarness(baseConfig, fetcher as typeof fetch);
    harnesses.push(harness);
    await harness.start();
    await harness.request('tools/call', { name: 'next_tasks', arguments: {} });

    const listCall = calls.find(({ pathname }) => pathname === '/api/issues')!;
    expect(listCall.searchParams.get('kinds')).toBe('open,started,review,blocked');
    expect(listCall.searchParams.get('fields')?.split(',') ?? []).toContain('parent_issue_id');
    expect(listCall.searchParams.get('fields')?.split(',') ?? []).not.toContain('description');
  });

  it('workspace_stats 返回与 kb stats --json 同形的 StatsResult', async () => {
    const calls: URL[] = [];
    const fetcher = vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input));
      calls.push(url);
      if (url.pathname === '/api/issues/counts') return Response.json({ items: [STATS_COUNTS] });
      return Response.json(STATS_UNFINISHED);
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
      // total 取整区 counts（含自定义状态），不是未完成明细行数
      total: 7,
    });
    expect(data.generated_at).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}[+-]\d{2}:\d{2}$/);

    expect(calls).toHaveLength(2);
    expect(calls[0]?.pathname).toBe('/api/issues/counts');
    expect(calls[0]?.searchParams.get('workspace_ids')).toBe('workspace-a');
    expect(calls[1]?.pathname).toBe('/api/issues');
    expect(calls[1]?.searchParams.get('workspace')).toBe('workspace-a');
    expect(calls[1]?.searchParams.get('kinds')).toBe('open,started,review,blocked');
    expect(calls[1]?.searchParams.get('fields')).toBe('status,claimed_by,blocked_by_open_count');
  });

  // 卡面评论：counts 端点 404/400 → 回落一次整区 3 列投影，口径与改前逐字一致
  it('workspace_stats 在 counts 端点缺失或被拒时回落整区投影，total 仍为整区总数', async () => {
    const cases = [
      { status: 404, code: 'NOT_FOUND', message: '接口不存在' },
      { status: 400, code: 'VALIDATION_ERROR', message: '缺少 workspace_ids 查询参数' },
    ];
    for (const failure of cases) {
      const calls: URL[] = [];
      const fetcher = vi.fn(async (input: RequestInfo | URL) => {
        const url = new URL(String(input));
        calls.push(url);
        if (url.pathname === '/api/issues/counts') {
          return Response.json({ error: { code: failure.code, message: failure.message } }, { status: failure.status });
        }
        return Response.json(STATS_ISSUES);
      });
      const harness = createHarness(baseConfig, fetcher as typeof fetch);
      harnesses.push(harness);
      await harness.start();

      const data = (await harness.request('tools/call', { name: 'workspace_stats', arguments: {} }))
        .result?.structuredContent?.data;
      expect(data).toMatchObject({
        total: 7,
        unclaimed_open: 2,
        blocked_open: 1,
        statuses: { 待规划: 2, 进行中: 1, 待验收: 1, 已关闭: 1, 已废弃: 1 },
      });
      // counts 缺失 → 直接整区 3 列投影一次（不再发过滤请求）
      expect(calls.map(({ pathname }) => pathname)).toEqual(['/api/issues/counts', '/api/issues']);
      expect(calls[1]?.searchParams.has('kinds')).toBe(false);
      expect(calls[1]?.searchParams.get('fields')).toBe('status,claimed_by,blocked_by_open_count');
    }
  });

  it('workspace_stats 在老服务端拒绝 fields 时回落整对象，计数口径不变', async () => {
    const calls: URL[] = [];
    const fetcher = vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input));
      calls.push(url);
      if (url.pathname === '/api/issues/counts') {
        return Response.json({ error: { code: 'NOT_FOUND', message: '接口不存在' } }, { status: 404 });
      }
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

    const issueCalls = calls.filter(({ pathname }) => pathname === '/api/issues');
    expect(issueCalls).toHaveLength(2);
    expect(issueCalls[0]?.searchParams.has('fields')).toBe(true);
    expect(issueCalls[1]?.searchParams.has('fields')).toBe(false);
  });
});
