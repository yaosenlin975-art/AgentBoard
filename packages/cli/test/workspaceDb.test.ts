/**
 * STORE-2b/3b：`kb workspace-db enable|status|cleanup|revert` 的 HTTP 契约与输出（真本地 mock HTTP，不 mock fetch）。
 * 多阶段轮询场景直接调命令函数（注入 pollMs/timeoutMs 缩短等待）；单发场景走 main()。
 */
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { WorkspaceDbOpJobView, WorkspaceDbStatusView, WorkspaceLocalizeJobView } from '@agentboard/shared';
import { main } from '../src/index.js';
import { workspaceDbCleanup, workspaceDbEnable, workspaceDbRevert } from '../src/commands/workspaceDb.js';
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
  errorCode: null,
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
const runDirect = async (args: { dryRun?: boolean; overwrite?: boolean; resume?: boolean } = {}, json = false) => {
  const t = makeIo();
  const ctx: Ctx = { base, json, agentId: 'test', io: t.io };
  const code = await workspaceDbEnable(ctx, '下沉空间', { ...args, pollMs: 1, timeoutMs: 5000 })
    .then(() => 0)
    .catch((error: { exitCode?: number }) => error.exitCode ?? 1);
  return { code, out: t.out(), err: t.err() };
};

const DB_PATH = '/api/workspaces/ws1/db';
const CLEANUP_PATH = `${LOCALIZE_PATH}/cleanup`;
const REVERT_PATH = `${LOCALIZE_PATH}/revert`;

const opJob = (overrides: Partial<WorkspaceDbOpJobView> = {}): WorkspaceDbOpJobView => ({
  jobId: 'revert-ab12cd34',
  workspaceId: 'ws1',
  kind: 'revert',
  status: 'running',
  stage: 'preflight',
  counts: {},
  lastError: null,
  errorCode: null,
  result: null,
  backupPath: null,
  startedAt: 1,
  finishedAt: null,
  ...overrides,
});

const dbStatus = (overrides: Partial<WorkspaceDbStatusView> = {}): WorkspaceDbStatusView => ({
  workspaceId: 'ws1',
  dbMode: 'localized',
  writeGate: 'open',
  disabled: false,
  needsRevert: false,
  centerDbPath: 'C:/AppData/AgentBoard/agentboard.db',
  workspaceDbPath: 'D:/ws/localize/.agentboard/agentboard.db',
  workspaceDbExists: true,
  effectiveDbPath: 'D:/ws/localize/.agentboard/agentboard.db',
  counts: { issue: 45, issue_comment: 200, session: 3, message: 900, rows_total: 1150 },
  attachments: { rows: 3, files: 3, bytes: 1572864, dir: 'D:/ws/localize/.agentboard/attachments' },
  snapshotLagRows: 0,
  localizeState: { migrationId: 'mig-1', stage: 'finalize', lastError: null, backupPath: null, startedAt: 1 },
  activeJob: null,
  error: null,
  reason: '中心=localized 且工作区库可打开：读写走工作区库',
  ...overrides,
});

