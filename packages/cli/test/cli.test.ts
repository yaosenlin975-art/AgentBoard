import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_BASE, normalizeBase, resetVersionWarned, SERVER_VERSION_HEADER } from '../src/api.js';
import { CLI_VERSION } from '../src/version.js';
import { main } from '../src/index.js';

interface Recorded {
  method: string;
  url: string;
  body: unknown;
  headers?: { contentType?: string; fileName?: string; requestId?: string };
}

type MockReply = { status: number; body?: unknown; headers?: Record<string, string> } | undefined;
type Handler = (method: string, url: string, body: unknown) => MockReply;

const WS = { id: 'ws1', name: '前端', path: 'D:/ws/frontend', created_at: 1 };
const ISSUE = {
  id: 'iss1',
  workspace_id: 'ws1',
  title: '实现登录',
  description: '描述\n多行',
  priority: '高',
  labels: ['p1'],
  status: '待规划',
  sort_order: 0,
  claimed_by: null,
  claimed_at: null,
  session_id: null,
  comment_count: 2,
  created_at: 2,
  updated_at: 3,
};
const COMMENTS = [
  { id: 'c1', issue_id: 'iss1', author: 'user', content: '开工前注意兼容旧数据', ts: 5 },
  { id: 'c2', issue_id: 'iss1', author: 'agent:codebuddy', content: '已完成解析层', ts: 6 },
];

let server: Server;
let base = '';
let calls: Recorded[] = [];
/** 每次请求的 Idempotency-Key（'' 表示未带），与 calls 同序；不改 calls 形状以免影响既有断言 */
let keyLog: string[] = [];
let handler: Handler = () => undefined;

beforeEach(async () => {
  calls = [];
  keyLog = [];
  handler = () => undefined;
  server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(c as Buffer));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      let body: unknown;
      try {
        body = raw === '' ? undefined : JSON.parse(raw);
      } catch {
        body = raw;
      }
      const contentType = String(req.headers['content-type'] ?? '');
      const fileName = String(req.headers['x-file-name'] ?? '');
      const requestId = String(req.headers['idempotency-key'] ?? '');
      const isCommentRequest = (req.url ?? '').includes('/comments');
      keyLog.push(requestId);
      calls.push({
        method: req.method ?? '',
        url: req.url ?? '',
        body,
        ...((contentType.startsWith('image/') || (isCommentRequest && requestId !== '')) ? {
          headers: {
            ...(contentType.startsWith('image/') ? { contentType } : {}),
            ...(fileName !== '' ? { fileName } : {}),
            ...(isCommentRequest && requestId !== '' ? { requestId } : {}),
          },
        } : {}),
      });
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
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterEach(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

function makeIo(stdin = '') {
  const outChunks: string[] = [];
  const errChunks: string[] = [];
  const io = {
    write: (s: string) => {
      outChunks.push(s);
    },
    writeErr: (s: string) => {
      errChunks.push(s);
    },
    readStdin: async () => stdin,
  };
  return { io, out: () => outChunks.join(''), err: () => errChunks.join('') };
}

describe('api', () => {
  it('normalizeBase：缺省回默认基址、去尾部斜杠', () => {
    expect(normalizeBase(undefined)).toBe(DEFAULT_BASE);
    expect(normalizeBase('http://x:1/')).toBe('http://x:1');
    expect(normalizeBase('  http://y:2//  ')).toBe('http://y:2');
  });
});

describe('版本', () => {
  beforeEach(() => resetVersionWarned());

  function spacesHandler(headers: Record<string, string> | undefined): void {
    handler = (m, u) => (m === 'GET' && u === '/api/workspaces' ? { status: 200, body: [WS], headers } : undefined);
  }

  function warnCount(err: string): number {
    return err.split('版本不匹配').length - 1;
  }

  /** 捕获真实 stderr（版本警告走 process.stderr，不经注入 Io） */
  function captureStderr(): { text: () => string; stop: () => void } {
    const chunks: string[] = [];
    const spy = vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
      chunks.push(String(chunk));
      return true;
    });
    return {
      text: () => chunks.join(''),
      stop: () => spy.mockRestore(),
    };
  }

  it('--version 输出与 package.json 一致', async () => {
    const chunks: string[] = [];
    const spy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
      chunks.push(String(chunk));
      return true;
    });
    try {
      const code = await main(['node', 'kb', '--version']);
      expect(code).toBe(0);
      expect(chunks.join('')).toContain(CLI_VERSION);
    } finally {
      spy.mockRestore();
    }
  });

  it('响应缺失 x-agentboard-version（旧服务端）→ stderr 警告一次，stdout 不受污染', async () => {
    spacesHandler(undefined);
    const t = makeIo();
    const cap = captureStderr();
    let code = 1;
    try {
      code = await main(['node', 'kb', '--server', base, '--json', 'list-spaces'], t.io);
    } finally {
      cap.stop();
    }
    expect(code).toBe(0);
    expect(warnCount(cap.text())).toBe(1);
    expect(cap.text()).toContain('服务端未上报版本');
    expect(cap.text()).toContain(CLI_VERSION);
    expect(JSON.parse(t.out())).toEqual([WS]);
  });

  it('0.x minor 不同 → 警告；major 不同 → 警告', async () => {
    spacesHandler({ [SERVER_VERSION_HEADER]: '0.2.0' });
    const t1 = makeIo();
    const cap1 = captureStderr();
    try {
      await main(['node', 'kb', '--server', base, 'list-spaces'], t1.io);
    } finally {
      cap1.stop();
    }
    expect(warnCount(cap1.text())).toBe(1);
    expect(cap1.text()).toContain('服务端 0.2.0');

    resetVersionWarned();
    spacesHandler({ [SERVER_VERSION_HEADER]: '1.0.0' });
    const t2 = makeIo();
    const cap2 = captureStderr();
    try {
      await main(['node', 'kb', '--server', base, 'list-spaces'], t2.io);
    } finally {
      cap2.stop();
    }
    expect(warnCount(cap2.text())).toBe(1);
    expect(cap2.text()).toContain('服务端 1.0.0');
  });

  it('版本一致或仅 patch 不同 → 不警告', async () => {
    spacesHandler({ [SERVER_VERSION_HEADER]: CLI_VERSION });
    const cap1 = captureStderr();
    try {
      await main(['node', 'kb', '--server', base, 'list-spaces'], makeIo().io);
    } finally {
      cap1.stop();
    }
    expect(cap1.text()).toBe('');

    resetVersionWarned();
    spacesHandler({ [SERVER_VERSION_HEADER]: '0.1.999' });
    const cap2 = captureStderr();
    try {
      await main(['node', 'kb', '--server', base, 'list-spaces'], makeIo().io);
    } finally {
      cap2.stop();
    }
    expect(cap2.text()).toBe('');
  });

  it('每进程最多警告一次（多次请求仅一行）', async () => {
    spacesHandler({ [SERVER_VERSION_HEADER]: '0.2.0' });
    const cap = captureStderr();
    try {
      await main(['node', 'kb', '--server', base, 'list-spaces'], makeIo().io);
      await main(['node', 'kb', '--server', base, 'list-spaces'], makeIo().io);
    } finally {
      cap.stop();
    }
    expect(warnCount(cap.text())).toBe(1);
  });
});

describe('list-spaces', () => {
  it('GET /api/workspaces，表格含 id name path', async () => {
    handler = (m, u) => (m === 'GET' && u === '/api/workspaces' ? { status: 200, body: [WS] } : undefined);
    const t = makeIo();
    const code = await main(['node', 'kb', '--server', base, 'list-spaces'], t.io);
    expect(code).toBe(0);
    expect(calls).toEqual([{ method: 'GET', url: '/api/workspaces', body: undefined }]);
    expect(t.out()).toContain('ws1');
    expect(t.out()).toContain('前端');
    expect(t.out()).toContain('D:/ws/frontend');
  });

  it('--json 输出原始 JSON 响应', async () => {
    handler = (m, u) => (m === 'GET' && u === '/api/workspaces' ? { status: 200, body: [WS] } : undefined);
    const t = makeIo();
    const code = await main(['node', 'kb', '--server', base, '--json', 'list-spaces'], t.io);
    expect(code).toBe(0);
    expect(JSON.parse(t.out())).toEqual([WS]);
  });
});

