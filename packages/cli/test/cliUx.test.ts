/** CLI-UX：--notes-stdin / --full 提示 / changelog 本地时区。 */
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { main } from '../src/index.js';

interface Recorded { method: string; url: string; body: unknown }
type MockReply = { status: number; body?: unknown } | undefined;
type Handler = (method: string, url: string, body: unknown) => MockReply;

const ISSUE = { id: 'iss1', workspace_id: 'ws1', title: 't', description: '', priority: '中', labels: [], status: '待验收', sort_order: 0, parent_issue_id: null, claimed_by: null, claimed_at: null, session_id: null, comment_count: 0, created_at: 1, updated_at: 1 };
let server: Server; let base = ''; let calls: Recorded[] = []; let handler: Handler = () => undefined;

beforeEach(async () => {
  calls = []; handler = () => undefined;
  server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', c => chunks.push(c as Buffer));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      let body: unknown; try { body = raw === '' ? undefined : JSON.parse(raw); } catch { body = raw; }
      calls.push({ method: req.method ?? '', url: req.url ?? '', body });
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

function makeIo(stdin = '') {
  const out: string[] = []; const err: string[] = [];
  return { io: { write: (s: string) => { out.push(s); }, writeErr: (s: string) => { err.push(s); }, readStdin: async () => stdin }, out: () => out.join(''), err: () => err.join('') };
}
const run = async (args: string[], stdin = '') => { const t = makeIo(stdin); const code = await main(['node', 'kb', '--server', base, ...args], t.io); return { code, out: t.out(), err: t.err() }; };

describe('CLI-UX：done --notes-stdin', () => {
  it('从 stdin 读 notes（多行、含 "- " 行都安全）', async () => {
    handler = (m, u) => (m === 'POST' && u === '/api/issues/iss1/done' ? { status: 200, body: { ...ISSUE, status: '待验收' } } : undefined);
    const result = await run(['done', 'iss1', '--notes-stdin'], '- 第一行\n- 第二行\n');
    expect(result.code).toBe(0);
    expect((calls[0]!.body as Record<string, unknown>).notes).toBe('- 第一行\n- 第二行');
    expect(result.err).toBe('');
  });

  it('--notes 含 "- " 开头行时给警告（建议改用 --notes-stdin）', async () => {
    handler = (m, u) => (m === 'POST' && u === '/api/issues/iss1/done' ? { status: 200, body: { ...ISSUE, status: '待验收' } } : undefined);
    const result = await run(['done', 'iss1', '--notes', '第一行\n- 危险行']);
    expect(result.code).toBe(0);
    expect(result.err).toContain('--notes-stdin');
  });
});

describe('CLI-UX：--full 只在 --json 下生效', () => {
  it('表格模式带 --full → 提示且不影响输出', async () => {
    handler = (m, u) => (m === 'GET' && u.startsWith('/api/workspaces/ws1/statuses') ? { status: 200, body: [] }
      : m === 'GET' && u === '/api/workspaces' ? { status: 200, body: [{ id: 'ws1', name: 'ws', path: 'D:/ws', created_at: 1 }] }
        : m === 'GET' && u.startsWith('/api/issues?workspace=ws1') ? { status: 200, body: [ISSUE] } : undefined);
    const result = await run(['list-tasks', '--workspace', 'ws1', '--full']);
    expect(result.code).toBe(0);
    expect(result.err).toContain('--full 只对 --json 输出生效');
    expect(result.out).toContain('iss1');
  });
});
