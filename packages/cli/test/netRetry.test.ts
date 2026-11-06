/**
 * CLI-RETRY：GET 类命令网络抖动自动重试一次 + 网络层错误分三类文案。
 * 用真实 node:http 假服务端，靠 res.socket.resetAndDestroy() 造出真 ECONNRESET（实测 undici cause 链为
 * TypeError: fetch failed -> Error(code=ECONNRESET, "read ECONNRESET")），并按路由计数证明「只重试一次 / 写请求不重试」。
 */
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GET_RETRY_DELAY_MS, resetVersionWarned } from '../src/api.js';
import { main } from '../src/index.js';

interface Recorded { method: string; path: string }

interface MockIssue {
  id: string;
  workspace_id: string;
  title: string;
  description: string;
  priority: string;
  labels: string[];
  status: string;
  sort_order: number;
  parent_issue_id: null;
  claimed_by: null;
  claimed_at: null;
  session_id: null;
  comment_count: number;
  created_at: number;
  updated_at: number;
}

function blankIssue(id: string): MockIssue {
  return {
    id,
    workspace_id: 'ws1',
    title: '',
    description: '',
    priority: '中',
    labels: [],
    status: '待规划',
    sort_order: 0,
    parent_issue_id: null,
    claimed_by: null,
    claimed_at: null,
    session_id: null,
    comment_count: 0,
    created_at: 1,
    updated_at: 2,
  };
}

const ISSUE_ID = 'iss-net-retry';
const WS = [{ id: 'ws1', name: '前端', path: 'D:/ws/frontend', created_at: 1 }];

let server: Server;
let base = '';
let calls: Recorded[] = [];
let issues = new Map<string, MockIssue>();
/** `METHOD path` → 还需断连几次（每次请求消耗一次，用完即恢复正常） */
let resetByRoute: Record<string, number> = {};
/** `METHOD path` → 该路由固定返回的 HTTP 状态（4xx/5xx，用于验证不重试） */
let statusByRoute: Record<string, number> = {};

const key = (method: string, path: string) => `${method} ${path}`;

const countOf = (method: string, path: string) => calls.filter((c) => c.method === method && c.path === path).length;

beforeEach(async () => {
  resetVersionWarned();
  calls = [];
  issues = new Map();
  resetByRoute = {};
  statusByRoute = {};
  server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(c as Buffer));
    req.on('end', () => {
      const method = req.method ?? '';
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      const path = url.pathname;
      const raw = Buffer.concat(chunks).toString('utf8');
      const payload = (raw === '' ? {} : JSON.parse(raw)) as Record<string, unknown>;
      calls.push({ method, path });
      const route = key(method, path);
      const fixed = statusByRoute[route];
      if (fixed !== undefined) {
        res.writeHead(fixed, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: { code: 'MOCK_HTTP', message: `mock 固定 ${fixed}` } }));
        return;
      }
      if ((resetByRoute[route] ?? 0) > 0) {
        resetByRoute[route] = (resetByRoute[route] ?? 1) - 1;
        res.socket?.resetAndDestroy();
        return;
      }
      const send = (status: number, body: unknown) => {
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(body));
      };

      if (method === 'GET' && path === '/api/workspaces') return send(200, WS);
      if (method === 'POST' && path === '/api/issues') {
        const issue: MockIssue = {
          ...blankIssue(ISSUE_ID),
          workspace_id: String(payload.workspace_id ?? 'ws1'),
          title: String(payload.title ?? ''),
          description: String(payload.description ?? ''),
        };
        issues.set(issue.id, issue);
        return send(201, issue);
      }
      if (method === 'PATCH' && path === `/api/issues/${ISSUE_ID}`) {
        const stored = issues.get(ISSUE_ID) ?? blankIssue(ISSUE_ID);
        if (payload.title !== undefined) stored.title = String(payload.title);
        if (payload.description !== undefined) stored.description = String(payload.description);
        issues.set(ISSUE_ID, stored);
        return send(200, stored);
      }
      if (method === 'GET' && path === `/api/issues/${ISSUE_ID}`) return send(200, issues.get(ISSUE_ID) ?? blankIssue(ISSUE_ID));
      return send(404, { error: { code: 'MOCK', message: 'mock 未匹配' } });
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterEach(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

function makeIo(stdinText = '') {
  const out: string[] = [];
  const err: string[] = [];
  return {
    io: { write: (s: string) => { out.push(s); }, writeErr: (s: string) => { err.push(s); }, readStdin: async () => stdinText },
    out: () => out.join(''),
    err: () => err.join(''),
  };
}

/**
 * 一次命令调用：同时收集注入 Io 的 stderr 与真实 process.stderr（重试提示走 process.stderr，与版本警告同口径），
 * 并记录整段耗时用于核对重试间隔口径。
 */
async function run(args: string[], stdinText = '') {
  const t = makeIo(stdinText);
  const chunks: string[] = [];
  const spy = vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
    chunks.push(String(chunk));
    return true;
  });
  const started = Date.now();
  try {
    const code = await main(['node', 'kb', '--server', base, ...args], t.io);
    return { code, out: t.out(), err: `${t.err()}${chunks.join('')}`, elapsed: Date.now() - started };
  } finally {
    spy.mockRestore();
  }
}

