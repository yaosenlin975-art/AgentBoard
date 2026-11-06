/**
 * CLI-CLOSE：kb close / reopen / update 的 HTTP 契约与 409 原样文案。
 */
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { main } from '../src/index.js';

interface Recorded { method: string; url: string; body: unknown; requestId?: string }
type MockReply = { status: number; body?: unknown } | undefined;
type Handler = (method: string, url: string, body: unknown) => MockReply;

const ISSUE = {
  id: 'iss1', workspace_id: 'ws1', title: '标题', description: '描述', priority: '中', labels: [],
  status: '已关闭', sort_order: 0, parent_issue_id: null, claimed_by: null, claimed_at: null,
  session_id: null, comment_count: 0, created_at: 1, updated_at: 2,
};

let server: Server; let base = ''; let calls: Recorded[] = []; let handler: Handler = () => undefined;

beforeEach(async () => {
  calls = []; handler = () => undefined;
  server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', c => chunks.push(c as Buffer));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      let body: unknown;
      try { body = raw === '' ? undefined : JSON.parse(raw); } catch { body = raw; }
      const requestId = String(req.headers['idempotency-key'] ?? '') || undefined;
      calls.push({ method: req.method ?? '', url: req.url ?? '', body, ...(requestId ? { requestId } : {}) });
      const reply = handler(req.method ?? '', req.url ?? '', body);
      if (!reply) { res.writeHead(404, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: { code: 'NOT_FOUND', message: 'mock 未匹配' } })); return; }
      res.writeHead(reply.status, { 'content-type': 'application/json' });
      res.end(reply.body === undefined ? '' : JSON.stringify(reply.body));
    });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterEach(async () => { await new Promise<void>(resolve => server.close(() => resolve())); });

function makeIo() {
  const out: string[] = []; const err: string[] = [];
  return { io: { write: (s: string) => { out.push(s); }, writeErr: (s: string) => { err.push(s); }, readStdin: async () => '长描述正文\n第二行' }, out: () => out.join(''), err: () => err.join('') };
}
const run = async (args: string[]) => { const t = makeIo(); const code = await main(['node', 'kb', '--server', base, ...args], t.io); return { code, out: t.out(), err: t.err() }; };

describe('kb close / reopen / update', () => {
  it('close posts to /close and prints status', async () => {
    handler = (m, u) => (m === 'POST' && u === '/api/issues/iss1/close' ? { status: 200, body: { ...ISSUE, status: '已关闭' } } : undefined);
    const result = await run(['close', 'iss1']);
    expect(result.code).toBe(0);
    expect(result.out).toContain('已关闭: iss1');
    expect(calls[0]).toEqual({ method: 'POST', url: '/api/issues/iss1/close', body: { agent_id: 'kb-cli' } });
  });

  it('close surfaces 409 raw message with exit 2', async () => {
    handler = (m, u) => (m === 'POST' && u === '/api/issues/iss1/close'
      ? { status: 409, body: { error: { code: 'ISSUE_CLAIMED', message: '任务正被 board-server 占用，请先 release 再关闭' } } }
      : undefined);
    const result = await run(['close', 'iss1']);
    expect(result.code).toBe(2);
    expect(result.err).toContain('请先 kb release <issue-id> 再关闭');
    expect(result.err).not.toMatch(/(?<!kb )release/);
    expect(result.err).not.toContain('已被占用（');
  });

  it('reopen sends --to and request id', async () => {
    handler = (m, u) => (m === 'POST' && u === '/api/issues/iss1/reopen' ? { status: 200, body: { ...ISSUE, status: '进行中' } } : undefined);
    const key = '33333333-3333-4333-8333-333333333333';
    const result = await run(['reopen', 'iss1', '--to', '进行中', '--request-id', key]);
    expect(result.code).toBe(0);
    expect(result.out).toContain('状态: 进行中');
    expect(calls[0]).toEqual({ method: 'POST', url: '/api/issues/iss1/reopen', body: { agent_id: 'kb-cli', status: '进行中' }, requestId: key });
  });

  it('update patches fields without status and supports --description-stdin', async () => {
    handler = (m, u) => {
      if (m === 'PATCH' && u === '/api/issues/iss1') return { status: 200, body: { ...ISSUE, title: '新标题' } };
      // MOJI-GUARD 回读：落库文本按提交原文应答
      if (m === 'GET' && u === '/api/issues/iss1') return { status: 200, body: { ...ISSUE, title: '新标题', description: '长描述正文\n第二行' } };
      return undefined;
    };
    const result = await run(['update', 'iss1', '--title', '新标题', '--priority', '高', '--labels', 'a,b', '--due-date', '2026-12-01', '--description-stdin']);
    expect(result.code).toBe(0);
    expect(result.out).toContain('已更新: iss1');
    const sent = calls[0]!.body as Record<string, unknown>;
    expect(sent).toMatchObject({ agent_id: 'kb-cli', title: '新标题', priority: '高', labels: ['a', 'b'], due_date: '2026-12-01', description: '长描述正文\n第二行' });
    expect(sent).not.toHaveProperty('status');
  });

  it('update without any field fails fast', async () => {
    const result = await run(['update', 'iss1']);
    expect(result.code).not.toBe(0);
    expect(result.err).toContain('至少提供一个要修改的字段');
    expect(calls).toHaveLength(0);
  });
});

