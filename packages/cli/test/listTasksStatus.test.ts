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
  if (method === 'GET' && url === '/api/issues?workspace=ws1') return { status: 200, body: ISSUES };
  return undefined;
};

const run = async (args: string[]) => {
  const t = makeIo();
  const code = await main(['node', 'kb', '--server', base, ...args], t.io);
  return { code, out: t.out(), err: t.err() };
};

describe('kb list-tasks status guard', () => {
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
    const parsed = JSON.parse(trimmed.out) as Array<Record<string, unknown>>;
    expect(parsed).toHaveLength(3);
    expect(Object.keys(parsed[0]!)).not.toContain('description');
    expect(parsed[0]!.description_omitted).toBe(true);
    expect(trimmed.out).not.toContain('正文-i1');

    const full = await run(['--json', 'list-tasks', '--workspace', 'ws1', '--full']);
    expect(full.code).toBe(0);
    const fullParsed = JSON.parse(full.out) as Array<Record<string, unknown>>;
    expect(fullParsed[0]!.description).toBe('正文-i1');
    expect(fullParsed[0]!.description_omitted).toBeUndefined();
  });
});
