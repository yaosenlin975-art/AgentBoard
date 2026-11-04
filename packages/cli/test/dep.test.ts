/**
 * DEP-2：`kb dep ls|add|rm` 的 HTTP 契约、输出与自带退出码映射（设计 §9 / §17-B2）。
 * 用真实本地 HTTP mock（同 cli.test.ts 手法），不 mock fetch。
 */
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { main } from '../src/index.js';

interface Recorded { method: string; url: string; body: unknown }
type MockReply = { status: number; body?: unknown } | undefined;
type Handler = (method: string, url: string, body: unknown) => MockReply;

const ISSUE = {
  id: 'iss1', workspace_id: 'ws1', title: '被阻塞卡', description: '', priority: '中', labels: [],
  status: '待规划', sort_order: 0, claimed_by: null, claimed_at: null, session_id: null,
  comment_count: 0, created_at: 1, updated_at: 1,
};
const VIEW = {
  blockers: [{ issue_id: 'blk1', title: '前置卡', status: '待规划', resolved: false }],
  blocked: [{ issue_id: 'dep1', title: '下游卡', status: '已关闭', resolved: true }],
};

let server: Server;
let base = '';
let calls: Recorded[] = [];
let handler: Handler = () => undefined;

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
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterEach(async () => {
  await new Promise<void>(resolve => server.close(() => resolve()));
});

function makeIo() {
  const out: string[] = [];
  const err: string[] = [];
  return {
    io: { write: (s: string) => { out.push(s); }, writeErr: (s: string) => { err.push(s); }, readStdin: async () => '' },
    out: () => out.join(''),
    err: () => err.join(''),
  };
}

/** 依赖接口一律走 issue 先取 workspace_id 的两步：GET issue 命中，再交给 case 自己的 handler */
function withIssue(inner: Handler): Handler {
  return (method, url, body) => {
    if (method === 'GET' && url === '/api/issues/iss1') return { status: 200, body: ISSUE };
    return inner(method, url, body);
  };
}

const run = async (args: string[]) => {
  const t = makeIo();
  const code = await main(['node', 'kb', '--server', base, ...args], t.io);
  return { code, out: t.out(), err: t.err() };
};