describe('list-tasks', () => {
  const issues = [
    { ...ISSUE, labels: ['p1', 'bug'] },
    { ...ISSUE, id: 'iss2', title: '已占用任务', status: '进行中', claimed_by: 'agent:codebuddy', labels: [], comment_count: 0 },
  ];

  it('--workspace 按名称解析后查任务，输出含 id/状态/优先级/占用者/标题', async () => {
    handler = (m, u) => {
      if (m === 'GET' && u === '/api/workspaces') return { status: 200, body: [WS] };
      if (m === 'GET' && u === '/api/issues?workspace=ws1') return { status: 200, body: issues };
      return undefined;
    };
    const t = makeIo();
    const code = await main(['node', 'kb', '--server', base, 'list-tasks', '--workspace', '前端'], t.io);
    expect(code).toBe(0);
    expect(calls[1]).toEqual({ method: 'GET', url: '/api/issues?workspace=ws1', body: undefined });
    expect(t.out()).toContain('实现登录');
    expect(t.out()).toContain('agent:codebuddy');
    expect(t.out()).toContain('待规划');
    expect(t.out()).toContain('高');
  });

  it('表格含 labels（多标签逗号连接、空为 -）与评论（comment_count）列', async () => {
    handler = (m, u) => {
      if (m === 'GET' && u === '/api/workspaces') return { status: 200, body: [WS] };
      if (m === 'GET' && u === '/api/issues?workspace=ws1') return { status: 200, body: issues };
      return undefined;
    };
    const t = makeIo();
    const code = await main(['node', 'kb', '--server', base, 'list-tasks', '--workspace', '前端'], t.io);
    expect(code).toBe(0);
    const header = t.out().split('\n')[0]!;
    expect(header).toContain('labels');
    expect(header).toContain('评论');
    const row = (id: string) => t.out().split('\n').find((r) => r.includes(id))!.split(/\s{2,}/);
    const iss1 = row('iss1');
    expect(iss1[3]).toBe('p1,bug'); // 多标签逗号连接
    expect(iss1[5]).toBe('2'); // 评论数
    const iss2 = row('iss2');
    expect(iss2[3]).toBe('-'); // 空标签显示 -
    expect(iss2[5]).toBe('0');
  });

  it('--workspace 传 id 同样可用', async () => {
    handler = (m, u) => {
      if (m === 'GET' && u === '/api/workspaces') return { status: 200, body: [WS] };
      if (m === 'GET' && u === '/api/issues?workspace=ws1') return { status: 200, body: [] };
      return undefined;
    };
    const t = makeIo();
    const code = await main(['node', 'kb', '--server', base, 'list-tasks', '--workspace', 'ws1'], t.io);
    expect(code).toBe(0);
    expect(t.out()).toContain('（无任务）');
  });

  it('未知工作空间名 → 退出码 1 + stderr', async () => {
    handler = (m, u) => (m === 'GET' && u === '/api/workspaces' ? { status: 200, body: [WS] } : undefined);
    const t = makeIo();
    const code = await main(['node', 'kb', '--server', base, 'list-tasks', '--workspace', '不存在'], t.io);
    expect(code).toBe(1);
    expect(t.err()).toContain('工作空间不存在: 不存在');
  });

  it('--status 客户端过滤（--json 下同样生效）', async () => {
    handler = (m, u) => {
      if (m === 'GET' && u === '/api/workspaces') return { status: 200, body: [WS] };
      // CLI-LIST-GUARD：--status 先按工作区状态字典校验
      if (m === 'GET' && u === '/api/workspaces/ws1/statuses') return { status: 200, body: [
        { id: 's1', workspace_id: 'ws1', name: '待规划', kind: 'open', sort_order: 0, is_builtin: 1 },
        { id: 's2', workspace_id: 'ws1', name: '进行中', kind: 'started', sort_order: 10, is_builtin: 1 },
      ] };
      if (m === 'GET' && u === '/api/issues?workspace=ws1') return { status: 200, body: issues };
      return undefined;
    };
    const t = makeIo();
    const code = await main(
      ['node', 'kb', '--server', base, '--json', 'list-tasks', '--status', '待规划'],
      t.io,
    );
    expect(code).toBe(0);
    const parsed = JSON.parse(t.out()) as Array<{ id: string }>;
    expect(parsed.map((i) => i.id)).toEqual(['iss1']);
  });

  it('缺省 --workspace 时聚合全部工作空间', async () => {
    const ws2 = { ...WS, id: 'ws2', name: '后端' };
    handler = (m, u) => {
      if (m === 'GET' && u === '/api/workspaces') return { status: 200, body: [WS, ws2] };
      if (m === 'GET' && u === '/api/issues?workspace=ws1') return { status: 200, body: [ISSUE] };
      if (m === 'GET' && u === '/api/issues?workspace=ws2')
        return { status: 200, body: [{ ...ISSUE, id: 'iss9', workspace_id: 'ws2' }] };
      return undefined;
    };
    const t = makeIo();
    const code = await main(['node', 'kb', '--server', base, '--json', 'list-tasks'], t.io);
    expect(code).toBe(0);
    const parsed = JSON.parse(t.out()) as Array<{ id: string }>;
    expect(parsed.map((i) => i.id)).toEqual(['iss1', 'iss9']);
  });
});

describe('show', () => {
  /** show 的 handler：默认走 consume 主路径（c2 为新评论）；degrade 时 consume 404 → GET 降级 */
  function mockShow(opts: { degrade?: boolean } = {}): void {
    handler = (m, u) => {
      if (m === 'GET' && u === '/api/issues/iss1') return { status: 200, body: ISSUE };
      if (m === 'POST' && u === '/api/issues/iss1/comments/consume') {
        return opts.degrade
          ? { status: 404, body: { error: { code: 'NOT_FOUND', message: '接口不存在' } } }
          : { status: 200, body: { comments: COMMENTS, new_comment_ids: ['c2'] } };
      }
      if (m === 'GET' && u === '/api/issues/iss1/comments') return { status: 200, body: COMMENTS };
      return undefined;
    };
  }

  it('POST consume 标注新评论：GET issue + POST consume；文本模式新评论行 [新] 前缀', async () => {
    mockShow();
    const t = makeIo();
    const code = await main(['node', 'kb', '--server', base, 'show', 'iss1'], t.io);
    expect(code).toBe(0);
    expect(calls).toEqual([
      { method: 'GET', url: '/api/issues/iss1', body: undefined },
      { method: 'POST', url: '/api/issues/iss1/comments/consume', body: undefined },
    ]);
    const out = t.out();
    expect(out).toContain('标题: 实现登录');
    expect(out).toContain('优先级: 高');
    expect(out).toContain('标签: p1');
    expect(out).toContain('占用者: （未占用）');
    expect(out).toContain('评论（2）:');
    expect(out).toContain('- [user] 开工前注意兼容旧数据');
    expect(out).toContain('[新] - [agent:codebuddy] 已完成解析层');
    expect(out).not.toContain('[新] - [user]');
  });

  it('show 展示附件名、MIME、大小与服务器URL元数据', async () => {
    const withImage = {
      ...COMMENTS[0]!,
      attachments: [{ id: 'a1', file_name: 'screen.png', mime_type: 'image/png', size_bytes: 123, url: '/api/issues/iss1/attachments/a1' }],
    };
    handler = (m, u) => {
      if (m === 'GET' && u === '/api/issues/iss1') return { status: 200, body: ISSUE };
      if (m === 'POST' && u === '/api/issues/iss1/comments/consume') return { status: 200, body: { comments: [withImage], new_comment_ids: [] } };
      return undefined;
    };
    const t = makeIo();
    const code = await main(['node', 'kb', '--server', base, 'show', 'iss1'], t.io);
    expect(code).toBe(0);
    expect(t.out()).toContain('图片（交付未验证）: screen.png (image/png, 123 bytes) /api/issues/iss1/attachments/a1');
  });

  it('--json：issue 响应 + comments 内嵌，每条评论带 is_new 布尔', async () => {
    mockShow();
    const t = makeIo();
    const code = await main(['node', 'kb', '--server', base, '--json', 'show', 'iss1'], t.io);
    expect(code).toBe(0);
    const parsed = JSON.parse(t.out()) as {
      id: string;
      comments: Array<{ id: string; is_new?: boolean }>;
    };
    expect(parsed.id).toBe('iss1');
    expect(parsed.comments).toEqual([
      { ...COMMENTS[0], is_new: false },
      { ...COMMENTS[1], is_new: true },
    ]);
  });

  it('consume 端点不可用（旧服务端 404）→ 降级 GET comments，不标注 is_new', async () => {
    mockShow({ degrade: true });
    const t = makeIo();
    const code = await main(['node', 'kb', '--server', base, '--json', 'show', 'iss1'], t.io);
    expect(code).toBe(0);
    expect(calls.map((c) => `${c.method} ${c.url}`)).toEqual([
      'GET /api/issues/iss1',
      'POST /api/issues/iss1/comments/consume',
      'GET /api/issues/iss1/comments',
    ]);
    const parsed = JSON.parse(t.out()) as { comments: Array<{ is_new?: boolean }> };
    expect(parsed.comments).toEqual(COMMENTS);
  });

  it('未知 id → 404 → 退出码 1 + 服务端 message', async () => {
    const t = makeIo();
    const code = await main(['node', 'kb', '--server', base, 'show', 'nope'], t.io);
    expect(code).toBe(1);
    expect(t.err()).toContain('mock 未匹配');
  });
});

