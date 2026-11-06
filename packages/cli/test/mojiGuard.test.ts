/**
 * MOJI-GUARD：create / update / comment 三条文本写入路径的「写入后回读校验」。
 * 用一个可控的假服务端复现历史事故（中文落库成 ? 串），断言三条命令明确报错、正常往返不误报、失败不重试。
 */
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { describeStoredTextDrift, resetVersionWarned } from '../src/api.js';
import { main } from '../src/index.js';

/** 假服务端破坏方式：mangle=中文全部替换成 ?；drop-readback=回读路由 404 */
type Breakage = 'none' | 'mangle' | 'drop-readback';

interface Recorded { method: string; url: string }

interface MockIssue {
  id: string;
  workspace_id: string;
  title: string;
  description: string;
  priority: string;
  labels: string[];
  status: string;
  sort_order: number;
  parent_issue_id: null;
  claimed_by: null;
  claimed_at: null;
  session_id: null;
  comment_count: number;
  created_at: number;
  updated_at: number;
}

function blankIssue(id: string): MockIssue {
  return {
    id,
    workspace_id: 'ws1',
    title: '',
    description: '',
    priority: '中',
    labels: [],
    status: '待规划',
    sort_order: 0,
    parent_issue_id: null,
    claimed_by: null,
    claimed_at: null,
    session_id: null,
    comment_count: 0,
    created_at: 1,
    updated_at: 2,
  };
}

const ISSUE_ID = 'iss-moji-guard';
const WS = [{ id: 'ws1', name: '前端', path: 'D:/ws/frontend', created_at: 1 }];

/** 服务端只按码位切窗（与 apps/server textWindow 同口径），用于验证长正文分页回读 */
function textWindow(text: string, offset: number, max: number) {
  const chars = Array.from(text);
  const truncated = offset + max < chars.length;
  return { content: chars.slice(offset, offset + max).join(''), truncated };
}

let server: Server;
let base = '';
let breakage: Breakage = 'none';
let windowMax = 40000;
let calls: Recorded[] = [];
let issues = new Map<string, MockIssue>();
let comments = new Map<string, string>();
let commentSeq = 0;

function corrupt(text: string): string {
  return breakage === 'mangle' ? text.replace(/[^\x00-\x7F]/g, '?') : text;
}