describe('kb dep', () => {
  // BORROW-2.2：--type 透传、白名单中文报错、ls 分组输出
  it('depAddWithTypePostsRelation', async () => {
    handler = withIssue((method, url) => {
      if (method === 'POST' && url === '/api/issues/iss1/dependencies') return { status: 201, body: VIEW };
      return undefined;
    });
    const result = await run(['dep', 'add', 'iss1', 'blk9', '--type', 'related']);
    expect(result.code).toBe(0);
    const post = calls.find(c => c.method === 'POST' && c.url === '/api/issues/iss1/dependencies');
    expect((post!.body as { relation?: string }).relation).toBe('related');
    expect(result.out).toContain('已建立依赖（related）');
  });

  it('depAddWithBogusTypeFailsWithWhitelistAndNoRequest', async () => {
    handler = withIssue(() => undefined);
    const result = await run(['dep', 'add', 'iss1', 'blk9', '--type', 'sibling']);
    expect(result.code).toBe(3);
    expect(result.err).toContain('--type 取值不合法');
    expect(result.err).toContain('blocks / related / duplicate');
    // 未发起任何写请求（白名单校验在请求前）
    expect(calls.filter(c => c.method === 'POST')).toHaveLength(0);
  });

  it('depLsPrintsRelatedAndDuplicateGroupsWhenPresent', async () => {
    const grouped = {
      blockers: [{ issue_id: 'blk1', title: '前置卡', status: '待规划', resolved: false, relation: 'blocks' }],
      blocked: [],
      related: [{ issue_id: 'rel1', title: '关联卡', status: '进行中', resolved: false, relation: 'related' }],
      duplicate: [{ issue_id: 'dup1', title: '重复卡', status: '待规划', resolved: false, relation: 'duplicate' }],
    };
    handler = withIssue((method, url) => {
      if (method === 'GET' && url.startsWith('/api/issues/iss1/dependencies')) return { status: 200, body: grouped };
      return undefined;
    });
    const result = await run(['dep', 'ls', 'iss1']);
    expect(result.code).toBe(0);
    expect(result.out).toContain('关联（related，不阻塞领取）：1 个');
    expect(result.out).toContain('重复（duplicate，不阻塞领取）：1 个');
    expect(result.out).toContain('关联卡');
    expect(result.out).toContain('重复卡');
  });

  it('depLsPrintsBlockersAndBlockedWithResolution', async () => {
    handler = withIssue((method, url) => (
      method === 'GET' && url === '/api/issues/iss1/dependencies?workspace_id=ws1' ? { status: 200, body: VIEW } : undefined
    ));
    const result = await run(['dep', 'ls', 'iss1']);
    expect(result.code).toBe(0);
    expect(result.out).toContain('前置（blockers，1 个）');
    expect(result.out).toContain('前置卡');
    expect(result.out).toContain('未解除');
    expect(result.out).toContain('被阻塞者（blocked，1 个）');
    expect(result.out).toContain('下游卡');
    expect(result.out).toContain('已解除');
    // 两步：先取 issue 的 workspace_id，再带 query
    expect(calls.map(call => `${call.method} ${call.url}`)).toEqual([
      'GET /api/issues/iss1',
      'GET /api/issues/iss1/dependencies?workspace_id=ws1',
    ]);
  });

  it('depLsJsonPrintsRawResponse', async () => {
    handler = withIssue((method, url) => (
      method === 'GET' && url === '/api/issues/iss1/dependencies?workspace_id=ws1' ? { status: 200, body: VIEW } : undefined
    ));
    const result = await run(['--json', 'dep', 'ls', 'iss1']);
    expect(result.code).toBe(0);
    expect(JSON.parse(result.out)).toEqual(VIEW);
  });

  it('depAddPostsWorkspaceAndBlockerId', async () => {
    handler = withIssue((method, url) => (
      method === 'POST' && url === '/api/issues/iss1/dependencies' ? { status: 201, body: VIEW } : undefined
    ));
    const result = await run(['dep', 'add', 'iss1', 'blk1']);
    expect(result.code).toBe(0);
    expect(result.out).toContain('已建立依赖（blocks）：iss1 ← blk1');
    expect(calls[1]).toEqual({ method: 'POST', url: '/api/issues/iss1/dependencies', body: { workspace_id: 'ws1', blocker_issue_id: 'blk1' } });
  });

  it('depRmDeletesWithWorkspaceQuery', async () => {
    handler = withIssue((method, url) => (
      method === 'DELETE' && url === '/api/issues/iss1/dependencies/blk1?workspace_id=ws1' ? { status: 204 } : undefined
    ));
    const result = await run(['dep', 'rm', 'iss1', 'blk1']);
    expect(result.code).toBe(0);
    expect(result.out).toContain('已移除依赖：iss1 ← blk1');
    expect(calls[1]).toEqual({ method: 'DELETE', url: '/api/issues/iss1/dependencies/blk1?workspace_id=ws1', body: undefined });
  });

  it('mapsDependencyErrorCodesToOwnExitCodesAndMessages', async () => {
    const cases: Array<{ code: string; status: number; exit: number; text: string }> = [
      { code: 'DEPENDENCY_CYCLE', status: 409, exit: 2, text: '成环' },
      // DEP-GUARD：子卡依赖父/祖先卡（流程死锁）——必须自带文案，别落到通用「已被占用（…）」前缀
      { code: 'DEPENDENCY_PARENT_CYCLE', status: 409, exit: 2, text: '流程死锁' },
      { code: 'DEPENDENCY_EXISTS', status: 409, exit: 2, text: '已存在' },
      // REL-3：裸 release 已补成可执行的 `kb release <issue-id>`
      { code: 'ISSUE_CLAIMED', status: 409, exit: 2, text: '请先 kb release <issue-id> 再新增前置' },
      { code: 'CROSS_WORKSPACE_DEPENDENCY', status: 400, exit: 3, text: '不支持跨工作区依赖' },
      { code: 'DEPENDENCY_SELF', status: 400, exit: 3, text: '不能依赖自身' },
      { code: 'VALIDATION_ERROR', status: 400, exit: 3, text: '参数不合法' },
      // CLI-02：任务不存在统一 exit 1（与 show/claim 一致），文案不再分「任务」/「依赖」
      { code: 'NOT_FOUND', status: 404, exit: 1, text: '任务不存在或不属于该工作区' },
      { code: 'TASK_NOT_FOUND', status: 404, exit: 1, text: '任务不存在或不属于该工作区' },
    ];
    for (const item of cases) {
      handler = withIssue((method, url) => (
        method === 'POST' && url === '/api/issues/iss1/dependencies'
          ? { status: item.status, body: { error: { code: item.code, message: `服务端原文 ${item.code}` } } }
          : undefined
      ));
      const result = await run(['dep', 'add', 'iss1', 'blk1']);
      expect({ code: item.code, exit: result.code }).toEqual({ code: item.code, exit: item.exit });
      expect(result.err).toContain(item.text);
      // 不得被全局 toExit 包装成「已被占用（…）」
      expect(result.err).not.toContain('已被占用（');
      expect(result.err).not.toContain('服务端原文');
    }
  });

  it('leavesUnmappedCodesToGlobalExitMap', async () => {
    // 未映射的码不进 dep 的 0/2/3/4 表，原样交给全局 toExit（400 → 退出码 1，文案用服务端原文）
    handler = withIssue((method, url) => (
      method === 'POST' && url === '/api/issues/iss1/dependencies'
        ? { status: 400, body: { error: { code: 'UNEXPECTED_CODE', message: '其它错误' } } }
        : undefined
    ));
    const result = await run(['dep', 'add', 'iss1', 'blk1']);
    expect(result.code).toBe(1);
    expect(result.err).toContain('其它错误');
  });

  it('depLsEmptyViewSaysNone', async () => {
    handler = withIssue((method, url) => (
      method === 'GET' && url === '/api/issues/iss1/dependencies?workspace_id=ws1'
        ? { status: 200, body: { blockers: [], blocked: [] } }
        : undefined
    ));
    const result = await run(['dep', 'ls', 'iss1']);
    expect(result.code).toBe(0);
    expect(result.out).toContain('（无）');
  });
});
