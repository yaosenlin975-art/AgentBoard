/**
 * DEC-4：kb 决策命令组（ask / decisions / decision / answer / stop-check）。
 *
 * 覆盖卡面验收：
 * - ask 请求体带选项、触发与 fence；回答先到 → ANSWERED + 退出 0；
 * - --grace 0：立即 LOCKED，退出 0，不轮询（实测 <2s 的语义用「不发 GET /decisions」表达）；
 * - --no-wait：PENDING，退出 0；
 * - 选项不足 / 非法 grace → 退出码 3（不发请求）；
 * - answer 按 label/序号解析；重复 answer 409 → 退出码 2；
 * - kb decisions --issue 列待决策；kb stop-check 输出停止信号；kb show 显示锁标识。
 */
import { createServer, type Server } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { main } from '../src/index.js';

interface Recorded { method: string; url: string; body: unknown; }
type Reply = { status: number; body?: unknown } | undefined;

const ISSUE = {
  id: 'iss-a', workspace_id: 'ws1', title: '待决策卡', description: '', priority: '高',
  labels: [], status: '进行中', sort_order: 0, claimed_by: 'agent-1', claimed_at: 1,
  session_id: null, comment_count: 0, created_at: 1, updated_at: 2,
};

const DECISION_ID = 'decf0000-0000-0000-0000-000000000001';

function decision(overrides: Record<string, unknown> = {}) {
  const now = Date.now();
  return {
    id: DECISION_ID, workspace_id: 'ws1', issue_id: 'iss-a', question: 'A 还是 B？',
    context_md: '', trigger: 'blocked', state: 'grace', created_by: 'agent-1',
    grace_seconds: 1, grace_until: now + 1000, locked_at: null, stop_requested_at: null,
    stop_ack_at: null, answer_revision: 0, created_at: now, answered_at: null,
    withdrawn_at: null, withdrawn_by: null, withdrawn_reason: null, expires_at: null,
    on_expire: 'stay_locked', remaining_grace_seconds: 1, waiting_seconds: null,
    options: [
      { id: 'opt-a', ord: 1, label: 'A 方案', consequence: '按 A 继续', is_default: 1 },
      { id: 'opt-b', ord: 2, label: 'B 方案', consequence: '按 B 继续', is_default: 0 },
    ],
    answers: [], ...overrides,
  };
}

let server: Server;
let base = '';
let calls: Recorded[] = [];
let handler: (method: string, url: string, body: unknown) => Reply = () => undefined;
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
  oldCwd = process.cwd();
  cwd = mkdtempSync(join(tmpdir(), 'kb-decision-'));
  process.chdir(cwd);
});

afterEach(async () => {
  process.chdir(oldCwd);
  await new Promise<void>((resolve) => server.close(() => resolve()));
  rmSync(cwd, { recursive: true, force: true });
});

const run = async (args: string[]) => {
  const out: string[] = []; const err: string[] = [];
  const io = { write: (s: string) => { out.push(s); }, writeErr: (s: string) => { err.push(s); }, readStdin: async () => '' };
  const code = await main(['node', 'kb', '--server', base, ...args], io);
  return { code, out: out.join(''), err: err.join('') };
};

const baseHandlers = (extras: (method: string, url: string, body: unknown) => Reply) =>
  (method: string, url: string, body: unknown): Reply => {
    if (method === 'GET' && url === '/api/issues/iss-a') return { status: 200, body: ISSUE };
    if (method === 'POST' && url === '/api/issues/iss-a/heartbeat') return { status: 200, body: ISSUE };
    if (method === 'POST' && url === '/api/issues/iss-a/ask') return { status: 201, body: { decision: decision() } };
    if (method === 'GET' && url === `/api/decisions/${DECISION_ID}`) {
      return {
        status: 200,
        body: {
          decision: decision({
            state: 'answered', answer_revision: 1,
            answers: [{
              revision: 1, option_id: 'opt-a', answer_text: null, answered_by: 'user', source: 'web', created_at: Date.now(),
            }],
          }),
        },
      };
    }
    return extras(method, url, body);
  };

