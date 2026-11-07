/**
 * BULK-OPS：kb close / release / fail --ids-file 批量执行（串行、汇总、dry-run、幂等键派生）。
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { main } from '../src/index.js';
import { deriveBulkRequestId } from '../src/commands/lifecycle.js';

interface Recorded { method: string; url: string; body: unknown; requestId?: string }
type MockReply = { status: number; body?: unknown } | undefined;
type Handler = (method: string, url: string, body: unknown) => MockReply;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function issue(id: string, status = '待验收', extra: Record<string, unknown> = {}) {
  return {
    id, workspace_id: 'ws1', title: `卡 ${id}`, description: '', priority: '中', labels: [],
    status, sort_order: 0, parent_issue_id: null, claimed_by: null, claimed_at: null,
    session_id: null, comment_count: 0, created_at: 1, updated_at: 2, ...extra,
  };
}

let server: Server; let base = ''; let calls: Recorded[] = []; let handler: Handler = () => undefined;
let dir = '';

beforeEach(async () => {
  calls = []; handler = () => undefined;
  dir = mkdtempSync(join(tmpdir(), 'ab-bulk-'));
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
      if (!reply) { res.writeHead(404, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: { code: 'NOT_FOUND', message: 'mock 未匹配 ' + req.url } })); return; }
      res.writeHead(reply.status, { 'content-type': 'application/json' });
      res.end(reply.body === undefined ? '' : JSON.stringify(reply.body));
    });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterEach(async () => {
  await new Promise<void>(resolve => server.close(() => resolve()));
  rmSync(dir, { recursive: true, force: true });
});

function makeIo() {
  const out: string[] = []; const err: string[] = [];
  return { io: { write: (s: string) => { out.push(s); }, writeErr: (s: string) => { err.push(s); }, readStdin: async () => '' }, out: () => out.join(''), err: () => err.join('') };
}
const run = async (args: string[]) => { const t = makeIo(); const code = await main(['node', 'kb', '--server', base, ...args], t.io); return { code, out: t.out(), err: t.err() }; };
const idsFile = (lines: string[]) => {
  const path = join(dir, 'ids.txt');
  writeFileSync(path, lines.join('\n'), 'utf8');
  return path;
};

describe('BULK-OPS：close --ids-file', () => {
  it('3 张待验收卡逐个串行关闭，汇总 成功 3 / 失败 0', async () => {
    handler = (m, u) => {
      if (m === 'POST' && /^\/api\/issues\/[^/]+\/close$/.test(u)) return { status: 200, body: issue(u.split('/')[3]!, '已关闭') };
      return undefined;
    };
    const ids = ['aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'];
    const result = await run(['close', '--ids-file', idsFile(ids)]);
    expect(result.code).toBe(0);
    expect(result.out).toContain('批量 close：成功 3 / 失败 0 / 跳过 0');
    expect(calls.map(c => `${c.method} ${c.url}`)).toEqual(ids.map(id => `POST /api/issues/${id}/close`));
  });

  it('混合占用中 + 正常：正常关闭，失败项带服务端原因（含占用者），exit 1 且不中断后续', async () => {
    const busy = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    const good = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
    handler = (m, u) => {
      if (m === 'POST' && u === `/api/issues/${busy}/close`) return { status: 409, body: { error: { code: 'ISSUE_CLAIMED', message: '任务正被 other-agent 占用，请先 release 再关闭' } } };
      if (m === 'GET' && u === `/api/issues/${busy}`) return { status: 200, body: issue(busy, '待验收', { claimed_by: 'other-agent' }) };
      if (m === 'POST' && u === `/api/issues/${good}/close`) return { status: 200, body: issue(good, '已关闭') };
      return undefined;
    };
    const result = await run(['close', '--ids-file', idsFile([busy, good])]);
    expect(result.code).toBe(1);
    expect(result.out).toContain('批量 close：成功 1 / 失败 1 / 跳过 0');
    expect(result.out).toContain(`- ${busy}：任务正被 other-agent 占用`);
    // 他人占用不自动 release，但后面的卡照常处理
    expect(calls.some(c => c.url.endsWith('/release'))).toBe(false);
    expect(calls.some(c => c.method === 'POST' && c.url === `/api/issues/${good}/close`)).toBe(true);
  });

  it('--dry-run 只打印清单，零请求零写入', async () => {
    const ids = ['aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'];
    const result = await run(['close', '--ids-file', idsFile(ids), '--dry-run']);
    expect(result.code).toBe(0);
    expect(result.out).toContain('[dry-run] close：将处理 2 张（未写入任何数据）');
    for (const id of ids) expect(result.out).toContain(id);
    expect(calls).toHaveLength(0);
  });

  it('同 --request-id 重跑：每条派生稳定且互不相同的 UUID 幂等键', async () => {
    handler = (m, u) => (m === 'POST' && /\/close$/.test(u) ? { status: 200, body: issue(u.split('/')[3]!, '已关闭') } : undefined);
    const ids = ['aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'];
    const baseKey = '11111111-1111-4111-8111-111111111111';
    const file = idsFile(ids);
    expect((await run(['close', '--ids-file', file, '--request-id', baseKey])).code).toBe(0);
    const first = calls.map(c => c.requestId!);
    calls = [];
    expect((await run(['close', '--ids-file', file, '--request-id', baseKey])).code).toBe(0);
    const second = calls.map(c => c.requestId!);
    expect(first).toEqual(second);
    expect(new Set(first).size).toBe(ids.length);
    for (const key of first) expect(key).toMatch(UUID_RE);
    // 不同动作派生不同键，避免同一次批量里 close/release/fail 撞键
    expect(deriveBulkRequestId(baseKey, 'close', ids[0]!)).not.toBe(deriveBulkRequestId(baseKey, 'fail', ids[0]!));
  });

  it('ids 文件兼容 ≥8 位前缀、空行与 # 注释', async () => {
    const full = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    handler = (m, u) => {
      if (m === 'GET' && u === '/api/workspaces') return { status: 200, body: [{ id: 'ws1', name: 'Demo', path: 'D:\\demo', created_at: 1 }] };
      if (m === 'GET' && u.startsWith('/api/issues?workspace=ws1')) return { status: 200, body: [issue(full)] };
      if (m === 'POST' && u === `/api/issues/${full}/close`) return { status: 200, body: issue(full, '已关闭') };
      return undefined;
    };
    const result = await run(['close', '--ids-file', idsFile(['# 待关闭', '', full.slice(0, 8), '  '])]);
    expect(result.code).toBe(0);
    expect(result.out).toContain('批量 close：成功 1 / 失败 0 / 跳过 0');
    expect(calls.some(c => c.method === 'POST' && c.url === `/api/issues/${full}/close`)).toBe(true);
  });

  it('重复行只执行一次，第二次计入跳过', async () => {
    const id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    handler = (m, u) => (m === 'POST' && u === `/api/issues/${id}/close` ? { status: 200, body: issue(id, '已关闭') } : undefined);
    const result = await run(['close', '--ids-file', idsFile([id, id])]);
    expect(result.code).toBe(0);
    expect(result.out).toContain('批量 close：成功 1 / 失败 0 / 跳过 1');
    expect(result.out).toContain(`- ${id}：重复 id`);
    expect(calls.filter(c => c.method === 'POST')).toHaveLength(1);
  });
});

describe('BULK-OPS：release / fail --ids-file 接线', () => {
  it('release 批量：逐条带 workspace_id 释放', async () => {
    const id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    handler = (m, u) => {
      if (m === 'GET' && u === `/api/issues/${id}`) return { status: 200, body: issue(id, '进行中') };
      if (m === 'POST' && u === `/api/issues/${id}/release`) return { status: 200, body: issue(id, '待规划') };
      return undefined;
    };
    const result = await run(['release', '--ids-file', idsFile([id])]);
    expect(result.code).toBe(0);
    expect(result.out).toContain('批量 release：成功 1 / 失败 0 / 跳过 0');
    expect(calls.find(c => c.method === 'POST')?.body).toMatchObject({ agent_id: 'kb-cli', workspace_id: 'ws1' });
  });

  it('fail 批量：共用同一 reason，逐条写失败', async () => {
    const ids = ['aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'];
    handler = (m, u) => (m === 'POST' && /\/fail$/.test(u) ? { status: 200, body: issue(u.split('/')[3]!, '待规划') } : undefined);
    const result = await run(['fail', '--ids-file', idsFile(ids), '--reason', '批量退回']);
    expect(result.code).toBe(0);
    expect(result.out).toContain('批量 fail：成功 2 / 失败 0 / 跳过 0');
    expect(calls.filter(c => c.method === 'POST').map(c => (c.body as { reason: string }).reason)).toEqual(['批量退回', '批量退回']);
  });
});
