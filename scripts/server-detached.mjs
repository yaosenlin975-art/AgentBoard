#!/usr/bin/env node
/**
 * 看板服务（默认 8787）幂等启动：先探活 `/api/version`，活着就复用；死了才后台拉起并轮询到健康。
 *
 * 为什么需要：此前重启靠手工「Stop-Process <pid> → start /b node apps\server\dist\index.js」，
 * 每一步都能留下「没人监听」的空窗（停止成功但启动失败、cwd 不对、少一层 dist），
 * 而且没有任何 stdout/stderr 落盘，事后无法归因。本脚本让重启变成幂等操作：
 *  - 端口上已是健康的看板服务 → 直接复用，**不重启进程**（pid 不变），exit 0；
 *  - 端口被别的东西占着（探活不是 agentboard-server）→ 明确报错，不杀任何进程，exit 2；
 *  - 未监听 → 后台拉起 `apps/server/dist/index.js`，轮询到健康（默认 ≤30s），失败 exit 1；
 *  - 全程日志落 `.logs/server.log`（追加），下次服务静默退出至少有迹可循。
 *
 * 用法：node scripts/server-detached.mjs [--port 8787] [--timeout 30000]
 *      pnpm server:ensure
 * 退出码：0 健康（复用或新起） / 1 拉起后仍不健康或子进程提前退出 / 2 端口被非看板服务占用 / 3 dist 缺失
 */
import { spawn } from 'node:child_process';
import { mkdirSync, openSync, closeSync, existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const ENTRY = join(ROOT, 'apps', 'server', 'dist', 'index.js');
const LOG_DIR = join(ROOT, '.logs');
const LOG_FILE = join(LOG_DIR, 'server.log');
const DEFAULT_PORT = 8787;
const DEFAULT_TIMEOUT_MS = 30_000;

function parseArgs(argv) {
  const out = { port: Number(process.env.AGENTBOARD_PORT ?? DEFAULT_PORT), timeoutMs: DEFAULT_TIMEOUT_MS };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--port') {
      out.port = Number(argv[i + 1]);
      i += 1;
    } else if (arg.startsWith('--port=')) {
      out.port = Number(arg.slice('--port='.length));
    } else if (arg === '--timeout') {
      out.timeoutMs = Number(argv[i + 1]);
      i += 1;
    } else if (arg.startsWith('--timeout=')) {
      out.timeoutMs = Number(arg.slice('--timeout='.length));
    }
  }
  if (!Number.isInteger(out.port) || out.port <= 0 || out.port > 65535) throw new Error(`端口不合法：${out.port}`);
  if (!Number.isFinite(out.timeoutMs) || out.timeoutMs <= 0) throw new Error(`超时不合法：${out.timeoutMs}`);
  return out;
}

const versionUrl = (port) => `http://127.0.0.1:${port}/api/version`;

/**
 * 探活：只有拿到 `{ name: 'agentboard-server' }` 才算本服务健康。
 * 返回 { ok: true, version } / { ok: false, status, reason }（端口有响应但不是看板）/ null（连不上）。
 */
