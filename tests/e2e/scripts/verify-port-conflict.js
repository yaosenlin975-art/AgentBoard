'use strict';

/**
 * 辅助脚本 4：端口占用场景验证（C5 验收项 5「8787 被占用时有明确原生提示且不崩」）。
 *
 * 分三条互不干扰的分支验证：
 *  A) 逻辑层（不起窗口）：直接调 apps/desktop/src/bootstrap.js 的 ensureServer，
 *     - 对着已在跑的 AgentBoard（默认 8787）→ 期望 kind=reused；
 *     - 对着返回 JSON 对象的假 HTTP 服务 → 期望 kind=foreign。
 *  B) 应用层复用分支：完整启动桌面端指向在跑的 AgentBoard → 期望日志出现「复用已在运行的 AgentBoard 服务」、
 *     不新增 node 子进程、窗口 URL 就是该端口。
 *  C) 应用层 foreign 分支：完整启动桌面端指向假 HTTP 服务 → 期望日志出现「端口 N 被其它程序占用」、
 *     进程存活（弹原生对话框，未崩溃）、且没有创建 BrowserWindow；随后结束该进程树。
 *
 * 为什么 C 不用 Playwright：showMessageBoxSync 会阻塞主进程，CDP 侧拿不到任何信号；
 * 用裸 spawn + 日志 + 存活判定，才拿得到「确实弹了提示且没崩」的证据。
 *
 * 现网约束：A/B 只读访问在跑的 AgentBoard，不 kill、不重启、不写库；C 用独立假服务与独立端口。
 *
 * 用法（在 tests/e2e 目录）：
 *   node scripts/verify-port-conflict.js                    # 默认对着 8787
 *   node scripts/verify-port-conflict.js --live-port 8787
 *   node scripts/verify-port-conflict.js --skip-app         # 只跑逻辑层 A
 */
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { REPO_ROOT, makeIsolatedEnv, freePort, PACKAGED_EXE, DEV_ELECTRON, DESKTOP_DIR } = require('../lib/desktop');
const { snapshotProcesses, processTree, waitFor, httpGet } = require('../lib/proc');

const args = process.argv.slice(2);
const livePort = args.includes('--live-port') ? Number(args[args.indexOf('--live-port') + 1]) : 8787;
const skipApp = args.includes('--skip-app');
const mode = args.includes('--mode') ? args[args.indexOf('--mode') + 1] : 'packaged';

/** A：直接跑 bootstrap 的判定逻辑（纯 Node，无 Electron、无窗口） */
async function ensureServerAgainst({ port, userDataDir }) {
  const { ensureServer } = require(path.join(REPO_ROOT, 'apps', 'desktop', 'src', 'bootstrap.js'));
  const runtime = {
    mode: 'dev',
    root: REPO_ROOT,
    // 逻辑层不真正 spawn：这三个分支都不会走到 spawn（reused / foreign 直接返回）
    nodeExe: process.execPath,
    serverEntry: path.join(REPO_ROOT, 'apps', 'server', 'dist', 'index.js'),
    webDist: path.join(REPO_ROOT, 'apps', 'web', 'dist'),
    binDirs: [],
  };
  const silent = { info: () => {}, warn: () => {}, error: () => {} };
  const result = await ensureServer({ runtime, userDataDir, port, logger: silent });
  return { kind: result.kind, detail: result.detail };
}

/** 起一个「非 AgentBoard」的 HTTP 服务：200 + JSON 对象（不是数组） */
function startFakeForeignServer(port) {
  return new Promise((resolve) => {
    const srv = http.createServer((req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, service: 'not-agentboard' }));
    });
    srv.listen(port, '127.0.0.1', () => resolve(srv));
  });
}

/** 裸 spawn 完整桌面端，返回观察句柄 */
function spawnApp({ env, userDataDir, port }) {
  const exe = mode === 'dev' ? DEV_ELECTRON : PACKAGED_EXE;
  const spawnArgs = mode === 'dev' ? ['.', `--user-data-dir=${userDataDir}`] : [`--user-data-dir=${userDataDir}`];
  const child = spawn(exe, spawnArgs, {
    cwd: mode === 'dev' ? DESKTOP_DIR : undefined,
    env: { ...env, AGENTBOARD_PORT: String(port) },
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (c) => {
    stdout += c.toString('utf8');
  });
  child.stderr.on('data', (c) => {
    stderr += c.toString('utf8');
  });
  const exited = new Promise((resolve) => {
    child.once('exit', (code) => resolve(code));
    child.once('error', () => resolve(-1));
  });
  return { child, exited, output: () => ({ stdout, stderr }) };
}

function readLog(file) {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return '';
  }
}

