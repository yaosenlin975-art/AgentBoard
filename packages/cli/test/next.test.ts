/**
 * OPT-10：`kb next` —— 可派卡 = 待规划 · 无占用 · 前置全部解除。
 * 覆盖：过滤口径、父卡/前置字段、--limit、空结果、参数校验、--json 信封。
 */
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { main } from '../src/index.js';

interface Recorded { method: string; url: string }
type MockReply = { status: number; body?: unknown } | undefined;
type Handler = (method: string, url: string) => MockReply;

const WS = { id: 'ws1', name: '派活空间', path: 'D:/ws/next', created_at: 1 };

const issue = (id: string, over: Record<string, unknown> = {}): Record<string, unknown> => ({
  id, workspace_id: 'ws1', title: `标题-${id}`, description: '', priority: '中', labels: [],
  status: '待规划', sort_order: 0, parent_issue_id: null, claimed_by: null, claimed_at: null,
  session_id: null, comment_count: 0, created_at: 1, updated_at: 1, ...over,
});

const ref = (id: string, resolved: boolean, status = resolved ? '已关闭' : '进行中'): Record<string, unknown> => ({
  issue_id: id, title: `标题-${id}`, status, resolved,
});

const ISSUES = [
  issue('aaaaaaaa-0000-4000-8000-000000000001', { parent_issue_id: 'cccccccc-0000-4000-8000-000000000001' }),
  issue('aaaaaaaa-0000-4000-8000-000000000002', { claimed_by: 'trae' }), // 已占用
  issue('aaaaaaaa-0000-4000-8000-000000000003', { status: '待验收' }), // 非待规划
  issue('aaaaaaaa-0000-4000-8000-000000000004'), // 前置未解除
  issue('aaaaaaaa-0000-4000-8000-000000000005', { labels: ['cli'] }), // 与 006 同标签
  issue('aaaaaaaa-0000-4000-8000-000000000006', { labels: ['cli'] }),
  issue('aaaaaaaa-0000-4000-8000-000000000007', { status: '已关闭' }),
];

const DEPS: Record<string, Record<string, unknown>> = {
  'aaaaaaaa-0000-4000-8000-000000000001': {
    blockers: [{ ...ref('bbbbbbbb-0000-4000-8000-000000000001', true, '待验收'), relation: 'blocks' }],
    blocked: [{ ...ref('dddddddd-0000-4000-8000-000000000001', false), relation: 'blocks' }],
  },
  'aaaaaaaa-0000-4000-8000-000000000004': {
    blockers: [{ ...ref('bbbbbbbb-0000-4000-8000-000000000002', false, '进行中'), relation: 'blocks' }],
    blocked: [],
  },
};

let server: Server;
let base = '';
let calls: Recorded[] = [];
let handler: Handler = () => undefined;

beforeEach(async () => {
  calls = [];
  handler = (method, url) => {
    if (method === 'GET' && url === '/api/workspaces') return { status: 200, body: [WS] };
    if (method === 'GET' && url === '/api/issues?workspace=ws1') return { status: 200, body: ISSUES };
    const dep = /^\/api\/issues\/([^/]+)\/dependencies\?workspace_id=ws1$/.exec(url);
    if (method === 'GET' && dep) return { status: 200, body: DEPS[dep[1]!] ?? { blockers: [], blocked: [] } };
    return undefined;
  };
  server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', chunk => chunks.push(chunk as Buffer));
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

function makeIo(): { io: Parameters<typeof main>[1]; out: () => string; err: () => string } {
  let out = '';
  let err = '';
  return {
    io: { write: (text: string) => { out += text; }, writeErr: (text: string) => { err += text; } },
    out: () => out,
    err: () => err,
  };
}

const run = (args: string[]) => {
  const t = makeIo();
  return main(['node', 'kb', '--server', base, 'next', '--workspace', 'ws1', ...args], t.io)
    .then(code => ({ code, ...t }));
};

describe('kb next 可派卡组合视图（OPT-10）', () => {
  it('只返回 待规划 + 无占用 + 前置全部解除 的卡', async () => {
    const result = await run([]);
    expect(result.code).toBe(0);
    // 1/5/6 可派；2 已占用、3 非待规划、4 前置未解除、7 已关闭都被排除
    expect(result.out()).toContain('可派卡 3 张');
    expect(result.out()).toContain('【1】aaaaaaaa');
    expect(result.out()).toContain('标题-aaaaaaaa-0000-4000-8000-000000000001');
    expect(result.out()).not.toContain('标题-aaaaaaaa-0000-4000-8000-000000000002');
    expect(result.out()).not.toContain('标题-aaaaaaaa-0000-4000-8000-000000000004');
  });

  it('输出含父卡 parent_issue_id 与前置（blocker）id', async () => {
    const result = await run([]);
    expect(result.out()).toContain('父卡: cccccccc');
    expect(result.out()).toContain('前置: bbbbbbbb(待验收)');
    // 只为候选卡取依赖：已占用/非待规划/已关闭的卡不发 dep 请求
    expect(calls.some(c => c.url.includes('000000000002/dependencies'))).toBe(false);
    expect(calls.some(c => c.url.includes('000000000003/dependencies'))).toBe(false);
    expect(calls.some(c => c.url.includes('000000000007/dependencies'))).toBe(false);
  });

  it('--limit 截断文本条数与 --json items，但总数行仍报真实可派数', async () => {
    const text = await run(['--limit', '1']);
    expect(text.code).toBe(0);
    expect(text.out()).toContain('可派卡 3 张（显示 1 张');
    const json = await run(['--limit', '2', '--json']);
    const payload = JSON.parse(json.out()) as { items: Array<Record<string, unknown>>; next_offset: number | null };
    expect(payload.items).toHaveLength(2);
    expect(payload.next_offset).toBeNull();
    expect(payload.items[0]).toMatchObject({ status: '待规划', parent_issue_id: 'cccccccc-0000-4000-8000-000000000001' });
    expect((payload.items[0]!.blockers as Array<Record<string, unknown>>)[0]).toMatchObject({ issue_id: 'bbbbbbbb-0000-4000-8000-000000000001', resolved: true });
  });

  it('无可派卡：输出「（无可派卡）」且退出码 0；--json 空 items', async () => {
    handler = (method, url) => {
      if (method === 'GET' && url === '/api/workspaces') return { status: 200, body: [WS] };
      if (method === 'GET' && url === '/api/issues?workspace=ws1') return { status: 200, body: [issue('aaaaaaaa-0000-4000-8000-000000000009', { claimed_by: 'x' })] };
      return undefined;
    };
    const text = await run([]);
    expect(text.code).toBe(0);
    expect(text.out()).toBe('（无可派卡）\n');
    const json = await run(['--json']);
    expect(JSON.parse(json.out())).toEqual({ items: [], next_offset: null });
  });

  it('--limit 非法：退出 1 且不发请求', async () => {
    const result = await run(['--limit', 'zero']);
    expect(result.code).toBe(1);
    expect(result.err()).toContain('--limit');
    expect(calls).toHaveLength(0);
  });
});