describe('CLOSE-FLOW：done --close 与 close 自动释放自有占用', () => {
  it('done --close 成功路径直接关闭并输出两阶段回执', async () => {
    handler = (m, u) => {
      if (m === 'POST' && u === '/api/issues/iss1/done') return { status: 200, body: { ...ISSUE, status: '待验收' } };
      if (m === 'POST' && u === '/api/issues/iss1/close') return { status: 200, body: { ...ISSUE, status: '已关闭' } };
      return undefined;
    };
    const result = await run(['done', 'iss1', '--close']);
    expect(result.code).toBe(0);
    expect(result.out).toContain('已完成: iss1');
    expect(result.out).toContain('已关闭: iss1');
    expect(calls.map(c => `${c.method} ${c.url}`)).toEqual([
      'POST /api/issues/iss1/done',
      'POST /api/issues/iss1/close',
    ]);
  });

  it('close 遇自有占用：自动 release 一次后再关闭', async () => {
    let released = false;
    handler = (m, u) => {
      if (m === 'POST' && u === '/api/issues/iss1/close') {
        return released
          ? { status: 200, body: { ...ISSUE, status: '已关闭' } }
          : { status: 409, body: { error: { code: 'ISSUE_CLAIMED', message: '任务正被 kb-cli 占用，请先 release 再关闭' } } };
      }
      if (m === 'GET' && u === '/api/issues/iss1') {
        return { status: 200, body: { ...ISSUE, status: '待验收', claimed_by: 'kb-cli' } };
      }
      if (m === 'POST' && u === '/api/issues/iss1/release') {
        released = true;
        return { status: 200, body: { ...ISSUE, status: '待规划', claimed_by: null } };
      }
      return undefined;
    };
    const result = await run(['close', 'iss1']);
    expect(result.code).toBe(0);
    expect(result.out).toContain('已释放自有占用后关闭');
    expect(result.out).toContain('已关闭: iss1');
    const releaseCall = calls.find(c => c.url === '/api/issues/iss1/release');
    expect(releaseCall?.body).toMatchObject({ agent_id: 'kb-cli', workspace_id: 'ws1' });
    expect(calls.filter(c => c.url === '/api/issues/iss1/close')).toHaveLength(2);
  });

  it('close 遇他人占用：exit 2，不 release，提示占用者与 kb release', async () => {
    handler = (m, u) => {
      if (m === 'POST' && u === '/api/issues/iss1/close') {
        return { status: 409, body: { error: { code: 'ISSUE_CLAIMED', message: '任务正被 board-server 占用，请先 release 再关闭' } } };
      }
      if (m === 'GET' && u === '/api/issues/iss1') {
        return { status: 200, body: { ...ISSUE, status: '待验收', claimed_by: 'board-server' } };
      }
      return undefined;
    };
    const result = await run(['close', 'iss1']);
    expect(result.code).toBe(2);
    expect(result.err).toContain('board-server');
    expect(result.err).toContain('kb release <issue-id>');
    expect(calls.some(c => c.url === '/api/issues/iss1/release')).toBe(false);
  });

  it('父卡存在未关闭后代：exit 2，原样透出且不 release', async () => {
    handler = (m, u) => (m === 'POST' && u === '/api/issues/iss1/close'
      ? { status: 409, body: { error: { code: 'CONFLICT', message: '存在未关闭的后代任务，不能关闭此父任务' } } }
      : undefined);
    const result = await run(['close', 'iss1']);
    expect(result.code).toBe(2);
    expect(result.err).toContain('存在未关闭的后代任务，不能关闭此父任务');
    expect(calls.some(c => c.url === '/api/issues/iss1/release')).toBe(false);
  });

  it('done 成功但 close 阶段失败：保留 done 结果并分阶段报错', async () => {
    handler = (m, u) => {
      if (m === 'POST' && u === '/api/issues/iss1/done') return { status: 200, body: { ...ISSUE, status: '待验收' } };
      if (m === 'POST' && u === '/api/issues/iss1/close') {
        return { status: 409, body: { error: { code: 'CONFLICT', message: '存在未关闭的后代任务，不能关闭此父任务' } } };
      }
      return undefined;
    };
    const result = await run(['done', 'iss1', '--close']);
    expect(result.code).toBe(2);
    expect(result.err).toContain('done 阶段已完成');
    expect(result.err).toContain('存在未关闭的后代任务');
    expect(calls.filter(c => c.url === '/api/issues/iss1/done')).toHaveLength(1);
  });
});
