import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_BASE, normalizeBase } from '../src/api.js';
import { main } from '../src/index.js';

interface Recorded {
  method: string;
  url: string;
  body: unknown;
}

type MockReply = { status: number; body?: unknown } | undefined;
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
let handler: Handler = () => undefined;

beforeEach(async () => {
  calls = [];
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
    { ...ISSUE },
    { ...ISSUE, id: 'iss2', title: '已占用任务', status: '进行中', claimed_by: 'agent:codebuddy' },
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
  it('完整字段 + 评论列表（含作者）', async () => {
    handler = (m, u) => {
      if (m === 'GET' && u === '/api/issues/iss1') return { status: 200, body: ISSUE };
      if (m === 'GET' && u === '/api/issues/iss1/comments') return { status: 200, body: COMMENTS };
      return undefined;
    };
    const t = makeIo();
    const code = await main(['node', 'kb', '--server', base, 'show', 'iss1'], t.io);
    expect(code).toBe(0);
    const out = t.out();
    expect(out).toContain('标题: 实现登录');
    expect(out).toContain('优先级: 高');
    expect(out).toContain('标签: p1');
    expect(out).toContain('占用者: （未占用）');
    expect(out).toContain('评论（2）:');
    expect(out).toContain('- [user] 开工前注意兼容旧数据');
    expect(out).toContain('- [agent:codebuddy] 已完成解析层');
  });

  it('--json：issue 响应 + comments 内嵌', async () => {
    handler = (m, u) => {
      if (m === 'GET' && u === '/api/issues/iss1') return { status: 200, body: ISSUE };
      if (m === 'GET' && u === '/api/issues/iss1/comments') return { status: 200, body: COMMENTS };
      return undefined;
    };
    const t = makeIo();
    const code = await main(['node', 'kb', '--server', base, '--json', 'show', 'iss1'], t.io);
    expect(code).toBe(0);
    const parsed = JSON.parse(t.out()) as { id: string; comments: Array<{ id: string }> };
    expect(parsed.id).toBe('iss1');
    expect(parsed.comments.map((c) => c.id)).toEqual(['c1', 'c2']);
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
  it('text 参数 → POST 体 {content}；woke=true 打印唤醒', async () => {
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
    expect(calls[0]).toEqual({ method: 'POST', url: '/api/issues/iss1/comments', body: { content: '你好 世界' } });
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

  it('--stdin 中文/多行不损坏（体 content 精确往返）', async () => {
    const stdinText = '第一行：开工\n第二行：中文与空格保持 🙂\n第三行\n';
    handler = (m, u) =>
      m === 'POST' && u === '/api/issues/iss1/comments'
        ? { status: 200, body: { comment: { id: 'c10', issue_id: 'iss1', author: 'user', content: 'echo', ts: 7 }, woke: true } }
        : undefined;
    const t = makeIo(stdinText);
    const code = await main(['node', 'kb', '--server', base, 'comment', 'iss1', '--stdin'], t.io);
    expect(code).toBe(0);
    expect(calls[0]).toEqual({ method: 'POST', url: '/api/issues/iss1/comments', body: { content: stdinText } });
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
});
