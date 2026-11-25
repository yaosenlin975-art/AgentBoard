import { execFile } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, rmSync, statSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createIssue, updateIssue } from '../src/db/repos/issue.js';
import { createWorkspace } from '../src/db/repos/workspace.js';
import { createApp } from '../src/index.js';
import { resetSessionManager } from '../src/services/sessionManager.js';
import { createTestDb, type TestDb } from './helpers.js';

const repo = fileURLToPath(new URL('../../../', import.meta.url));
const run = promisify(execFile);
const reads: { url: URL; bytes: number }[] = [];
let db: TestDb;
let server: Server;
let cwd: string;
let base: string;
let workspace: string;
let parent: string;
let planned: string;
let started: string;

async function cli(args: string[], json = true): Promise<string> {
  reads.length = 0;
  const { stdout } = await run(process.execPath, [
    join(repo, 'packages/cli/dist/index.js'), '--server', base, ...(json ? ['--json'] : []), ...args,
  ], { cwd, windowsHide: true, timeout: 20_000 });
  return stdout;
}

function listRead(): { url: URL; bytes: number } {
  const matches = reads.filter(read => read.url.pathname === '/api/issues');
  expect(matches).toHaveLength(1);
  return matches[0]!;
}

function sourcesChanged(dir: string, builtAt: number): boolean {
  return readdirSync(dir, { withFileTypes: true }).some(entry => {
    const path = join(dir, entry.name);
    return entry.isDirectory() ? sourcesChanged(path, builtAt) : statSync(path).mtimeMs > builtAt;
  });
}

beforeAll(async () => {
  const tsc = join(repo, 'packages/cli/node_modules/typescript/bin/tsc');
  for (const packageName of ['shared', 'cli']) {
    const path = join(repo, 'packages', packageName);
    const entry = join(path, 'dist/index.js');
    const builtAt = existsSync(entry) ? statSync(entry).mtimeMs : 0;
    if (sourcesChanged(join(path, 'src'), builtAt)) {
      await run(process.execPath, [tsc, '-p', join(path, 'tsconfig.build.json')], { windowsHide: true });
    }
  }
  db = createTestDb();
  cwd = mkdtempSync(join(tmpdir(), 'agentboard-fetch-convergence-'));
  workspace = createWorkspace(db.db, { name: 'fetch-convergence', path: cwd }).id;
  const add = (title: string, options: Partial<Parameters<typeof createIssue>[1]> = {}) =>
    createIssue(db.db, { workspace_id: workspace, title, ...options }).id;
  parent = add('父任务', { status: '待验收' });
  planned = add('待规划子任务', { parent_issue_id: parent });
  const closed = add('已关闭子任务', { parent_issue_id: parent });
  updateIssue(db.db, closed, { status: '已关闭' });
  started = add('进行中孙任务', { parent_issue_id: closed });
  updateIssue(db.db, started, { status: '进行中' });
  for (let index = 0; index < 48; index++) {
    const archived = add(`历史任务 ${index}`, { description: 'x'.repeat(2_000) });
    updateIssue(db.db, archived, { status: '已关闭' });
  }
  const { app } = await createApp({ db: db.db, adapters: [], refreshClisOnBoot: false });
  server = createServer((req, res) => {
    if (req.method === 'GET' && req.url !== undefined) {
      const url = new URL(req.url, 'http://127.0.0.1');
      res.once('finish', () => reads.push({ url, bytes: Number(res.getHeader('content-length')) }));
    }
    app(req, res);
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}, 60_000);

afterAll(async () => {
  if (server) await new Promise<void>(resolve => server.close(() => resolve()));
  resetSessionManager();
  db?.cleanup();
  if (cwd) rmSync(cwd, { recursive: true, force: true });
});

describe('CLI 取数收敛的真实 HTTP 回归', () => {
  it('平铺状态过滤只传命中行，树仍保留跨状态祖先', async () => {
    const flat = await cli(['list-tasks', '--status', '待规划']);
    expect(Buffer.byteLength(flat)).toBeLessThanOrEqual(4_000);
    expect(JSON.parse(flat).items.map((item: { id: string }) => item.id)).toEqual([planned]);
    const filtered = listRead();
    expect(filtered.bytes).toBeGreaterThan(0);
    expect(filtered.bytes).toBeLessThanOrEqual(2_000);
    expect(filtered.url.searchParams.get('status')).toBe('待规划');
    expect(filtered.url.searchParams.get('format')).toBe('compact');

    const all = await fetch(`${base}/api/issues?workspace=${workspace}&fields=id`);
    expect(await all.json()).toHaveLength(52);
    const tree = JSON.parse(await cli(['list-tasks', '--tree', '--status', '待规划']));
    expect(tree.items.map(({ id, tree_depth, tree_context }: {
      id: string; tree_depth: number; tree_context: boolean;
    }) => [id, tree_depth, tree_context])).toEqual([[parent, 0, true], [planned, 1, false]]);
  });

  it('派发列表使用字段投影且保留续做顺序', async () => {
    const result = JSON.parse(await cli(['next']));
    expect(result.items.map(({ id, status }: { id: string; status: string }) => [id, status])).toEqual([
      [started, '进行中'], [planned, '待规划'],
    ]);
    const query = listRead();
    expect(query.url.searchParams.get('fields')?.split(',').sort()).toEqual([
      'claimed_by', 'id', 'labels', 'parent_issue_id', 'priority', 'status', 'title',
    ]);
    expect(query.bytes).toBeLessThanOrEqual(20_000);
  });

  it('统计读取 counts，父卡进度只读取未完成任务投影', async () => {
    const stats = JSON.parse(await cli(['stats']));
    expect(reads.some(read => read.url.pathname === '/api/issues/counts')).toBe(true);
    expect(stats.statuses).toEqual({ 待规划: 1, 进行中: 1, 待验收: 1, 已关闭: 49, 已废弃: 0 });
    expect(stats.total).toBe(52);
    expect(listRead().bytes).toBeLessThanOrEqual(10_000);
    for (const [status, count] of Object.entries(stats.statuses)) {
      const result = JSON.parse(await cli(['list-tasks', '--status', status]));
      expect(result.items).toHaveLength(count as number);
    }
    expect(await cli(['show', parent], false)).toContain('1/2 已完成（进行中 0，待验收 0，待规划 1）');
    const query = listRead();
    expect(query.url.searchParams.get('fields')).toBe('id,status,parent_issue_id');
    expect(query.bytes).toBeLessThanOrEqual(12_000);
  });
});
