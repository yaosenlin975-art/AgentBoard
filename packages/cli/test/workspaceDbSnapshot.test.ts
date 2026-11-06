/**
 * STORE-5：`kb workspace-db snapshot export|validate|import` 的 HTTP 契约与输出。
 * 真本地 mock HTTP（不 mock fetch），三命令都经 main() 真实装配。
 */
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { main } from '../src/index.js';

interface Recorded { method: string; url: string; body: unknown }
type MockReply = { status: number; body?: unknown } | undefined;
type Handler = (method: string, url: string, body: unknown) => MockReply;

const WS = { id: 'ws1', name: '快照空间', path: 'D:/ws/localize', created_at: 1 };
const BASE = '/api/workspaces/ws1/db/snapshot';
const MANIFEST = {
  format: 'agentboard.workspace-snapshot/1',
  workspace_id: 'ws1',
  schema_version: 1,
  exported_at: '2026-11-06T12:00:00.000Z',
  generator_version: 'agentboard-server/1',
  source_db: 'D:/ws/localize/.agentboard/agentboard.db',
  included_tables: ['issue', 'issue_comment'],
  files: [
    { file: 'issues', table: 'issue', rows: 3, sha256: 'a'.repeat(64) },
    { file: 'issue_comments', table: 'issue_comment', rows: 0, sha256: 'b'.repeat(64) },
  ],
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
        res.end(JSON.stringify({ error: { code: 'NOT_FOUND', message: 'mock 未匹配 ' + req.url } }));
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
  const out: string[] = []; const err: string[] = [];
  return { io: { write: (s: string) => { out.push(s); }, writeErr: (s: string) => { err.push(s); }, readStdin: async () => '' }, out: () => out.join(''), err: () => err.join('') };
}
const withWorkspaces = (inner: Handler): Handler => (method, url, body) => (
  method === 'GET' && url === '/api/workspaces' ? { status: 200, body: [WS] } : inner(method, url, body)
);
const run = async (args: string[]) => {
  const t = makeIo();
  const code = await main(['node', 'kb', '--server', base, ...args], t.io);
  return { code, out: t.out(), err: t.err() };
};

