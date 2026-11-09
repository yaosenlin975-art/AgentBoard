/**
 * OPT-11：`kb stats` —— 五状态 / 未完成无主 / 被阻塞 汇总计数。
 * 覆盖：计数口径（含自定义状态不计入五行）、workspace id + 生成时间、--json、fields 400 回落。
 */
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { main } from '../src/index.js';

interface Recorded { method: string; url: string }
type MockReply = { status: number; body?: unknown } | undefined;
type Handler = (method: string, url: string) => MockReply;

const WS = { id: 'ws1', name: '统计空间', path: 'D:/ws/stats', created_at: 1 };

const issue = (id: string, status: string, over: Record<string, unknown> = {}): Record<string, unknown> => ({
  id, workspace_id: 'ws1', title: `标题-${id}`, description: '', priority: '中', labels: [],
  status, sort_order: 0, parent_issue_id: null, claimed_by: null, claimed_at: null,
  session_id: null, comment_count: 0, blocked_by_open_count: 0, created_at: 1, updated_at: 1, ...over,
});

const ISSUES = [
  issue('i-1', '待规划', { blocked_by_open_count: 1 }),
  issue('i-2', '待规划', { claimed_by: 'trae' }),
  issue('i-3', '进行中', { claimed_by: 'trae' }),
  issue('i-4', '待验收'),
  issue('i-5', '已关闭'),
  issue('i-6', '已废弃'),
  issue('i-7', '自定义状态'), // 自定义状态不计入五行，但计入覆盖总数
];

let server: Server;
let base = '';
let calls: Recorded[] = [];
let handler: Handler = () => undefined;

beforeEach(async () => {
  calls = [];
  handler = (method, url) => {
    if (method === 'GET' && url === '/api/workspaces') return { status: 200, body: [WS] };
    if (method === 'GET' && url.startsWith('/api/issues?workspace=ws1')) return { status: 200, body: ISSUES };
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
  return main(['node', 'kb', '--server', base, 'stats', '--workspace', 'ws1', ...args], t.io)
    .then(code => ({ code, ...t }));
};

describe('kb stats 汇总计数（OPT-11）', () => {
  it('五状态计数、未完成无主、被阻塞与覆盖总数口径正确', async () => {
    const result = await run([]);
    expect(result.code).toBe(0);
    expect(result.out()).toContain('待规划: 2');
    expect(result.out()).toContain('进行中: 1');
    expect(result.out()).toContain('待验收: 1');
    expect(result.out()).toContain('已关闭: 1');
    expect(result.out()).toContain('已废弃: 1');
    // 未完成无主 = i-1 + i-4（i-2/i-3 有占用；已关闭/已废弃/自定义不算未完成）
    expect(result.out()).toContain('无主（未完成）: 2');
    // 被阻塞 = 未完成且 blocked_by_open_count > 0
    expect(result.out()).toContain('被阻塞（未完成，有未解除前置）: 1');
    // 自定义状态不计入五行，但计入总数
    expect(result.out()).toContain('覆盖卡总数: 7');
  });

  it('输出含 workspace id 与本地生成时间，并给出一条复算命令', async () => {
    const result = await run([]);
    expect(result.out()).toContain('工作区: ws1');
    expect(result.out()).toMatch(/生成时间: \d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}[+-]\d{2}:\d{2}/);
    expect(result.out()).toContain('复算：kb list-tasks --workspace ws1 --status');
    // 只取一次 issues：不再逐状态跑五条 list-tasks
    expect(calls.filter(c => c.url.startsWith('/api/issues?workspace=ws1'))).toHaveLength(1);
  });

  it('--json 输出结构化计数', async () => {
    const result = await run(['--json']);
    expect(result.code).toBe(0);
    expect(JSON.parse(result.out())).toMatchObject({
      workspace_id: 'ws1',
      statuses: { 待规划: 2, 进行中: 1, 待验收: 1, 已关闭: 1, 已废弃: 1 },
      unclaimed_open: 2,
      blocked_open: 1,
      total: 7,
    });
  });

  it('老服务端不认 fields（400）→ 回落整对象请求，计数不变', async () => {
    const plain = handler;
    handler = (method, url) => {
      if (method === 'GET' && url.includes('&fields=')) return { status: 400, body: { error: { code: 'VALIDATION', message: 'unknown field' } } };
      return plain(method, url);
    };
    const result = await run([]);
    expect(result.code).toBe(0);
    expect(result.out()).toContain('待规划: 2');
    expect(calls.filter(c => c.url.startsWith('/api/issues?workspace=ws1'))).toHaveLength(2);
  });
});
