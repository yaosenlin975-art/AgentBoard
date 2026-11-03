/**
 * CLI-CRASH：错误分支渲染不再因非数组输入崩溃（`value.flatMap is not a function`），
 * 并且 done/fail 的三类失败态都给出可操作文案与正确退出码。
 */
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { main } from '../src/index.js';
import { commentLines, issueLines } from '../src/render.js';

interface Recorded { method: string; url: string; body: unknown }
type MockReply = { status: number; body?: unknown } | undefined;
type Handler = (method: string, url: string) => MockReply;

let server: Server; let base = ''; let handler: Handler = () => undefined;

beforeEach(async () => {
  handler = () => undefined;
  server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', c => chunks.push(c as Buffer));
    req.on('end', () => {
      const reply = handler(req.method ?? '', req.url ?? '');
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
  return { io: { write: (s: string) => { out.push(s); }, writeErr: (s: string) => { err.push(s); }, readStdin: async () => '' }, out: () => out.join(''), err: () => err.join('') };
}
const run = async (args: string[]) => { const t = makeIo(); const code = await main(['node', 'kb', '--server', base, ...args], t.io); return { code, out: t.out(), err: t.err() }; };

describe('render 容忍非数组输入（CLI-CRASH）', () => {
  it('commentLines 对 null / object / 分页体都不抛错', () => {
    expect(commentLines(null)).toEqual(['评论（0）:（无）']);
    expect(commentLines({ items: [{ id: 'c1' }] })).toEqual(['评论（0）:（无）']);
    expect(commentLines(undefined)).toEqual(['评论（0）:（无）']);
    expect(commentLines([{ id: 'c1', author: 'user', content: 'hi', ts: 1, issue_id: 'i1' }])[0]).toContain('评论（1）');
  });

  it('issueLines 对 null / 非对象不抛错', () => {
    expect(issueLines(null)).toEqual(['id: （无）']);
    expect(issueLines(undefined)).toEqual(['id: （无）']);
  });
});

describe('done / fail 三类失败态（CLI-CRASH）', () => {
  it('未占用：退出码 2 + 可操作提示，不崩', async () => {
    handler = (m, u) => (m === 'POST' && u === '/api/issues/iss1/done'
      ? { status: 409, body: { error: { code: 'CONFLICT', message: '未被占用' } } }
      : undefined);
    const result = await run(['done', 'iss1', '--notes', 'x']);
    expect(result.code).toBe(2);
    expect(result.err).toContain('未被占用：如需推进请先 kb claim，或使用 kb close');
    expect(result.err).not.toContain('TypeError');
    expect(result.err).not.toContain('flatMap');
  });

  it('不存在：退出码 1 + 任务不存在，不崩', async () => {
    handler = (m, u) => (m === 'POST' && u === '/api/issues/iss1/done'
      ? { status: 404, body: { error: { code: 'NOT_FOUND', message: '任务不存在' } } }
      : undefined);
    const result = await run(['done', 'iss1', '--notes', 'x']);
    expect(result.code).toBe(1);
    expect(result.err).toContain('任务不存在');
    expect(result.err).not.toContain('flatMap');
  });

  it('占用者是别人：退出码 2 + 仅占用者提示，不崩', async () => {
    handler = (m, u) => (m === 'POST' && u === '/api/issues/iss1/fail'
      ? { status: 409, body: { error: { code: 'NOT_TASK_OWNER', message: '只有当前占用者可回报失败' } } }
      : undefined);
    const result = await run(['fail', 'iss1', '--reason', 'x']);
    expect(result.code).toBe(2);
    expect(result.err).toContain('只有当前占用者可回报失败');
    expect(result.err).not.toContain('flatMap');
  });
});
