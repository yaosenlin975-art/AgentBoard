/**
 * ARCH-07：CLI 黑盒 e2e —— 真 createApp + 临时 DB + 真 `kb` 子进程。
 *
 * 目的：给「命令输出形状」这类契约变化补单测覆盖不到的一层。
 * 只通过 stdout / stderr / 退出码断言，不 import CLI 内部函数、不查内部实现。
 *
 * 隔离：
 * - 服务端用 createTestDb() 的临时 SQLite 文件（WAL），随机端口 listen(0)，绝不碰 8787 / 真实库；
 * - 工作区目录、子进程 cwd（claim fence 落 `.agentboard/claims/`）都在临时目录，afterAll 整棵删除；
 * - 子进程显式 `--server <随机端口>`，去掉继承的 KB_SERVER / KB_METRICS。
 *
 * dist 新鲜度：CLI 子进程跑 packages/cli/dist/index.js。src 比 dist 新时先就地 tsc 构建，
 * 避免「测试跑的是旧产物」造成假绿（演练旧行为时必须真变红）。
 */
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, rmSync, statSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDb, type TestDb } from './helpers.js';
import { createApp } from '../src/index.js';
import { resetSessionManager } from '../src/services/sessionManager.js';

const testDir = fileURLToPath(new URL('.', import.meta.url));
const repoRoot = resolve(testDir, '../../..');
const cliDir = resolve(repoRoot, 'packages/cli');
const sharedDir = resolve(repoRoot, 'packages/shared');
const cliEntry = join(cliDir, 'dist', 'index.js');

/** 目录内最新 mtime（递归）；目录不存在返回 0 */
function newestMtime(dir: string): number {
  if (!existsSync(dir)) return 0;
  let newest = 0;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    newest = Math.max(newest, entry.isDirectory() ? newestMtime(full) : statSync(full).mtimeMs);
  }
  return newest;
}

function tscBin(): string {
  const candidates = [
    join(cliDir, 'node_modules', 'typescript', 'bin', 'tsc'),
    join(repoRoot, 'node_modules', 'typescript', 'bin', 'tsc'),
  ];
  const found = candidates.find(candidate => existsSync(candidate));
  if (found === undefined) throw new Error('找不到 typescript 编译器（tsc），无法构建 CLI e2e 依赖的 dist');
  return found;
}

function buildPackage(dir: string): void {
  execFileSync(process.execPath, [tscBin(), '-p', join(dir, 'tsconfig.build.json')], {
    cwd: dir,
    stdio: 'pipe',
    windowsHide: true,
  });
}

/** dist 缺产物或落后于 src 就先构建（shared 是 CLI 运行期依赖，同样按 mtime 判定） */
function ensureCliBuilt(): void {
  if (newestMtime(join(sharedDir, 'src')) > newestMtime(join(sharedDir, 'dist'))) buildPackage(sharedDir);
  if (!existsSync(cliEntry) || newestMtime(join(cliDir, 'src')) > statSync(cliEntry).mtimeMs) buildPackage(cliDir);
}

interface ListEnvelope {
  items: Array<Record<string, unknown>>;
  next_offset: number | null;
}

interface CliRun {
  code: number | null;
  stdout: string;
  stderr: string;
}

let t: TestDb;
let server: Server;
let base = '';
let spaceDir = '';
let wsId = '';
/** 夹具卡 id（beforeAll 一次建好） */
interface FixtureIds {
  open: string;
  started: string;
  review: string;
  blocked: string;
  claimed: string;
  closed: string;
}
const ids: FixtureIds = { open: '', started: '', review: '', blocked: '', claimed: '', closed: '' };

const BLOCKED_STATUS = '等待外部';

async function apiCall<T>(method: string, path: string, body?: unknown): Promise<T> {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: body === undefined ? undefined : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`${method} ${path} → ${response.status} ${text}`);
  return (text === '' ? undefined : JSON.parse(text)) as T;
}

async function mkIssue(title: string, patch: Record<string, unknown> = {}): Promise<string> {
  const issue = await apiCall<{ id: string }>('POST', '/api/issues', {
    workspace_id: wsId,
    title,
    description: `${title}：CLI e2e 夹具`,
  });
  if (Object.keys(patch).length > 0) await apiCall('PATCH', `/api/issues/${issue.id}`, patch);
  return issue.id;
}