describe('STORE-5：kb workspace-db snapshot', () => {
  it('export 默认不含消息，输出目录与行数摘要', async () => {
    handler = withWorkspaces((m, u) => (
      m === 'POST' && u === `${BASE}/export` ? { status: 200, body: { dir: 'D:/ws/localize/.agentboard/snapshot', manifest: MANIFEST } } : undefined
    ));
    const result = await run(['workspace-db', 'snapshot', 'export', 'ws1']);
    expect(result.code).toBe(0);
    expect(result.out).toContain('快照已导出：D:/ws/localize/.agentboard/snapshot');
    expect(result.out).toContain('行数合计：3（issue 3）');
    expect(result.out).toContain('未包含：消息');
    expect(calls.find(c => c.method === 'POST')?.body).toEqual({});
  });

  it('export --include-messages 透传开关，且不再提示未包含消息', async () => {
    const withMessages = { ...MANIFEST, included_tables: [...MANIFEST.included_tables, 'message'] };
    handler = withWorkspaces((m, u) => (
      m === 'POST' && u === `${BASE}/export` ? { status: 200, body: { dir: 'D:/snap', manifest: withMessages } } : undefined
    ));
    const result = await run(['workspace-db', 'snapshot', 'export', 'ws1', '--include-messages']);
    expect(result.code).toBe(0);
    expect(calls.find(c => c.method === 'POST')?.body).toEqual({ includeMessages: true });
    expect(result.out).not.toContain('未包含：消息');
  });

  it('validate 默认目录与 --file 目录都走 query 参数，输出校验通过', async () => {
    handler = withWorkspaces((m, u) => (
      m === 'GET' && u === `${BASE}/validate` ? { status: 200, body: { ok: true, dir: 'D:/ws/localize/.agentboard/snapshot', manifest: MANIFEST, tables: [{ table: 'issue', rows: 3 }, { table: 'issue_comment', rows: 0 }] } } : undefined
    ));
    const first = await run(['workspace-db', 'snapshot', 'validate', 'ws1']);
    expect(first.code).toBe(0);
    expect(first.out).toContain('快照校验通过');
    expect(first.out).toContain('文件：2 个，行数合计：3（issue 3）');

    calls = [];
    handler = withWorkspaces((m, u) => (
      m === 'GET' && u === `${BASE}/validate?dir=.agentboard%2Fclone-snapshot`
        ? { status: 200, body: { ok: true, dir: 'D:/ws/localize/.agentboard/clone-snapshot', manifest: MANIFEST, tables: [{ table: 'issue', rows: 3 }] } }
        : undefined
    ));
    const second = await run(['workspace-db', 'snapshot', 'validate', 'ws1', '--file', '.agentboard/clone-snapshot']);
    expect(second.code).toBe(0);
    expect(calls).toHaveLength(2);
  });

  it('validate 遇到坏快照：exit 1，stderr 保留「快照不可导入」原因', async () => {
    handler = withWorkspaces((m, u) => (
      m === 'GET' && u === `${BASE}/validate`
        ? { status: 422, body: { error: { code: 'SNAPSHOT_INVALID', message: '快照不可导入：issues.jsonl 哈希不符' } } }
        : undefined
    ));
    const result = await run(['workspace-db', 'snapshot', 'validate', 'ws1']);
    expect(result.code).toBe(1);
    expect(result.err).toContain('快照不可导入：issues.jsonl 哈希不符');
  });

  it('import 默认空库导入；--file + --replace 透传参数并显示备份路径', async () => {
    handler = withWorkspaces((m, u) => (
      m === 'POST' && u === `${BASE}/import`
        ? { status: 200, body: { dir: 'D:/snap', tables: [{ table: 'issue', rows: 3 }], rows: 3, backupPath: null } }
        : undefined
    ));
    const first = await run(['workspace-db', 'snapshot', 'import', 'ws1']);
    expect(first.code).toBe(0);
    expect(first.out).toContain('导入行数：3（表 1 个：issue 3）');
    expect(calls.find(c => c.method === 'POST')?.body).toEqual({});

    calls = [];
    handler = withWorkspaces((m, u) => (
      m === 'POST' && u === `${BASE}/import`
        ? { status: 200, body: { dir: 'D:/snap', tables: [{ table: 'issue', rows: 3 }], rows: 3, backupPath: 'D:/ws/.agentboard/backup/snapshot-import-1.db' } }
        : undefined
    ));
    const second = await run(['workspace-db', 'snapshot', 'import', 'ws1', '--file', 'snap', '--replace']);
    expect(second.code).toBe(0);
    expect(calls.find(c => c.method === 'POST')?.body).toEqual({ dir: 'snap', replace: true });
    expect(second.out).toContain('覆盖前备份：D:/ws/.agentboard/backup/snapshot-import-1.db');
  });

  it('export --include-attachments 透传开关并显示附件清单摘要', async () => {
    const withAttachments = {
      ...MANIFEST,
      included_tables: [...MANIFEST.included_tables, 'attachment'],
      attachments: [{ storage_key: 'att-1.png', file: 'attachments/att-1.png', bytes: 16, sha256: 'c'.repeat(64) }],
    };
    handler = withWorkspaces((m, u) => (
      m === 'POST' && u === `${BASE}/export` ? { status: 200, body: { dir: 'D:/snap', manifest: withAttachments } } : undefined
    ));
    const result = await run(['workspace-db', 'snapshot', 'export', 'ws1', '--include-attachments']);
    expect(result.code).toBe(0);
    expect(calls.find(c => c.method === 'POST')?.body).toEqual({ includeAttachments: true });
    expect(result.out).toContain('附件：1 个文件，16 字节');
  });

  it('导出遇 409（如迁移中）→ exit 2 并保留服务端原因', async () => {
    handler = withWorkspaces((m, u) => (
      m === 'POST' && u === `${BASE}/export`
        ? { status: 409, body: { error: { code: 'SNAPSHOT_MIGRATING', message: '工作区库迁移进行中，暂不导出快照' } } }
        : undefined
    ));
    const result = await run(['workspace-db', 'snapshot', 'export', 'ws1']);
    expect(result.code).toBe(2);
    expect(result.err).toContain('迁移进行中');
  });

  it('center-export / center-validate：不解析工作区，走 /api/system/center-snapshot/*', async () => {
    const centerManifest = {
      format: 'agentboard.center-snapshot/1',
      scope: 'center',
      schema_version: 1,
      exported_at: '2026-11-06T12:00:00.000Z',
      generator_version: 'agentboard-server/1',
      source_db: 'C:/AppData/AgentBoard/agentboard.db',
      included_tables: ['workspace', 'managed_account'],
      files: [
        { file: 'workspaces', table: 'workspace', rows: 2, sha256: 'a'.repeat(64) },
        { file: 'managed_accounts', table: 'managed_account', rows: 1, sha256: 'b'.repeat(64) },
      ],
    };
    handler = (m, u) => {
      if (m === 'POST' && u === '/api/system/center-snapshot/export') {
        return { status: 200, body: { dir: 'C:/AppData/AgentBoard/center-snapshot', manifest: centerManifest } };
      }
      if (m === 'GET' && u === '/api/system/center-snapshot/validate') {
        return { status: 200, body: { ok: true, dir: 'C:/AppData/AgentBoard/center-snapshot', manifest: centerManifest, tables: [{ table: 'workspace', rows: 2 }] } };
      }
      return undefined;
    };

    const exported = await run(['workspace-db', 'snapshot', 'center-export']);
    expect(exported.code).toBe(0);
    expect(exported.out).toContain('中心库快照已导出');
    expect(exported.out).toContain('脱敏为 ***');
    expect(calls.some(call => call.url === '/api/workspaces')).toBe(false);

    const validated = await run(['workspace-db', 'snapshot', 'center-validate']);
    expect(validated.code).toBe(0);
    expect(validated.out).toContain('中心库快照校验通过');
  });
});
