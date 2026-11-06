/**
 * REL-3：`kb release` 单卡释放。
 * 覆盖成功 / 未占用 / 被他人占用 / fence 冲突四类，外加帮助文案不再指向不存在的 release。
 */
import { createServer, type Server } from 'node:http';
import { mkdtempSync, mkdirSync, rmSync, existsSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { main } from '../src/index.js';

interface Recorded { method: string; url: string; body: unknown; requestId?: string }

const ISSUE = {
  id: 'iss-release', workspace_id: 'ws1', title: '释放卡', description: '', priority: '中',
  labels: [], status: '进行中', sort_order: 0, claimed_by: 'kb-cli', claimed_at: 1,
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
  oldCwd = process.cwd();
  cwd = mkdtempSync(join(tmpdir(), 'kb-release-'));
  process.chdir(cwd);
});

afterEach(async () => {
  process.chdir(oldCwd);
  await new Promise<void>((resolve) => server.close(() => resolve()));
  rmSync(cwd, { recursive: true, force: true });
});

const claimFile = () => join(cwd, '.agentboard', 'claims', 'iss-release.json');
const run = async (args: string[]) => {
  const out: string[] = []; const err: string[] = [];
  const io = { write: (s: string) => { out.push(s); }, writeErr: (s: string) => { err.push(s); }, readStdin: async () => '' };
  const code = await main(['node', 'kb', '--server', base, ...args], io);
  return { code, out: out.join(''), err: err.join('') };
};

const withIssue = (next: typeof handler): typeof handler => (method, url, body) => (
  method === 'GET' && url === '/api/issues/iss-release' ? { status: 200, body: ISSUE } : next(method, url, body)
);

describe('kb release', () => {
  it('当前占用者释放成功：exit 0、退回待规划、清掉本地 fence', async () => {
    handler = withIssue((method, url) => (
      method === 'POST' && url === '/api/issues/iss-release/release'
        ? { status: 200, body: { ...ISSUE, status: '待规划', claimed_by: null, claimed_at: null } }
        : undefined
    ));
    mkdirClaims();
    writeFileSync(claimFile(), JSON.stringify({ issue_id: 'iss-release', fence: 5, agent_id: 'kb-cli', claimed_at: 1, base }), 'utf8');
    const key = '44444444-4444-4444-8444-444444444444';
    const result = await run(['release', 'iss-release', '--request-id', key]);
    expect(result.code).toBe(0);
    expect(result.out).toContain('已释放: iss-release');
    expect(result.out).toContain('待规划');
    expect(result.out).toContain('不是失败');
    const posted = calls.find((c) => c.url === '/api/issues/iss-release/release');
    expect(posted!.body).toEqual({ agent_id: 'kb-cli', workspace_id: 'ws1', fence: 5 });
    expect(posted!.requestId).toBe(key);
    expect(existsSync(claimFile())).toBe(false);
  });

  it('未被占用：409 NOT_TASK_OWNER → exit 2，文案原样透传', async () => {
    handler = withIssue((method, url) => (
      method === 'POST' && url === '/api/issues/iss-release/release'
        ? { status: 409, body: { error: { code: 'NOT_TASK_OWNER', message: '只有当前占用者可执行此操作' } } }
        : undefined
    ));
    const result = await run(['release', 'iss-release']);
    expect(result.code).toBe(2);
    expect(result.err).toContain('只有当前占用者可执行此操作');
    expect(result.err).not.toContain('已被占用（');
  });

  it('被他人占用：409 NOT_TASK_OWNER → exit 2，本地记录保留', async () => {
    handler = withIssue((method, url) => (
      method === 'POST' && url === '/api/issues/iss-release/release'
        ? { status: 409, body: { error: { code: 'NOT_TASK_OWNER', message: '只有当前占用者可执行此操作' } } }
        : undefined
    ));
    mkdirClaims();
    writeFileSync(claimFile(), JSON.stringify({ issue_id: 'iss-release', fence: 2, agent_id: 'other', claimed_at: 1, base }), 'utf8');
    const result = await run(['release', 'iss-release']);
    expect(result.code).toBe(2);
    expect(result.err).toContain('只有当前占用者可执行此操作');
    expect(existsSync(claimFile())).toBe(true);
  });

  it('持旧 fence：409 STALE_FENCE → exit 2 + 重新 claim 提示，记录保留', async () => {
    handler = withIssue((method, url) => (
      method === 'POST' && url === '/api/issues/iss-release/release'
        ? { status: 409, body: { error: { code: 'STALE_FENCE', message: '占用代次已过期（请求 fence=999，当前=2）；重新 kb claim 获取新 fence 后再收尾' } } }
        : undefined
    ));
    mkdirClaims();
    writeFileSync(claimFile(), JSON.stringify({ issue_id: 'iss-release', fence: 999, agent_id: 'kb-cli', claimed_at: 1, base }), 'utf8');
    const result = await run(['release', 'iss-release']);
    expect(result.code).toBe(2);
    expect(result.err).toContain('重新 kb claim');
    const posted = calls.find((c) => c.url === '/api/issues/iss-release/release');
    expect((posted!.body as { fence?: number }).fence).toBe(999);
    expect(existsSync(claimFile())).toBe(true);
  });
});

describe('REL-3 文案：不再指向不存在的 release', () => {
  const helpOf = async (...args: string[]): Promise<{ code: number; text: string }> => {
    const out: string[] = [];
    const io = { write: (s: string) => { out.push(s); }, writeErr: (s: string) => { out.push(s); }, readStdin: async () => '' };
    const code = await main(['node', 'kb', ...args, '--help'], io);
    return { code, text: out.join('') };
  };

  it('release --help：只收单张 id 或 --ids-file 批量，不收工作区/--all', async () => {
    const { code, text } = await helpOf('release');
    expect(code).toBe(0);
    expect(text).toContain('kb release');
    expect(text).toContain('--ids-file');
    expect(text).not.toContain('--workspace');
    expect(text).not.toContain('--all');
  });

  it('close / claim --help 不再出现孤立 release（都指向 kb release）', async () => {
    for (const command of ['close', 'claim']) {
      const { code, text } = await helpOf(command);
      expect(code).toBe(0);
      expect(text).toContain('kb release');
      expect(text).not.toMatch(/(?<!kb )release/);
    }
  });

  it('claim 运行时占用冲突文案补成可执行的 kb release', async () => {
    handler = (method, url) => (
      method === 'POST' && url === '/api/issues/iss-release/claim'
        ? { status: 409, body: { error: { code: 'ISSUE_CLAIMED', message: '已被 racer-1 占用；先 release 或换卡，勿重复 claim' } } }
        : undefined
    );
    const result = await run(['claim', 'iss-release']);
    expect(result.code).toBe(2);
    expect(result.err).toContain('kb release <issue-id>');
    expect(result.err).not.toMatch(/(?<!kb )release/);
  });
});

function mkdirClaims(): void {
  mkdirSync(join(cwd, '.agentboard', 'claims'), { recursive: true });
}