/** 跑真实 kb 子进程：全局选项在子命令前；cwd 指临时工作区，fence 不落仓库 */
function runCli(args: string[], stdin = ''): Promise<CliRun> {
  return new Promise((resolveRun, rejectRun) => {
    const env: NodeJS.ProcessEnv = { ...process.env, KB_AGENT: 'cli-e2e-agent' };
    delete env.KB_SERVER;
    delete env.KB_METRICS;
    const child = spawn(process.execPath, [cliEntry, '--server', base, ...args], {
      cwd: spaceDir,
      env,
      windowsHide: true,
    });
    let stdout = '';
    let stderr = '';
    child.stdout!.setEncoding('utf8');
    child.stderr!.setEncoding('utf8');
    child.stdout!.on('data', (chunk: string) => { stdout += chunk; });
    child.stderr!.on('data', (chunk: string) => { stderr += chunk; });
    const timer = setTimeout(() => {
      child.kill();
      rejectRun(new Error(`kb 子进程超时 60s：${args.join(' ')}`));
    }, 60_000);
    child.on('error', (error) => { clearTimeout(timer); rejectRun(error); });
    child.on('close', (code) => { clearTimeout(timer); resolveRun({ code, stdout, stderr }); });
    child.stdin!.end(stdin);
  });
}

async function listJson(args: string[]): Promise<ListEnvelope> {
  const result = await runCli(['--json', 'list-tasks', '--workspace', wsId, ...args]);
  expect(result.stderr).not.toContain('Error');
  expect(result.code).toBe(0);
  return JSON.parse(result.stdout) as ListEnvelope;
}

beforeAll(async () => {
  ensureCliBuilt();
  t = createTestDb();
  spaceDir = mkdtempSync(join(tmpdir(), 'agentboard-cli-e2e-space-'));
  const created = await createApp({
    db: t.db,
    // CLI e2e 不碰会话/派发，适配器一律不注入
    getAdapter: () => { throw new Error('CLI e2e 不注入适配器'); },
    adapters: [],
    refreshClisOnBoot: false,
  });
  server = createServer(created.app);
  await new Promise<void>((resolveListen) => server.listen(0, '127.0.0.1', resolveListen));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  wsId = (await apiCall<{ id: string }>('POST', '/api/workspaces', { name: 'cli-e2e', path: spaceDir })).id;
  await apiCall('POST', `/api/workspaces/${wsId}/statuses`, { name: BLOCKED_STATUS, kind: 'blocked' });

  ids.open = await mkIssue('e2e 待规划无主');
  ids.started = await mkIssue('e2e 进行中无主', { status: '进行中' });
  ids.review = await mkIssue('e2e 待验收无主', { status: '待验收' });
  ids.blocked = await mkIssue('e2e 阻塞无主', { status: BLOCKED_STATUS });
  ids.claimed = await mkIssue('e2e 已占用卡');
  await apiCall('POST', `/api/issues/${ids.claimed}/claim`, { agent_id: 'other-agent', knowledge_enabled: false });
  ids.closed = await mkIssue('e2e 已关闭卡', { status: '已关闭' });

  // show 评论窗口夹具：7 条评论，默认只渲染最近 5 条
  for (let index = 1; index <= 7; index += 1) {
    await apiCall('POST', `/api/issues/${ids.open}/comments`, { content: `评论 ${index}`, agent_id: 'e2e-seed' });
  }
}, 180_000);

afterAll(async () => {
  if (server !== undefined) await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
  resetSessionManager();
  t?.cleanup();
  if (spaceDir !== '') rmSync(spaceDir, { recursive: true, force: true });
});

