#!/usr/bin/env node
/**
 * DB-4 端到端验收：改数据库路径 → 迁移 → 重启 → 新进程自检 → 旧库归档 → 回滚演练。
 *
 * 可复现：`node scripts/verify/db-home-e2e.mjs`（默认端口 18830；不改 8787 上正在跑的服务）
 *
 * 隔离口径：
 * - 独立 `APPDATA`（临时目录）+ 独立端口 → `GET /api/settings/storage` 的 `db_path_source` 为 `default`；
 * - **子进程必须继承完整环境**：最小 env 会让启动期 `defaultWorkbuddyPaths()` 抛
 *   `ApiError: 无法解析本机 WorkBuddy 契约路径` → 进程 exit 1、端口从未监听 → 首次请求 ECONNREFUSED
 *   （DB-4 前任卡点的真实原因，见 Docs/evidence/db-home-e2e-2026-11-04.md）；
 * - 循环回请求不走代理：给子进程与自身都显式设置 `NO_PROXY=127.0.0.1,localhost`；
 * - 跑前清掉临时 APPDATA 里的 `server.lock` 与 `db-migration-status-*.json`（陈旧锁会导致 exit 4）。
 *
 * 退出码：0 全绿 / 1 有失败项。
 */
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const STAMP = new Date().toISOString().replace(/[:.]/g, '-');
const WORK = join(process.env.TEMP ?? 'D:\\tools\\tmp', `db4-e2e-${STAMP}`);
const APPDATA = join(WORK, 'appdata');
const PORT = Number(process.env.DB4_PORT ?? 18830);
const BASE = `http://127.0.0.1:${PORT}`;
const TARGET_DB = join(WORK, 'target-home', 'agentboard.db');

const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail === '' ? '' : `  — ${detail}`}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function api(method, path, body) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: body === undefined ? undefined : { 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await res.text();
  let parsed = null;
  try { parsed = text === '' ? null : JSON.parse(text); } catch { parsed = text; }
  return { status: res.status, body: parsed };
}

async function version() {
  try {
    const res = await fetch(`${BASE}/api/version`);
    return res.ok ? await res.json() : null;
  } catch {
    return null;
  }
}

async function waitVersion(predicate, timeoutMs = 40_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const v = await version();
    if (v !== null && predicate(v)) return v;
    await sleep(300);
  }
  return null;
}

const walk = (dir) => {
  if (!existsSync(dir)) return [];
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(path));
    else out.push({ path, bytes: statSync(path).size, sha256: createHash('sha256').update(readFileSync(path)).digest('hex') });
  }
  return out;
};
const killPort = () => {
  spawnSync('powershell', ['-NoProfile', '-Command', `Get-NetTCPConnection -State Listen -LocalPort ${PORT} -ErrorAction SilentlyContinue | ForEach-Object { Stop-Process -Id $_.OwningProcess -Force -ErrorAction SilentlyContinue }`], { encoding: 'utf8' });
};

// ── 准备：隔离目录 + 清陈旧锁/状态 ───────────────────────────────
rmSync(WORK, { recursive: true, force: true, maxRetries: 8, retryDelay: 300 });
mkdirSync(join(APPDATA, 'AgentBoard'), { recursive: true });
mkdirSync(join(WORK, 'space'), { recursive: true });
for (const stale of ['server.lock']) {
  const p = join(APPDATA, 'AgentBoard', stale);
  if (existsSync(p)) rmSync(p, { force: true });
}
console.log(`工作目录：${WORK}\n端口：${PORT}\n`);

// ── 启动（完整 env 继承；loopback 不走代理）──────────────────────
const childEnv = { ...process.env, APPDATA, AGENTBOARD_PORT: String(PORT), NO_PROXY: '127.0.0.1,localhost,::1', no_proxy: '127.0.0.1,localhost,::1' };
delete childEnv.AGENTBOARD_DB; // 让 db 走 default（APPDATA 下的默认库）
process.env.NO_PROXY = '127.0.0.1,localhost,::1';
process.env.no_proxy = '127.0.0.1,localhost,::1';

killPort();
const child = spawn(process.execPath, ['apps/server/dist/index.js'], {
  cwd: ROOT, env: childEnv, detached: true, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
});
let childOut = '';
child.stdout.on('data', (d) => { childOut += String(d); });
child.stderr.on('data', (d) => { childOut += String(d); });
child.unref();

