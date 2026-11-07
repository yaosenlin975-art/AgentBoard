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

  it('CLI-STATUS-SET：update --status 把卡置入自定义状态', async () => {
    handler = (m, u) => (m === 'PATCH' && u === '/api/issues/iss1'
      ? { status: 200, body: { ...ISSUE, status: '待确认' } }
      : undefined);
    const result = await run(['update', 'iss1', '--status', '待确认']);
    expect(result.code).toBe(0);
    expect(result.out).toContain('状态: 待确认');
    expect(calls).toHaveLength(1);
    expect(calls[0]!.body).toMatchObject({ agent_id: 'kb-cli', status: '待确认' });
  });

  it('CLI-STATUS-SET：update --status 非法 → exit 1 且透出可用状态清单', async () => {
    handler = (m, u) => (m === 'PATCH' && u === '/api/issues/iss1'
      ? { status: 400, body: { error: { code: 'VALIDATION_ERROR', message: 'status: 不是本工作区已定义状态，可用：待规划 / 进行中 / 待确认' } } }
      : undefined);
    const result = await run(['update', 'iss1', '--status', '不存在']);
    expect(result.code).toBe(1);
    expect(result.err).toContain('可用：待规划 / 进行中 / 待确认');
  });

  it('CLI-STATUS-SET：update --status 命中占用 → exit 2 并提示先释放', async () => {
    handler = (m, u) => (m === 'PATCH' && u === '/api/issues/iss1'
      ? { status: 409, body: { error: { code: 'ISSUE_CLAIMED', message: '占用中禁止修改状态' } } }
      : undefined);
    const result = await run(['update', 'iss1', '--status', '已废弃']);
    expect(result.code).toBe(2);
    expect(result.err).toContain('占用中禁止修改状态');
    expect(result.err).toContain('kb release');
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

describe('GIT-OBSERVABLE：done 自动提交未完成必须可感知（卡 9fa0d16f）', () => {
  const NOT_COMMITTED = {
    status: 'not-committed',
    reason: 'NO_BASELINE',
    pending: ['src/feature.ts'],
    note: '⚠ 无 claim 基线，本次未自动提交（done 已生效，工作树未改动）\n- 补救（可直接复制执行）：git add -- src/feature.ts; git commit -m "[iss1] 标题" -- src/feature.ts',
  };

  it('无基线 / 提交失败：done 已生效但 exit 1，stderr 带原因与补救命令', async () => {
    handler = (m, u) => (m === 'POST' && u === '/api/issues/iss1/done'
      ? { status: 200, body: { ...ISSUE, status: '待验收', git_commit: NOT_COMMITTED } }
      : undefined);
    const result = await run(['done', 'iss1', '--scope', 'src/feature.ts']);
    expect(result.code).toBe(1);
    expect(result.out).toContain('已完成: iss1');
    expect(result.err).toContain('自动提交未完成');
    expect(result.err).toContain('git add -- src/feature.ts');
  });

  it('done --close 遇提交未完成：不执行 close 并 exit 1', async () => {
    handler = (m, u) => {
      if (m === 'POST' && u === '/api/issues/iss1/done') return { status: 200, body: { ...ISSUE, status: '待验收', git_commit: NOT_COMMITTED } };
      if (m === 'POST' && u === '/api/issues/iss1/close') return { status: 200, body: { ...ISSUE, status: '已关闭' } };
      return undefined;
    };
    const result = await run(['done', 'iss1', '--close']);
    expect(result.code).toBe(1);
    expect(calls.some(c => c.url === '/api/issues/iss1/close')).toBe(false);
    expect(result.err).toContain('已跳过 close');
    expect(result.err).toContain('kb close iss1');
  });

  it('提交成功：不产生 stderr，退出码 0', async () => {
    handler = (m, u) => (m === 'POST' && u === '/api/issues/iss1/done'
      ? { status: 200, body: { ...ISSUE, status: '待验收', git_commit: { status: 'committed', reason: null, pending: [], note: '已自动提交 1 个文件：a.ts（commit abc12345）' } } }
      : undefined);
    const result = await run(['done', 'iss1', '--scope', 'a.ts']);
    expect(result.code).toBe(0);
    expect(result.err).toBe('');
  });

  it('git 不可用（无法判定）只落 stderr 警告，不改退出码', async () => {
    handler = (m, u) => (m === 'POST' && u === '/api/issues/iss1/done'
      ? { status: 200, body: { ...ISSUE, status: '待验收', git_commit: { status: 'unavailable', reason: 'GIT_NOT_INSTALLED', pending: [], note: '跳过自动提交：环境未安装 git（GIT_NOT_INSTALLED）' } } }
      : undefined);
    const result = await run(['done', 'iss1', '--scope', 'a.ts']);
    expect(result.code).toBe(0);
    expect(result.err).toContain('跳过自动提交');
  });

  it('仅提示类原因（未声明范围的遗留脏文件）保持 exit 0 但落 stderr', async () => {
    handler = (m, u) => (m === 'POST' && u === '/api/issues/iss1/done'
      ? { status: 200, body: { ...ISSUE, status: '待验收', git_commit: { status: 'not-committed', reason: 'UNDECLARED_PREEXISTING', pending: ['legacy.ts'], note: '未提交 1 个 claim 前就已修改的文件' } } }
      : undefined);
    const result = await run(['done', 'iss1']);
    expect(result.code).toBe(0);
    expect(result.err).toContain('未提交 1 个');
  });

  it('幂等重放（git_commit=null）不误报，退出码 0', async () => {
    handler = (m, u) => (m === 'POST' && u === '/api/issues/iss1/done'
      ? { status: 200, body: { ...ISSUE, status: '待验收', git_commit: null } }
      : undefined);
    const result = await run(['done', 'iss1']);
    expect(result.code).toBe(0);
    expect(result.err).toBe('');
  });
});