describe('kb ask', () => {
  it('grace 内回答先到：ANSWERED + 退出 0；请求体带 ≥2 选项与提问者', async () => {
    handler = baseHandlers(() => undefined);
    const result = await run(['ask', 'iss-a', '--question', 'A 还是 B？', '--option', 'A 方案|按 A 继续', '--option', 'B 方案|按 B 继续']);
    expect(result.code).toBe(0);
    expect(result.out).toContain('ANSWERED');
    expect(result.out).toContain('A 方案');
    const askCall = calls.find((c) => c.url === '/api/issues/iss-a/ask');
    const body = askCall!.body as { agent_id: string; options: unknown[]; question: string };
    expect(body.question).toBe('A 还是 B？');
    expect(body.options).toHaveLength(2);
    expect(body.agent_id).toBeTruthy();
    // 轮询期间续租
    expect(calls.some((c) => c.url === '/api/issues/iss-a/heartbeat')).toBe(true);
  });

  it('--grace 0：立即 LOCKED、退出 0、不轮询（不等待）', async () => {
    handler = (method, url) => {
      if (method === 'GET' && url === '/api/issues/iss-a') return { status: 200, body: ISSUE };
      if (method === 'POST' && url === '/api/issues/iss-a/ask') {
        return { status: 201, body: { decision: decision({ state: 'open', grace_seconds: 0, grace_until: Date.now(), locked_at: Date.now(), stop_requested_at: Date.now() }) } };
      }
      return undefined;
    };
    const started = Date.now();
    const result = await run(['ask', 'iss-a', '--question', '立即决定？', '--option', 'A|a', '--option', 'B|b', '--grace', '0']);
    expect(result.code).toBe(0);
    expect(result.out).toContain('LOCKED');
    expect(Date.now() - started).toBeLessThan(2000);
    expect(calls.some((c) => c.url === `/api/decisions/${DECISION_ID}`)).toBe(false);
  });

  it('--no-wait：PENDING 立即返回，退出 0', async () => {
    handler = baseHandlers(() => undefined);
    const result = await run(['ask', 'iss-a', '--question', '异步？', '--option', 'A|a', '--option', 'B|b', '--no-wait']);
    expect(result.code).toBe(0);
    expect(result.out).toContain('PENDING');
    expect(calls.some((c) => c.url === `/api/decisions/${DECISION_ID}`)).toBe(false);
  });

  it('选项不足 → 退出码 3 且不发请求', async () => {
    handler = baseHandlers(() => undefined);
    const result = await run(['ask', 'iss-a', '--question', '只有一个？', '--option', 'A|a']);
    expect(result.code).toBe(3);
    expect(result.err).toContain('至少需要 2 个');
    expect(calls.some((c) => c.url === '/api/issues/iss-a/ask')).toBe(false);
  });

  it('重复 label → 退出码 3', async () => {
    handler = baseHandlers(() => undefined);
    const result = await run(['ask', 'iss-a', '--question', 'x', '--option', 'A|a', '--option', 'A|b']);
    expect(result.code).toBe(3);
  });

  it('--grace 601 / -1 / 1.5 → 退出码 3（0–600 整数）', async () => {
    handler = baseHandlers(() => undefined);
    for (const grace of ['601', '-1', '1.5']) {
      const result = await run(['ask', 'iss-a', '--question', 'x', '--option', 'A|a', '--option', 'B|b', '--grace', grace]);
      expect(result.code).toBe(3);
    }
    expect(calls.some((c) => c.url === '/api/issues/iss-a/ask')).toBe(false);
  });

  it('服务端 400 ASK_TOO_FEW_OPTIONS 也按退出码 3 口径', async () => {
    handler = (method, url) => {
      if (method === 'GET' && url === '/api/issues/iss-a') return { status: 200, body: ISSUE };
      if (method === 'POST' && url === '/api/issues/iss-a/ask') {
        return { status: 400, body: { error: { code: 'ASK_TOO_FEW_OPTIONS', message: '至少需要 2 个选项' } } };
      }
      return undefined;
    };
    const result = await run(['ask', 'iss-a', '--question', 'x', '--option', 'A|a', '--option', 'B|b']);
    expect(result.code).toBe(3);
  });
});