describe('claim', () => {
  const claimed = { ...ISSUE, status: '进行中', claimed_by: 'kb-cli', claimed_at: 9 };

  it('POST claim 体 {agent_id}（默认 kb-cli）+ 领取结果/任务详情/工作空间路径', async () => {
    handler = (m, u) => {
      if (m === 'POST' && u === '/api/issues/iss1/claim') return { status: 200, body: claimed };
      if (m === 'GET' && u === '/api/issues/iss1/comments') return { status: 200, body: COMMENTS };
      if (m === 'GET' && u === '/api/workspaces') return { status: 200, body: [WS] };
      return undefined;
    };
    const t = makeIo();
    const code = await main(['node', 'kb', '--server', base, 'claim', 'iss1'], t.io);
    expect(code).toBe(0);
    expect(calls[0]).toEqual({ method: 'POST', url: '/api/issues/iss1/claim', body: { agent_id: 'kb-cli' } });
    const out = t.out();
    expect(out).toContain('领取成功（agent: kb-cli）');
    expect(out).toContain('状态: 进行中');
    expect(out).toContain('工作空间路径: D:/ws/frontend');
    expect(out).toContain('- [user] 开工前注意兼容旧数据');
  });

  it('KB_AGENT 环境变量覆盖 agent_id', async () => {
    handler = (m, u) =>
      m === 'POST' && u === '/api/issues/iss1/claim' ? { status: 200, body: claimed } : undefined;
    const t = makeIo();
    process.env.KB_AGENT = 'coder-bot';
    try {
      const code = await main(['node', 'kb', '--server', base, '--json', 'claim', 'iss1'], t.io);
      expect(code).toBe(0);
      expect(calls[0]?.body).toEqual({ agent_id: 'coder-bot' });
      expect(JSON.parse(t.out())).toEqual(claimed);
    } finally {
      delete process.env.KB_AGENT;
    }
  });

  it('409 → 退出码 2 + stderr 已被占用', async () => {
    handler = (m, u) =>
      m === 'POST' && u === '/api/issues/iss1/claim'
        ? { status: 409, body: { error: { code: 'CONFLICT', message: '已被占用' } } }
        : undefined;
    const t = makeIo();
    const code = await main(['node', 'kb', '--server', base, 'claim', 'iss1'], t.io);
    expect(code).toBe(2);
    expect(t.err()).toContain('已被占用');
  });
});

