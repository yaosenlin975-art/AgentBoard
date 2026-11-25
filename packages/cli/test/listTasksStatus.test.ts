/**
 * CLI-LIST-GUARD（CLI 侧）：
 * - `--status` 非法值 → 非 0 退出 + 报错列出可用状态（不再静默「（无任务）」）；
 * - `--status` 支持自定义状态 / 已废弃；
 * - `--json` 默认不输出 description 正文（带 `description_omitted`），`--json --full` 才输出。
 */
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { main } from '../src/index.js';
import { resetIssueFieldsFallback } from '../src/commands/listTasks.js';

interface Recorded { method: string; url: string }
type MockReply = { status: number; body?: unknown } | undefined;
type Handler = (method: string, url: string) => MockReply;

const WS = { id: 'ws1', name: '状态空间', path: 'D:/ws/status', created_at: 1 };
const STATUSES = [
  { id: 's-open', workspace_id: 'ws1', name: '待规划', kind: 'open', sort_order: 0, is_builtin: 1 },
  { id: 's-dep', workspace_id: 'ws1', name: '已废弃', kind: 'deprecated', sort_order: 40, is_builtin: 1 },
  { id: 's-custom', workspace_id: 'ws1', name: '待复测', kind: 'review', sort_order: 50, is_builtin: 0 },
];
const issue = (id: string, status: string): Record<string, unknown> => ({
  id, workspace_id: 'ws1', title: `标题-${id}`, description: `正文-${id}`, priority: '中', labels: [],
  status, sort_order: 0, parent_issue_id: null, claimed_by: null, claimed_at: null, session_id: null,
  comment_count: 0, created_at: 1, updated_at: 1,
});
const ISSUES = [issue('i1', '待规划'), issue('i2', '已废弃'), issue('i3', '待复测')];

let server: Server;
let base = '';
let calls: Recorded[] = [];
let handler: Handler = () => undefined;

beforeEach(async () => {
  calls = [];
  handler = () => undefined;
  resetIssueFieldsFallback();
  server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', c => chunks.push(c as Buffer));
    req.on('end', () => {
      calls.push({ method: req.method ?? '', url: req.url ?? '' });
      const reply = handler(req.method ?? '', req.url ?? '');
      if (!reply) {
        res.writeHead(404, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: { code: 'NOT_FOUND', message: 'mock 未匹配' } }));
        return;
      }
      res.writeHead(reply.status, { 'content-type': 'application/json' });
      res.end(reply.body === undefined ? '' : JSON.stringify(reply.body));
    });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterEach(async () => {
  await new Promise<void>(resolve => server.close(() => resolve()));
});

function makeIo() {
  const out: string[] = [];
  const err: string[] = [];
  return {
    io: { write: (s: string) => { out.push(s); }, writeErr: (s: string) => { err.push(s); }, readStdin: async () => '' },
    out: () => out.join(''),
    err: () => err.join(''),
  };
}

const baseHandler: Handler = (method, url) => {
  if (method === 'GET' && url === '/api/workspaces') return { status: 200, body: [WS] };
  if (method === 'GET' && url === '/api/workspaces/ws1/statuses') return { status: 200, body: STATUSES };
  if (method === 'GET' && url.startsWith('/api/issues?workspace=ws1')) return { status: 200, body: ISSUES };
  return undefined;
};

const run = async (args: string[]) => {
  const t = makeIo();
  const code = await main(['node', 'kb', '--server', base, ...args], t.io);
  return { code, out: t.out(), err: t.err() };
};

