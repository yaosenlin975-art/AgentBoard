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
});
