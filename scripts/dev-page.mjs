#!/usr/bin/env node
/**
 * 测试页（TEST-PAGE）：固定端口拉起 vite dev，供组员做界面验证。
 *
 * 为什么需要：8787 正式页服务的是 apps/web/dist 静态产物，只在 vite dev 上验证不会更新它，
 * 容易出现「改完在页面上看不到」。因此界面验证统一走本脚本拉起的测试页，正式页只在
 * 卡关闭/批量收口时用 `pnpm publish:web`（或 scripts/rebuild-web-dist.mjs）重建。
 *
 * 幂等：
 *  - 端口上已有可响应的页面 → 直接复用（打印探活结果并以 0 退出）；
 *  - 端口被占用但探活失败（不是本测试页）→ 明确报错退出，避免误连别的东西；
 *  - 均不杀任何进程（不按端口/名字 kill node）。
 *
 * 用法：node scripts/dev-page.mjs [--port 5174] [--no-wait]
 * 日志：<repo>/.logs/test-page.log（.gitignore 的 *.log 已覆盖）
 */
import { spawn } from 'node:child_process';
import { mkdirSync, openSync, closeSync, existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_PORT = 5174;
const LOG_DIR = join(ROOT, '.logs');
const LOG_FILE = join(LOG_DIR, 'test-page.log');
const WAIT_TIMEOUT_MS = 90_000;

function parseArgs(argv) {
  const out = { port: Number(process.env.TEST_PAGE_PORT ?? DEFAULT_PORT), wait: true };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--port') {
      out.port = Number(argv[i + 1]);
      i += 1;
    } else if (arg.startsWith('--port=')) {
      out.port = Number(arg.slice('--port='.length));
    } else if (arg === '--no-wait') {
      out.wait = false;
    }
  }
  if (!Number.isInteger(out.port) || out.port <= 0 || out.port > 65535) {
    throw new Error(`端口不合法：${out.port}`);
  }
  return out;
}

const url = (port) => `http://127.0.0.1:${port}/`;

/** 探活：能拿到 HTML 才算可复用；连不上/非 HTML 返回 null */
async function probe(port, timeoutMs = 2000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url(port), { signal: controller.signal });
    const text = await res.text();
    if (!res.ok) return { ok: false, status: res.status };
    return { ok: /<html|<!doctype html/i.test(text), status: res.status, bytes: text.length };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

function readLogTail(lines = 8) {
  if (!existsSync(LOG_FILE)) return '';
  const all = readFileSync(LOG_FILE, 'utf8').trimEnd().split('\n');
  return all.slice(-lines).join('\n');
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const { port, wait } = parseArgs(process.argv.slice(2));

const existing = await probe(port);
if (existing?.ok === true) {
  console.log(`[test-page] 已在运行，复用：${url(port)}（HTTP ${existing.status}，${existing.bytes} bytes）`);
  console.log(`[test-page] 日志：${LOG_FILE}`);
  process.exit(0);
}
if (existing !== null && existing.ok === false) {
  console.error(`[test-page] 端口 ${port} 被占用但不是可用页面（HTTP ${existing.status}）：请换 --port 或人工确认占用者`);
  process.exit(2);
}

mkdirSync(LOG_DIR, { recursive: true });
const fd = openSync(LOG_FILE, 'a');
const stamp = new Date().toISOString();
// 直接起 vite 可执行（不经 pnpm 转发）：避免 pnpm `dev --` 的二次 `--` 被 vite 当成参数终止符，
// 导致 --port/--host 失效（曾出现只监听 ::1、127.0.0.1 探活失败）。
const WEB_DIR = join(ROOT, 'apps', 'web');
const viteBin = join(WEB_DIR, 'node_modules', 'vite', 'bin', 'vite.js');
if (!existsSync(viteBin)) {
  closeSync(fd);
  console.error(`[test-page] 找不到 vite：${viteBin}（先在仓库根跑 pnpm install）`);
  process.exit(3);
}
const child = spawn(
  process.execPath,
  [viteBin, '--port', String(port), '--strictPort', '--host', '127.0.0.1'],
  { cwd: WEB_DIR, detached: true, stdio: ['ignore', fd, fd], windowsHide: true },
);
closeSync(fd);
child.unref();
console.log(`[test-page] 已后台拉起 vite dev（pid ${child.pid}），端口 ${port}`);
console.log(`[test-page] 日志：${LOG_FILE}  @ ${stamp}`);

if (!wait) {
  console.log(`[test-page] 未等待就绪，稍后访问 ${url(port)}`);
  process.exit(0);
}

const started = Date.now();
while (Date.now() - started < WAIT_TIMEOUT_MS) {
  const hit = await probe(port, 1500);
  if (hit?.ok === true) {
    console.log(`[test-page] 就绪：${url(port)}（HTTP ${hit.status}，${hit.bytes} bytes，耗时 ${Date.now() - started}ms）`);
    process.exit(0);
  }
  await sleep(500);
}

console.error(`[test-page] 等待就绪超时（${WAIT_TIMEOUT_MS}ms）。日志尾部：\n${readLogTail()}`);
process.exit(1);