describe('kb answer / decisions / stop-check / show', () => {
  it('answer 按 label 解析为 option_id；退出 0', async () => {
    handler = (method, url) => {
      if (method === 'GET' && url === `/api/decisions/${DECISION_ID}`) return { status: 200, body: { decision: decision() } };
      if (method === 'POST' && url === `/api/decisions/${DECISION_ID}/answer`) {
        return { status: 200, body: { decision: decision({ state: 'answered', answer_revision: 1 }) } };
      }
      return undefined;
    };
    const result = await run(['answer', DECISION_ID, '--option', 'A 方案']);
    expect(result.code).toBe(0);
    expect(result.out).toContain('ANSWERED');
    const answerCall = calls.find((c) => c.url === `/api/decisions/${DECISION_ID}/answer`);
    expect((answerCall!.body as { option_id?: string }).option_id).toBe('opt-a');
  });

  it('重复 answer 服务端 409 → 退出码 2', async () => {
    handler = (method, url) => {
      if (method === 'GET' && url === `/api/decisions/${DECISION_ID}`) return { status: 200, body: { decision: decision() } };
      if (method === 'POST' && url === `/api/decisions/${DECISION_ID}/answer`) {
        return { status: 409, body: { error: { code: 'DECISION_ALREADY_ANSWERED', message: '已回答；修订请带 expected_revision' } } };
      }
      return undefined;
    };
    const result = await run(['answer', DECISION_ID, '--option', '2']);
    expect(result.code).toBe(2);
  });

  it('decisions --issue 列出待决策；--json 输出 counts', async () => {
    handler = (method, url) => {
      if (method === 'GET' && url === '/api/issues/iss-a') return { status: 200, body: ISSUE };
      if (method === 'GET' && url.startsWith('/api/decisions?workspace_id=ws1')) {
        return {
          status: 200,
          body: {
            decisions: [{
              ...decision(), issue_title: ISSUE.title, issue_status: ISSUE.status, option_count: 2,
            }],
            counts: { grace: 1, open: 0, stale: 0 },
          },
        };
      }
      return undefined;
    };
    const result = await run(['decisions', '--issue', 'iss-a']);
    expect(result.code).toBe(0);
    expect(result.out).toContain('待决策卡');
    expect(result.out).toContain('[grace]');
    // OPT-12：--issue 由服务端按 issue_id 过滤，不在客户端扫描 200 条前缀窗口
    const listCall = calls.find(c => c.method === 'GET' && c.url.startsWith('/api/decisions?workspace_id=ws1'));
    expect(listCall?.url).toContain('issue_id=iss-a');
    expect(listCall?.url).not.toContain('limit=');
  });

  it('decisions 不带 --issue 时不传 issue_id（旧口径逐字不变）', async () => {
    handler = (method, url) => {
      if (method === 'GET' && url === '/api/workspaces') return { status: 200, body: [{ id: 'ws1', name: 'ws', path: cwd }] };
      if (method === 'GET' && url.startsWith('/api/decisions?workspace_id=ws1')) {
        return { status: 200, body: { decisions: [{ ...decision(), issue_title: ISSUE.title, issue_status: ISSUE.status, option_count: 2 }], counts: { grace: 1, open: 0, stale: 0 } } };
      }
      return undefined;
    };
    const result = await run(['decisions', '--workspace', 'ws1']);
    expect(result.code).toBe(0);
    const listCall = calls.find(c => c.method === 'GET' && c.url.startsWith('/api/decisions?workspace_id=ws1'));
    expect(listCall?.url).not.toContain('issue_id=');
  });

  it('decisions --issue 无该卡决策时输出空表并退出 0', async () => {
    handler = (method, url) => {
      if (method === 'GET' && url === '/api/issues/iss-a') return { status: 200, body: ISSUE };
      if (method === 'GET' && url.startsWith('/api/decisions?workspace_id=ws1')) {
        return { status: 200, body: { decisions: [], counts: { grace: 0, open: 0, stale: 0 } } };
      }
      return undefined;
    };
    const result = await run(['decisions', '--issue', 'iss-a']);
    expect(result.code).toBe(0);
    expect(result.out).toContain('（无决策）');
  });

  it('stop-check：落锁后输出 STOP_REQUESTED 与下一步协作式停止指引', async () => {
    handler = (method, url) => {
      if (method === 'GET' && url === '/api/issues/iss-a') return { status: 200, body: ISSUE };
      if (method === 'GET' && url === '/api/issues/iss-a/stop') {
        return { status: 200, body: { issue_id: 'iss-a', stop_requested: true, decision_id: DECISION_ID, reason: '决策未回答', stop_requested_at: Date.now() } };
      }
      return undefined;
    };
    const result = await run(['stop-check', 'iss-a']);
    expect(result.code).toBe(0);
    expect(result.out).toContain('STOP_REQUESTED');
    expect(result.out).toContain('不提交');
  });

  it('kb show 显示 open 决策锁标识；list-tasks 占用者后带 [待决策]', async () => {
    handler = (method, url) => {
      if (method === 'GET' && url === '/api/workspaces') return { status: 200, body: [{ id: 'ws1', name: 'ws', path: cwd }] };
      if (method === 'GET' && url.startsWith('/api/issues?workspace=ws1')) {
        return { status: 200, body: [{ ...ISSUE, decision_locked: true, open_decision_id: DECISION_ID, decision_waiting_seconds: 42 }] };
      }
      if (method === 'GET' && url.split('?')[0] === '/api/issues/iss-a') {
        return { status: 200, body: { ...ISSUE, decision_locked: true, open_decision_id: DECISION_ID, decision_waiting_seconds: 42 } };
      }
      if (method === 'GET' && url === '/api/issues/iss-a/comments') return { status: 200, body: [] };
      return undefined;
    };
    const shown = await run(['show', 'iss-a']);
    expect(shown.code).toBe(0);
    expect(shown.out).toContain('LOCKED');
    expect(shown.out).toContain('已等待 42 秒');
    const listed = await run(['list-tasks', '--workspace', 'ws1', '--full']); // OPT-07：决策列走 --full
    expect(listed.code).toBe(0);
    expect(listed.out).toContain('[待决策]');
  });
});

