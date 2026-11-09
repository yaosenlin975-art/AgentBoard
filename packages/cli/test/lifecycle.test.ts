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

describe('ARCH-04：done 设计页 landed 回改门禁', () => {
  const TASK_ID = 'aaaaaaaa-1111-4111-8111-111111111111';
  const PARENT_ID = 'bbbbbbbb-2222-4222-8222-222222222222';
  const PAGE_ID = 'cccccccc-3333-4333-8333-333333333333';
  const OTHER_ID = 'dddddddd-4444-4444-8444-444444444444';
  const TASK = { ...ISSUE, id: TASK_ID, parent_issue_id: PARENT_ID, status: '进行中' };
  const PARENT = { ...ISSUE, id: PARENT_ID, parent_issue_id: null };
  const page = (landed: string) => ({
    id: PAGE_ID, slug: 'design-page', title: '设计页', scope: 'workspace', workspace_id: 'ws1',
    revision: 1, status: 'active', category: 'design', landed,
  });
  const detail = (landed: string, linkedIssue = PARENT_ID) => ({
    ...page(landed),
    sources: [],
    evidence: [{ source_id: `issue:${linkedIssue}`, locator: `issue:${linkedIssue}` }],
  });
  const designHandler = (
    landed: () => string,
    onRevise?: (next: string) => void,
    linkedIssue = PARENT_ID,
  ): Handler => (m, u, body) => {
    if (m === 'GET' && u === '/api/workspaces') return { status: 200, body: [{ id: 'ws1', name: '测试工作区', path: 'D:\\ws1' }] };
    if (m === 'GET' && u === `/api/issues/${TASK_ID}`) return { status: 200, body: { ...TASK, status: '进行中' } };
    if (m === 'GET' && u === `/api/issues/${PARENT_ID}`) return { status: 200, body: PARENT };
    if (m === 'GET' && u.startsWith('/api/knowledge/pages?')) {
      return { status: 200, body: { items: [page(landed())], next_offset: null } };
    }
    if (m === 'GET' && u.startsWith(`/api/knowledge/pages/${PAGE_ID}`)) {
      return { status: 200, body: detail(landed(), linkedIssue) };
    }
    if (m === 'PUT' && u === `/api/knowledge/pages/${PAGE_ID}`) {
      const next = (body as { landed?: string }).landed ?? landed();
      onRevise?.(next);
      return { status: 200, body: detail(next, linkedIssue) };
    }
    if (m === 'POST' && u === `/api/issues/${TASK_ID}/done`) {
      return { status: 200, body: { ...TASK, status: '待验收', claimed_by: null } };
    }
    return undefined;
  };

  it('① 关联 proposed design 页且未声明：exit 1，列出页 id 与两个选项，done 未执行', async () => {
    handler = designHandler(() => 'proposed');
    const result = await run(['done', TASK_ID, '--notes', '改完']);
    expect(result.code).toBe(1);
    expect(result.err).toContain(PAGE_ID);
    expect(result.err).toContain('--landed landed|partial');
    expect(result.err).toContain('--design-not-advanced');
    expect(calls.some(c => c.method === 'POST' && c.url === `/api/issues/${TASK_ID}/done`)).toBe(false);
    expect(calls.some(c => c.method === 'PUT')).toBe(false);
  });

  it('② revise 改 landed=landed 后 done 通过，knowledge show 回读 landed', async () => {
    let landed = 'proposed';
    handler = designHandler(() => landed, next => { landed = next; });
    const revised = await run([
      'knowledge', 'revise', PAGE_ID, '--scope', 'workspace', '--workspace', 'ws1',
      '--expected-revision', '1', '--landed', 'landed',
    ]);
    expect(revised.code).toBe(0);
    const shown = await run(['knowledge', 'show', PAGE_ID, '--scope', 'workspace', '--workspace', 'ws1']);
    expect(shown.out).toContain('landed: landed');
    const result = await run(['done', TASK_ID, '--notes', '改完']);
    expect(result.code).toBe(0);
    expect(result.out).toContain('状态: 待验收');
    expect(calls.some(c => c.method === 'POST' && c.url === `/api/issues/${TASK_ID}/done`)).toBe(true);
  });

  it('②b landed=partial 同样放行', async () => {
    handler = designHandler(() => 'partial');
    const result = await run(['done', TASK_ID]);
    expect(result.code).toBe(0);
    expect(result.out).toContain('状态: 待验收');
  });

  it('③ --design-not-advanced：done 通过，声明与页 id 写入 notes', async () => {
    handler = designHandler(() => 'proposed');
    const result = await run(['done', TASK_ID, '--notes', '改完', '--design-not-advanced']);
    expect(result.code, result.err).toBe(0);
    const doneCall = calls.find(c => c.method === 'POST' && c.url === `/api/issues/${TASK_ID}/done`);
    expect((doneCall?.body as { notes?: string }).notes).toContain('设计页：本卡不推进设计');
    expect((doneCall?.body as { notes?: string }).notes).toContain(PAGE_ID);
  });

  it('③b --design-not-advanced 与 --close-record 共存：notes 同时含收尾记录与声明', async () => {
    const base = designHandler(() => 'proposed');
    handler = (m, u, body) => {
      if (m === 'POST' && u === '/api/workspaces/ws1/changelog') return { status: 201, body: { id: 'log-1' } };
      return base(m, u, body);
    };
    const result = await run([
      'done', TASK_ID, '--notes', '改完', '--design-not-advanced',
      '--close-record', '--changelog-title', '收尾', '--type', '调整',
    ]);
    expect(result.code, result.err).toBe(0);
    const notes = (calls.find(c => c.method === 'POST' && c.url === `/api/issues/${TASK_ID}/done`)?.body as { notes?: string }).notes;
    expect(notes).toContain('close-record: changelog=log-1');
    expect(notes).toContain('设计页：本卡不推进设计');
    expect(notes).toContain(PAGE_ID);
  });

  it('④ 无关联 design 页（证据指向别的卡）：行为与改造前一致，不追加 notes', async () => {
    handler = designHandler(() => 'proposed', undefined, OTHER_ID);
    const result = await run(['done', TASK_ID, '--notes', '改完']);
    expect(result.code).toBe(0);
    const doneCall = calls.find(c => c.method === 'POST' && c.url === `/api/issues/${TASK_ID}/done`);
    expect((doneCall?.body as { notes?: string }).notes).toBe('改完');
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