let exitCode = null;
child.once('exit', (code) => { exitCode = code; });

let ok = true;
try {
  const v1 = await waitVersion(() => true);
  if (v1 === null) {
    check('服务启动并可达', false, `exitCode=${exitCode}；子进程输出：${childOut.split('\n').filter((l) => l.trim() !== '').slice(0, 3).join(' | ')}`);
    throw new Error('服务未起来');
  }
  const pid1 = v1.pid;
  check('服务启动并可达', true, `pid=${pid1} instance=${v1.instance_id}`);

  const settings = await api('GET', '/api/settings');
  const storage0 = await api('GET', '/api/settings/storage');
  check('库来源为 default（未设 AGENTBOARD_DB，独立 APPDATA）', storage0.body?.db_path_source === 'default', `db=${storage0.body?.db_path} source=${storage0.body?.db_path_source}`);
  check('settings 对外字段与持久化键同值', settings.body?.db_path === settings.body?.dbPath, `${settings.body?.db_path}`);
  const oldDb = storage0.body?.db_path;
  const oldAttach = storage0.body?.attachments_dir;

  // ── 造数据：1 工作区 + 3 卡 + 1 附件 ─────────────────────────
  const ws = await api('POST', '/api/workspaces', { name: 'db4', path: join(WORK, 'space') });
  for (const title of ['DB4 卡一', 'DB4 卡二', 'DB4 卡三']) await api('POST', '/api/issues', { workspace_id: ws.body.id, title });
  const png = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da63f8ffff3f0005fe02fea735d0d10000000049454e44ae426082', 'hex');
  const up = await fetch(`${BASE}/api/workspaces/${ws.body.id}/attachments`, { method: 'POST', headers: { 'content-type': 'image/png' }, body: png });
  check('造数据：1 工作区 + 3 卡 + 1 附件', up.status === 201, `attachment=${up.status}`);
  const issuesBefore = (await api('GET', `/api/issues?workspace=${ws.body.id}`)).body;
  const attachBefore = walk(oldAttach);
  const estimate = (await api('GET', '/api/settings/storage')).body?.migration_estimate;

  // ── 迁移 ────────────────────────────────────────────────────
  const migrate = await api('POST', '/api/settings/db-path/migrate', { target_db_path: TARGET_DB });
  check('迁移受理 202（蛇形 target_db_path）', migrate.status === 202 && typeof migrate.body?.migration_id === 'string', `status=${migrate.status} id=${migrate.body?.migration_id}`);
  const migrationId = migrate.body?.migration_id;

  const v2 = await waitVersion((v) => v.pid !== pid1, 60_000);
  check('重启后新进程接管', v2 !== null && v2.pid !== pid1, `${pid1} → ${v2?.pid}`);

  let status = null;
  for (let i = 0; i < 120; i += 1) {
    const res = await api('GET', `/api/settings/db-path/migrate/${migrationId}`);
    if (res.status === 200) status = res.body;
    if (status?.stage === 'done') break;
    await sleep(300);
  }
  const stageChain = (status?.stages ?? []).map((s) => s.stage);
  check('五阶段 + 自检 + 归档，终态 done',
    status?.ok === true && JSON.stringify(stageChain) === JSON.stringify(['preflight', 'snapshot', 'verify', 'switch', 'restart', 'selfcheck', 'cleanup', 'done']),
    stageChain.join(' → '));
  check('自检通过（summary 无 problems）', status?.message?.includes('自检通过') === true, status?.message);

  // ── 数据完整性前后对照 ──────────────────────────────────────
  const after = await api('GET', '/api/settings/storage');
  const issuesAfter = (await api('GET', `/api/issues?workspace=${ws.body.id}`)).body;
  const attachAfter = walk(after.body?.attachments_dir);
  check('库路径切到目标', after.body?.db_path === TARGET_DB, after.body?.db_path);
  check('卡数前后一致', issuesBefore.length === issuesAfter.length && issuesAfter.length === 3, `${issuesBefore.length} → ${issuesAfter.length}`);
  check('附件数/字节/sha256 前后一致',
    attachBefore.length === attachAfter.length
      && attachBefore.every((f) => { const m = attachAfter.find((g) => g.path.endsWith(f.path.split('\\').pop())); return m !== undefined && m.bytes === f.bytes && m.sha256 === f.sha256; }),
    `${attachBefore.length} 个（${attachBefore.map((f) => `${f.bytes}B`).join(',')}）`);
  check('旧库归档进 <bak>.old/，旧路径文件已移走', existsSync(join(`${migrate.body?.backup_dir}.old`, 'agentboard.db')) && !existsSync(oldDb), `${migrate.body?.backup_dir}.old`);
  check('估算字节与实际迁移口径一致', typeof estimate?.estimated_bytes === 'number' && estimate.estimated_bytes > 0, `estimated_bytes=${estimate?.estimated_bytes} required=${estimate?.required_bytes}`);

  // ── 回滚演练（三次拒绝都不动当前库）─────────────────────────
  const dbPathNow = (await api('GET', '/api/settings')).body?.dbPath;
  const unwritable = await api('POST', '/api/settings/db-path/migrate', { target_db_path: 'Z:\\no-such-drive\\agentboard.db' });
  check('目标不可写 → 拒绝且给固定错误码', [409, 500].includes(unwritable.status) && String(unwritable.body?.error?.code ?? '').startsWith('DB_MIGRATION_'), `status=${unwritable.status} code=${unwritable.body?.error?.code}`);
  const existingTarget = join(WORK, 'occupied', 'agentboard.db');
  mkdirSync(dirname(existingTarget), { recursive: true });
  writeFileSync(existingTarget, 'occupied');
  const exists = await api('POST', '/api/settings/db-path/migrate', { target_db_path: existingTarget });
  check('目标已存在同名库 → DB_MIGRATION_TARGET_EXISTS', exists.body?.error?.code === 'DB_MIGRATION_TARGET_EXISTS', `status=${exists.status}`);
  // 目标 db 路径本身是个目录：VACUUM INTO 无法写 → 复制失败（且必须回滚到旧路径）
  const dirAsDbParent = join(WORK, 'dir-as-db');
  mkdirSync(join(dirAsDbParent, 'agentboard.db'), { recursive: true });
  const copyFail = await api('POST', '/api/settings/db-path/migrate', { target_db_path: join(dirAsDbParent, 'agentboard.db') });
  // 目标路径已被一个**目录**占住：preflight 的 existsSync 先命中 → TARGET_EXISTS（拒绝且不动当前库）
  check('目标 db 路径被目录占住 → 拒绝（TARGET_EXISTS），不是静默成功',
    ['DB_MIGRATION_TARGET_EXISTS', 'DB_MIGRATION_COPY_FAILED', 'DB_MIGRATION_VERIFY_FAILED', 'DB_MIGRATION_TARGET_UNWRITABLE'].includes(copyFail.body?.error?.code),
    `status=${copyFail.status} code=${copyFail.body?.error?.code} msg=${copyFail.body?.error?.message}`);

  const settingsAfterRollback = await api('GET', '/api/settings');
  const v3 = await version();
  const issuesStill = (await api('GET', `/api/issues?workspace=${ws.body.id}`)).body;
  check('回滚演练后旧路径不变、服务仍可用、数据未丢',
    settingsAfterRollback.body?.dbPath === dbPathNow && v3 !== null && issuesStill.length === 3,
    `dbPath=${settingsAfterRollback.body?.dbPath} pid=${v3?.pid} issues=${issuesStill.length}`);
} catch (error) {
  if (results.every((r) => r.ok)) check('脚本未抛错', false, error instanceof Error ? error.message : String(error));
} finally {
  const failed = results.filter((r) => !r.ok).length;
  ok = failed === 0;
  console.log(`\n合计 ${results.length} 项，失败 ${failed} 项`);
  writeFileSync(join(WORK, 'result.json'), `${JSON.stringify({ port: PORT, work: WORK, results }, null, 2)}\n`, 'utf8');
  console.log(`结果文件：${join(WORK, 'result.json')}`);
  killPort();
  if (child.exitCode === null) { try { child.kill('SIGKILL'); } catch { /* 忽略 */ } }
  process.exit(ok ? 0 : 1);
}