beforeEach(async () => {
  resetVersionWarned();
  breakage = 'none';
  windowMax = 40000;
  calls = [];
  issues = new Map();
  comments = new Map();
  commentSeq = 0;
  server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(c as Buffer));
    req.on('end', () => {
      const method = req.method ?? '';
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      const path = url.pathname;
      const raw = Buffer.concat(chunks).toString('utf8');
      const payload = (raw === '' ? {} : JSON.parse(raw)) as Record<string, unknown>;
      calls.push({ method, url: req.url ?? '' });
      const send = (status: number, body: unknown) => {
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(body));
      };
      const fail = (status: number, message: string) => send(status, { error: { code: 'MOCK', message } });

      if (method === 'GET' && path === '/api/workspaces') return send(200, WS);

      // 卡面：POST 建卡 / PATCH 改卡 / GET 回读
      if (method === 'POST' && path === '/api/issues') {
        const issue: MockIssue = { ...blankIssue(ISSUE_ID), workspace_id: String(payload.workspace_id ?? 'ws1'), title: corrupt(String(payload.title ?? '')), description: corrupt(String(payload.description ?? '')) };
        issues.set(issue.id, issue);
        return send(201, issue);
      }
      if (method === 'PATCH' && path === `/api/issues/${ISSUE_ID}`) {
        const stored = issues.get(ISSUE_ID) ?? blankIssue(ISSUE_ID);
        if (payload.title !== undefined) stored.title = corrupt(String(payload.title));
        if (payload.description !== undefined) stored.description = corrupt(String(payload.description));
        issues.set(ISSUE_ID, stored);
        return send(200, stored);
      }
      if (method === 'GET' && path === `/api/issues/${ISSUE_ID}`) {
        if (breakage === 'drop-readback') return fail(404, '接口不存在: GET /api/issues/:id');
        return send(200, issues.get(ISSUE_ID) ?? blankIssue(ISSUE_ID));
      }

      // 评论：POST 写入 / GET 单条窗口回读
      if (method === 'POST' && path === `/api/issues/${ISSUE_ID}/comments`) {
        const id = `c${(commentSeq += 1)}`;
        const content = corrupt(String(payload.content ?? ''));
        comments.set(id, content);
        return send(200, { comment: { id, issue_id: ISSUE_ID, author: 'user', content, ts: 7 }, woke: false });
      }
      const commentMatch = /^\/api\/issues\/[^/]+\/comments\/([^/]+)$/.exec(path);
      if (method === 'GET' && commentMatch) {
        if (breakage === 'drop-readback') return fail(404, '接口不存在: GET /api/issues/:id/comments/:commentId');
        const stored = comments.get(commentMatch[1]!);
        if (stored === undefined) return fail(404, '评论不存在');
        const offset = Number(url.searchParams.get('content_offset_chars') ?? '0');
        // windowMax 模拟服务端窗口上限（请求值同样被夹住）
        const requested = Number(url.searchParams.get('content_max_chars') ?? '12000');
        const max = Math.min(requested, windowMax);
        return send(200, { id: commentMatch[1], content: stored, ...textWindow(stored, offset, max) });
      }
      return fail(404, 'mock 未匹配');
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterEach(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

function makeIo(stdinText = '') {
  const out: string[] = [];
  const err: string[] = [];
  return {
    io: { write: (s: string) => { out.push(s); }, writeErr: (s: string) => { err.push(s); }, readStdin: async () => stdinText },
    out: () => out.join(''),
    err: () => err.join(''),
  };
}

const run = async (args: string[], stdinText = '') => {
  const t = makeIo(stdinText);
  const code = await main(['node', 'kb', '--server', base, ...args], t.io);
  return { code, out: t.out(), err: t.err() };
};

/** 已发生的写入请求数（POST/PATCH），用于断言校验失败后没有重试 */
const writeCalls = () => calls.filter((c) => c.method === 'POST' || c.method === 'PATCH').length;

describe('MOJI-GUARD 写入回读校验', () => {
  it('回显被破坏（中文替换成 ?）：create-issue / update --description-stdin / comment 三条均 exit 1 并报出位置', async () => {
    breakage = 'mangle';

    const created = await run(['create-issue', 'ws1', '导出功能验收', '-d', '正文与验收标准']);
    expect(created.code).toBe(1);
    expect(created.err).toContain('写入校验失败');
    expect(created.err).toContain('疑似中文被替换字符吞掉');
    expect(created.err).toContain('第 1 字符起');
    expect(created.err).toContain(ISSUE_ID);

    const updated = await run(['update', ISSUE_ID, '--description-stdin'], '回读校验：中文正文第二行\n');
    expect(updated.code).toBe(1);
    expect(updated.err).toContain('写入校验失败');
    expect(updated.err).toContain('描述');

    const commented = await run(['comment', ISSUE_ID, '第一条中文评论']);
    expect(commented.code).toBe(1);
    expect(commented.err).toContain('写入校验失败');
    expect(commented.err).toContain('评论内容');
    expect(commented.err).toContain('第 1 字符起');
    expect(commented.err).toContain('c1');
  });

  it('正常中文往返（含问号与 emoji）三条均 exit 0 且无误报', async () => {
    const created = await run(['create-issue', 'ws1', '导出功能验收', '-d', '目标：导出 CSV？两问?? 号合法\n验收：中文与 emoji 🙂 一致']);
    expect(created.code).toBe(0);
    expect(created.err).not.toContain('写入校验失败');
    expect(created.out).toContain('已创建任务');

    const updated = await run(['update', ISSUE_ID, '--description-stdin'], '改后正文：仍含合法问号 ??? 与中文\n');
    expect(updated.code).toBe(0);
    expect(updated.err).not.toContain('写入校验失败');

    const commented = await run(['comment', ISSUE_ID, '中文评论一行', '第二词']);
    expect(commented.code).toBe(0);
    expect(commented.out).toContain('评论已写入');
  });

  it('提交原文本身就含连续 ? 时不判失败（合法问号不误伤）', async () => {
    const commented = await run(['comment', ISSUE_ID, '落库内容 ???? 已确认']);
    expect(commented.code).toBe(0);
    expect(commented.err).not.toContain('写入校验失败');
  });

  it('校验失败不重试：每类命令只发生一次写入请求', async () => {
    breakage = 'mangle';
    await run(['create-issue', 'ws1', '导出功能验收', '-d', '正文与验收标准']);
    expect(writeCalls()).toBe(1);

    const callsAfterCreate = calls.length;
    await run(['comment', ISSUE_ID, '第一条中文评论']);
    expect(writeCalls()).toBe(2);
    // 写入 1 次 + 回读 1 次，失败后不再追加请求
    expect(calls.length - callsAfterCreate).toBe(2);
  });

  it('长评论按窗口分页读全，不因截断误报', async () => {
    windowMax = 4; // 强制服务端每次只回 4 个码位
    const long = '一'.repeat(30);
    const commented = await run(['comment', ISSUE_ID, long]);
    expect(commented.code).toBe(0);
    expect(commented.err).not.toContain('写入校验失败');
    // 30 个码位 / 每窗 4 = 8 次回读
    expect(calls.filter((c) => c.method === 'GET' && c.url.includes('/comments/')).length).toBe(8);
  });

  it('回读请求失败时报「未确认」并保留已写入 id，不静默通过', async () => {
    breakage = 'drop-readback';
    const commented = await run(['comment', ISSUE_ID, '中文评论正文']);
    expect(commented.code).toBe(1);
    expect(commented.err).toContain('写入校验失败');
    expect(commented.err).toContain('回读');
    expect(commented.err).toContain('c1');

    const created = await run(['create-issue', 'ws1', '导出功能验收', '-d', '正文与验收标准']);
    expect(created.code).toBe(1);
    expect(created.err).toContain('写入校验失败');
    expect(created.err).toContain(ISSUE_ID);
  });
});

describe('describeStoredTextDrift 逐字比对', () => {
  it('一致 → 空串；提交原文含同样的 ? 串时不算漂移', () => {
    expect(describeStoredTextDrift('中文正文', '中文正文')).toBe('');
    expect(describeStoredTextDrift('问题 ???? 已确认', '问题 ???? 已确认')).toBe('');
  });

  it('普通不一致给出首个差异码位（emoji 按码位不按代理对）', () => {
    expect(describeStoredTextDrift('前 🙂 后', '前 X 后')).toBe('落库内容与提交内容不一致（第 3 字符起）');
  });

  it('落库出现提交中没有的连续 3 个以上 ? → 判替换字符异常', () => {
    const drift = describeStoredTextDrift('中文正文与验收', '???????与验收');
    expect(drift).toContain('连续 7 个 ?');
    expect(drift).toContain('第 1 字符起');
    expect(drift).toContain('疑似中文被替换字符吞掉');
  });

  it('两个连续 ? 不算异常（未达 3 个阈值）', () => {
    expect(describeStoredTextDrift('中文正文', '??正文')).not.toContain('疑似中文被替换字符吞掉');
    expect(describeStoredTextDrift('中文正文', '??正文')).toContain('不一致（第 1 字符起）');
  });
});