async function probe(port, timeoutMs = 2000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(versionUrl(port), { signal: controller.signal });
    const text = await res.text();
    if (!res.ok) return { ok: false, status: res.status, reason: `HTTP ${res.status}` };
    let body;
    try {
      body = JSON.parse(text);
    } catch {
      return { ok: false, status: res.status, reason: '响应不是 JSON' };
    }
    if (body?.name !== 'agentboard-server') {
      return { ok: false, status: res.status, reason: `不是看板服务（name=${JSON.stringify(body?.name)}）` };
    }
    return { ok: true, version: body.version };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

function readLogTail(lines = 10) {
  if (!existsSync(LOG_FILE)) return '';
  const all = readFileSync(LOG_FILE, 'utf8').trimEnd().split('\n');
  return all.slice(-lines).join('\n');
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * SERVER-SINGLETON：读单例锁（复用 apps/server 的 `serverLock` 实现，不另写一份判定）。
 * 返回 null 表示没有锁 / 读不到（服务未构建等情况按「无锁」处理，不阻断启动）。
 */
async function readLock() {
  try {
    const mod = await import(new URL('../apps/server/dist/services/serverLock.js', import.meta.url).href);
    const configDir = process.env.APPDATA && process.env.APPDATA !== ''
      ? join(process.env.APPDATA, 'AgentBoard')
      : join(homedir(), '.config', 'AgentBoard');
    return { mod, lock: mod.readServerLock(configDir) };
  } catch {
    return null;
  }
}

const { port, timeoutMs } = parseArgs(process.argv.slice(2));

const existing = await probe(port);
if (existing?.ok === true) {
  console.log(`[server] 已在运行，复用：${versionUrl(port)}（version ${existing.version}，未重启进程）`);
  console.log(`[server] 日志：${LOG_FILE}`);
  process.exit(0);
}
if (existing !== null && existing.ok === false) {
  console.error(`[server] 端口 ${port} 有响应但不是看板服务：${existing.reason}。不杀任何进程，请人工确认占用者后换端口或停掉它。`);
  process.exit(2);
}

if (!existsSync(ENTRY)) {
  console.error(`[server] 找不到服务入口：${ENTRY}\n先构建：pnpm --filter @agentboard/server build（或 pnpm -r build）`);
  process.exit(3);
}

// SERVER-SINGLETON：有活着的持有者就**不再 spawn**——等它健康（可能正在启动），或按持有者信息失败
const lockState = await readLock();
if (lockState !== null && lockState.lock !== null) {
  const { mod, lock: holder } = lockState;
  if (mod.isProcessAlive(holder.pid) && holder.port !== port) {
    // 同 configDir/同 DB 想再起一个到别的端口：明确拒绝，不静默双开
    console.error(`[server] 拒绝启动：单例锁已被活实例持有（${mod.describeLockHolder(holder)}）。`);
    console.error('[server] 同 DB / 同 configDir 只能有一个实例；需要多开请换 APPDATA（configDir）与 AGENTBOARD_DB，并监听不同端口。');
    process.exit(2);
  }
  if (mod.isProcessAlive(holder.pid)) {
    console.log(`[server] 单例锁已被活实例持有：${mod.describeLockHolder(holder)}；不重复拉起，等待其健康`);
    const waitUntil = Date.now() + timeoutMs;
    while (Date.now() < waitUntil) {
      const hit = await probe(port, 1500);
      if (hit?.ok === true) {
        console.log(`[server] 已在运行，复用：${versionUrl(port)}（version ${hit.version}，pid ${holder.pid}，未重启进程）`);
        console.log(`[server] 日志：${LOG_FILE}`);
        process.exit(0);
      }
      await sleep(300);
    }
    console.error(`[server] 持有者 ${holder.pid} 未在 ${timeoutMs}ms 内健康：${mod.describeLockHolder(holder)}`);
    process.exit(1);
  }
  console.log(`[server] 陈旧单例锁（pid ${holder.pid} 已不存在），接管：${mod.describeLockHolder(holder)}`);
}

/**
 * PROXY-ENV：Node 24 的内置 fetch 默认不读 `HTTPS_PROXY`，必须 `NODE_USE_ENV_PROXY=1`。
 * 子进程继承本进程环境，所以**在这里注入**（唯一入口），服务端只需只读暴露状态。
 * 规则：宿主有 HTTPS_PROXY/HTTP_PROXY 且未显式设 `NODE_USE_ENV_PROXY=0` 才注入；
 * 日志只打 host:port（丢 userinfo，不打印凭据）。
 * 实现复用 `packages/shared`（`ensureProxyEnv`），不在脚本里另写一份。
 */
async function applyProxyEnv() {
  try {
    const mod = await import(new URL('../packages/shared/dist/proxyEnv.js', import.meta.url).href);
    const info = mod.ensureProxyEnv(process.env);
    if (info.proxy_var === null) {
      console.log('[server] proxy_env=off（未检测到 HTTP(S)_PROXY，出站直连）');
    } else if (info.node_env_proxy === '0') {
      console.log(`[server] proxy_env=off（NODE_USE_ENV_PROXY=0，用户显式关闭；代理 ${info.proxy_var}=${info.proxy_host ?? ''}）`);
    } else {
      console.log(`[server] proxy_env=on host=${info.proxy_host ?? '?'}（源 ${info.proxy_var}，已注入 NODE_USE_ENV_PROXY=1）`);
    }
  } catch (error) {
    // shared 未构建时不影响启动；服务端自己还有一份兜底
    console.log(`[server] proxy_env=unknown（读取 shared/proxyEnv 失败：${error instanceof Error ? error.message : String(error)}）`);
  }
}
await applyProxyEnv();

mkdirSync(LOG_DIR, { recursive: true });
const fd = openSync(LOG_FILE, 'a');
const stamp = new Date().toISOString();
const child = spawn(process.execPath, [ENTRY], {
  cwd: ROOT,
  detached: true,
  stdio: ['ignore', fd, fd],
  windowsHide: true,
  env: process.env,
});
closeSync(fd);
child.unref();
console.log(`[server] 未探活到服务，已后台拉起（pid ${child.pid}），端口 ${port}`);
console.log(`[server] 日志：${LOG_FILE}  @ ${stamp}`);

let exited = null;
child.once('exit', (code, signal) => {
  exited = { code, signal };
});

/**
 * SERVER-SINGLETON：并发 ensure 竞争时，落败的子进程会因单例锁退出（exit 4，或 Windows 上报 code=null）。
 * 这类退出**不代表失败**：另一个实例可能还在启动。所以子进程一退出也继续等端口健康（直到 timeout），
 * 只有整个超时窗口内都没健康才报失败——避免「两个 ensure 只成功一个」的误报。
 */
const started = Date.now();
let sawExit = false;
while (Date.now() - started < timeoutMs) {
  const hit = await probe(port, 1500);
  if (hit?.ok === true) {
    if (sawExit) {
      console.log(`[server] 另一实例已接管端口 ${port}（version ${hit.version}），本次不重复拉起`);
    } else {
      console.log(`[server] 就绪：${versionUrl(port)}（version ${hit.version}，pid ${child.pid}，耗时 ${Date.now() - started}ms）`);
    }
    process.exit(0);
  }
  if (exited !== null && !sawExit) {
    sawExit = true;
    console.log(`[server] 子进程已退出（code ${exited.code}，signal ${exited.signal ?? '无'}）；继续等待端口 ${port} 上可能已接管的实例`);
  }
  await sleep(400);
}

const late = await probe(port, 1500);
if (late?.ok === true) {
  console.log(`[server] 另一实例已接管端口 ${port}（version ${late.version}），本次不重复拉起`);
  process.exit(0);
}
if (exited !== null) {
  console.error(
    `[server] 新进程已退出（code ${exited.code}，signal ${exited.signal ?? '无'}），端口 ${port} 无监听。日志尾部：\n${readLogTail()}`,
  );
  process.exit(1);
}
console.error(`[server] 等待健康超时（${timeoutMs}ms，pid ${child.pid} 仍在跑）。日志尾部：\n${readLogTail()}`);
process.exit(1);
