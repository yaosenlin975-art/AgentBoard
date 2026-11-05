/**
 * STORE-2b：`kb workspace-db enable` 的 HTTP 契约与输出（真本地 mock HTTP，不 mock fetch）。
 * 多阶段轮询场景直接调 workspaceDbEnable（注入 pollMs/timeoutMs 缩短等待）；单发场景走 main()。
 */
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { WorkspaceLocalizeJobView } from '@agentboard/shared';
import { main } from '../src/index.js';
import { workspaceDbEnable } from '../src/commands/workspaceDb.js';
import type { Ctx } from '../src/io.js';

interface Recorded { method: string; url: string; body: unknown }
type MockReply = { status: number; body?: unknown } | undefined;
type Handler = (method: string, url: string, body: unknown) => MockReply;

const WS = { id: 'ws1', name: '下沉空间', path: 'D:/ws/localize', created_at: 1 };
const LOCALIZE_PATH = '/api/workspaces/ws1/db/localize';
const COUNTS = {
  issue: 45, issue_comment: 200, session: 3, message: 900, issue_dependency: 2,
  rows_total: 1150, attachment_files: 3, attachment_bytes: 1572864, estimated_bytes: 10485760,
};

const job = (overrides: Partial<WorkspaceLocalizeJobView> = {}): WorkspaceLocalizeJobView => ({
  jobId: 'loc-ab12cd34',
  workspaceId: 'ws1',
  dryRun: false,
  status: 'running',
  stage: 'preflight',
  counts: {},
  lastError: null,
  result: null,
  targetDbPath: null,
  backupPath: null,
  startedAt: 1,
  finishedAt: null,
  ...overrides,
});

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

/** 所有命令都先解析 workspace（GET /api/workspaces） */
const withWorkspaces = (inner: Handler): Handler => (method, url, body) => (
  method === 'GET' && url === '/api/workspaces' ? { status: 200, body: [WS] } : inner(method, url, body)
);

const run = async (args: string[]) => {
  const t = makeIo();
  const code = await main(['node', 'kb', '--server', base, ...args], t.io);
  return { code, out: t.out(), err: t.err() };
};

/** 直接调命令（注入毫秒级轮询，测多阶段/超时路径） */
const runDirect = async (args: { dryRun?: boolean; overwrite?: boolean } = {}, json = false) => {
  const t = makeIo();
  const ctx: Ctx = { base, json, agentId: 'test', io: t.io };
  const code = await workspaceDbEnable(ctx, '下沉空间', { ...args, pollMs: 1, timeoutMs: 5000 })
    .then(() => 0)
    .catch((error: { exitCode?: number }) => error.exitCode ?? 1);
  return { code, out: t.out(), err: t.err() };
};

