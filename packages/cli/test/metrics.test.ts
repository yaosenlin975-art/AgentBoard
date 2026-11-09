/**
 * ARCH-06：CLI 输出体积可观测（KB_METRICS）。
 * - 未设 / 设为 0：stdout 与 stderr 与改造前逐字一致（埋点层透明）；
 * - 设为 1：stdout 不变，stderr 恰好新增一行 `[kb] cmd=<cmd> out=<n>B lines=<m>`；
 * - `--json`：stdout 仍可被 JSON.parse，指标行只走 stderr；
 * - 失败路径：退出码不变，指标行仍只追加在 stderr 末尾。
 */
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SERVER_VERSION_HEADER } from '../src/api.js';
import { main } from '../src/index.js';
import { CLI_VERSION } from '../src/version.js';

const WS = { id: 'ws1', name: '指标空间', path: 'D:/ws/metrics', created_at: 1 };
const ISSUE = {
  id: 'iss1',
  workspace_id: 'ws1',
  title: '实现登录',
  description: '描述\n多行',
  priority: '高',
  labels: ['p1'],
  status: '待规划',
  sort_order: 0,
  claimed_by: null,
  claimed_at: null,
  session_id: null,
  comment_count: 2,
  created_at: 2,
  updated_at: 3,
};
const COMMENTS = [
  { id: 'c1', issue_id: 'iss1', author: 'user', content: '开工前注意兼容旧数据', ts: 5 },
  { id: 'c2', issue_id: 'iss1', author: 'agent:codebuddy', content: '已完成解析层', ts: 6 },
];

const METRIC_LINE = /^\[kb\] cmd=([a-z-]+) out=(\d+)B lines=(\d+)\n$/;

type MockReply = { status: number; body?: unknown } | undefined;
type Handler = (method: string, pathname: string) => MockReply;

let server: Server;
let base = '';
let handler: Handler = () => undefined;

const reply = (body: unknown, status = 200): MockReply => ({ status, body });

beforeEach(async () => {
  handler = (method, pathname) => {
    if (method === 'GET' && pathname === '/api/workspaces') return reply([WS]);
    if (method === 'GET' && pathname === '/api/issues') return reply([ISSUE]);
    if (method === 'GET' && pathname === '/api/issues/iss1') return reply(ISSUE);
    if (method === 'GET' && pathname === '/api/issues/iss1/comments') return reply(COMMENTS);
    if (method === 'POST' && pathname === '/api/issues/iss1/claim') {
      return reply({ ...ISSUE, status: '进行中', claimed_by: 'kb-cli', claimed_at: 10 });
    }
    if (method === 'GET' && pathname === '/api/knowledge/search') return reply({ items: [], next_offset: null });
    if (pathname.startsWith('/api/issues/')) return reply({ error: { code: 'NOT_FOUND', message: '任务不存在' } }, 404);
    return undefined;
  };
  server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', chunk => chunks.push(chunk as Buffer));
    req.on('end', () => {
      const pathname = new URL(req.url ?? '/', 'http://mock').pathname;
      const matched = handler(req.method ?? '', pathname);
      if (!matched) {
        res.writeHead(404, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: { code: 'NOT_FOUND', message: 'mock 未匹配' } }));
        return;
      }
      res.writeHead(matched.status, { 'content-type': 'application/json', [SERVER_VERSION_HEADER]: CLI_VERSION });
      res.end(matched.body === undefined ? '' : JSON.stringify(matched.body));
    });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterEach(async () => {
  await new Promise<void>(resolve => server.close(() => resolve()));
  delete process.env.KB_METRICS;
});

interface RunResult { code: number; out: string; err: string }

/** metrics 传 undefined 时不设置 KB_METRICS；跑完恢复原值 */
async function run(args: string[], metrics?: string): Promise<RunResult> {
  const chunks = { out: '', err: '' };
  const io = {
    write: (text: string) => { chunks.out += text; },
    writeErr: (text: string) => { chunks.err += text; },
    readStdin: async () => '',
  };
  const previous = process.env.KB_METRICS;
  if (metrics === undefined) delete process.env.KB_METRICS;
  else process.env.KB_METRICS = metrics;
  try {
    const code = await main(['node', 'kb', '--server', base, ...args], io);
    return { code, out: chunks.out, err: chunks.err };
  } finally {
    if (previous === undefined) delete process.env.KB_METRICS;
    else process.env.KB_METRICS = previous;
  }
}