describe('kb 黑盒 e2e', () => {
  it('list-tasks 默认口径 = open/started/review/blocked + 无主；--all-status 保留全量', async () => {
    const converged = await listJson([]);
    expect(converged.items.map(item => item.id).sort()).toEqual(
      [ids.open, ids.started, ids.review, ids.blocked].sort(),
    );
    // 占用中的卡（unclaimed=1）与关闭类状态都不在默认口径里
    expect(converged.items.some(item => item.id === ids.claimed)).toBe(false);
    expect(converged.items.some(item => item.id === ids.closed)).toBe(false);

    const convergedText = await runCli(['list-tasks', '--workspace', wsId]);
    expect(convergedText.code).toBe(0);
    expect(convergedText.stderr).toContain('默认已收敛为未完成无主卡，全量用 --all-status');

    const all = await listJson(['--all-status']);
    expect(all.items.map(item => item.id).sort()).toEqual(Object.values(ids).sort());
  });

  it('show 默认只渲染最近 5 条评论，--comments all 输出全量', async () => {
    const limited = await runCli(['show', ids.open]);
    expect(limited.code).toBe(0);
    expect(limited.stdout).toContain('评论（5/7）:');
    expect(limited.stdout).toContain('另有 2 条，--comments all 查看');
    expect(limited.stdout).not.toContain('评论 2\n');

    const full = await runCli(['show', ids.open, '--comments', 'all']);
    expect(full.code).toBe(0);
    expect(full.stdout).toContain('评论（7）:');
    expect(full.stdout).not.toContain('另有');
    expect(full.stdout).toContain('评论 1');
    expect(full.stdout).toContain('评论 7');
  });

  it('next 输出 NextItem 形状的可派卡字段', async () => {
    const result = await runCli(['--json', 'next', '--workspace', wsId]);
    expect(result.code).toBe(0);
    const items = (JSON.parse(result.stdout) as ListEnvelope).items;
    // 只有「待规划 + 无主」的卡可派；进行中 / 待验收 / 阻塞 / 已占用 / 已关闭都不出现
    expect(items.map(item => item.id)).toEqual([ids.open]);
    expect(Object.keys(items[0]!).sort()).toEqual([
      'blockers', 'blocks', 'id', 'labels', 'parent_issue_id', 'priority', 'siblings_by_label', 'status', 'title',
    ]);
    expect(items[0]!.status).toBe('待规划');
    expect(items[0]!.parent_issue_id).toBeNull();
    expect(Array.isArray(items[0]!.blockers)).toBe(true);
    expect(Array.isArray(items[0]!.blocks)).toBe(true);
    expect(Array.isArray(items[0]!.siblings_by_label)).toBe(true);
  });

  it('stats 逐状态计数与 list-tasks --status 一致', async () => {
    const statsResult = await runCli(['--json', 'stats', '--workspace', wsId]);
    expect(statsResult.code).toBe(0);
    const stats = JSON.parse(statsResult.stdout) as {
      workspace_id: string;
      generated_at: string;
      statuses: Record<string, number>;
      unclaimed_open: number;
      blocked_open: number;
      total: number;
    };
    expect(stats.workspace_id).toBe(wsId);
    expect(stats.generated_at).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}[+-]\d{2}:\d{2}$/);
    expect(Object.keys(stats.statuses).sort()).toEqual(['待规划', '进行中', '待验收', '已关闭', '已废弃'].sort());

    // total 与整区全量列表同源对账（自定义状态也计入 total，但不进五状态计数）
    const all = await listJson(['--all-status']);
    expect(stats.total).toBe(all.items.length);

    for (const status of ['待规划', '进行中', '待验收', '已关闭', '已废弃'] as const) {
      const byStatus = await listJson(['--status', status]);
      expect(byStatus.items.length, `状态「${status}」计数应与 list-tasks 一致`).toBe(stats.statuses[status]);
    }
  });

  it('claim / done 文本输出带 status（进行中 → 待验收）', async () => {
    const issueId = await mkIssue('e2e 待领取卡');

    const claimed = await runCli(['claim', issueId]);
    expect(claimed.code).toBe(0);
    expect(claimed.stdout).toContain('领取成功');
    expect(claimed.stdout).toContain('状态: 进行中');

    const done = await runCli(['done', issueId, '--notes', 'CLI e2e 收尾']);
    expect(done.code).toBe(0);
    expect(done.stdout).toContain('状态: 待验收');
    expect(done.stdout).toContain('占用者: （未占用）');
  });
});
