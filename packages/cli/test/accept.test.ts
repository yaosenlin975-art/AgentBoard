/**
 * ACCEPT-1：`kb accept` 结构化验收记录。
 * 覆盖：待验收写入固定格式评论、reviewer 覆盖、非待验收 exit 2 且不写、缺参 exit 1、幂等 request-id 透传。
 */
import { createServer, type Server } from 'node:http';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { main } from '../src/index.js';

interface Recorded { method: string; url: string; body: unknown; requestId?: string }

const ISSUE = {
  id: 'iss-accept', workspace_id: 'ws1', title: '待验收卡', description: '验收标准：x', priority: '中',
  labels: [], status: '待验收', sort_order: 0, claimed_by: null, claimed_at: null,
  session_id: null, comment_count: 0, created_at: 1, updated_at: 2,
};

let server: Server;
let base = '';
let calls: Recorded[] = [];
let handler: (method: string, url: string, body: unknown) => { status: number; body?: unknown } | undefined = () => undefined;

beforeEach(async () => {
  calls = [];
  handler = () => undefined;
  server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(c as Buffer));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      let body: unknown;
      try { body = raw === '' ? undefined : JSON.parse(raw); } catch { body = raw; }
      const requestId = req.headers['idempotency-key'];
      calls.push({ method: req.method ?? '', url: req.url ?? '', body, requestId: typeof requestId === 'string' ? requestId : undefined });
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
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});

afterEach(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

const run = async (args: string[]) => {
  const out: string[] = []; const err: string[] = [];
  const io = { write: (s: string) => { out.push(s); }, writeErr: (s: string) => { err.push(s); }, readStdin: async () => '' };
  const code = await main(['node', 'kb', '--server', base, ...args], io);
  return { code, out: out.join(''), err: err.join('') };
};

const withIssue = (status: string) => (method: string, url: string) => (
  method === 'GET' && url === '/api/issues/iss-accept'
    ? { status: 200, body: { ...ISSUE, status } }
    : method === 'POST' && url === '/api/issues/iss-accept/comments'
      ? { status: 200, body: { comment: { id: 'c1', author: 'agent:kb-cli', content: 'x', ts: 3 }, woke: false } }
      : undefined
);

describe('kb accept', () => {
  it('待验收卡写固定格式评论：exit 0、不改状态、无 PATCH/close', async () => {
    handler = withIssue('待验收');
    const t = await run(['accept', 'iss-accept', '--verdict', 'pass', '--note', '对照验收标准逐条通过']);
    expect(t.code).toBe(0);
    expect(t.out).toContain('验收记录已写入: c1');
    expect(t.out).toContain('卡片状态未变更');
    const post = calls.find((c) => c.method === 'POST');
    expect(post?.url).toBe('/api/issues/iss-accept/comments');
    const content = (post?.body as { content: string }).content;
    expect(content.split('\n')[0]).toMatch(/^【验收记录】verdict=pass; reviewer=kb-cli; at=\d{4}-\d{2}-\d{2}T[\d:.]+Z$/);
    expect(content.split('\n')[1]).toBe('对照验收标准逐条通过');
    expect(calls.filter((c) => c.method !== 'GET' && c.method !== 'POST')).toHaveLength(0);
  });

  it('--reviewer 覆盖验收人；--request-id 走 Idempotency-Key', async () => {
    handler = withIssue('待验收');
    const id = '00000000-0000-4000-8000-0000000000aa';
    const t = await run(['accept', 'iss-accept', '--verdict', 'fail', '--note', '第二条验收未过', '--reviewer', 'qa-bot', '--request-id', id]);
    expect(t.code).toBe(0);
    const post = calls.find((c) => c.method === 'POST');
    expect((post?.body as { content: string }).content).toContain('verdict=fail; reviewer=qa-bot;');
    expect(post?.requestId).toBe(id);
  });

  it('非待验收卡 exit 2，提示当前状态且不写评论', async () => {
    handler = withIssue('待规划');
    const t = await run(['accept', 'iss-accept', '--verdict', 'pass', '--note', 'x']);
    expect(t.code).toBe(2);
    expect(t.err).toContain('当前状态：待规划');
    expect(t.err).toMatch(/kb done|kb close/);
    expect(calls.filter((c) => c.method === 'POST')).toHaveLength(0);
  });

  it('缺 --verdict / --note 时 exit 1，不发任何请求', async () => {
    for (const args of [['accept', 'iss-accept', '--note', 'x'], ['accept', 'iss-accept', '--verdict', 'pass'], ['accept', 'iss-accept', '--verdict', 'ok', '--note', 'x']]) {
      const t = await run(args);
      expect(t.code).toBe(1);
      expect(t.err).toMatch(/验收结论|验收依据/);
    }
    expect(calls).toHaveLength(0);
  });
});