describe('kb ask-extend（DEC-V4-API-EXTEND）', () => {
  const extended = {
    decision_id: DECISION_ID,
    state: 'grace',
    grace_until: Date.now() + 60_000,
    remaining_grace_seconds: 60,
    extended_seconds: 60,
    extension_count: 1,
    max_extend_seconds: 300,
  };

  it('成功：POST /api/decisions/:id/extend，默认 60 秒，文本含累计与次数', async () => {
    handler = (method, url) => {
      if (method === 'GET' && url === '/api/workspaces') return { status: 200, body: [] };
      if (method === 'POST' && url === `/api/decisions/${DECISION_ID}/extend`) return { status: 200, body: extended };
      return undefined;
    };
    const result = await run(['ask-extend', DECISION_ID]);
    expect(result.code).toBe(0);
    expect(result.out).toContain('EXTENDED');
    expect(result.out).toContain('60/300');
    const call = calls.find((c) => c.url === `/api/decisions/${DECISION_ID}/extend`);
    expect(call?.body).toMatchObject({ seconds: 60 });
    expect((call?.body as { by: string }).by).toBeTruthy();
  });

  it('--json：输出结构化结果；--by/--fence 进请求体', async () => {
    handler = (method, url) => {
      if (method === 'GET' && url === '/api/workspaces') return { status: 200, body: [] };
      if (method === 'POST' && url === `/api/decisions/${DECISION_ID}/extend`) return { status: 200, body: extended };
      return undefined;
    };
    const result = await run(['ask-extend', DECISION_ID, '--seconds', '120', '--by', 'user', '--fence', '7', '--json']);
    expect(result.code).toBe(0);
    expect(JSON.parse(result.out)).toMatchObject({ decision_id: DECISION_ID, extended_seconds: 60 });
    const call = calls.find((c) => c.url === `/api/decisions/${DECISION_ID}/extend`);
    expect(call?.body).toMatchObject({ seconds: 120, by: 'user', fence: 7 });
  });

  it('参数非法（0/301/abc/前缀 <8 位）→ 退出码 3，不发延长请求', async () => {
    handler = () => undefined;
    for (const args of [
      ['ask-extend', DECISION_ID, '--seconds', '0'],
      ['ask-extend', DECISION_ID, '--seconds', '301'],
      ['ask-extend', DECISION_ID, '--seconds', 'abc'],
      ['ask-extend', 'decf000'],
    ]) {
      const result = await run(args);
      expect(result.code).toBe(3);
    }
    expect(calls.some((c) => c.url.endsWith('/extend'))).toBe(false);
  });

  it('409 EXTEND_LIMIT_EXCEEDED → 退出码 2 并带错误码', async () => {
    handler = (method, url) => {
      if (method === 'GET' && url === '/api/workspaces') return { status: 200, body: [] };
      if (method === 'POST' && url === `/api/decisions/${DECISION_ID}/extend`) {
        return { status: 409, body: { error: { code: 'EXTEND_LIMIT_EXCEEDED', message: '延长上限 200 秒' } } };
      }
      return undefined;
    };
    const result = await run(['ask-extend', DECISION_ID, '--seconds', '60']);
    expect(result.code).toBe(2);
    expect(result.err).toContain('延长上限');
  });

  it('跨区（当前工作区 ≠ 决策工作区）→ 服务端 403 → 退出码 2', async () => {
    handler = (method, url) => {
      if (method === 'GET' && url === '/api/workspaces') return { status: 200, body: [{ id: 'ws-local', name: '本地', path: cwd }] };
      if (method === 'POST' && url === `/api/decisions/${DECISION_ID}/extend`) {
        return { status: 403, body: { error: { code: 'FORBIDDEN', message: '跨区延长需要目标工作区写权限' } } };
      }
      return undefined;
    };
    const result = await run(['ask-extend', DECISION_ID]);
    expect(result.code).toBe(2);
    expect(result.err).toContain('FORBIDDEN');
    const call = calls.find((c) => c.url === `/api/decisions/${DECISION_ID}/extend`);
    expect(call?.body).toMatchObject({ workspace_id: 'ws-local' });
  });
});