describe('ARCH-06 KB_METRICS 输出体积埋点', () => {
  it('未设 / 设为 0：stdout 与 stderr 与改造前逐字一致', async () => {
    const baseline = await run(['show', 'iss1']);
    expect(baseline.code).toBe(0);
    expect(baseline.err).toBe('');
    expect(baseline.out).toContain('id: iss1');

    const zero = await run(['show', 'iss1'], '0');
    expect(zero.code).toBe(baseline.code);
    expect(zero.out).toBe(baseline.out);
    expect(zero.err).toBe('');
  });

  it('KB_METRICS=1：stdout 不变，stderr 恰好新增一行且字节数/行数与 stdout 吻合', async () => {
    const baseline = await run(['show', 'iss1']);
    const measured = await run(['show', 'iss1'], '1');

    expect(measured.code).toBe(baseline.code);
    expect(measured.out).toBe(baseline.out); // 验收②：stdout 不受影响
    expect(measured.err).toMatch(METRIC_LINE); // 验收②：只多一行，格式固定
    const line = measured.err;
    expect(line.split('\n').filter(Boolean)).toHaveLength(1);
    const match = METRIC_LINE.exec(line)!;
    expect(match[1]).toBe('show');
    expect(Number(match[2])).toBe(Buffer.byteLength(baseline.out, 'utf8'));
    expect(Number(match[3])).toBe(baseline.out.split('\n').length - 1);
  });

  it('KB_METRICS=1 覆盖 list-tasks / claim / knowledge 的顶层 cmd 解析', async () => {
    const listBaseline = await run(['list-tasks', '--workspace', 'ws1', '--all-status']);
    const listMeasured = await run(['list-tasks', '--workspace', 'ws1', '--all-status'], '1');
    expect(listMeasured.out).toBe(listBaseline.out);
    expect(listMeasured.err).toMatch(/^\[kb\] cmd=list-tasks out=\d+B lines=\d+\n$/);

    const claimMeasured = await run(['claim', 'iss1'], '1');
    expect(claimMeasured.code).toBe(0);
    expect(claimMeasured.err).toMatch(/^\[kb\] cmd=claim out=\d+B lines=\d+\n$/);

    const knowledgeMeasured = await run(['knowledge', 'search', '缓存', '--scope', 'common'], '1');
    expect(knowledgeMeasured.code).toBe(0);
    expect(knowledgeMeasured.err).toMatch(/^\[kb\] cmd=knowledge out=\d+B lines=\d+\n$/);
  });

  it('--json + KB_METRICS=1：stdout 仍可 JSON.parse，指标行只走 stderr', async () => {
    const measured = await run(['show', 'iss1', '--json'], '1');
    expect(measured.code).toBe(0);
    expect(() => JSON.parse(measured.out)).not.toThrow();
    expect(JSON.parse(measured.out)).toMatchObject({ id: 'iss1', comments: COMMENTS });
    expect(measured.err).toMatch(/^\[kb\] cmd=show out=\d+B lines=\d+\n$/);
  });

  it('失败路径：退出码不变，原 stderr 保留、指标行追加在末尾', async () => {
    const args = ['show', '00000000-0000-4000-8000-000000000000'];
    const baseline = await run(args);
    const measured = await run(args, '1');

    expect(baseline.code).toBe(1);
    expect(measured.code).toBe(baseline.code); // 验收：退出码不改变
    expect(measured.out).toBe(baseline.out);
    expect(baseline.err).toContain('任务不存在');
    expect(measured.err.startsWith(baseline.err)).toBe(true);
    expect(measured.err.slice(baseline.err.length)).toMatch(/^\[kb\] cmd=show out=\d+B lines=\d+\n$/);
  });
});