/** taskkill 整个进程树（只用于本脚本自己起的实例） */
function killTree(pid) {
  return new Promise((resolve) => {
    const k = spawn('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
    k.once('exit', () => resolve());
    k.once('error', () => resolve());
  });
}

async function main() {
  const report = { ok: false, mode, livePort, steps: [] };
  const fail = (message) => {
    report.error = message;
    return report;
  };

  // ---- A：逻辑层 ----
  const liveProbe = await httpGet(`http://127.0.0.1:${livePort}/api/workspaces`, { timeoutMs: 3000 });
  if (liveProbe.status !== 200) {
    return fail(`在跑的 AgentBoard（端口 ${livePort}）不可访问：status=${liveProbe.status}；本脚本要求现网实例在跑`);
  }
  const tmpA = fs.mkdtempSync(path.join(os.tmpdir(), 'agentboard-pc-a-'));
  const reused = await ensureServerAgainst({ port: livePort, userDataDir: tmpA });
  report.steps.push({ step: 'A1 逻辑层·对着在跑的 AgentBoard', ...reused });
  if (reused.kind !== 'reused') return fail(`期望 reused，实际 ${reused.kind}（${reused.detail}）`);

  const foreignPort = await freePort();
  const fake = await startFakeForeignServer(foreignPort);
  let foreign;
  try {
    foreign = await ensureServerAgainst({ port: foreignPort, userDataDir: tmpA });
  } finally {
    await new Promise((resolve) => fake.close(resolve));
  }
  report.steps.push({ step: 'A2 逻辑层·对着假外来服务', port: foreignPort, ...foreign });
  if (foreign.kind !== 'foreign') return fail(`期望 foreign，实际 ${foreign.kind}（${foreign.detail}）`);
  fs.rmSync(tmpA, { recursive: true, force: true, maxRetries: 3 });

  if (skipApp) {
    report.ok = true;
    return report;
  }

  // ---- B：应用层复用分支 ----
  const envB = await makeIsolatedEnv({ port: livePort });
  let appB;
  try {
    appB = spawnApp({ env: envB.env, userDataDir: envB.userDataDir, port: livePort });
    const sawReuse = await waitFor(
      () => readLog(envB.mainLog).includes('复用已在运行的 AgentBoard 服务，不启动子进程'),
      { timeoutMs: 40000, intervalMs: 300 },
    );
    const sawWindow = await waitFor(() => readLog(envB.mainLog).includes('窗口已创建'), {
      timeoutMs: 20000,
      intervalMs: 300,
    });
    const log = readLog(envB.mainLog);
    const spawnedLine = log.split(/\r?\n/).find((l) => l.includes('已启动服务子进程')) ?? null;
    const tree = processTree(await snapshotProcesses(), appB.child.pid);
    const nodeChildren = tree.filter((p) => p.name.toLowerCase() === 'node.exe' && p.pid !== appB.child.pid);
    report.steps.push({
      step: 'B 应用层·复用分支',
      reuseLogLine: sawReuse,
      windowCreated: sawWindow,
      spawnedLine,
      nodeChildren: nodeChildren.map((p) => p.pid),
      logTail: log.split(/\r?\n/).filter((l) => l.includes('端口探测')).slice(-2),
    });
    if (!sawReuse) return fail('复用时未出现「复用已在运行的 AgentBoard 服务」日志');
    if (spawnedLine !== null) return fail(`复用分支却启动了服务子进程：${spawnedLine}`);
    if (nodeChildren.length !== 0) return fail(`复用分支出现了 node 子进程：${nodeChildren.map((p) => p.pid)}`);
    if (!sawWindow) return fail('复用分支未创建窗口');
  } finally {
    if (appB && appB.child.pid) await killTree(appB.child.pid);
    envB.dispose();
  }

  // ---- C：应用层 foreign 分支 ----
  const envC = await makeIsolatedEnv();
  const foreignPort2 = await freePort();
  const fake2 = await startFakeForeignServer(foreignPort2);
  let appC;
  try {
    appC = spawnApp({ env: envC.env, userDataDir: envC.userDataDir, port: foreignPort2 });
    const sawOccupied = await waitFor(
      () => new RegExp(`端口 ${foreignPort2} 被其它程序占用`).test(readLog(envC.mainLog)),
      { timeoutMs: 40000, intervalMs: 300 },
    );
    // 对话框阻塞主进程：窗口不会创建，进程仍然存活
    await new Promise((r) => setTimeout(r, 2000));
    const exitedEarly = await Promise.race([appC.exited, Promise.resolve('alive')]);
    const log = readLog(envC.mainLog);
    const fatalLine = log.split(/\r?\n/).find((l) => l.includes('端口被占用')) ?? null;
    const windowLine = log.split(/\r?\n/).find((l) => l.includes('窗口已创建')) ?? null;
    const stderrTail = appC.output().stderr.split(/\r?\n/).filter((l) => l.trim() !== '').slice(-3);
    report.steps.push({
      step: 'C 应用层·foreign 分支',
      occupiedLogLine: sawOccupied,
      fatalLogLine: fatalLine,
      processState: exitedEarly === 'alive' ? '存活（对话框阻塞中）' : `已退出 code=${exitedEarly}`,
      windowCreated: windowLine !== null,
      stderrTail,
    });
    if (!sawOccupied) return fail(`未出现「端口 ${foreignPort2} 被其它程序占用」日志`);
    if (windowLine !== null) return fail('foreign 分支竟然创建了窗口（应在提示后退出）');
    if (exitedEarly !== 'alive') {
      return fail(`进程在提示对话框期间就已退出（code=${exitedEarly}），无法确认原生提示存在`);
    }
  } finally {
    if (appC && appC.child.pid) await killTree(appC.child.pid);
    await new Promise((resolve) => fake2.close(resolve));
    envC.dispose();
  }

  report.ok = true;
  return report;
}

main()
  .then((report) => {
    console.log(`端口占用场景验证（${report.mode}，现网端口 ${report.livePort}）：${report.ok ? '通过' : '失败'}`);
    for (const step of report.steps) console.log(` - ${step.step}: ${JSON.stringify(step)}`);
    if (report.error) console.log(` 失败原因：${report.error}`);
    process.exit(report.ok ? 0 : 1);
  })
  .catch((err) => {
    console.error(`端口占用场景验证异常：${err && err.stack ? err.stack : err}`);
    process.exit(2);
  });