describe('CR2-10：决策前缀解析（批量读 + 大上限）', () => {
  it('历史决策 >500 条时前缀仍能命中，且只发一次 workspace_ids 批量请求', async () => {
    const target = 'deadbeef-1111-4111-8111-111111111111';
    // 599 条干扰项在前，目标在末尾：任何 500/200 上限截断都会假阴性
    const decoys = Array.from({ length: 599 }, (_, i) => ({ id: `a${String(i).padStart(7, '0')}-0000-4000-8000-000000000000` }));
    handler = (method, url) => {
      if (method === 'GET' && url === '/api/workspaces') {
        return { status: 200, body: [{ id: 'ws1', name: 'A', path: cwd }, { id: 'ws2', name: 'B', path: cwd }] };
      }
      if (method === 'GET' && url.startsWith('/api/decisions?')) {
        return { status: 200, body: { decisions: [...decoys, { id: target }] } };
      }
      if (method === 'GET' && url === `/api/decisions/${target}`) return { status: 200, body: { decision: decision({ id: target }) } };
      return undefined;
    };
    const result = await run(['decision', 'show', 'deadbeef']);
    expect(result.code).toBe(0);
    expect(result.out).toContain(`id: ${target}`);
    const listCalls = calls.filter((c) => c.url.startsWith('/api/decisions?'));
    expect(listCalls).toHaveLength(1);
    expect(listCalls[0]!.url).toContain('workspace_ids=ws1,ws2');
    expect(listCalls[0]!.url).toContain('limit=100000');
  });

  it('N-06：默认项标注说明它只在 on_expire=unlock_default 时生效，不暗示 CLI 可回车即答', async () => {
    const target = 'deadbeef-2222-4222-8222-222222222222';
    handler = (method, url) => {
      if (method === 'GET' && url === '/api/workspaces') return { status: 200, body: [{ id: 'ws1', name: 'A', path: cwd }] };
      if (method === 'GET' && url.startsWith('/api/decisions?')) return { status: 200, body: { decisions: [{ id: target }] } };
      if (method === 'GET' && url === `/api/decisions/${target}`) return { status: 200, body: { decision: decision({ id: target }) } };
      return undefined;
    };
    const result = await run(['decision', 'show', 'deadbeef']);
    expect(result.code).toBe(0);
    expect(result.out).toContain('on_expire=unlock_default 时宽限到期自动采用');
    expect(result.out).not.toContain('未指定时的默认项');
  });
});
