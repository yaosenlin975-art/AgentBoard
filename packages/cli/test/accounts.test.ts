/**
 * CLI-SWITCH：`kb accounts list / capabilities / switch`。
 * 覆盖默认 dry-run、显式 --apply、能力表透出、不支持来源 409 文案原样透传。
 */
import { createServer, type Server } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { main } from '../src/index.js';

interface Recorded { method: string; url: string; body: unknown }

const ACCOUNT_ID = '22222222-2222-4222-8222-222222222222';
const DRY = {
  app_id: 'deepseek', account_id: ACCOUNT_ID, status: 'dry_run', applied: false,
  target: '~/.deepseek/config.toml', field: 'api_key',
  current_identity_hint: 'sha256:aaaaaaaaaaaa', target_identity_hint: 'sha256:bbbbbbbbbbbb',
  already_current: false, blocked_reason_code: null,
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
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  oldCwd = process.cwd();
  cwd = mkdtempSync(join(tmpdir(), 'kb-accounts-'));
  process.chdir(cwd);
});

afterEach(async () => {
  process.chdir(oldCwd);
  await new Promise<void>(resolve => server.close(() => resolve()));
  rmSync(cwd, { recursive: true, force: true });
});

const run = async (args: string[]) => {
  const out: string[] = []; const err: string[] = [];
  const io = { write: (s: string) => { out.push(s); }, writeErr: (s: string) => { err.push(s); }, readStdin: async () => '' };
  const code = await main(['node', 'kb', '--server', base, ...args], io);
  return { code, out: out.join(''), err: err.join('') };
};

describe('kb accounts switch', () => {
  it('默认 dry-run：POST apply=false，输出计划摘要且明确未写入', async () => {
    handler = (method, url) => (method === 'POST' && url === `/api/cli-accounts/${ACCOUNT_ID}/switch`
      ? { status: 200, body: DRY }
      : undefined);
    const result = await run(['accounts', 'switch', ACCOUNT_ID]);

    expect(result.code).toBe(0);
    const posted = calls.find(call => call.url === `/api/cli-accounts/${ACCOUNT_ID}/switch`);
    expect(posted!.body).toEqual({ apply: false });
    expect(result.out).toContain('dry-run（未写入；加 --apply 才执行切换）');
    expect(result.out).toContain('~/.deepseek/config.toml');
    expect(result.out).toContain('sha256:bbbbbbbbbbbb');
  });

  it('--apply：POST apply=true，提示已写入并通过读回校验', async () => {
    handler = (method, url) => (method === 'POST' && url === `/api/cli-accounts/${ACCOUNT_ID}/switch`
      ? { status: 200, body: { ...DRY, status: 'switched', applied: true } }
      : undefined);
    const result = await run(['accounts', 'switch', ACCOUNT_ID, '--apply']);

    expect(result.code).toBe(0);
    const posted = calls.find(call => call.url === `/api/cli-accounts/${ACCOUNT_ID}/switch`);
    expect(posted!.body).toEqual({ apply: true });
    expect(result.out).toContain('已写入并通过读回校验');
  });

  it('dry-run 预检阻断：输出阻断原因码且不声称已写入', async () => {
    handler = (method, url) => (method === 'POST' && url === `/api/cli-accounts/${ACCOUNT_ID}/switch`
      ? { status: 200, body: { ...DRY, blocked_reason_code: 'DEEPSEEK_ENV_SHADOWS' } }
      : undefined);
    const result = await run(['accounts', 'switch', ACCOUNT_ID]);
    expect(result.out).toContain('预检阻断 DEEPSEEK_ENV_SHADOWS');
    expect(result.out).not.toContain('已写入');
  });

  it('Codex 不支持切换：409 CLI_SWITCH_UNSUPPORTED 原样透传，exit 2', async () => {
    handler = (method, url) => (method === 'POST' && url === `/api/cli-accounts/${ACCOUNT_ID}/switch`
      ? { status: 409, body: { error: { code: 'CLI_SWITCH_UNSUPPORTED', message: '来源 codex 不支持切换：Codex 登录态是 OAuth 令牌（含刷新令牌），写入与读回校验路径未验证，保持只读' } } }
      : undefined);
    const result = await run(['accounts', 'switch', ACCOUNT_ID, '--apply']);
    expect(result.code).toBe(2);
    expect(result.err).toContain('不支持切换');
    expect(result.err).not.toContain('已被占用（');
  });

  it('校验失败已回滚：409 CLI_SWITCH_ROLLED_BACK 原样透传，exit 2', async () => {
    handler = (method, url) => (method === 'POST' && url === `/api/cli-accounts/${ACCOUNT_ID}/switch`
      ? { status: 409, body: { error: { code: 'CLI_SWITCH_ROLLED_BACK', message: '切换失败，已回滚到写入前内容（校验未通过）' } } }
      : undefined);
    const result = await run(['accounts', 'switch', ACCOUNT_ID, '--apply']);
    expect(result.code).toBe(2);
    expect(result.err).toContain('已回滚到写入前内容');
  });
});

describe('kb accounts list / capabilities', () => {
  it('list 输出账号表格，不含凭据字段', async () => {
    handler = (method, url) => (method === 'GET' && url === '/api/cli-accounts'
      ? { status: 200, body: { items: [{ id: ACCOUNT_ID, app_id: 'deepseek', identity_hint: 'sha256:aaaaaaaaaaaa', created_at: 1, last_seen_at: 2 }] } }
      : undefined);
    const result = await run(['accounts', 'list']);
    expect(result.code).toBe(0);
    expect(result.out).toContain(ACCOUNT_ID);
    expect(result.out).toContain('sha256:aaaaaaaaaaaa');
  });

  it('capabilities 明示 codex switch=false 与原因', async () => {
    handler = (method, url) => (method === 'GET' && url === '/api/cli-accounts/switch-capabilities'
      ? {
        status: 200,
        body: {
          items: [
            { app_id: 'deepseek', switch: true, reason_code: 'OK', reason: null },
            { app_id: 'opencode_go', switch: true, reason_code: 'OK', reason: null },
            { app_id: 'codex', switch: false, reason_code: 'CODEX_OAUTH_WRITE_UNVERIFIED', reason: 'Codex 登录态是 OAuth 令牌，保持只读' },
          ],
        },
      }
      : undefined);
    const result = await run(['accounts', 'capabilities']);
    expect(result.code).toBe(0);
    expect(result.out).toContain('codex');
    expect(result.out).toContain('false');
    expect(result.out).toContain('CODEX_OAUTH_WRITE_UNVERIFIED');
  });
});
