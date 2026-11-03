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

const started = Date.now();
while (Date.now() - started < timeoutMs) {
  const hit = await probe(port, 1500);
  if (hit?.ok === true) {
    console.log(`[server] 就绪：${versionUrl(port)}（version ${hit.version}，pid ${child.pid}，耗时 ${Date.now() - started}ms）`);
    process.exit(0);
  }
  if (exited !== null) {
    console.error(
      `[server] 新进程已退出（code ${exited.code}，signal ${exited.signal ?? '无'}），端口 ${port} 无监听。日志尾部：\n${readLogTail()}`,
    );
    process.exit(1);
  }
  await sleep(400);
}

console.error(`[server] 等待健康超时（${timeoutMs}ms，pid ${child.pid} 仍在跑）。日志尾部：\n${readLogTail()}`);
process.exit(1);
