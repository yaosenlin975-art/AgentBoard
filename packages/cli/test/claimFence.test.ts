/**
 * BORROW-0.3：CLI fence 持久化闭环。
 * claim 成功 → .agentboard/claims/<issueId>.json；done/fail 自动带 fence；成功后清除；
 * 篡改 fence → 409 STALE_FENCE 透传（退出码 2 + 重新 claim 提示）；无记录按软模式不带 fence。
 */
import { createServer, type Server } from 'node:http';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { main } from '../src/index.js';

interface Recorded { method: string; url: string; body: unknown; }

const ISSUE = {
  id: 'iss-fence', workspace_id: 'ws1', title: 'fence 卡', description: '', priority: '高',
  labels: [], status: '进行中', sort_order: 0, claimed_by: 'agent-x', claimed_at: 1,
  session_id: null, comment_count: 0, created_at: 1, updated_at: 2,
};

let server: Server;
let base = '';
let calls: Recorded[] = [];
let handler: (method: string, url: string, body: unknown) => { status: number; body?: unknown } | undefined = () => undefined;
let cwd: string;
let oldCwd: string;

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
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  // claimStore 相对 cwd 写 .agentboard/claims：测试全程在临时目录里跑
  oldCwd = process.cwd();
  cwd = mkdtempSync(join(tmpdir(), 'kb-fence-'));
  process.chdir(cwd);
});

afterEach(async () => {
  process.chdir(oldCwd);
  await new Promise<void>((resolve) => server.close(() => resolve()));
  rmSync(cwd, { recursive: true, force: true });
});

const claimFile = () => join(cwd, '.agentboard', 'claims', 'iss-fence.json');
const run = async (args: string[]) => {
  const out: string[] = []; const err: string[] = [];
  const io = { write: (s: string) => { out.push(s); }, writeErr: (s: string) => { err.push(s); }, readStdin: async () => '' };
  const code = await main(['node', 'kb', '--server', base, ...args], io);
  return { code, out: out.join(''), err: err.join('') };
};

describe('CLI fence 持久化', () => {
  it('claim 落盘 fence；done 自动携带并在成功后清除', async () => {
    handler = (method, url) => {
      if (method === 'POST' && url === '/api/issues/iss-fence/claim') return { status: 200, body: { ...ISSUE, claim_fence: 7 } };
      if (method === 'GET' && url === '/api/issues/iss-fence/comments') return { status: 200, body: [] };
      if (method === 'GET' && url === '/api/workspaces') return { status: 200, body: [] };
      if (method === 'POST' && url === '/api/issues/iss-fence/done') return { status: 200, body: { ...ISSUE, status: '待验收', claimed_by: null } };
      return undefined;
    };
    const claimed = await run(['claim', 'iss-fence']);
    expect(claimed.code).toBe(0);
    const stored = JSON.parse(readFileSync(claimFile(), 'utf8')) as { fence: number; issue_id: string };
    expect(stored.fence).toBe(7);
    expect(stored.issue_id).toBe('iss-fence');

    const finished = await run(['done', 'iss-fence', '--notes', '完成']);
    expect(finished.code).toBe(0);
    const doneCall = calls.find((c) => c.url === '/api/issues/iss-fence/done');
    expect((doneCall!.body as { fence?: number }).fence).toBe(7);
    expect(existsSync(claimFile())).toBe(false);
  });

  it('篡改 fence：done 带 409 STALE_FENCE → 退出码 2 + 重新 claim 提示，记录文件保留', async () => {
    handler = (method, url) => {
      if (method === 'POST' && url === '/api/issues/iss-fence/done') {
        return { status: 409, body: { error: { code: 'STALE_FENCE', message: '占用代次已过期（请求 fence=999，当前=2）；重新 kb claim 获取新 fence 后再收尾' } } };
      }
      return undefined;
    };
    mkdirClaims();
    writeFileSync(claimFile(), JSON.stringify({ issue_id: 'iss-fence', fence: 999, agent_id: 'agent-x', claimed_at: 1, base }), 'utf8');
    const result = await run(['done', 'iss-fence', '--notes', '完成']);
    expect(result.code).toBe(2);
    expect(result.err).toContain('重新 kb claim');
    expect(existsSync(claimFile())).toBe(true);
  });

  it('无本地记录：done 不带 fence（软模式），失败不误伤', async () => {
    handler = (method, url) => {
      if (method === 'POST' && url === '/api/issues/iss-fence/done') return { status: 200, body: { ...ISSUE, status: '待验收', claimed_by: null } };
      return undefined;
    };
    const result = await run(['done', 'iss-fence', '--notes', '完成']);
    expect(result.code).toBe(0);
    const doneCall = calls.find((c) => c.url === '/api/issues/iss-fence/done');
    expect((doneCall!.body as { fence?: number }).fence).toBeUndefined();
  });

  it('fail 同样自动携带 fence 并在成功后清除', async () => {
    handler = (method, url) => {
      if (method === 'POST' && url === '/api/issues/iss-fence/fail') return { status: 200, body: { ...ISSUE, status: '待规划', claimed_by: null } };
      return undefined;
    };
    mkdirClaims();
    writeFileSync(claimFile(), JSON.stringify({ issue_id: 'iss-fence', fence: 3, agent_id: 'agent-x', claimed_at: 1, base }), 'utf8');
    const result = await run(['fail', 'iss-fence', '--reason', '受阻']);
    expect(result.code).toBe(0);
    const failCall = calls.find((c) => c.url === '/api/issues/iss-fence/fail');
    expect((failCall!.body as { fence?: number }).fence).toBe(3);
    expect(existsSync(claimFile())).toBe(false);
  });
});

function mkdirClaims(): void {
  mkdirSync(join(cwd, '.agentboard', 'claims'), { recursive: true });
}