describe('CLI-RETRY GET 抖动重试', () => {
  it('首个 GET 断连、第二次正常 → exit 0 + stderr「已重试 1 次」，且间隔 ≤300ms', async () => {
    resetByRoute = { [key('GET', '/api/workspaces')]: 1 };
    const r = await run(['list-spaces']);
    expect(r.code).toBe(0);
    expect(r.out).toContain('前端');
    expect(r.err).toContain('已重试 1 次');
    expect(countOf('GET', '/api/workspaces')).toBe(2);
    // 口径：间隔 ≤300ms（常量 + 实际耗时双向核对，留出本机调度余量）
    expect(GET_RETRY_DELAY_MS).toBeLessThanOrEqual(300);
    expect(r.elapsed).toBeGreaterThanOrEqual(GET_RETRY_DELAY_MS - 50);
    expect(r.elapsed).toBeLessThanOrEqual(300 + 400);
  });

  it('连续两次断连 → exit 1，文案含 ECONNRESET 与「服务端可能未启动/网络抖动」，且只重试一次', async () => {
    resetByRoute = { [key('GET', '/api/workspaces')]: 2 };
    const r = await run(['list-spaces']);
    expect(r.code).toBe(1);
    expect(r.err).toContain('ECONNRESET');
    expect(r.err).toContain('服务端可能未启动/网络抖动');
    expect(r.err).toContain(base);
    expect(countOf('GET', '/api/workspaces')).toBe(2);
  });

  it('ECONNREFUSED（无监听端口）同样重试一次，文案保持「看板服务未启动」', async () => {
    const probe = createServer();
    await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', resolve));
    const deadPort = (probe.address() as AddressInfo).port;
    await new Promise<void>((resolve) => probe.close(() => resolve()));

    const t = makeIo();
    const started = Date.now();
    const code = await main(['node', 'kb', '--server', `http://127.0.0.1:${deadPort}`, 'list-spaces'], t.io);
    expect(code).toBe(1);
    expect(t.err()).toContain('看板服务未启动');
    expect(t.err()).toContain('启动：');
    // 拒绝连接同样走「重试一次」：两次尝试之间隔着 GET_RETRY_DELAY_MS
    expect(Date.now() - started).toBeGreaterThanOrEqual(GET_RETRY_DELAY_MS - 50);
  });

  it('4xx/5xx 不触发重试（请求计数 = 1，原样透出服务端文案）', async () => {
    statusByRoute = { [key('GET', '/api/workspaces')]: 500 };
    const r500 = await run(['list-spaces']);
    expect(r500.code).toBe(1);
    expect(r500.err).toContain('mock 固定 500');
    expect(r500.err).not.toContain('已重试');
    expect(countOf('GET', '/api/workspaces')).toBe(1);

    calls = [];
    statusByRoute = { [key('GET', '/api/workspaces')]: 404 };
    const r404 = await run(['list-spaces']);
    expect(r404.code).toBe(1);
    expect(r404.err).not.toContain('已重试');
    expect(countOf('GET', '/api/workspaces')).toBe(1);
  });
});

describe('CLI-RETRY 写请求不重试', () => {
  it('POST 断连只发 1 次请求（第二次本会成功），exit 1 并提示复用 --request-id', async () => {
    resetByRoute = { [key('POST', '/api/issues')]: 1 };
    const r = await run([
      'create-issue', 'ws1', '网络抖动卡', '-d', '正文与验收',
      '--request-id', '00000000-0000-4000-8000-000000000301',
    ]);
    expect(r.code).toBe(1);
    expect(r.err).toContain('ECONNRESET');
    expect(r.err).toContain('网络中断；重试请复用 --request-id');
    expect(countOf('POST', '/api/issues')).toBe(1);
    // 写请求失败后不该再有 MOJI-GUARD 回读
    expect(countOf('GET', `/api/issues/${ISSUE_ID}`)).toBe(0);
  });

  it('PATCH 断连只发 1 次请求，exit 1 并提示复用 --request-id', async () => {
    issues.set(ISSUE_ID, blankIssue(ISSUE_ID));
    resetByRoute = { [key('PATCH', `/api/issues/${ISSUE_ID}`)]: 1 };
    const r = await run(['update', ISSUE_ID, '--title', '抖动改标题']);
    expect(r.code).toBe(1);
    expect(r.err).toContain('网络中断；重试请复用 --request-id');
    expect(countOf('PATCH', `/api/issues/${ISSUE_ID}`)).toBe(1);
  });

  it('MOJI-GUARD 语义不破：校验用的回读 GET 断连只补发读请求，写请求仍只 1 次且最终 exit 0', async () => {
    resetByRoute = { [key('GET', `/api/issues/${ISSUE_ID}`)]: 1 };
    const r = await run([
      'create-issue', 'ws1', '回读抖动卡', '-d', '正文与验收',
      '--request-id', '00000000-0000-4000-8000-000000000302',
    ]);
    expect(r.code).toBe(0);
    expect(r.err).not.toContain('写入校验失败');
    expect(r.err).toContain('已重试 1 次');
    expect(countOf('POST', '/api/issues')).toBe(1);
    expect(countOf('GET', `/api/issues/${ISSUE_ID}`)).toBe(2);
  });

  it('回读 GET 撞 404 属 HTTP 错误：不重试（计数 = 1），仍按 MOJI-GUARD 报「回读…未成功」', async () => {
    statusByRoute = { [key('GET', `/api/issues/${ISSUE_ID}`)]: 404 };
    const r = await run([
      'create-issue', 'ws1', '回读缺失卡', '-d', '正文与验收',
      '--request-id', '00000000-0000-4000-8000-000000000303',
    ]);
    expect(r.code).toBe(1);
    expect(r.err).toContain('写入校验失败');
    expect(r.err).toContain('回读');
    expect(r.err).not.toContain('已重试');
    expect(countOf('POST', '/api/issues')).toBe(1);
    expect(countOf('GET', `/api/issues/${ISSUE_ID}`)).toBe(1);
  });
});