describe('kb list-tasks status guard', () => {
  it('defaults to the cwd workspace and aggregates only with --all', async () => {
    const cwdSpace = { ...WS, path: process.cwd() };
    const remoteSpace = { ...WS, id: 'ws2', name: '远端', path: 'Z:/remote/workspace' };
    handler = (method, url) => {
      if (method === 'GET' && url === '/api/workspaces') return { status: 200, body: [cwdSpace, remoteSpace] };
      if (method === 'GET' && url.startsWith('/api/issues?workspace=ws1')) return { status: 200, body: [ISSUES[0]] };
      if (method === 'GET' && url.startsWith('/api/issues?workspace=ws2')) {
        return { status: 200, body: [{ ...ISSUES[1], workspace_id: 'ws2' }] };
      }
      return undefined;
    };

    const current = await run(['--json', 'list-tasks']);
    expect(current.code).toBe(0);
    expect(((JSON.parse(current.out) as { items: Array<{ id: string }> }).items).map(item => item.id)).toEqual(['i1']);
    const issueCalls = calls.filter(call => call.url.startsWith('/api/issues?'));
    expect(issueCalls).toHaveLength(1);
    // OPT-01：缺省收敛参数在 fields= 之前下发
    expect(issueCalls[0]!.url.startsWith('/api/issues?workspace=ws1&kinds=open,started,review,blocked&unclaimed=1&fields=')).toBe(true);

    calls = [];
    const all = await run(['--json', 'list-tasks', '--all']);
    expect(all.code).toBe(0);
    expect(((JSON.parse(all.out) as { items: Array<{ id: string }> }).items).map(item => item.id)).toEqual(['i1', 'i2']);
    expect(calls.filter(call => call.url.startsWith('/api/issues?'))).toHaveLength(2);
  });

  it('prefetches status dictionaries once for --all through the aggregate endpoint', async () => {
    // KB-CLI-4 / CLI-20：--all 的状态字典由 GET /api/statuses?workspace_ids=… 一次取全
    const wsA = { ...WS, id: 'ws-a', name: 'A 区', path: 'D:/ws/a' };
    const wsB = { ...WS, id: 'ws-b', name: 'B 区', path: 'D:/ws/b' };
    const dictA = [{ id: 'a-open', workspace_id: 'ws-a', name: '待规划', kind: 'open', sort_order: 0, is_builtin: 1 }];
    const dictB = [
      { id: 'b-open', workspace_id: 'ws-b', name: '待规划', kind: 'open', sort_order: 0, is_builtin: 1 },
      { id: 'b-custom', workspace_id: 'ws-b', name: '待复测', kind: 'review', sort_order: 50, is_builtin: 0 },
    ];
    handler = (method, url) => {
      if (method === 'GET' && url === '/api/workspaces') return { status: 200, body: [wsA, wsB] };
      if (method === 'GET' && url.startsWith('/api/statuses?workspace_ids=')) {
        return { status: 200, body: { items: [{ workspace_id: 'ws-a', statuses: dictA }, { workspace_id: 'ws-b', statuses: dictB }] } };
      }
      if (method === 'GET' && url.startsWith('/api/issues?workspace=ws-a')) return { status: 200, body: [{ ...issue('a1', '待规划'), workspace_id: 'ws-a' }] };
      if (method === 'GET' && url.startsWith('/api/issues?workspace=ws-b')) return { status: 200, body: [{ ...issue('b1', '待复测'), workspace_id: 'ws-b' }] };
      return undefined;
    };

    const all = await run(['--json', 'list-tasks', '--all', '--status', '待复测']);
    expect(all.code).toBe(0);
    expect(((JSON.parse(all.out) as { items: Array<{ id: string }> }).items).map(item => item.id)).toEqual(['b1']);
    const statusCalls = calls.filter(call => call.url.includes('/statuses'));
    expect(statusCalls).toHaveLength(1);
    expect(statusCalls[0]!.url).toContain('/statuses?workspace_ids=');
  });

  it('rejects --all with --workspace before fetching workspaces', async () => {
    handler = baseHandler;
    const result = await run(['list-tasks', '--workspace', 'ws1', '--all']);
    expect(result.code).toBe(1);
    expect(result.err).toContain('--all 与 --workspace 不能同时使用');
    expect(calls).toHaveLength(0);
  });

  it('rejectsUnkNownStatusWithAvailableListAndNonZeroExit', async () => {
    handler = baseHandler;
    const result = await run(['list-tasks', '--workspace', 'ws1', '--status', '不存在的状态']);
    expect(result.code).not.toBe(0);
    expect(result.err).toContain('未知状态：不存在的状态');
    expect(result.err).toContain('待规划');
    expect(result.err).toContain('已废弃');
    expect(result.out).not.toContain('（无任务）');
    // 抛错发生在列表请求之前：没有 GET /api/issues
    expect(calls.filter(call => call.url.startsWith('/api/issues'))).toHaveLength(0);
  });

  it('filtersByDeprecatedStatus', async () => {
    handler = baseHandler;
    const result = await run(['list-tasks', '--workspace', 'ws1', '--status', '已废弃']);
    expect(result.code).toBe(0);
    expect(result.out).toContain('i2');
    expect(result.out).not.toContain('i1');
  });

  it('filtersByCustomStatus', async () => {
    handler = baseHandler;
    const result = await run(['list-tasks', '--workspace', 'ws1', '--status', '待复测']);
    expect(result.code).toBe(0);
    expect(result.out).toContain('i3');
    expect(result.out).not.toContain('i2');
  });

  it('jsonOmitsDescriptionByDefaultAndKeepsItWithFull', async () => {
    handler = baseHandler;
    const trimmed = await run(['--json', 'list-tasks', '--workspace', 'ws1']);
    expect(trimmed.code).toBe(0);
    const parsed = (JSON.parse(trimmed.out) as { items: Array<Record<string, unknown>> }).items;
    expect(parsed).toHaveLength(3);
    expect(Object.keys(parsed[0]!)).not.toContain('description');
    expect(parsed[0]!.description_omitted).toBe(true);
    expect(trimmed.out).not.toContain('正文-i1');

    const full = await run(['--json', 'list-tasks', '--workspace', 'ws1', '--full']);
    expect(full.code).toBe(0);
    const fullParsed = (JSON.parse(full.out) as { items: Array<Record<string, unknown>> }).items;
    expect(fullParsed[0]!.description).toBe('正文-i1');
    expect(fullParsed[0]!.description_omitted).toBeUndefined();
  });

  it('--json --full 不请求 fields=（正文窗口照旧）', async () => {
    handler = (method, url) => {
      if (method === 'GET' && url === '/api/workspaces') return { status: 200, body: [WS] };
      if (method === 'GET' && url.startsWith('/api/issues?workspace=ws1')) return { status: 200, body: ISSUES };
      return undefined;
    };
    const result = await run(['--json', 'list-tasks', '--workspace', 'ws1', '--full']);
    expect(result.code).toBe(0);
    expect(calls.filter(call => call.url.startsWith('/api/issues?'))).toEqual([
      { method: 'GET', url: '/api/issues?workspace=ws1&kinds=open,started,review,blocked&unclaimed=1' },
    ]);
  });

  it('OPT-01 缺省收敛：请求携带 kind 集合与无主过滤，stderr 首行提示全量开关', async () => {
    handler = baseHandler;
    const result = await run(['list-tasks', '--workspace', 'ws1']);
    expect(result.code).toBe(0);
    expect(result.err.startsWith('默认已收敛为未完成无主卡，全量用 --all-status')).toBe(true);
    const issueCall = calls.find(call => call.url.startsWith('/api/issues?'))!;
    expect(issueCall.url).toContain('kinds=open,started,review,blocked');
    expect(issueCall.url).toContain('unclaimed=1');
  });

  it('S5：--all 跨区盘点用跨区文案（报区数），单区缺省文案逐字不变', async () => {
    const wsA = { ...WS, id: 'ws-a', name: 'A 区', path: 'D:/ws/a' };
    const wsB = { ...WS, id: 'ws-b', name: 'B 区', path: 'D:/ws/b' };
    handler = (method, url) => {
      if (method === 'GET' && url === '/api/workspaces') return { status: 200, body: [wsA, wsB] };
      if (method === 'GET' && url.startsWith('/api/issues?workspace=')) return { status: 200, body: [] };
      return undefined;
    };

    // --all：主语是「几个工作空间」，不是「默认」（--all 是显式指定，没有默认可言）
    const all = await run(['list-tasks', '--all']);
    expect(all.code).toBe(0);
    expect(all.err).toBe('跨区盘点：2 个工作空间的未完成无主卡（只读聚合），含占用中与已关闭用 --all-status\n');
    expect(all.err).not.toContain('默认已收敛');

    // --all 仍然收敛（维持 api.md:458 的口径）：过滤参数照发
    const issueCalls = calls.filter(call => call.url.startsWith('/api/issues?'));
    expect(issueCalls).toHaveLength(2);
    expect(issueCalls.every(call => call.url.includes('unclaimed=1'))).toBe(true);

    // --all --all-status：仍取整区，在 stderr 提示实际行数。
    calls = [];
    const allStatus = await run(['list-tasks', '--all', '--all-status']);
    expect(allStatus.code).toBe(0);
    expect(allStatus.err).toBe('--all-status 取整区全状态（0 行），找活请用 kb next\n');
    expect(calls.filter(call => call.url.startsWith('/api/issues?')).every(call => !call.url.includes('kinds='))).toBe(true);
  });

  it('--all-status 关闭收敛（不带过滤参数、无提示），--status 显式覆盖同样不带收敛参数', async () => {
    handler = baseHandler;
    const allStatus = await run(['--json', 'list-tasks', '--workspace', 'ws1', '--all-status']);
    expect(allStatus.code).toBe(0);
    expect(allStatus.err).not.toContain('默认已收敛');
    expect(calls.filter(call => call.url.startsWith('/api/issues?')).every(call => !call.url.includes('kinds='))).toBe(true);
    expect(((JSON.parse(allStatus.out) as { items: Array<{ id: string }> }).items).map(item => item.id)).toEqual(['i1', 'i2', 'i3']);

    calls = [];
    const byStatus = await run(['--json', 'list-tasks', '--workspace', 'ws1', '--status', '已废弃']);
    expect(byStatus.code).toBe(0);
    expect(byStatus.err).not.toContain('默认已收敛');
    const issueCalls = calls.filter(call => call.url.startsWith('/api/issues?'));
    expect(issueCalls).toHaveLength(1);
    // FETCHC-1：显式状态走服务端过滤，且不叠加 kinds/unclaimed（否则 --status 进行中 恒空）
    expect(issueCalls[0]!.url).toContain('status=%E5%B7%B2%E5%BA%9F%E5%BC%83');
    expect(issueCalls[0]!.url).not.toContain('kinds=');
    expect(issueCalls[0]!.url).not.toContain('unclaimed=');
  });

  it('--tree 保留整树口径：不做缺省收敛、不提示', async () => {
    handler = (method, url) => {
      if (method === 'GET' && url === '/api/workspaces') return { status: 200, body: [WS] };
      if (method === 'GET' && url.startsWith('/api/issues?workspace=ws1')) return { status: 200, body: ISSUES };
      return undefined;
    };
    const result = await run(['list-tasks', '--workspace', 'ws1', '--tree']);
    expect(result.code).toBe(0);
    expect(result.err).not.toContain('默认已收敛');
    const issueCall = calls.find(call => call.url.startsWith('/api/issues?'))!;
    expect(issueCall.url).not.toContain('kinds=');
    expect(issueCall.url).not.toContain('unclaimed=');
  });

  it('旧服务端/回滚开关（400）时静默回落全量，输出不变且进程内只回落一次', async () => {
    handler = (method, url) => {
      if (method === 'GET' && url === '/api/workspaces') return { status: 200, body: [WS] };
      if (method === 'GET' && url.includes('fields=')) {
        return { status: 400, body: { error: { code: 'VALIDATION_ERROR', message: '未知字段：fields' } } };
      }
      if (method === 'GET' && url.startsWith('/api/issues?workspace=ws1')) return { status: 200, body: ISSUES };
      return undefined;
    };
    const first = await run(['--json', 'list-tasks', '--workspace', 'ws1']);
    expect(first.code).toBe(0);
    const items = (JSON.parse(first.out) as { items: Array<Record<string, unknown>> }).items;
    expect(items.map(item => item.id)).toEqual(['i1', 'i2', 'i3']);
    expect(Object.keys(items[0]!)).not.toContain('description');
    expect(calls.filter(call => call.url.includes('fields='))).toHaveLength(1);

    const second = await run(['--json', 'list-tasks', '--workspace', 'ws1']);
    expect(second.code).toBe(0);
    expect(calls.filter(call => call.url.includes('fields='))).toHaveLength(1);
    expect(second.out).toBe(first.out);
  });

  it('旧服务端不认 kind=blocked（400）时回落到改造前的收敛集合', async () => {
    handler = (method, url) => {
      if (method === 'GET' && url === '/api/workspaces') return { status: 200, body: [WS] };
      if (method === 'GET' && url.includes('blocked')) {
        return { status: 400, body: { error: { code: 'VALIDATION_ERROR', message: '未知 kind：blocked' } } };
      }
      if (method === 'GET' && url.startsWith('/api/issues?workspace=ws1')) return { status: 200, body: ISSUES };
      return undefined;
    };
    const first = await run(['--json', 'list-tasks', '--workspace', 'ws1']);
    expect(first.code).toBe(0);
    const issueCalls = calls.filter(call => call.url.startsWith('/api/issues?'));
    expect(issueCalls.at(-1)!.url).toBe('/api/issues?workspace=ws1&kinds=open,started,review&unclaimed=1');
    expect((JSON.parse(first.out) as { items: Array<{ id: string }> }).items.map(item => item.id)).toEqual(['i1', 'i2', 'i3']);

    // 进程内记住回落：第二次不再尝试 blocked
    calls = [];
    const second = await run(['--json', 'list-tasks', '--workspace', 'ws1']);
    expect(second.code).toBe(0);
    const secondCalls = calls.filter(call => call.url.startsWith('/api/issues?'));
    expect(secondCalls).toHaveLength(1);
    expect(secondCalls[0]!.url).not.toContain('blocked');
  });

  describe('FETCHC-1 服务端 status= 过滤', () => {
    // 层级：p1(进行中) → p2(已关闭) → 命中(待规划)；root2(待规划) 为根命中；other 为同层非命中
    // 键序与服务端 rowToIssue 一致（补链祖先按 LIST_TASK_FIELDS 剪裁，键序必须可比）
    const treeIssue = (id: string, status: string, parent: string | null): Record<string, unknown> => ({
      id, workspace_id: 'ws1', title: `标题-${id}`, description: `正文-${id}`, priority: '中', labels: [],
      status, sort_order: 0, claimed_by: null, claimed_at: null, session_id: null, parent_issue_id: parent,
      due_date: null, due_time: null, comment_count: 0,
      dependency_violation: null, decision_locked: false, open_decision_id: null, decision_grace_until: null,
      decision_waiting_seconds: null, blocked_by_count: 0, blocked_by_open_count: 0, resolved: false,
      created_at: 1, updated_at: 1, children_total: 0, children_closed: 0,
    });
    const TREE = [
      treeIssue('p1', '进行中', null),
      treeIssue('p2', '已关闭', 'p1'),
      treeIssue('hit', '待规划', 'p2'),
      treeIssue('root2', '待规划', null),
      treeIssue('other', '已关闭', null),
    ];
    const byId = new Map(TREE.map(row => [String(row.id), row]));

    /** 支持 status= 的新服务端：非分页按 status 过滤；单卡详情返回比列表多的列，验证补链剪裁 */
    const statusServer: Handler = (method, url) => {
      if (method === 'GET' && url === '/api/workspaces') return { status: 200, body: [WS] };
      if (method === 'GET' && url === '/api/workspaces/ws1/statuses') return { status: 200, body: STATUSES };
      if (method === 'GET' && url.startsWith('/api/issues?')) {
        const parsed = new URL(url, 'http://x');
        const status = parsed.searchParams.get('status');
        const body = status === null ? TREE : TREE.filter(row => row.status === status);
        return { status: 200, body };
      }
      const detail = /^\/api\/issues\/([^/?]+)\?/.exec(url);
      if (method === 'GET' && detail) {
        const row = byId.get(detail[1]!);
        if (row === undefined) return { status: 404, body: { error: { code: 'NOT_FOUND', message: '任务不存在' } } };
        return { status: 200, body: { ...row, description: '正文', claim_lease_until: null, last_heartbeat_at: null } };
      }
      return undefined;
    };

    it('平铺 --status 只请求命中集（带 status=，不带 kinds=/unclaimed=）', async () => {
      handler = statusServer;
      const result = await run(['--json', 'list-tasks', '--workspace', 'ws1', '--status', '待规划']);
      expect(result.code).toBe(0);
      expect((JSON.parse(result.out) as { items: Array<{ id: string }> }).items.map(item => item.id))
        .toEqual(['hit', 'root2']);
      const issueCalls = calls.filter(call => call.url.startsWith('/api/issues?'));
      expect(issueCalls).toHaveLength(1);
      expect(issueCalls[0]!.url).toContain('&status=%E5%BE%85%E8%A7%84%E5%88%92');
      expect(issueCalls[0]!.url).not.toContain('kinds=');
      expect(issueCalls[0]!.url).not.toContain('unclaimed=');
    });

    it.each(['compact', 'array', 'rejected', 'malformed'])('状态紧凑响应兼容 %s', async mode => {
      handler = (method, url) => {
        if (method !== 'GET' || !url.startsWith('/api/issues?')) return statusServer(method, url);
        const params = new URL(url, 'http://x').searchParams;
        const fields = params.get('fields')!.split(',');
        const rows = TREE.filter(row => row.status === params.get('status'));
        const values = rows.map(row => fields.map(field => row[field]));
        if (params.get('format') === 'compact') {
          if (mode === 'compact') return { status: 200, body: { fields, rows: values } };
          if (mode === 'rejected') return { status: 400, body: { error: { message: 'Unknown format' } } };
          if (mode === 'malformed') return { status: 200, body: { fields, rows: [[]] } };
        }
        return { status: 200, body: values.map(row => Object.fromEntries(fields.map((field, index) => [field, row[index]]))) };
      };
      const result = await run(['--json', 'list-tasks', '--workspace', 'ws1', '--status', '待规划']);
      expect(result.code).toBe(0);
      const { items } = JSON.parse(result.out);
      expect(items.map((item: Record<string, unknown>) => [item.id, item.children_total, item.claimed_by]))
        .toEqual([['hit', 0, null], ['root2', 0, null]]);
      expect(items[0]).not.toHaveProperty('description');
      const issueCalls = calls.filter(call => call.url.startsWith('/api/issues?'));
      expect(issueCalls[0]?.url).toContain('&format=compact');
      expect(issueCalls).toHaveLength(mode === 'compact' || mode === 'array' ? 1 : 2);
    });

    it('树 --status 两段式：命中集 + 骨架 + 逐祖先补链，输出与整区读逐字一致', async () => {
      handler = statusServer;
      const narrowed = await run(['--json', 'list-tasks', '--workspace', 'ws1', '--tree', '--status', '待规划']);
      expect(narrowed.code).toBe(0);
      const narrowedCalls = [...calls];
      // 祖先 p1 / p2 不在命中集，需两次详情补链
      const urls = narrowedCalls.map(call => call.url);
      expect(urls.some(url => url.includes('&status='))).toBe(true);
      expect(urls).toContain('/api/issues?workspace=ws1&fields=id,status,parent_issue_id');
      expect(urls.filter(url => url.startsWith('/api/issues/p') && url.includes('workspace_id=ws1'))).toHaveLength(2);
      // 祖先行走在命中行之前（层级路径完整）：p1(路径) → p2(路径) → hit
      const items = (JSON.parse(narrowed.out) as { items: Array<Record<string, unknown>> }).items;
      expect(items.map(item => item.id)).toEqual(['p1', 'p2', 'hit', 'root2']);
      expect(items.map(item => item.tree_context)).toEqual([true, true, false, false]);
      expect(items.map(item => item.tree_depth)).toEqual([0, 1, 2, 0]);
      // 祖先行按列表字段剪裁：不应混入详情投影的正文
      expect(narrowed.out).not.toContain('正文');
      expect(Object.keys(items[0]!)).not.toContain('description');

      // 对照：status= 被拒时回落整区读（= 改前路径），输出逐字节一致
      handler = (method, url) => {
        if (method === 'GET' && url.startsWith('/api/issues?') && url.includes('status=')) {
          return { status: 400, body: { error: { code: 'VALIDATION_ERROR', message: '未知参数：status' } } };
        }
        return statusServer(method, url);
      };
      const legacy = await run(['--json', 'list-tasks', '--workspace', 'ws1', '--tree', '--status', '待规划']);
      expect(legacy.code).toBe(0);
      expect(narrowed.out).toBe(legacy.out);
    });

    it('读骨架时有任务刚进入筛选状态，回落整区读并保留新命中', async () => {
      handler = (method, url) => {
        if (method === 'GET' && url.startsWith('/api/issues?') && !url.includes('status=')) {
          return { status: 200, body: TREE.map(row => row.id === 'other' ? { ...row, status: '待规划' } : row) };
        }
        return statusServer(method, url);
      };
      const result = await run(['--json', 'list-tasks', '--workspace', 'ws1', '--tree', '--status', '待规划']);
      expect(result.code).toBe(0);
      expect((JSON.parse(result.out) as { items: Array<{ id: string }> }).items.map(item => item.id))
        .toEqual(['p1', 'p2', 'hit', 'root2', 'other']);
    });

    it('status= 返回 400（旧服务端）时回落整区 + 本地筛，退出码 0、输出不变', async () => {
      handler = (method, url) => {
        if (method === 'GET' && url.startsWith('/api/issues?') && url.includes('status=')) {
          return { status: 400, body: { error: { code: 'VALIDATION_ERROR', message: '未知参数：status' } } };
        }
        return statusServer(method, url);
      };
      // 先跑一次建立降级标记，再与「显式整区」口径比对输出
      const flat = await run(['--json', 'list-tasks', '--workspace', 'ws1', '--status', '待规划']);
      expect(flat.code).toBe(0);
      expect(flat.err).toContain('回落整区读取');
      expect((JSON.parse(flat.out) as { items: Array<{ id: string }> }).items.map(item => item.id))
        .toEqual(['hit', 'root2']);

      const tree = await run(['--json', 'list-tasks', '--workspace', 'ws1', '--tree', '--status', '待规划']);
      expect(tree.code).toBe(0);
      const items = (JSON.parse(tree.out) as { items: Array<Record<string, unknown>> }).items;
      expect(items.map(item => item.id)).toEqual(['p1', 'p2', 'hit', 'root2']);

      // 进程内只试一次 status=：后续调用直接走整区
      calls = [];
      const again = await run(['--json', 'list-tasks', '--workspace', 'ws1', '--status', '待规划']);
      expect(again.code).toBe(0);
      expect(calls.filter(call => call.url.includes('status='))).toHaveLength(0);
      expect(again.out).toBe(flat.out);
    });
  });
});
