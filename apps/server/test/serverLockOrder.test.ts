/**
 * CR-1：启动单例锁必须先于 openDb / 迁移 / 租约清扫。
 *
 * 用真实进程（spawn `dist/index.js`）验证两件事：
 * 1. 锁文件已有存活持有者 → 后到进程以退出码 4 退出，且**目标 DB 文件从未被创建**（加锁早于 openDb 的直接证据）；
 * 2. 双进程先后启动 → 先到者 `/api/version` 返回 200，后到者退出码 4。
 *
 * 子进程跑的是构建产物，所以先断言 dist 不旧于 src；产物陈旧时给出可执行提示而不是测旧行为。
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

const serverRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const distEntry = join(serverRoot, 'dist', 'index.js');
const srcEntry = join(serverRoot, 'src', 'index.ts');
const STARTUP_TIMEOUT_MS = 60_000;

const dirs: string[] = [];
const children: ChildProcess[] = [];

afterEach(async () => {
  for (const child of children.splice(0)) {
    if (child.exitCode === null && child.signalCode === null) {
      const exited = new Promise<void>(resolve => child.once('exit', () => resolve()));
      child.kill();
      await exited;
    }
  }
  for (const dir of dirs.splice(0)) {
    try {
      rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
    } catch {
      // Windows 下子进程句柄释放有延迟，临时目录删不掉不影响断言结论
    }
  }
});

/** 子进程跑构建产物：dist 必须不旧于 src，否则测的是旧行为 */
function assertDistFresh(): void {
  expect(existsSync(distEntry), `缺少构建产物 ${distEntry}，先执行 pnpm --filter @agentboard/server build`).toBe(true);
  expect(statSync(distEntry).mtimeMs).toBeGreaterThanOrEqual(statSync(srcEntry).mtimeMs);
}

function tempRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), 'agentboard-lockorder-'));
  dirs.push(dir);
  return dir;
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address();
      const port = typeof address === 'object' && address !== null ? address.port : 0;
      probe.close(() => resolve(port));
    });
  });
}

interface ChildEnv extends NodeJS.ProcessEnv {
  APPDATA: string;
  AGENTBOARD_DB: string;
  AGENTBOARD_PORT: string;
  AGENTBOARD_LOG: string;
}

/** 完全隔离的运行环境：临时 APPDATA（configDir/server.lock）+ 独立 DB / 端口 / 日志 */
function childEnv(root: string, port: number): ChildEnv {
  return {
    ...process.env,
    APPDATA: root,
    AGENTBOARD_DB: join(root, 'AgentBoard', 'agentboard.db'),
    AGENTBOARD_PORT: String(port),
    AGENTBOARD_LOG: join(root, 'server.log'),
  };
}

type StreamSink = (chunk: string, stream: 'stdout' | 'stderr') => void;

function startServer(env: ChildEnv, root: string, sink?: StreamSink): ChildProcess {
  const child = spawn(process.execPath, [distEntry], { env, cwd: root, stdio: ['ignore', 'pipe', 'pipe'] });
  children.push(child);
  if (sink !== undefined) {
    child.stdout?.on('data', chunk => sink(String(chunk), 'stdout'));
    child.stderr?.on('data', chunk => sink(String(chunk), 'stderr'));
  } else {
    // 必须持续排空管道：并行跑全量测试时子进程日志量不小，管道缓冲写满会把服务本身卡死（表现为后续 fetch failed）
    child.stdout?.resume();
    child.stderr?.resume();
  }
  return child;
}

function runToExit(env: ChildEnv, root: string): Promise<{ code: number | null; stdout: string; stderr: string }> {
  let stdout = '';
  let stderr = '';
  const child = startServer(env, root, (chunk, stream) => {
    if (stream === 'stdout') stdout += chunk;
    else stderr += chunk;
  });
  return new Promise(resolve => child.once('exit', code => resolve({ code, stdout, stderr })));
}

async function waitHealthy(port: number, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/api/version`);
      if (response.ok) return;
    } catch {
      // 还没监听，继续等
    }
    await new Promise(resolve => setTimeout(resolve, 200));
  }
  throw new Error(`服务未在 ${timeoutMs}ms 内就绪（端口 ${port}）`);
}

describe('启动单例锁顺序（CR-1）', () => {
  it('已被存活实例持锁时：后到进程 exit 4，且不创建数据库、不建附件目录', async () => {
    assertDistFresh();
    const root = tempRoot();
    const port = await freePort();
    const env = childEnv(root, port);
    const configDir = join(root, 'AgentBoard');
    mkdirSync(configDir, { recursive: true });
    // 持有者 pid 用当前测试进程（存活）→ 后到进程必须被拒绝，而不是接管
    writeFileSync(join(configDir, 'server.lock'), JSON.stringify({
      pid: process.pid,
      port,
      dbPath: env.AGENTBOARD_DB,
      startedAt: Date.now(),
      instanceId: 'test-live-holder',
    }), 'utf8');

    const result = await runToExit(env, root);

    expect(result.code, `stderr: ${result.stderr}`).toBe(4);
    expect(result.stderr).toContain('拒绝启动');
    // 加锁早于 openDb / attachments 目录创建的硬证据
    expect(existsSync(env.AGENTBOARD_DB)).toBe(false);
    expect(existsSync(join(configDir, 'attachments'))).toBe(false);
  }, STARTUP_TIMEOUT_MS);

  it('双进程启动：先到者 /api/version 200，后到者 exit 4', async () => {
    assertDistFresh();
    const root = tempRoot();
    const port = await freePort();
    const env = childEnv(root, port);
    startServer(env, root);
    await waitHealthy(port, STARTUP_TIMEOUT_MS);

    const second = await runToExit(env, root);

    expect(second.code, `stderr: ${second.stderr}`).toBe(4);
    expect(second.stderr).toContain('拒绝启动');
    const version = await fetch(`http://127.0.0.1:${port}/api/version`);
    expect(version.status).toBe(200);
  }, STARTUP_TIMEOUT_MS);
});