/** 直接调 cleanup / revert（注入毫秒级轮询） */
const runOp = async (command: typeof workspaceDbRevert) => {
  const t = makeIo();
  const ctx: Ctx = { base, json: false, agentId: 'test', io: t.io };
  const code = await command(ctx, '下沉空间', { pollMs: 1, timeoutMs: 5000 })
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

  it('failed job 带 errorCode：文本行附错误码（STORE-4e 全链路透传到终端）', async () => {
    handler = withWorkspaces((method, url) => {
      if (method === 'POST' && url === LOCALIZE_PATH) return { status: 202, body: job({ stage: 'verify' }) };
      if (method === 'GET' && url === `${LOCALIZE_PATH}/loc-ab12cd34`) {
        return { status: 200, body: job({ status: 'failed', stage: 'verify', lastError: '迁移校验未通过：issue 行数 2 != 3', errorCode: 'LOCALIZE_VERIFY_FAILED' }) };
      }
      return undefined;
    });
    const result = await runDirect();
    expect(result.code).toBe(1);
    expect(result.err).toContain('迁移失败（失败阶段：校验（verify），错误码 LOCALIZE_VERIFY_FAILED）');
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

  it('done 终态兼容旧服务端精简 counts（无 rows_total/bytes 时省略聚合行，不打印「未知」）', async () => {
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

  it('STORE-4e 键集统一：真实迁移终态带聚合键 → 行数合计走 rows_total、渲染迁移落盘数据量', async () => {
    handler = withWorkspaces((method, url) => (
      method === 'POST' && url === LOCALIZE_PATH
        ? {
          status: 202,
          body: job({
            status: 'done', stage: 'finalize', result: 'localized',
            counts: { workspace_status: 5, issue: 2, issue_comment: 1, session: 1, message: 3, attachment: 1, workspace_change_log: 4, rows_total: 18, attachment_files: 1, attachment_bytes: 1024, db_bytes: 2048, estimated_bytes: 3072 },
            targetDbPath: 'D:/ws/localize/.agentboard/agentboard.db',
            finishedAt: 3,
          }),
        }
        : undefined
    ));
    const result = await run(['workspace-db', 'enable', '下沉空间']);
    expect(result.code).toBe(0);
    expect(result.out).toContain('行数合计：18（卡 2、评论 1、会话 1、消息 3）');
    expect(result.out).toContain('附件：1 个（1 KB）');
    expect(result.out).toContain('迁移落盘数据量：约 3 KB');
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

describe('kb workspace-db enable --resume', () => {
  it('请求体带 resume:true，开头打印「从<阶段>阶段继续」（阶段取 localize.json 中间态）', async () => {
    handler = withWorkspaces((method, url) => {
      if (method === 'GET' && url === DB_PATH) {
        return { status: 200, body: dbStatus({ dbMode: 'failed', writeGate: 'frozen', localizeState: { migrationId: 'mig-2', stage: 'copy', lastError: 'disk I/O error', backupPath: null, startedAt: 1 } }) };
      }
      if (method === 'POST' && url === LOCALIZE_PATH) {
        return { status: 202, body: job({ status: 'done', stage: 'finalize', result: 'localized', counts: COUNTS, finishedAt: 3 }) };
      }
      return undefined;
    });
    const result = await run(['workspace-db', 'enable', '下沉空间', '--resume']);
    expect(result.code).toBe(0);
    expect(calls.map(call => `${call.method} ${call.url}`)).toEqual(['GET /api/workspaces', `GET ${DB_PATH}`, `POST ${LOCALIZE_PATH}`]);
    expect(calls[2]!.body).toEqual({ resume: true });
    expect(result.out).toContain('从复制数据（copy）阶段继续');
    expect(result.out.indexOf('阶段继续')).toBeLessThan(result.out.indexOf('迁移完成'));
  });

  it('--resume --dry-run：dry-run 优先，不查中间态、不打印续跑阶段（resume 仍透传）', async () => {
    handler = withWorkspaces((method, url) => (
      method === 'POST' && url === LOCALIZE_PATH
        ? { status: 202, body: job({ dryRun: true, status: 'done', stage: null, result: 'dry_run', counts: COUNTS, finishedAt: 2 }) }
        : undefined
    ));
    const result = await run(['workspace-db', 'enable', '下沉空间', '--resume', '--dry-run']);
    expect(result.code).toBe(0);
    expect(calls.some(call => call.url === DB_PATH)).toBe(false);
    expect(calls[1]!.body).toEqual({ dryRun: true, resume: true });
    expect(result.out).not.toContain('阶段继续');
  });

  it('无中间态：不打印续跑阶段，失败原文透出并提示 status / resume / cleanup，退出码 1', async () => {
    handler = withWorkspaces((method, url) => {
      if (method === 'GET' && url === DB_PATH) return { status: 200, body: dbStatus({ dbMode: 'center', localizeState: null }) };
      if (method === 'POST' && url === LOCALIZE_PATH) return { status: 202, body: job() };
      if (method === 'GET' && url === `${LOCALIZE_PATH}/loc-ab12cd34`) {
        return { status: 200, body: job({ status: 'failed', lastError: '没有可恢复的迁移中间态（localize.json 不存在）；全新迁移请去掉 resume' }) };
      }
      return undefined;
    });
    const result = await runDirect({ resume: true });
    expect(result.code).toBe(1);
    expect(result.out).not.toContain('阶段继续');
    expect(result.err).toContain('没有可恢复的迁移中间态');
    expect(result.err).toContain('kb workspace-db status --workspace ws1');
    expect(result.err).toContain('cleanup --workspace ws1');
  });
});

describe('kb workspace-db status', () => {
  it('已下沉常态：--workspace 解析后 GET .../db，逐项中文渲染', async () => {
    handler = withWorkspaces((method, url) => (method === 'GET' && url === DB_PATH ? { status: 200, body: dbStatus() } : undefined));
    const result = await run(['workspace-db', 'status', '--workspace', '下沉空间']);
    expect(result.code).toBe(0);
    expect(calls[1]).toEqual({ method: 'GET', url: DB_PATH, body: undefined });
    expect(result.out).toContain('模式：已下沉（localized）');
    expect(result.out).toContain('写闸门：开放（open）');
    expect(result.out).toContain('生效库：D:/ws/localize/.agentboard/agentboard.db');
    expect(result.out).toContain('行数合计（数据所在库）：1150（卡 45、评论 200、会话 3、消息 900）');
    expect(result.out).toContain('附件：3 行，文件 3 个（1.5 MB）');
    expect(result.out).toContain('快照落后：0 条');
    expect(result.out).toContain('中间态（localize.json）：阶段 收尾（finalize），migrationId mig-1');
    expect(result.out).toContain('活动任务：无');
    expect(result.out).not.toContain('【警告】');
    expect(result.out).not.toContain('提示：');
  });

  it('disabled + needsRevert：首行醒目提示需 revert；--json 输出原文且 stderr 同步提示', async () => {
    const view = dbStatus({
      disabled: true,
      needsRevert: true,
      effectiveDbPath: 'C:/AppData/AgentBoard/agentboard.db',
      reason: 'AGENTBOARD_WORKSPACE_DB=disabled：已下沉工作区临时回中心库（不打开工作区库、不自动搬回；恢复请执行 revert）',
    });
    handler = withWorkspaces((method, url) => (method === 'GET' && url === DB_PATH ? { status: 200, body: view } : undefined));
    const text = await run(['workspace-db', 'status', '--workspace', '下沉空间']);
    expect(text.code).toBe(0);
    const firstLine = text.out.split('\n')[0]!;
    expect(firstLine).toContain('紧急开关已启用：该工作区数据在工作区库中，需 revert 才能回中心库');
    expect(firstLine).toContain('kb workspace-db revert --workspace ws1');
    expect(text.out).toContain('紧急开关：已启用（AGENTBOARD_WORKSPACE_DB=disabled）');

    const json = await run(['workspace-db', 'status', '--workspace', '下沉空间', '--json']);
    expect(json.code).toBe(0);
    const parsed = JSON.parse(json.out) as WorkspaceDbStatusView;
    expect(parsed).toMatchObject({ disabled: true, needsRevert: true });
    expect(json.err).toContain('需 revert 才能回中心库');
  });

  it('failed：冻结闸门、中间态 lastError / 快照路径，末行提示 resume 或 cleanup', async () => {
    handler = withWorkspaces((method, url) => (
      method === 'GET' && url === DB_PATH
        ? {
          status: 200,
          body: dbStatus({
            dbMode: 'failed',
            writeGate: 'frozen',
            effectiveDbPath: 'C:/AppData/AgentBoard/agentboard.db',
            snapshotLagRows: 600,
            localizeState: { migrationId: 'mig-2', stage: 'copy', lastError: '复制表 issue 失败：disk I/O error', backupPath: 'D:/ws/localize/.agentboard/agentboard.db.center-backup-2', startedAt: 1 },
            error: 'WORKSPACE_DB_MIGRATING',
            reason: '中心 db_mode=failed（迁移失败待恢复）：读走中心库、写被阻断，不打开工作区库',
          }),
        }
        : undefined
    ));
    const result = await run(['workspace-db', 'status', '--workspace', '下沉空间']);
    expect(result.code).toBe(0);
    expect(result.out).toContain('模式：失败（failed）');
    expect(result.out).toContain('写闸门：冻结（frozen');
    expect(result.out).toContain('快照落后：600 条');
    expect(result.out).toContain('中间态（localize.json）：阶段 复制数据（copy），migrationId mig-2');
    expect(result.out).toContain('lastError：复制表 issue 失败：disk I/O error');
    expect(result.out).toContain('中心库快照：D:/ws/localize/.agentboard/agentboard.db.center-backup-2');
    expect(result.out).toContain('（WORKSPACE_DB_MIGRATING）');
    const lines = result.out.trimEnd().split('\n');
    expect(lines[lines.length - 1]).toContain('kb workspace-db enable ws1 --resume');
    expect(lines[lines.length - 1]).toContain('kb workspace-db cleanup --workspace ws1');
  });

  it('迁移中：活动任务带中文阶段，快照落后不适用时如实标注', async () => {
    handler = withWorkspaces((method, url) => (
      method === 'GET' && url === DB_PATH
        ? { status: 200, body: dbStatus({ dbMode: 'localizing', writeGate: 'frozen', workspaceDbExists: false, snapshotLagRows: null, activeJob: { jobId: 'loc-ab12cd34', kind: 'localize', status: 'running', stage: 'copy' } }) }
        : undefined
    ));
    const result = await run(['workspace-db', 'status', '--workspace', '下沉空间']);
    expect(result.code).toBe(0);
    expect(result.out).toContain('模式：迁移中（localizing）');
    expect(result.out).toContain('（不存在）');
    expect(result.out).toContain('快照落后：不适用');
    expect(result.out).toContain('活动任务：loc-ab12cd34（localize，running，阶段 复制数据（copy））');
  });
});

describe('kb workspace-db cleanup', () => {
  it('清理成功：请求体 {}，打印删除项与中心库行数，退出码 0', async () => {
    handler = withWorkspaces((method, url) => (
      method === 'POST' && url === CLEANUP_PATH
        ? { status: 202, body: opJob({ jobId: 'cleanup-1', kind: 'cleanup', status: 'done', stage: null, result: 'cleaned', counts: { center_rows_before: 12, removed: 3 }, finishedAt: 2 }) }
        : undefined
    ));
    const result = await run(['workspace-db', 'cleanup', '--workspace', '下沉空间']);
    expect(result.code).toBe(0);
    expect(calls[1]).toEqual({ method: 'POST', url: CLEANUP_PATH, body: {} });
    expect(result.out).toContain('清理完成：已删除 3 项迁移半成品');
    expect(result.out).toContain('db_mode=center');
    expect(result.out).toContain('中心库该区数据：12 行（未动）');
  });

  it('NOTHING_TO_CLEAN（服务端真实形态：202 + job failed + errorCode）：中文「无可清理的半成品」，退出码 2；--json 同码', async () => {
    const failed = opJob({ jobId: 'cleanup-2', kind: 'cleanup', status: 'failed', stage: null, lastError: '没有可清理的迁移半成品（该工作区当前没有 localize.json / 目标库 / 残留快照）', errorCode: 'WORKSPACE_DB_NOTHING_TO_CLEAN', finishedAt: 2 });
    handler = withWorkspaces((method, url) => (method === 'POST' && url === CLEANUP_PATH ? { status: 202, body: failed } : undefined));
    const text = await run(['workspace-db', 'cleanup', '--workspace', '下沉空间']);
    expect(text.code).toBe(2);
    expect(text.err).toContain('无可清理的半成品');
    expect(text.err).not.toContain('清理失败');

    const json = await run(['workspace-db', 'cleanup', '--workspace', '下沉空间', '--json']);
    expect(json.code).toBe(2);
    expect((JSON.parse(json.out) as WorkspaceDbOpJobView).status).toBe('failed');
  });

  it('NOTHING_TO_CLEAN 判定只认 errorCode：lastError 文案碰巧含旧文案但 errorCode 不同 → 走清理失败（退出码 1，不误判为 2）', async () => {
    const failed = opJob({ jobId: 'cleanup-4', kind: 'cleanup', status: 'failed', stage: null, lastError: '没有可清理的迁移半成品之外的原因', errorCode: 'WORKSPACE_DB_CLEANUP_UNSAFE', finishedAt: 2 });
    handler = withWorkspaces((method, url) => (method === 'POST' && url === CLEANUP_PATH ? { status: 202, body: failed } : undefined));
    const result = await runOp(workspaceDbCleanup);
    expect(result.code).toBe(1);
    expect(result.err).toContain('清理失败（错误码 WORKSPACE_DB_CLEANUP_UNSAFE）');
    expect(result.err).not.toContain('无可清理的半成品');
  });

  it('NOTHING_TO_CLEAN（POST 409）：同样中文提示、退出码 2，不被包装成「已被占用（…）」', async () => {
    handler = withWorkspaces((method, url) => (
      method === 'POST' && url === CLEANUP_PATH
        ? { status: 409, body: { error: { code: 'WORKSPACE_DB_NOTHING_TO_CLEAN', message: '没有可清理的迁移半成品（该工作区当前没有 localize.json / 目标库 / 残留快照）' } } }
        : undefined
    ));
    const result = await run(['workspace-db', 'cleanup', '--workspace', '下沉空间']);
    expect(result.code).toBe(2);
    expect(result.err).toContain('无可清理的半成品');
    expect(result.err).not.toContain('已被占用（');
  });

  it('清理被拒（工作区库是唯一数据副本）：lastError 原文、退出码 1', async () => {
    handler = withWorkspaces((method, url) => (
      method === 'POST' && url === CLEANUP_PATH
        ? { status: 202, body: opJob({ jobId: 'cleanup-3', kind: 'cleanup', status: 'failed', stage: null, lastError: '中心库已无该工作区数据、工作区库是唯一数据副本，拒绝清理；请先执行 revert 恢复中心库', finishedAt: 2 }) }
        : undefined
    ));
    const result = await runOp(workspaceDbCleanup);
    expect(result.code).toBe(1);
    expect(result.err).toContain('清理失败：中心库已无该工作区数据');
    expect(result.err).toContain('请先执行 revert');
  });

  it('缺 --workspace：commander 报必填项，退出码 1、不发请求', async () => {
    const result = await run(['workspace-db', 'cleanup']);
    expect(result.code).toBe(1);
    expect(result.err).toContain('--workspace');
    expect(calls).toHaveLength(0);
  });
});

describe('kb workspace-db revert', () => {
  it('按四阶段中文进度轮询，终态打印反向拷贝计数与 backup 路径', async () => {
    handler = withWorkspaces((method, url) => {
      if (method === 'POST' && url === REVERT_PATH) return { status: 202, body: opJob() };
      if (method === 'GET' && url === `${LOCALIZE_PATH}/revert-ab12cd34`) {
        const seen = calls.filter(call => call.method === 'GET' && call.url.startsWith(LOCALIZE_PATH)).length;
        if (seen === 1) return { status: 200, body: opJob({ stage: 'copy_attachments_back' }) };
        if (seen === 2) return { status: 200, body: opJob({ stage: 'copy_back' }) };
        return {
          status: 200,
          body: opJob({
            status: 'done',
            stage: 'finalize',
            result: 'reverted',
            counts: { workspace_status: 5, issue: 2, issue_comment: 4, issue_dependency: 0, session: 1, message: 10, attachment: 1, removed_center_backups: 2 },
            backupPath: 'D:/ws/localize/.agentboard/backup/agentboard.db-reverted-2026',
            finishedAt: 3,
          }),
        };
      }
      return undefined;
    });
    const result = await runOp(workspaceDbRevert);
    expect(result.code).toBe(0);
    expect(calls[1]).toEqual({ method: 'POST', url: REVERT_PATH, body: {} });
    expect(result.out).toContain('回迁已受理（jobId revert-ab12cd34）');
    expect(result.out).toContain('回迁进行中 [2/4] 回拷附件（copy_attachments_back）');
    expect(result.out).toContain('回迁进行中 [3/4] 回拷数据（copy_back）');
    expect(result.out.indexOf('回拷附件')).toBeLessThan(result.out.indexOf('回拷数据'));
    expect(result.out).toContain('回迁完成');
    expect(result.out).toContain('反向拷贝行数合计：23（卡 2、评论 4、会话 1、消息 10）');
    // STORE-4e 快照生命周期：回迁收尾一并清理前向迁移快照，CLI 透出数量
    expect(result.out).toContain('已清理迁移前中心库快照 2 份');
    expect(result.out).toContain('工作区库已移入 .agentboard/backup/：D:/ws/localize/.agentboard/backup/agentboard.db-reverted-2026');
  });

  it('回迁被拒（中心库已有该区数据）：lastError 原文、退出码 1', async () => {
    handler = withWorkspaces((method, url) => {
      if (method === 'POST' && url === REVERT_PATH) return { status: 202, body: opJob() };
      if (method === 'GET' && url === `${LOCALIZE_PATH}/revert-ab12cd34`) {
        return { status: 200, body: opJob({ status: 'failed', stage: null, lastError: '中心库已存在该工作区数据，无法安全回迁；请先处理分叉（核对 snapshotLagRows 后删除或归档中心侧行）：3 行', finishedAt: 2 }) };
      }
      return undefined;
    });
    const result = await runOp(workspaceDbRevert);
    expect(result.code).toBe(1);
    expect(result.err).toContain('回迁失败：中心库已存在该工作区数据');
    expect(result.err).toContain('kb workspace-db status --workspace ws1');
  });

  it('POST 409（已有任务在跑）：原样透出、退出码 2', async () => {
    handler = withWorkspaces((method, url) => (
      method === 'POST' && url === REVERT_PATH
        ? { status: 409, body: { error: { code: 'MIGRATION_BUSY', message: '已有迁移在进行中（同一时间只允许一个）：本进程已有任务 loc-1（localize）在跑' } } }
        : undefined
    ));
    const result = await run(['workspace-db', 'revert', '--workspace', '下沉空间']);
    expect(result.code).toBe(2);
    expect(result.err).toContain('本进程已有任务 loc-1（localize）在跑');
    expect(result.err).not.toContain('已被占用（');
  });
});