describe('comment', () => {
  it('未设 KB_AGENT → POST 体 {content, agent_id: "kb-cli"}；woke=true 打印唤醒', async () => {
    handler = (m, u, body) => {
      if (m === 'POST' && u === '/api/issues/iss1/comments')
        return {
          status: 200,
          body: { comment: { id: 'c9', issue_id: 'iss1', author: 'user', content: (body as { content: string }).content, ts: 7 }, woke: true },
        };
      return undefined;
    };
    const t = makeIo();
    const code = await main(['node', 'kb', '--server', base, 'comment', 'iss1', '你好 世界'], t.io);
    expect(code).toBe(0);
    expect(calls[0]).toEqual({ method: 'POST', url: '/api/issues/iss1/comments', body: { content: '你好 世界', agent_id: 'kb-cli' } });
    expect(t.out()).toContain('评论已写入: c9');
    expect(t.out()).toContain('已唤醒占用 agent');
  });

  it('KB_AGENT 置位 → POST 体带 agent_id（服务端作者记为 agent:<KB_AGENT>）', async () => {
    handler = (m, u) =>
      m === 'POST' && u === '/api/issues/iss1/comments'
        ? { status: 200, body: { comment: { ...COMMENTS[0]!, author: 'agent:coder-bot' }, woke: false } }
        : undefined;
    const t = makeIo();
    process.env.KB_AGENT = 'coder-bot';
    try {
      const code = await main(['node', 'kb', '--server', base, 'comment', 'iss1', '进展'], t.io);
      expect(code).toBe(0);
      expect(calls[0]?.body).toEqual({ content: '进展', agent_id: 'coder-bot' });
      expect(t.out()).toContain('未唤醒（任务未被占用，仅留言）');
    } finally {
      delete process.env.KB_AGENT;
    }
  });

  it('woke=false 打印未唤醒（仅留言）', async () => {
    handler = (m, u) =>
      m === 'POST' && u === '/api/issues/iss1/comments'
        ? { status: 200, body: { comment: { ...COMMENTS[0]!, id: 'c8' }, woke: false } }
        : undefined;
    const t = makeIo();
    const code = await main(['node', 'kb', '--server', base, 'comment', 'iss1', '进展'], t.io);
    expect(code).toBe(0);
    expect(t.out()).toContain('未唤醒（任务未被占用，仅留言）');
  });

  it('图片评论先上传原始字节，再以幂等键绑定附件并保留未验证提示', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'agentboard-cli-image-'));
    const imagePath = join(dir, 'screen.png');
    writeFileSync(imagePath, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
    handler = (m, u) => {
      if (m === 'GET' && u === '/api/issues/iss1') return { status: 200, body: { workspace_id: 'ws1' } };
      if (m === 'POST' && u === '/api/workspaces/ws1/attachments') return { status: 201, body: { id: 'attachment-1' } };
      if (m === 'POST' && u === '/api/issues/iss1/comments') return {
        status: 200,
        body: { comment: { ...COMMENTS[0]!, id: 'c-image' }, woke: false, warning: 'IMAGE_DELIVERY_UNVERIFIED' },
      };
      return undefined;
    };
    const t = makeIo();
    try {
      const code = await main([
        'node', 'kb', '--server', base, 'comment', 'iss1', '--image', imagePath, '--request-id', '44444444-4444-4444-8444-444444444444',
      ], t.io);
      expect(code).toBe(0);
      expect(calls.map(({ method, url }) => [method, url])).toEqual([
        ['GET', '/api/issues/iss1'],
        ['POST', '/api/workspaces/ws1/attachments'],
        ['POST', '/api/issues/iss1/comments'],
      ]);
      expect(calls[1]?.headers).toMatchObject({ contentType: 'image/png', fileName: 'screen.png' });
      expect(calls[2]?.body).toEqual({ content: '', agent_id: 'kb-cli', attachment_ids: ['attachment-1'], workspace_id: 'ws1' });
      expect(calls[2]?.headers?.requestId).toBe('44444444-4444-4444-8444-444444444444');
      expect(t.out()).toContain('图片交付能力未验证');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('--stdin 中文/多行不损坏（体 content 精确往返）', async () => {
    const stdinText = '第一行：开工\n第二行：中文与空格保持 🙂\n第三行\n';
    handler = (m, u) =>
      m === 'POST' && u === '/api/issues/iss1/comments'
        ? { status: 200, body: { comment: { id: 'c10', issue_id: 'iss1', author: 'user', content: 'echo', ts: 7 }, woke: true } }
        : undefined;
    const t = makeIo(stdinText);
    const code = await main(['node', 'kb', '--server', base, 'comment', 'iss1', '--stdin'], t.io);
    expect(code).toBe(0);
    expect(calls[0]).toEqual({ method: 'POST', url: '/api/issues/iss1/comments', body: { content: stdinText, agent_id: 'kb-cli' } });
  });

  it('text 与 --stdin 同时给 → 退出码 1；两者都缺 → 退出码 1', async () => {
    const both = makeIo('stdin 内容');
    const code1 = await main(['node', 'kb', '--server', base, 'comment', 'iss1', '文字', '--stdin'], both.io);
    expect(code1).toBe(1);
    expect(calls).toHaveLength(0);
    expect(both.err()).toContain('二选一');

    const none = makeIo();
    const code2 = await main(['node', 'kb', '--server', base, 'comment', 'iss1'], none.io);
    expect(code2).toBe(1);
    expect(none.err()).toContain('缺少评论内容');
  });
});

describe('done / fail', () => {
  it('done：POST 体 {agent_id, notes}，输出待验收', async () => {
    handler = (m, u) =>
      m === 'POST' && u === '/api/issues/iss1/done'
        ? { status: 200, body: { ...ISSUE, status: '待验收', claimed_by: null } }
        : undefined;
    const t = makeIo();
    const code = await main(['node', 'kb', '--server', base, 'done', 'iss1', '--notes', '已完成并自测'], t.io);
    expect(code).toBe(0);
    expect(calls[0]).toEqual({
      method: 'POST',
      url: '/api/issues/iss1/done',
      body: { agent_id: 'kb-cli', notes: '已完成并自测' },
    });
    expect(t.out()).toContain('状态: 待验收');
  });

  it('done 无 --notes：体只含 agent_id', async () => {
    handler = (m, u) =>
      m === 'POST' && u === '/api/issues/iss1/done'
        ? { status: 200, body: { ...ISSUE, status: '待验收' } }
        : undefined;
    const t = makeIo();
    const code = await main(['node', 'kb', '--server', base, 'done', 'iss1'], t.io);
    expect(code).toBe(0);
    expect(calls[0]?.body).toEqual({ agent_id: 'kb-cli' });
    // 服务端没给 hint 时不打印提示行
    expect(t.out()).not.toContain('提示:');
  });

  it('done --scope：多次与逗号分隔都并入 scope_paths（提交范围声明）', async () => {
    handler = (m, u) =>
      m === 'POST' && u === '/api/issues/iss1/done'
        ? { status: 200, body: { ...ISSUE, status: '待验收' } }
        : undefined;
    const t = makeIo();
    const code = await main(
      ['node', 'kb', '--server', base, 'done', 'iss1', '--scope', 'apps/server/src', '--scope', 'packages/cli/a.ts,packages/cli/b.ts'],
      t.io,
    );
    expect(code).toBe(0);
    expect(calls[0]?.body).toEqual({ agent_id: 'kb-cli', scope_paths: ['apps/server/src', 'packages/cli/a.ts', 'packages/cli/b.ts'] });
  });

  it('done --scope 值含空格：stderr 警告提示改重复传参（PowerShell 逗号串陷阱）', async () => {
    handler = (m, u) => (m === 'POST' && u === '/api/issues/iss1/done' ? { status: 200, body: { ...ISSUE, status: '待验收' } } : undefined);
    const t = makeIo();
    const code = await main(['node', 'kb', '--server', base, 'done', 'iss1', '--scope', 'a.txt b.txt'], t.io);
    expect(code).toBe(0);
    expect(t.err()).toContain('--scope 值含空格');
    expect(t.err()).toContain('重复传参');
    expect(calls[0]?.body).toEqual({ agent_id: 'kb-cli', scope_paths: ['a.txt b.txt'] });
  });

  it('done 带 knowledge_hint：输出「提示:」建议行，退出码仍 0 且不出现错误字样', async () => {
    handler = (m, u) =>
      m === 'POST' && u === '/api/issues/iss1/done'
        ? {
          status: 200,
          body: {
            ...ISSUE, status: '待验收',
            knowledge_hint: { suggested_slug: 'handoff-iss1', scope: 'workspace', message: '本任务还没有写知识页。建议：kb knowledge create …' },
          },
        }
        : undefined;
    const t = makeIo();
    const code = await main(['node', 'kb', '--server', base, 'done', 'iss1'], t.io);
    expect(code).toBe(0);
    expect(t.out()).toContain('状态: 待验收');
    expect(t.out()).toContain('提示: 本任务还没有写知识页');
    expect(t.out()).not.toMatch(/ERROR|错误/);
  });

  it('fail：POST 体 {agent_id, reason}，输出待规划；缺 --reason → 退出码 1', async () => {
    handler = (m, u) =>
      m === 'POST' && u === '/api/issues/iss1/fail'
        ? { status: 200, body: { ...ISSUE, status: '待规划' } }
        : undefined;
    const t = makeIo();
    const code = await main(['node', 'kb', '--server', base, 'fail', 'iss1', '--reason', '依赖缺失'], t.io);
    expect(code).toBe(0);
    expect(calls[0]).toEqual({
      method: 'POST',
      url: '/api/issues/iss1/fail',
      body: { agent_id: 'kb-cli', reason: '依赖缺失' },
    });
    expect(t.out()).toContain('状态: 待规划');

    const missing = makeIo();
    const code2 = await main(['node', 'kb', '--server', base, 'fail', 'iss1'], missing.io);
    expect(code2).toBe(1);
    expect(calls).toHaveLength(1);
  });
});

describe('create-space / create-issue', () => {
  it('create-space：POST 体 {name, path}，输出 id/name/path', async () => {
    handler = (m, u, body) =>
      m === 'POST' && u === '/api/workspaces'
        ? {
            status: 200,
            body: {
              id: 'ws2',
              name: (body as { name: string }).name,
              path: (body as { path: string }).path,
              created_at: 9,
            },
          }
        : undefined;
    const t = makeIo();
    const code = await main(['node', 'kb', '--server', base, 'create-space', '新空间', 'D:/ws/new'], t.io);
    expect(code).toBe(0);
    expect(calls[0]).toEqual({ method: 'POST', url: '/api/workspaces', body: { name: '新空间', path: 'D:/ws/new' } });
    expect(t.out()).toContain('已创建工作空间: ws2 新空间（D:/ws/new）');
  });

  it('create-space --json 输出原始 Workspace', async () => {
    const created = { id: 'ws2', name: '新空间', path: 'D:/ws/new', created_at: 9 };
    handler = (m, u) => (m === 'POST' && u === '/api/workspaces' ? { status: 200, body: created } : undefined);
    const t = makeIo();
    const code = await main(['node', 'kb', '--server', base, '--json', 'create-space', '新空间', 'D:/ws/new'], t.io);
    expect(code).toBe(0);
    expect(JSON.parse(t.out())).toEqual(created);
  });

  it('create-issue 按名称解析（GET workspaces 命中）→ POST 体 workspace_id 为 id + 状态行', async () => {
    handler = (m, u, body) => {
      if (m === 'GET' && u === '/api/workspaces') return { status: 200, body: [WS] };
      if (m === 'POST' && u === '/api/issues')
        return { status: 200, body: { ...ISSUE, title: (body as { title: string }).title } };
      return undefined;
    };
    const t = makeIo();
    const code = await main(['node', 'kb', '--server', base, 'create-issue', '前端', '实现导出'], t.io);
    expect(code).toBe(0);
    expect(calls[0]).toEqual({ method: 'GET', url: '/api/workspaces', body: undefined });
    expect(calls[1]).toEqual({ method: 'POST', url: '/api/issues', body: { workspace_id: 'ws1', title: '实现导出' } });
    expect(t.out()).toContain('已创建任务: iss1 实现导出');
    expect(t.out()).toContain('状态: 待规划');
  });

  it('create-issue 传 id 同样可用；--json 输出原始 Issue', async () => {
    handler = (m, u) => {
      if (m === 'GET' && u === '/api/workspaces') return { status: 200, body: [WS] };
      if (m === 'POST' && u === '/api/issues') return { status: 200, body: ISSUE };
      return undefined;
    };
    const t = makeIo();
    const code = await main(['node', 'kb', '--server', base, '--json', 'create-issue', 'ws1', '实现导出'], t.io);
    expect(code).toBe(0);
    expect(calls[1]?.body).toEqual({ workspace_id: 'ws1', title: '实现导出' });
    expect(JSON.parse(t.out())).toEqual(ISSUE);
  });

  it('create-issue 未命中 → 退出码 1 + stderr 工作空间不存在，不发 POST', async () => {
    handler = (m, u) => (m === 'GET' && u === '/api/workspaces' ? { status: 200, body: [WS] } : undefined);
    const t = makeIo();
    const code = await main(['node', 'kb', '--server', base, 'create-issue', '不存在', '实现导出'], t.io);
    expect(code).toBe(1);
    expect(t.err()).toContain('工作空间不存在: 不存在');
    expect(calls.map((c) => c.method)).toEqual(['GET']);
  });

  it('create-issue 选项透传：description / priority / labels 逗号拆分（去空格）', async () => {
    handler = (m, u) => {
      if (m === 'GET' && u === '/api/workspaces') return { status: 200, body: [WS] };
      if (m === 'POST' && u === '/api/issues') return { status: 200, body: ISSUE };
      return undefined;
    };
    const t = makeIo();
    const code = await main(
      ['node', 'kb', '--server', base, 'create-issue', '前端', '实现导出', '-d', '含 空格描述', '-p', '高', '-l', 'a, b,c'],
      t.io,
    );
    expect(code).toBe(0);
    expect(calls[1]?.body).toEqual({
      workspace_id: 'ws1',
      title: '实现导出',
      description: '含 空格描述',
      priority: '高',
      labels: ['a', 'b', 'c'],
    });
  });
});

describe('服务不可达', () => {
  it('ECONNREFUSED → 退出码 1 + stderr 看板服务未启动', async () => {
    // 先占用再关闭，拿到一个确定无监听的端口
    const probe = createServer();
    await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', resolve));
    const port = (probe.address() as AddressInfo).port;
    await new Promise<void>((resolve) => probe.close(() => resolve()));

    const t = makeIo();
    const code = await main(
      ['node', 'kb', '--server', `http://127.0.0.1:${port}`, 'list-spaces'],
      t.io,
    );
    expect(code).toBe(1);
    expect(t.err()).toContain('看板服务未启动');
    expect(t.err()).toContain(`http://127.0.0.1:${port}`);
    expect(t.err()).toContain('--server');
    expect(t.err()).toContain('启动：');
    expect(t.err()).toContain('pnpm --filter @agentboard/server start');
  });

  it('非连接拒绝的网络层失败（非法端口）→ 退出码 1 + 看板服务不可达（含地址与原始 message）', async () => {
    const t = makeIo();
    const code = await main(
      ['node', 'kb', '--server', 'http://127.0.0.1:99999', 'list-spaces'],
      t.io,
    );
    expect(code).toBe(1);
    expect(t.err()).toContain('看板服务不可达');
    expect(t.err()).toContain('http://127.0.0.1:99999');
    expect(t.err()).toContain('--server 指定');
    expect(t.err()).toContain('Failed to parse URL');
  });

  it('其他非 2xx（500）→ 退出码 1 + code/message', async () => {
    handler = (m, u) =>
      m === 'GET' && u === '/api/workspaces'
        ? { status: 500, body: { error: { code: 'INTERNAL', message: '内部错误' } } }
        : undefined;
    const t = makeIo();
    const code = await main(['node', 'kb', '--server', base, 'list-spaces'], t.io);
    expect(code).toBe(1);
    expect(t.err()).toContain('内部错误');
  });

  it('401 + 非默认 base → 退出码 1 + stderr 附 DSH web server 提示', async () => {
    handler = (m, u) =>
      m === 'GET' && u === '/api/workspaces'
        ? { status: 401, body: { error: { code: 'UNAUTHORIZED', message: 'unauthorized' } } }
        : undefined;
    const t = makeIo();
    const code = await main(['node', 'kb', '--server', base, 'list-spaces'], t.io);
    expect(code).toBe(1);
    expect(t.err()).toContain('unauthorized');
    expect(t.err()).toContain('DSH web server');
    expect(t.err()).toContain('DSH_TASK_BOARD_PROXY_TOKEN');
    expect(t.err()).toContain('http://127.0.0.1:8787');
  });

  it('401 + 默认 base → 退出码 1 + stderr 不含 DSH 提示（真鉴权问题）', async () => {
    delete process.env.KB_SERVER;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ error: { code: 'UNAUTHORIZED', message: 'unauthorized' } }), {
        status: 401,
        headers: { 'content-type': 'application/json' },
      })) as typeof fetch;
    try {
      const t = makeIo();
      const code = await main(['node', 'kb', 'list-spaces'], t.io);
      expect(code).toBe(1);
      expect(t.err()).toContain('unauthorized');
      expect(t.err()).not.toContain('DSH');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

// ---- kb autostart / kb shortcut（Windows 自启与桌面快捷方式） ----

import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  applyVbsConstants,
  buildRegAddArgs,
  buildRegDeleteArgs,
  buildRunValue,
  installAutostart,
  isVbsConfigured,
  ownsAutostartValue,
  parsePort,
  parseRegQueryValue,
  readVbsText,
  resolveAutostartPaths,
  statusAutostart,
  uninstallAutostart,
  writeVbsText,
  type AutostartPaths,
  type Runner,
} from '../src/commands/autostart.js';
import {
  buildShortcutScript,
  createShortcut,
  DESKTOP_PS,
  psQuote,
  removeShortcut,
  SHORTCUT_NAME,
} from '../src/commands/shortcut.js';

/**
 * vbs 模板：readVbsText 兼容模板（utf8）与 install 写回的已配置状态（UTF-16LE+BOM）；
 * 四常量归一化回占位符，使本文件在工作区已装/未装两种状态下都能取到占位符模板。
 */
const TEMPLATE_VBS = readVbsText(fileURLToPath(new URL('../../../scripts/agentboard.vbs', import.meta.url))).replace(
  /^Const (NODE_PATH|REPO_ROOT|LOG_DIR|PORT) = ".*"$/gm,
  'Const $1 = "%$1%"',
);

/** 临时仓库脚手架：vbs 模板 + 服务端产物 + 图标 + 独立 APPDATA（config.json） */
function scaffold(overrides: { port?: number } = {}): { paths: AutostartPaths; cleanup: () => void; repoRoot: string } {
  const root = mkdtempSync(join(tmpdir(), 'kb-autostart-'));
  const repoRoot = join(root, 'repo');
  const appData = join(root, 'appdata');
  mkdirSync(join(repoRoot, 'scripts'), { recursive: true });
  mkdirSync(join(repoRoot, 'apps', 'server', 'dist'), { recursive: true });
  mkdirSync(join(repoRoot, 'apps', 'web', 'public'), { recursive: true });
  mkdirSync(join(appData, 'AgentBoard'), { recursive: true });
  writeFileSync(join(repoRoot, 'scripts', 'agentboard.vbs'), TEMPLATE_VBS, 'utf8');
  writeFileSync(join(repoRoot, 'apps', 'server', 'dist', 'index.js'), '// built\n', 'utf8');
  writeFileSync(join(repoRoot, 'apps', 'web', 'public', 'agentboard.ico'), '// icon\n', 'utf8');
  writeFileSync(join(appData, 'AgentBoard', 'config.json'), JSON.stringify({ port: overrides.port ?? 8787 }), 'utf8');
  return {
    paths: resolveAutostartPaths(repoRoot, appData),
    repoRoot,
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

interface RecordedCall { cmd: string; args: string[] }

/** 假 Runner：reg query 按预设应答，reg add/delete/其余按序回 canned；记录全部调用 */
function fakeRunner(opts: { regQueryReply?: { code: number; stdout: string; stderr?: string } } = {}): {
  runner: Runner;
  calls: RecordedCall[];
} {
  const calls: RecordedCall[] = [];
  const runner: Runner = async (cmd, args) => {
    calls.push({ cmd, args });
    if (cmd === 'reg.exe' && args[0] === 'query') {
      return opts.regQueryReply ? { stderr: '', ...opts.regQueryReply } : { code: 1, stdout: '', stderr: '找不到' };
    }
    return { code: 0, stdout: '', stderr: '' };
  };
  return { runner, calls };
}

/** powershell 假 Runner：桌面查询回 desktop 目录，创建脚本回 lnk 路径 */
function psRunner(desktop: string): { runner: Runner; calls: RecordedCall[] } {
  const calls: RecordedCall[] = [];
  const runner: Runner = async (cmd, args) => {
    calls.push({ cmd, args });
    const script = args[args.length - 1] ?? '';
    if (script === DESKTOP_PS) return { code: 0, stdout: `${desktop}\r\n`, stderr: '' };
    if (script.includes('WScript.Shell')) return { code: 0, stdout: join(desktop, SHORTCUT_NAME), stderr: '' };
    return { code: 0, stdout: '', stderr: '' };
  };
  return { runner, calls };
}

describe('autostart 纯逻辑', () => {
  it('模板 vbs：四个占位符常量、未配置状态、ASCII 内容', () => {
    expect(TEMPLATE_VBS).toContain('Const NODE_PATH = "%NODE_PATH%"');
    expect(TEMPLATE_VBS).toContain('Const REPO_ROOT = "%REPO_ROOT%"');
    expect(TEMPLATE_VBS).toContain('Const LOG_DIR = "%LOG_DIR%"');
    expect(TEMPLATE_VBS).toContain('Const PORT = "%PORT%"');
    expect(isVbsConfigured(TEMPLATE_VBS)).toBe(false);
    expect(/^[\x00-\x7F]*$/.test(TEMPLATE_VBS)).toBe(true);
  });

  it('applyVbsConstants：占位符替换为已配置；重复应用（改端口 reinstall）可更新常量', () => {
    const first = applyVbsConstants(TEMPLATE_VBS, { nodePath: 'C:\\n\\node.exe', repoRoot: 'D:\\r', logDir: 'C:\\l', port: 8787 });
    expect(first).toContain('Const NODE_PATH = "C:\\n\\node.exe"');
    expect(first).toContain('Const REPO_ROOT = "D:\\r"');
    expect(first).toContain('Const LOG_DIR = "C:\\l"');
    expect(first).toContain('Const PORT = "8787"');
    expect(isVbsConfigured(first)).toBe(true);
    // 未配置守卫的哨兵串保留（检测逻辑依赖的字面量）
    expect(first).toContain('Not (NODE_PATH = "%NODE_PATH%"');
    const second = applyVbsConstants(first, { nodePath: 'C:\\n\\node.exe', repoRoot: 'D:\\r', logDir: 'C:\\l', port: 9000 });
    expect(second).toContain('Const PORT = "9000"');
    expect(isVbsConfigured(second)).toBe(true);
  });

  it('buildRunValue / reg 参数构造', () => {
    expect(buildRunValue('D:\\r\\scripts\\agentboard.vbs')).toBe('wscript.exe "D:\\r\\scripts\\agentboard.vbs" autostart');
    expect(buildRegAddArgs('V')).toEqual(['add', 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run', '/v', 'AgentBoard', '/t', 'REG_SZ', '/d', 'V', '/f']);
    expect(buildRegDeleteArgs()).toEqual(['delete', 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run', '/v', 'AgentBoard', '/f']);
  });

  it('parseRegQueryValue：REG_SZ 行取值（含中文路径）、找不到/空输出 → null', () => {
    const out = [
      '',
      'HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Run',
      '    AgentBoard    REG_SZ    wscript.exe "D:\\WorkSpaces\\任务看板\\scripts\\agentboard.vbs" autostart',
      '',
    ].join('\r\n');
    expect(parseRegQueryValue(out)).toBe('wscript.exe "D:\\WorkSpaces\\任务看板\\scripts\\agentboard.vbs" autostart');
    expect(parseRegQueryValue('ERROR: 系统找不到指定的注册表项或值。')).toBeNull();
    expect(parseRegQueryValue('')).toBeNull();
    // reg query /v 只输出目标值，取首个 REG_SZ 行即可
    const two = ['    AgentBoard    REG_SZ    wscript.exe "a\\agentboard.vbs" autostart', '    Other    REG_SZ    x'].join('\r\n');
    expect(parseRegQueryValue(two)).toBe('wscript.exe "a\\agentboard.vbs" autostart');
  });

  it('ownsAutostartValue：含 agentboard.vbs（大小写不敏感）才算自家', () => {
    expect(ownsAutostartValue('wscript.exe "D:\\x\\agentboard.vbs" autostart')).toBe(true);
    expect(ownsAutostartValue('wscript.exe "D:\\X\\AGENTBOARD.VBS" autostart')).toBe(true);
    expect(ownsAutostartValue('C:\\tools\\something.exe /run')).toBe(false);
    expect(ownsAutostartValue('')).toBe(false);
  });

  it('parsePort：合法端口、缺失/损坏/非法回缺省 8787', () => {
    expect(parsePort('{"port":9000}')).toBe(9000);
    expect(parsePort('{"dbPath":"x"}')).toBe(8787);
    expect(parsePort('not json')).toBe(8787);
    expect(parsePort('{"port":"8787"}')).toBe(8787);
    expect(parsePort('{"port":0}')).toBe(8787);
    expect(parsePort('{"port":70000}')).toBe(8787);
    expect(parsePort('{"port":8787}', 9000)).toBe(8787);
  });

  it('模板 vbs：autostart.log 引导日志（未配置回退 %APPDATA%、占位符退出、步骤错误、拉起记录）', () => {
    // 占位符未替换时日志路径仍可用（APPDATA 推导），写入 autostart.log 后退出
    expect(TEMPLATE_VBS).toContain('shell.ExpandEnvironmentStrings("%APPDATA%") & "\\AgentBoard\\logs"');
    expect(TEMPLATE_VBS).toContain('"\\autostart.log"');
    expect(TEMPLATE_VBS).toContain('Sub FailUnconfigured');
    expect(TEMPLATE_VBS).toContain('FATAL not configured (placeholders), run: kb autostart install');
    // 任何启动步骤失败记录 时间戳+mode+Err.Number+Err.Description
    expect(TEMPLATE_VBS).toContain('Sub LogErrStep');
    expect(TEMPLATE_VBS).toContain('" ERROR step=[" & stepName & "] Err=" & Err.Number & " Desc=" & Err.Description');
    // 成功拉起写 launched pid/time 行
    expect(TEMPLATE_VBS).toContain('" launched pid=" & FindServerPid() & " time=" & NowStamp()');
  });

  it('readVbsText/writeVbsText：UTF-16LE BOM 写读回环（中文路径）；无 BOM 回 utf8', () => {
    const dir = mkdtempSync(join(tmpdir(), 'kb-vbs-'));
    const p = join(dir, 'agentboard.vbs');
    try {
      writeVbsText(p, 'Const REPO_ROOT = "D:\\WorkSpaces\\任务看板"\r\n');
      const raw = readFileSync(p);
      expect(raw[0]).toBe(0xff);
      expect(raw[1]).toBe(0xfe);
      expect(readVbsText(p)).toBe('Const REPO_ROOT = "D:\\WorkSpaces\\任务看板"\r\n');
      writeFileSync(p, 'plain utf8 中文模板', 'utf8');
      expect(readVbsText(p)).toBe('plain utf8 中文模板');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('autostart install / uninstall（假 Runner + 临时仓库）', () => {
  it('install：写 vbs 常量（含 config 端口）+ reg add 一次；输出含日志与端口提示', async () => {
    const env = scaffold({ port: 9123 });
    const { runner, calls } = fakeRunner();
    const t = makeIo();
    try {
      await installAutostart(t.io, { runner, paths: env.paths, nodePath: 'C:\\n\\node.exe' });
      const add = calls.filter((c) => c.cmd === 'reg.exe' && c.args[0] === 'add');
      expect(add).toHaveLength(1);
      const dIdx = add[0]!.args.indexOf('/d');
      expect(add[0]!.args[dIdx + 1]).toBe(`wscript.exe "${join(env.repoRoot, 'scripts', 'agentboard.vbs')}" autostart`);
      const vbs = readVbsText(env.paths.vbsPath);
      expect(vbs).toContain('Const NODE_PATH = "C:\\n\\node.exe"');
      expect(vbs).toContain(`Const REPO_ROOT = "${env.repoRoot}"`);
      expect(vbs).toContain('Const PORT = "9123"');
      expect(isVbsConfigured(vbs)).toBe(true);
      // install 写回固定 UTF-16LE + BOM（wscript 无 BOM 按 ANSI 码页解码，中文路径会乱码）
      const raw = readFileSync(env.paths.vbsPath);
      expect(raw[0]).toBe(0xff);
      expect(raw[1]).toBe(0xfe);
      expect(t.out()).toContain('已安装开机自启');
      expect(t.out()).toContain(env.paths.logFile);
      expect(t.out()).toContain('改端口');
    } finally {
      env.cleanup();
    }
  });

  it('install 幂等：Run 键同值 → 不再 reg add，但 vbs 常量仍刷新（改端口 reinstall 生效）', async () => {
    const env = scaffold({ port: 9000 });
    const desired = `wscript.exe "${join(env.repoRoot, 'scripts', 'agentboard.vbs')}" autostart`;
    const stdout = `HKEY_CURRENT_USER\\...\\Run\r\n    AgentBoard    REG_SZ    ${desired}\r\n`;
    const { runner, calls } = fakeRunner({ regQueryReply: { code: 0, stdout } });
    const t = makeIo();
    try {
      await installAutostart(t.io, { runner, paths: env.paths, nodePath: 'C:\\n\\node.exe' });
      expect(calls.filter((c) => c.cmd === 'reg.exe' && c.args[0] === 'add')).toHaveLength(0);
      expect(t.out()).toContain('已安装');
      expect(readVbsText(env.paths.vbsPath)).toContain('Const PORT = "9000"');
    } finally {
      env.cleanup();
    }
  });

  it('install 前置：服务未构建报错并提示 corepack pnpm -r build', async () => {
    const env = scaffold();
    const { runner } = fakeRunner();
    const t = makeIo();
    try {
      rmSync(env.paths.serverEntry, { force: true });
      await expect(installAutostart(t.io, { runner, paths: env.paths })).rejects.toThrow('corepack pnpm -r build');
    } finally {
      env.cleanup();
    }
  });

  it('uninstall：自家值 → reg delete；异值不动并报错；未装提示', async () => {
    const env = scaffold();
    const own = `wscript.exe "${join(env.repoRoot, 'scripts', 'agentboard.vbs')}" autostart`;
    const t1 = makeIo();
    const r1 = fakeRunner({ regQueryReply: { code: 0, stdout: `    AgentBoard    REG_SZ    ${own}\r\n` } });
    await uninstallAutostart(t1.io, { runner: r1.runner, paths: env.paths });
    expect(r1.calls.filter((c) => c.cmd === 'reg.exe' && c.args[0] === 'delete')).toHaveLength(1);
    expect(t1.out()).toContain('已移除');

    const t2 = makeIo();
    const r2 = fakeRunner({ regQueryReply: { code: 0, stdout: '    AgentBoard    REG_SZ    C:\\other\\tool.exe /run\r\n' } });
    await expect(uninstallAutostart(t2.io, { runner: r2.runner, paths: env.paths })).rejects.toThrow('未删除');
    expect(r2.calls.filter((c) => c.cmd === 'reg.exe' && c.args[0] === 'delete')).toHaveLength(0);

    const t3 = makeIo();
    const r3 = fakeRunner();
    await uninstallAutostart(t3.io, { runner: r3.runner, paths: env.paths });
    expect(t3.out()).toContain('未安装');
    env.cleanup();
  });
});

describe('autostart status（mock HTTP + 假 Runner）', () => {
  function ctx(io: ReturnType<typeof makeIo>['io'], json = false) {
    return { base: '', json, agentId: 't', io };
  }

  it('已装 + 服务可达：值、可达与版本、日志路径', async () => {
    const env = scaffold({ port: Number(base.split(':').pop()) });
    handler = (m, u) =>
      m === 'GET' && u === '/api/version'
        ? { status: 200, body: { name: 'agentboard-server', version: '0.1.0' }, headers: { [SERVER_VERSION_HEADER]: CLI_VERSION } }
        : undefined;
    const { runner } = fakeRunner({ regQueryReply: { code: 0, stdout: '    AgentBoard    REG_SZ    wscript.exe "D:\\x\\agentboard.vbs" autostart\r\n' } });
    const t = makeIo();
    try {
      await statusAutostart(ctx(t.io), { runner, paths: env.paths });
      expect(t.out()).toContain('自启: 已安装');
      expect(t.out()).toContain('agentboard.vbs');
      expect(t.out()).toContain('服务: 可达');
      expect(t.out()).toContain('0.1.0');
      expect(t.out()).toContain(env.paths.logFile);
    } finally {
      env.cleanup();
    }
  });

  it('未装 + 服务不可达（端口无监听）', async () => {
    const probe = createServer();
    await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', resolve));
    const deadPort = (probe.address() as AddressInfo).port;
    await new Promise<void>((resolve) => probe.close(() => resolve()));
    const env = scaffold({ port: deadPort });
    const { runner } = fakeRunner();
    const t = makeIo();
    try {
      await statusAutostart(ctx(t.io), { runner, paths: env.paths });
      expect(t.out()).toContain('自启: 未安装');
      expect(t.out()).toContain('服务: 不可达');
      expect(t.out()).toContain(`http://127.0.0.1:${deadPort}`);
    } finally {
      env.cleanup();
    }
  });

  it('--json：结构化输出 installed/value/reachable/log', async () => {
    const env = scaffold({ port: Number(base.split(':').pop()) });
    handler = (m, u) =>
      m === 'GET' && u === '/api/version'
        ? { status: 200, body: { name: 'agentboard-server', version: '0.1.0' }, headers: { [SERVER_VERSION_HEADER]: CLI_VERSION } }
        : undefined;
    const { runner } = fakeRunner({ regQueryReply: { code: 0, stdout: '    AgentBoard    REG_SZ    V1\r\n' } });
    const t = makeIo();
    try {
      await statusAutostart(ctx(t.io, true), { runner, paths: env.paths });
      const data = JSON.parse(t.out()) as { autostart: { installed: boolean; value: string }; service: { reachable: boolean; version: string }; log: string };
      expect(data.autostart.installed).toBe(true);
      expect(data.autostart.value).toBe('V1');
      expect(data.service.reachable).toBe(true);
      expect(data.service.version).toBe('0.1.0');
      expect(data.log).toBe(env.paths.logFile);
    } finally {
      env.cleanup();
    }
  });
});

describe('shortcut（纯构造 + 假 Runner）', () => {
  it('psQuote：单引号双写转义', () => {
    expect(psQuote('abc')).toBe("'abc'");
    expect(psQuote("a'b")).toBe("'a''b'");
    expect(psQuote('D:\\x\\y')).toBe("'D:\\x\\y'");
  });

  it('buildShortcutScript：含 wscript 目标、vbs open 参数、图标、工作目录、描述与 Save', () => {
    const script = buildShortcutScript('D:\\r\\scripts\\agentboard.vbs', 'D:\\r', 'D:\\r\\apps\\web\\public\\agentboard.ico');
    expect(script).toContain("$lnk.TargetPath='wscript.exe'");
    expect(script).toContain(`$lnk.Arguments='"D:\\r\\scripts\\agentboard.vbs" open'`);
    expect(script).toContain(`$lnk.WorkingDirectory='D:\\r'`);
    expect(script).toContain(`$lnk.IconLocation='D:\\r\\apps\\web\\public\\agentboard.ico'`);
    expect(script).toContain(`$lnk.Description='AgentBoard 任务看板'`);
    expect(script).toContain('$lnk.Save()');
    expect(script).toContain("[Environment]::GetFolderPath('Desktop')");
    expect(script.startsWith("$ErrorActionPreference='Stop'")).toBe(true);
  });

  it('create：ico 缺失报错；vbs 未配置报错；install 后经 powershell 创建', async () => {
    const env = scaffold();
    const t = makeIo();
    const ctxObj = { base: '', json: false, agentId: 't', io: t.io };
    const desktop = mkdtempSync(join(tmpdir(), 'kb-desktop-'));
    const ps = psRunner(desktop);
    try {
      rmSync(env.paths.iconPath, { force: true });
      await expect(createShortcut(ctxObj, { runner: ps.runner, paths: env.paths })).rejects.toThrow('图标缺失');
      writeFileSync(env.paths.iconPath, '// icon\n', 'utf8');
      await expect(createShortcut(ctxObj, { runner: ps.runner, paths: env.paths })).rejects.toThrow('kb autostart install');
      const reg = fakeRunner();
      await installAutostart(t.io, { runner: reg.runner, paths: env.paths, nodePath: 'C:\\n\\node.exe' });
      const t2 = makeIo();
      await createShortcut({ base: '', json: false, agentId: 't', io: t2.io }, { runner: ps.runner, paths: env.paths });
      expect(t2.out()).toContain('已创建桌面快捷方式');
      const createCall = ps.calls.find((c) => (c.args[c.args.length - 1] ?? '').includes('WScript.Shell'));
      expect(createCall).toBeDefined();
      expect(createCall!.cmd).toBe('powershell.exe');
      expect(createCall!.args).toContain('-NoProfile');
    } finally {
      env.cleanup();
      rmSync(desktop, { recursive: true, force: true });
    }
  });

  it('remove：存在则删（真文件）、不存在提示无需移除', async () => {
    const desktop = mkdtempSync(join(tmpdir(), 'kb-desktop-'));
    const ps = psRunner(desktop);
    try {
      const lnk = join(desktop, SHORTCUT_NAME);
      const t1 = makeIo();
      await removeShortcut({ base: '', json: false, agentId: 't', io: t1.io }, { runner: ps.runner });
      expect(t1.out()).toContain('无需移除');
      expect(existsSync(lnk)).toBe(false);
      writeFileSync(lnk, 'fake', 'utf8');
      const t2 = makeIo();
      await removeShortcut({ base: '', json: false, agentId: 't', io: t2.io }, { runner: ps.runner });
      expect(t2.out()).toContain('已移除');
      expect(existsSync(lnk)).toBe(false);
    } finally {
      rmSync(desktop, { recursive: true, force: true });
    }
  });
});

describe('delete-issue', () => {
  it('缺 --yes（stdin 非 TTY）：打印标题与状态、非 0 退出、不发 DELETE', async () => {
    handler = (m, u) => (m === 'GET' && u === '/api/issues/iss1' ? { status: 200, body: ISSUE } : undefined);
    const originalTty = process.stdin.isTTY;
    Object.defineProperty(process.stdin, 'isTTY', { value: false, configurable: true });
    try {
      const t = makeIo();
      const code = await main(['node', 'kb', '--server', base, 'delete-issue', 'iss1'], t.io);
      expect(code).not.toBe(0);
      expect(t.err()).toContain('实现登录');
      expect(t.err()).toContain('待规划');
      expect(t.err()).toContain('--yes');
      expect(calls.filter(call => call.method === 'DELETE')).toHaveLength(0);
    } finally {
      Object.defineProperty(process.stdin, 'isTTY', { value: originalTty, configurable: true });
    }
  });

  it('--yes：发 DELETE、输出已删除、退出码 0', async () => {
    handler = (m, u) => (m === 'DELETE' && u === '/api/issues/iss1' ? { status: 204, body: undefined } : undefined);
    const t = makeIo();
    const code = await main(['node', 'kb', '--server', base, 'delete-issue', 'iss1', '--yes'], t.io);
    expect(code).toBe(0);
    expect(calls[0]).toMatchObject({ method: 'DELETE', url: '/api/issues/iss1' });
    expect(t.out()).toContain('已删除任务: iss1');
  });

  it('--yes --json：输出 {deleted,id}', async () => {
    handler = (m, u) => (m === 'DELETE' && u === '/api/issues/iss1' ? { status: 204, body: undefined } : undefined);
    const t = makeIo();
    const code = await main(['node', 'kb', '--json', '--server', base, 'delete-issue', 'iss1', '--yes'], t.io);
    expect(code).toBe(0);
    expect(JSON.parse(t.out())).toEqual({ deleted: true, id: 'iss1' });
  });

  it('409 文案原样透传、退出码 2', async () => {
    handler = (m, u) => (m === 'DELETE' && u === '/api/issues/iss1'
      ? { status: 409, body: { error: { code: 'CONFLICT', message: '占用中禁止删除' } } }
      : undefined);
    const t = makeIo();
    const code = await main(['node', 'kb', '--server', base, 'delete-issue', 'iss1', '--yes'], t.io);
    expect(code).toBe(2);
    expect(t.err()).toBe('占用中禁止删除\n');
    expect(t.err()).not.toContain('已被占用');
  });
});

describe('幂等键透传（CLI-IDEM）', () => {
  const KEY = '7f1d2c3b-4a5e-4f60-8b71-9c2d3e4f5a60';

  it('done --request-id：透出 Idempotency-Key，并带 workspace_id（服务端幂等 owner 操作要求）', async () => {
    handler = (m, u) => {
      if (m === 'GET' && u === '/api/issues/iss1') return { status: 200, body: ISSUE };
      if (m === 'POST' && u === '/api/issues/iss1/done') return { status: 200, body: { ...ISSUE, status: '待验收', knowledge_hint: null } };
      return undefined;
    };
    const t = makeIo();
    const code = await main(['node', 'kb', '--server', base, 'done', 'iss1', '--request-id', KEY], t.io);
    expect(code).toBe(0);
    expect(keyLog).toEqual(['', KEY]);
    expect(calls[1]).toMatchObject({ method: 'POST', url: '/api/issues/iss1/done', body: { workspace_id: 'ws1', agent_id: 'kb-cli' } });
  });

  it('done 不带 --request-id：无 Key、无额外 GET、body 与既有行为一致', async () => {
    handler = (m, u) => (m === 'POST' && u === '/api/issues/iss1/done' ? { status: 200, body: { ...ISSUE, status: '待验收' } } : undefined);
    const t = makeIo();
    const code = await main(['node', 'kb', '--server', base, 'done', 'iss1'], t.io);
    expect(code).toBe(0);
    expect(keyLog).toEqual(['']);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual({ method: 'POST', url: '/api/issues/iss1/done', body: { agent_id: 'kb-cli' } });
  });

  it('claim / fail --request-id：同样带 Key 与 workspace_id', async () => {
    handler = (m, u) => {
      if (m === 'GET' && u === '/api/issues/iss1') return { status: 200, body: ISSUE };
      if (m === 'GET' && u === '/api/issues/iss1/comments') return { status: 200, body: [] };
      if (m === 'GET' && u === '/api/workspaces') return { status: 200, body: [WS] };
      if (m === 'POST' && u === '/api/issues/iss1/claim') return { status: 200, body: { ...ISSUE, status: '进行中', claimed_by: 'kb-cli' } };
      if (m === 'POST' && u === '/api/issues/iss1/fail') return { status: 200, body: { ...ISSUE, status: '待规划' } };
      return undefined;
    };
    const claimCode = await main(['node', 'kb', '--server', base, 'claim', 'iss1', '--request-id', KEY], makeIo().io);
    expect(claimCode).toBe(0);
    expect(keyLog[0]).toBe('');
    expect(keyLog[1]).toBe(KEY);
    expect(calls[1]).toMatchObject({ method: 'POST', url: '/api/issues/iss1/claim', body: { workspace_id: 'ws1', agent_id: 'kb-cli' } });

    calls = [];
    keyLog = [];
    const failCode = await main(['node', 'kb', '--server', base, 'fail', 'iss1', '--reason', '做不了', '--request-id', KEY], makeIo().io);
    expect(failCode).toBe(0);
    expect(keyLog).toEqual(['', KEY]);
    expect(calls[1]).toMatchObject({ method: 'POST', url: '/api/issues/iss1/fail', body: { workspace_id: 'ws1', agent_id: 'kb-cli', reason: '做不了' } });
  });

  it('--json 两次同 key 输出一致（服务端原样重放时）', async () => {
    const payload = { ...ISSUE, status: '待验收', knowledge_hint: null, comment: { id: 'c9', issue_id: 'iss1', author: 'agent:kb-cli', content: '完成', ts: 9 } };
    handler = (m, u) => {
      if (m === 'GET' && u === '/api/issues/iss1') return { status: 200, body: ISSUE };
      if (m === 'POST' && u === '/api/issues/iss1/done') return { status: 200, body: payload };
      return undefined;
    };
    const first = makeIo();
    const second = makeIo();
    await main(['node', 'kb', '--json', '--server', base, 'done', 'iss1', '--request-id', KEY], first.io);
    await main(['node', 'kb', '--json', '--server', base, 'done', 'iss1', '--request-id', KEY], second.io);
    expect(first.out()).toBe(second.out());
    expect(keyLog.filter(key => key === KEY)).toHaveLength(2);
  });

  it('409 IDEMPOTENCY_KEY_REUSED：原样透传、退出码 2', async () => {
    handler = (m, u) => {
      if (m === 'GET' && u === '/api/issues/iss1') return { status: 200, body: ISSUE };
      if (m === 'POST' && u === '/api/issues/iss1/done') return { status: 409, body: { error: { code: 'IDEMPOTENCY_KEY_REUSED', message: '该幂等键已用于不同请求' } } };
      return undefined;
    };
    const t = makeIo();
    const code = await main(['node', 'kb', '--server', base, 'done', 'iss1', '--request-id', KEY], t.io);
    expect(code).toBe(2);
    expect(t.err()).toBe('该幂等键已用于不同请求\n');
  });
});