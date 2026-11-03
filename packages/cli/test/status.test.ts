/**
 * STATUS-2：`kb status ls|add|rm` 的 HTTP 契约与输出（真本地 mock HTTP，不 mock fetch）。
 */
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { main } from '../src/index.js';

interface Recorded { method: string; url: string; body: unknown }
type MockReply = { status: number; body?: unknown } | undefined;
type Handler = (method: string, url: string, body: unknown) => MockReply;

const WS = { id: 'ws1', name: '状态空间', path: 'D:/ws/status', created_at: 1 };
const STATUSES = [
  { id: 's-open', workspace_id: 'ws1', name: '待规划', kind: 'open', sort_order: 0, is_builtin: 1 },
  { id: 's-doing', workspace_id: 'ws1', name: '进行中', kind: 'started', sort_order: 10, is_builtin: 1 },
  { id: 's-custom', workspace_id: 'ws1', name: '待复测', kind: 'review', sort_order: 50, is_builtin: 0 },
];

let server: Server;
let base = '';
let calls: Recorded[] = [];
let handler: Handler = () => undefined;

beforeEach(async () => {
  calls = [];
  handler = () => undefined;
  server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', chunk => chunks.push(chunk as Buffer));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      let body: unknown;
      try { body = raw === '' ? undefined : JSON.parse(raw); } catch { body = raw; }
      calls.push({ method: req.method ?? '', url: req.url ?? '', body });
      const reply = handler(req.method ?? '', req.url ?? '', body);
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

/** 所有命令都先解析 workspace（GET /api/workspaces） */
const withWorkspaces = (inner: Handler): Handler => (method, url, body) => (
  method === 'GET' && url === '/api/workspaces' ? { status: 200, body: [WS] } : inner(method, url, body)
);

const run = async (args: string[]) => {
  const t = makeIo();
  const code = await main(['node', 'kb', '--server', base, ...args], t.io);
  return { code, out: t.out(), err: t.err() };
};

describe('kb status', () => {
  it('lists statuses with kind and builtin marker', async () => {
    handler = withWorkspaces((method, url) => (
      method === 'GET' && url === '/api/workspaces/ws1/statuses' ? { status: 200, body: STATUSES } : undefined
    ));
    const result = await run(['status', 'ls', '状态空间']);
    expect(result.code).toBe(0);
    expect(result.out).toContain('工作区 ws1 的状态（3 个）');
    expect(result.out).toContain('待规划');
    expect(result.out).toContain('内置');
    expect(result.out).toContain('待复测');
    expect(result.out).toContain('自定义');
  });

  it('adds a custom status with kind and sort order', async () => {
    handler = withWorkspaces((method, url) => (
      method === 'POST' && url === '/api/workspaces/ws1/statuses'
        ? { status: 201, body: { id: 's-new', workspace_id: 'ws1', name: '待复测', kind: 'review', sort_order: 60, is_builtin: 0 } }
        : undefined
    ));
    const result = await run(['status', 'add', 'ws1', '待复测', '--kind', 'review', '--sort-order', '60']);
    expect(result.code).toBe(0);
    expect(result.out).toContain('已新增状态：待复测（kind=review，排序 60');
    expect(calls[1]).toEqual({ method: 'POST', url: '/api/workspaces/ws1/statuses', body: { workspace_id: 'ws1', name: '待复测', kind: 'review', sort_order: 60 } });
  });

  it('removes a status by name with migrate-to', async () => {
    handler = withWorkspaces((method, url) => {
      if (method === 'GET' && url === '/api/workspaces/ws1/statuses') return { status: 200, body: STATUSES };
      if (method === 'DELETE' && url.startsWith('/api/workspaces/ws1/statuses/s-custom')) {
        return { status: 200, body: { removed: STATUSES[2], migrate_to: '进行中', migrated_issue_count: 2 } };
      }
      return undefined;
    });
    const result = await run(['status', 'rm', 'ws1', '待复测', '--migrate-to', '进行中']);
    expect(result.code).toBe(0);
    expect(result.out).toContain('已删除状态：待复测；2 张卡迁移到 进行中');
    expect(calls[2]!.url).toBe('/api/workspaces/ws1/statuses/s-custom?migrate_to=%E8%BF%9B%E8%A1%8C%E4%B8%AD');
  });

  it('surfaces migration-required error from the server', async () => {
    handler = withWorkspaces((method, url) => {
      if (method === 'GET' && url === '/api/workspaces/ws1/statuses') return { status: 200, body: STATUSES };
      if (method === 'DELETE' && url.startsWith('/api/workspaces/ws1/statuses/s-custom')) {
        return { status: 400, body: { error: { code: 'MIGRATION_TARGET_REQUIRED', message: '删除状态 待复测 前必须指定迁移目标（migrate_to）' } } };
      }
      return undefined;
    });
    const result = await run(['status', 'rm', 'ws1', '待复测']);
    expect(result.code).toBe(1);
    expect(result.err).toContain('必须指定迁移目标');
  });

  it('reports builtin rejection with exit code 2 and an unwrapped message', async () => {
    handler = withWorkspaces((method, url) => {
      if (method === 'GET' && url === '/api/workspaces/ws1/statuses') return { status: 200, body: STATUSES };
      if (method === 'DELETE' && url.startsWith('/api/workspaces/ws1/statuses/s-open')) {
        return { status: 409, body: { error: { code: 'WORKSPACE_STATUS_BUILTIN', message: '内置状态不可删除：待规划' } } };
      }
      return undefined;
    });
    const result = await run(['status', 'rm', 'ws1', '待规划', '--migrate-to', '进行中']);
    expect(result.code).toBe(2);
    expect(result.err).toContain('内置状态不可删除');
    // 不得被全局 toExit 包装成「已被占用（内置状态不可删除：…）」
    expect(result.err).not.toContain('已被占用（');
  });

  it('reports unknown local status name before calling the API', async () => {
    handler = withWorkspaces((method, url) => (
      method === 'GET' && url === '/api/workspaces/ws1/statuses' ? { status: 200, body: STATUSES } : undefined
    ));
    const result = await run(['status', 'rm', 'ws1', '不存在的状态', '--migrate-to', '进行中']);
    expect(result.code).toBe(1);
    expect(result.err).toContain('状态不存在：不存在的状态');
    // 只有 2 次请求：解析工作区 + 列表；没有发 DELETE
    expect(calls.filter(call => call.method === 'DELETE')).toHaveLength(0);
  });
});
