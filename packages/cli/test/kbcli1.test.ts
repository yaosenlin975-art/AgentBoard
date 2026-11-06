/**
 * KB-CLI-1：输入安全与幂等回显。
 * 覆盖卡面验收 5 条：引号标题拒绝且不发请求；--title-stdin 建卡；600 字标题拒；空 stdin 中文提示；重放可区分。
 */
import { createServer, type Server } from 'node:http';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { main } from '../src/index.js';

interface Recorded { method: string; url: string; body: unknown; replayHeader: string }

const ISSUE = {
  id: 'iss-new', workspace_id: 'ws1', title: '标题', description: '', priority: '中', labels: [],
  status: '待规划', sort_order: 0, claimed_by: null, claimed_at: null, session_id: null,
  comment_count: 0, created_at: 1, updated_at: 1,
};

let server: Server;
let base = '';
let calls: Recorded[] = [];
let handler: (method: string, url: string, body: unknown) => { status: number; body?: unknown; headers?: Record<string, string> } | undefined = () => undefined;

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
      calls.push({ method: req.method ?? '', url: req.url ?? '', body, replayHeader: String(req.headers['x-agentboard-replayed'] ?? '') });
      const reply = handler(req.method ?? '', req.url ?? '', body);
      if (!reply) {
        res.writeHead(404, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: { code: 'NOT_FOUND', message: 'mock 未匹配' } }));
        return;
      }
      res.writeHead(reply.status, { 'content-type': 'application/json', ...reply.headers });
      res.end(reply.body === undefined ? '' : JSON.stringify(reply.body));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});

