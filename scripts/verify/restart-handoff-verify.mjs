#!/usr/bin/env node
/**
 * ACC-SRV-RESTART（卡 2fef2488）真机验收：服务自重启交棒竞态修复。
 *
 * 起临时验证实例（独立临时 APPDATA + AGENTBOARD_DB + 端口 8799，与生产 8787 / 真实
 * %APPDATA%\AgentBoard 完全隔离），连续 5 次 POST /api/system/restart，断言：
 *  1. 每次最终 /api/version 的 pid = 202 响应里的 new_pid，且该 pid 存活；
 *  2. 旧 pid 已退出（无双进程并存）；
 *  3. 实例日志无 EADDRINUSE / 重启失败 / 回退，`重启完成` 恰 5 次；
 *  4. 最终实例 started_at 晚于 dist 产物 mtime（跑的是当前构建）。
 *
 * 用法：node scripts/verify/restart-handoff-verify.mjs
 * 退出码：0 全部断言通过 / 1 有断言失败（逐条打印）
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(join(dirname(fileURLToPath(import.meta.url)), '..', '..'));
const ENTRY = join(ROOT, 'apps', 'server', 'dist', 'index.js');
const PORT = 8799;
const RESTARTS = 5;
const PID_CHANGE_TIMEOUT_MS = 90_000;

if (!existsSync(ENTRY)) {
  console.error(`[verify] 找不到 ${ENTRY}，先 pnpm --filter @agentboard/server build`);
  process.exit(1);
}
const distMtime = statSync(ENTRY).mtimeMs;

const dir = mkdtempSync(join(tmpdir(), 'acc-restart-verify-'));
const logFile = join(dir, 'server.log');
const env = {
  ...process.env,
  APPDATA: dir,
  AGENTBOARD_DB: join(dir, 'ab.db'),
  AGENTBOARD_PORT: String(PORT),
  AGENTBOARD_LOG: logFile,
};

const failures = [];
const fail = (msg) => { failures.push(msg); console.error(`[verify] FAIL ${msg}`); };
const pass = (msg) => console.log(`[verify] ok   ${msg}`);
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

const version = async (timeoutMs = 2000) => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`http://127.0.0.1:${PORT}/api/version`, { signal: controller.signal });
    const body = await res.json();
    return res.ok && body?.name === 'agentboard-server' ? body : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
};

const alive = (pid) => {
  try { process.kill(pid, 0); return true; } catch { return false; }
};

async function waitVersionChange(oldPid, timeoutMs = PID_CHANGE_TIMEOUT_MS) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const v = await version();
    if (v !== null && v.pid !== oldPid) return v;
    await sleep(300);
  }
  return null;
}

/** 旧进程在健康确认后还有 ~100ms 的延迟退出（exit 依赖 setTimeout），交棒检测到后给它一个宽限窗口 */
async function waitPidGone(pid, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!alive(pid)) return true;
    await sleep(200);
  }
  return !alive(pid);
}

// 起临时实例（attached，便于最后兜底清理；restart 子进程是 detached 的，靠 /api/version 追踪）
if (await version(1000) !== null) {
  console.error(`[verify] 端口 ${PORT} 已有 agentboard 实例在跑，为避免误伤它，本次不执行。先清理占用者或换端口。`);
  process.exit(1);
}
const first = spawn(process.execPath, [ENTRY], { cwd: ROOT, env, stdio: 'ignore', windowsHide: true });
let v = null;
for (let i = 0; i < 100 && v === null; i += 1) {
  await sleep(300);
  v = await version();
}
if (v === null) {
  fail('临时实例 30s 内未健康（/api/version 无 agentboard-server 响应）');
  try { first.kill(); } catch { /* 已退出 */ }
  if (existsSync(logFile)) console.error(readFileSync(logFile, 'utf8').split('\n').slice(-20).join('\n'));
  rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  process.exit(1);
}
pass(`临时实例就绪 pid=${v.pid} port=${PORT} appdata=${dir}`);