describe('kb workspace-db enable', () => {
  it('dry-run：请求体只有 {dryRun:true}，打印计数并明确未产生变更', async () => {
    handler = withWorkspaces((method, url) => (
      method === 'POST' && url === LOCALIZE_PATH
        ? { status: 202, body: job({ dryRun: true, status: 'done', stage: null, result: 'dry_run', counts: COUNTS, targetDbPath: 'D:/ws/localize/.agentboard/workspace.db', finishedAt: 2 }) }
        : undefined
    ));
    const result = await run(['workspace-db', 'enable', '下沉空间', '--dry-run']);
    expect(result.code).toBe(0);
    expect(calls[1]).toEqual({ method: 'POST', url: LOCALIZE_PATH, body: { dryRun: true } });
    expect(result.out).toContain('未产生任何变更');
    expect(result.out).toContain('行数合计：1150');
    expect(result.out).toContain('附件：3 个');
    expect(result.out).toContain('预计迁移数据量');
    expect(result.out).toContain('D:/ws/localize/.agentboard/workspace.db');
  });

  it('dry-run --overwrite：请求体带 overwrite:true', async () => {
    handler = withWorkspaces((method, url) => (
      method === 'POST' && url === LOCALIZE_PATH
        ? { status: 202, body: job({ dryRun: true, status: 'done', stage: null, result: 'dry_run', counts: COUNTS, finishedAt: 2 }) }
        : undefined
    ));
    const result = await run(['workspace-db', 'enable', '下沉空间', '--dry-run', '--overwrite']);
    expect(result.code).toBe(0);
    expect(calls[1]!.body).toEqual({ dryRun: true, overwrite: true });
  });

  it('真实迁移按阶段渲染进度并展示 done 终态计数', async () => {
    handler = withWorkspaces((method, url) => {
      if (method === 'POST' && url === LOCALIZE_PATH) return { status: 202, body: job() };
      if (method === 'GET' && url === `${LOCALIZE_PATH}/loc-ab12cd34`) {
        const seen = calls.filter(call => call.method === 'GET' && call.url.startsWith(LOCALIZE_PATH)).length;
        if (seen === 1) return { status: 200, body: job({ stage: 'backup' }) };
        if (seen === 2) return { status: 200, body: job({ stage: 'copy', counts: { rows_total: 600 } }) };
        return { status: 200, body: job({ status: 'done', stage: 'finalize', result: 'localized', counts: COUNTS, targetDbPath: 'D:/ws/localize/.agentboard/workspace.db', backupPath: 'D:/center/backup.db', finishedAt: 3 }) };
      }
      return undefined;
    });
    const result = await runDirect();
    expect(result.code).toBe(0);
    expect(result.out).toContain('迁移已受理（jobId loc-ab12cd34）');
    expect(result.out).toContain('备份中心库（backup）');
    expect(result.out).toContain('复制数据（copy）');
    expect(result.out.indexOf('备份中心库')).toBeLessThan(result.out.indexOf('复制数据'));
    expect(result.out).toContain('迁移完成');
    expect(result.out).toContain('行数合计：1150');
    expect(result.out).toContain('D:/center/backup.db');
    // 真实迁移不带 --dry-run：请求体为空对象（服务端 strict schema 仍接受）
    expect(calls[1]!.body).toEqual({});
  });

  it('already_localized 幂等回显：退出码 0、提示不重做', async () => {
    handler = withWorkspaces((method, url) => (
      method === 'POST' && url === LOCALIZE_PATH
        ? { status: 202, body: job({ status: 'already_localized', stage: null, result: 'already_localized', finishedAt: 2 }) }
        : undefined
    ));
    const result = await run(['workspace-db', 'enable', '下沉空间']);
    expect(result.code).toBe(0);
    expect(result.out).toContain('已启用工作区库');
    expect(result.out).toContain('无需重复启用');
  });

  it('409 MIGRATION_BUSY：原样透出服务端文案、退出码 2、不被包装成「已被占用（…）」', async () => {
    handler = withWorkspaces((method, url) => (
      method === 'POST' && url === LOCALIZE_PATH
        ? { status: 409, body: { error: { code: 'MIGRATION_BUSY', message: '已有迁移在进行中（同一时间只允许一个）' } } }
        : undefined
    ));
    const result = await run(['workspace-db', 'enable', '下沉空间']);
    expect(result.code).toBe(2);
    expect(result.err).toContain('已有迁移在进行中');
    expect(result.err).not.toContain('已被占用（');
  });

  it('400 参数类：退出码 1、透出服务端文案', async () => {
    handler = withWorkspaces((method, url) => (
      method === 'POST' && url === LOCALIZE_PATH
        ? { status: 400, body: { error: { code: 'VALIDATION_ERROR', message: '请求体含未知字段：foo' } } }
        : undefined
    ));
    const result = await run(['workspace-db', 'enable', '下沉空间']);
    expect(result.code).toBe(1);
    expect(result.err).toContain('请求体含未知字段');
  });

  it('failed job：中文阶段 + lastError 原文，退出码 1', async () => {
    handler = withWorkspaces((method, url) => {
      if (method === 'POST' && url === LOCALIZE_PATH) return { status: 202, body: job({ stage: 'backup' }) };
      if (method === 'GET' && url === `${LOCALIZE_PATH}/loc-ab12cd34`) {
        return { status: 200, body: job({ status: 'failed', stage: 'copy', lastError: '复制表 issue 失败：disk I/O error（行主键 42）' }) };
      }
      return undefined;
    });
    const result = await runDirect();
    expect(result.code).toBe(1);
    expect(result.err).toContain('迁移失败');
    expect(result.err).toContain('复制数据（copy）');
    expect(result.err).toContain('复制表 issue 失败：disk I/O error');
    expect(result.err).toContain('loc-ab12cd34');
  });

  it('轮询超时：中文提示并保留 jobId 重查，退出码 1', async () => {
    handler = withWorkspaces((method, url) => {
      if (method === 'POST' && url === LOCALIZE_PATH) return { status: 202, body: job({ stage: 'copy' }) };
      if (method === 'GET' && url === `${LOCALIZE_PATH}/loc-ab12cd34`) return { status: 200, body: job({ stage: 'copy' }) };
      return undefined;
    });
    const t = makeIo();
    const ctx: Ctx = { base, json: false, agentId: 'test', io: t.io };
    let thrown = '';
    const code = await workspaceDbEnable(ctx, '下沉空间', { pollMs: 1, timeoutMs: 30 })
      .then(() => 0)
      .catch((error: unknown) => { thrown = error instanceof Error ? error.message : String(error); return 1; });
    expect(code).toBe(1);
    expect(thrown).toContain('迁移超时');
    expect(thrown).toContain('loc-ab12cd34');
    expect(thrown).toContain('复制数据（copy）');
  });

  it('done 终态兼容真实迁移的精简 counts（无 rows_total/bytes 时省略聚合行，不打印「未知」）', async () => {
    handler = withWorkspaces((method, url) => (
      method === 'POST' && url === LOCALIZE_PATH
        ? { status: 202, body: job({ status: 'done', stage: 'finalize', result: 'localized', counts: { workspace_status: 5, issue: 1, issue_comment: 0, issue_dependency: 0, issue_git_baseline: 0, issue_draft_audit: 0, session: 0, message: 0, attachment: 0, workspace_change_log: 0, knowledge_page: 0, knowledge_revision: 0, knowledge_link: 0, knowledge_attachment: 0, attachment_files: 0 }, targetDbPath: 'D:/ws/localize/.agentboard/agentboard.db', finishedAt: 3 }) }
        : undefined
    ));
    const result = await run(['workspace-db', 'enable', '下沉空间']);
    expect(result.code).toBe(0);
    expect(result.out).toContain('迁移完成');
    expect(result.out).toContain('行数合计：6（卡 1、评论 0、会话 0、消息 0）');
    expect(result.out).toContain('附件：0 个');
    expect(result.out).not.toContain('未知');
    expect(result.out).not.toContain('预计迁移数据量');
  });

  it('--json：dry-run 终态输出 JobView 原文（可解析、无进度行混入 stdout）', async () => {
    handler = withWorkspaces((method, url) => (
      method === 'POST' && url === LOCALIZE_PATH
        ? { status: 202, body: job({ dryRun: true, status: 'done', stage: null, result: 'dry_run', counts: COUNTS, finishedAt: 2 }) }
        : undefined
    ));
    const result = await run(['workspace-db', 'enable', '下沉空间', '--dry-run', '--json']);
    expect(result.code).toBe(0);
    const parsed = JSON.parse(result.out) as WorkspaceLocalizeJobView;
    expect(parsed.jobId).toBe('loc-ab12cd34');
    expect(parsed.status).toBe('done');
    expect(parsed.dryRun).toBe(true);
    expect(parsed.counts['rows_total']).toBe(1150);
  });

  it('工作空间不存在：退出码 1、中文文案', async () => {
    handler = (method, url) => (
      method === 'GET' && url === '/api/workspaces' ? { status: 200, body: [] } : undefined
    );
    const result = await run(['workspace-db', 'enable', '不存在的空间']);
    expect(result.code).toBe(1);
    expect(result.err).toContain('工作空间不存在');
  });
});