afterEach(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

const run = async (args: string[], stdin = '') => {
  const out: string[] = []; const err: string[] = [];
  const io = { write: (s: string) => { out.push(s); }, writeErr: (s: string) => { err.push(s); }, readStdin: async () => stdin };
  const code = await main(['node', 'kb', '--server', base, ...args], io);
  return { code, out: out.join(''), err: err.join('') };
};

describe('create-issue 标题安全（本地拒绝，不发请求）', () => {
  it('含引号的标题 → exit≠0 且看板未新增卡（零 POST）', async () => {
    const result = await run(['create-issue', 'ws1', '实现"登录"功能']);
    expect(result.code).not.toBe(0);
    expect(result.err).toContain('--title-stdin');
    expect(calls.filter((c) => c.method === 'POST')).toHaveLength(0);
  });

  it('引号含全角变体同样拒绝；-- 开头疑似选项串拒绝', async () => {
    expect((await run(['create-issue', 'ws1', '带“全角”引号'])).code).not.toBe(0);
    const opt = await run(['create-issue', 'ws1', '--', '--request-id']);
    expect(opt.code).not.toBe(0);
    expect(opt.err).toContain('疑似命令选项');
    expect(calls.filter((c) => c.method === 'POST')).toHaveLength(0);
  });

  it('600 字标题被拒并提示 200 字上限', async () => {
    const result = await run(['create-issue', 'ws1', '长'.repeat(600)]);
    expect(result.code).not.toBe(0);
    expect(result.err).toContain('200');
    expect(calls.filter((c) => c.method === 'POST')).toHaveLength(0);
  });

  it('200 字边界：正常建卡', async () => {
    handler = (method, url) => {
      if (method === 'GET' && url.startsWith('/api/workspaces')) return { status: 200, body: [{ id: 'ws1', name: 'ws', path: 'D:/ws' }] };
      if (method === 'POST' && url === '/api/issues') return { status: 200, body: { ...ISSUE, title: '长'.repeat(200) } };
      return undefined;
    };
    const result = await run(['create-issue', 'ws1', '长'.repeat(200), '-d', '正文与验收']);
    expect(result.code).toBe(0);
    expect(calls.filter((c) => c.method === 'POST')).toHaveLength(1);
  });

  it('--title-stdin 可正常建卡；与位置参数互斥；空 stdin 中文报错', async () => {
    handler = (method, url) => {
      if (method === 'GET' && url.startsWith('/api/workspaces')) return { status: 200, body: [{ id: 'ws1', name: 'ws', path: 'D:/ws' }] };
      if (method === 'POST' && url === '/api/issues') return { status: 200, body: { ...ISSUE, title: '来自 stdin 的标题' } };
      return undefined;
    };
    const ok = await run(['create-issue', 'ws1', '--title-stdin', '-d', '正文与验收'], '来自 stdin 的标题\n');
    expect(ok.code).toBe(0);
    const post = calls.find((c) => c.method === 'POST' && c.url === '/api/issues');
    expect((post!.body as { title: string }).title).toBe('来自 stdin 的标题');

    const conflict = await run(['create-issue', 'ws1', '参数标题', '--title-stdin'], 'stdin 标题');
    expect(conflict.code).not.toBe(0);
    expect(conflict.err).toContain('互斥');

    const empty = await run(['create-issue', 'ws1', '--title-stdin'], '   \n');
    expect(empty.code).not.toBe(0);
    expect(empty.err).toContain('--title-stdin 读到的标题为空');
  });

  it('缺标题（无参数、无 --title-stdin）→ 中文报错', async () => {
    const result = await run(['create-issue', 'ws1']);
    expect(result.code).not.toBe(0);
    expect(result.err).toContain('缺少标题');
    expect(calls.filter((c) => c.method === 'POST')).toHaveLength(0);
  });
});

describe('幂等重放回显', () => {
  beforeEach(() => {
    handler = (method, url) => {
      if (method === 'GET' && url.startsWith('/api/workspaces')) return { status: 200, body: [{ id: 'ws1', name: 'ws', path: 'D:/ws' }] };
      if (method === 'POST' && url === '/api/issues') return { status: 200, body: ISSUE, headers: { 'x-agentboard-replayed': '1' } };
      return undefined;
    };
  });

  it('文本模式标「（幂等重放）」；JSON 模式加 replayed:true；非重放无标记', async () => {
    const text = await run(['create-issue', 'ws1', '标题', '-d', '正文与验收']);
    expect(text.code).toBe(0);
    expect(text.out).toContain('（幂等重放）已创建任务');

    const json = await run(['--json', 'create-issue', 'ws1', '标题', '-d', '正文与验收']);
    expect(json.code).toBe(0);
    expect(JSON.parse(json.out)).toMatchObject({ id: 'iss-new', replayed: true });
  });

  it('服务端未标重放（首次执行）→ 文本无标记、JSON replayed:false', async () => {
    handler = (method, url) => {
      if (method === 'GET' && url.startsWith('/api/workspaces')) return { status: 200, body: [{ id: 'ws1', name: 'ws', path: 'D:/ws' }] };
      if (method === 'POST' && url === '/api/issues') return { status: 200, body: ISSUE };
      return undefined;
    };
    const text = await run(['create-issue', 'ws1', '标题', '-d', '正文与验收']);
    expect(text.out).not.toContain('（幂等重放）');
    const json = await run(['--json', 'create-issue', 'ws1', '标题', '-d', '正文与验收']);
    expect(JSON.parse(json.out)).toMatchObject({ id: 'iss-new', replayed: false });
  });
});

describe('knowledge 空 stdin', () => {
  it('空正文 → 中文提示，exit≠0，不发请求', async () => {
    const result = await run([
      'knowledge', 'create', '--scope', 'common', '--title', 'T', '--slug', 's', '--domain', 'knowledge',
      '--sources', '[]', '--evidence', '[]', '--stdin',
    ], '   \n');
    expect(result.code).not.toBe(0);
    expect(result.err).toContain('--stdin 读到的正文为空');
    expect(result.err).toContain('Get-Content body.md -Raw');
    expect(calls.filter((c) => c.method === 'POST')).toHaveLength(0);
  });
});