let currentPid = v.pid;
const record = [];
for (let i = 1; i <= RESTARTS; i += 1) {
  const res = await fetch(`http://127.0.0.1:${PORT}/api/system/restart`, { method: 'POST' });
  const body = await res.json().catch(() => null);
  if (res.status !== 202 || body?.restarting !== true) {
    fail(`第 ${i} 次 restart：HTTP ${res.status} ${JSON.stringify(body)}`);
    break;
  }
  const newPid = body.new_pid;
  const next = await waitVersionChange(currentPid);
  if (next === null) {
    fail(`第 ${i} 次 restart：${PID_CHANGE_TIMEOUT_MS}ms 内端口未交棒给新 pid（疑似回退或死亡）`);
    break;
  }
  if (next.pid !== newPid) fail(`第 ${i} 次 restart：端口上的 pid ${next.pid} ≠ 202 声明的 new_pid ${newPid}`);
  if (!alive(next.pid)) fail(`第 ${i} 次 restart：新 pid ${next.pid} 不存活`);
  if (!(await waitPidGone(currentPid))) fail(`第 ${i} 次 restart：旧 pid ${currentPid} 在 10s 宽限后仍存活（双进程并存）`);
  if (next.started_at <= distMtime) fail(`第 ${i} 次 restart：实例 started_at ${next.started_at} 早于 dist mtime ${distMtime}（跑的不是当前构建）`);
  record.push({ round: i, old: currentPid, new: next.pid, started_at: next.started_at });
  if (failures.length === 0) pass(`第 ${i} 次 restart：${currentPid} → ${next.pid}，接管完成，旧进程已退出`);
  currentPid = next.pid;
}

const final = await version();
if (final !== null && !alive(final.pid)) fail(`最终 pid ${final.pid} 不存活`);

// 实例日志断言（临时实例的 AGENTBOARD_LOG 指向临时目录，与生产 .logs/server.log 无关）
const log = existsSync(logFile) ? readFileSync(logFile, 'utf8') : '';
const eaddr = (log.match(/EADDRINUSE/g) ?? []).length;
const rollback = (log.match(/重启失败|回退失败|已回退/g) ?? []).length;
const done = (log.match(/重启完成/g) ?? []).length;
if (eaddr !== 0) fail(`实例日志出现 EADDRINUSE ×${eaddr}`);
if (rollback !== 0) fail(`实例日志出现回退线 ×${rollback}`);
if (done !== RESTARTS) fail(`实例日志「重启完成」×${done}，预期 ×${RESTARTS}`);
if (failures.length === 0) pass(`实例日志干净：重启完成 ×${done}，无 EADDRINUSE、无回退`);

console.log('\n[verify] 逐次交接：');
for (const r of record) console.log(`  round ${r.round}: pid ${r.old} -> ${r.new} (started_at ${new Date(r.started_at).toISOString()})`);

// 清理：终止临时实例（最终 pid，restart 子进程是 detached 的，必须按 pid 杀）+ 删临时目录
if (final !== null && alive(final.pid)) {
  try { process.kill(final.pid); } catch { /* 已退出 */ }
  await sleep(500);
  if (alive(final.pid)) {
    const killer = spawn('taskkill', ['/pid', String(final.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
    await new Promise(r => killer.once('exit', r));
  }
  pass(`临时实例已终止（pid ${final.pid}）`);
}
if (first.pid !== null && alive(first.pid)) { try { first.kill(); } catch { /* 已退出 */ } }
rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
pass(`临时目录已清理 ${dir}`);

if (failures.length > 0) {
  console.error(`\n[verify] 结果：FAIL（${failures.length} 条断言失败）`);
  process.exit(1);
}
console.log(`\n[verify] 结果：PASS（${RESTARTS} 次 restart 全部干净交接）`);
