'use strict';

/**
 * 辅助脚本 3：单实例验证（C5 验收项 4「开第二个不重复起服务」）。
 *
 * 判定口径（三条同时成立才算过）：
 *  1) 第一个实例就绪后，端口上只有 1 个监听 PID，其进程树里只有 1 个 node.exe 服务子进程；
 *  2) 用同一 userData 目录再启动第二个实例，它必须自己退出，且不新增任何监听进程；
 *  3) 第二个实例退出后，第一个实例仍然可用（窗口可交互、/api/workspaces 仍 200）。
 *
 * 第二个实例刻意用裸 spawn 而不是 Playwright：它会在 app.whenReady 之前就 quit，
 * 走 CDP 反而拿不到稳定的退出信号。
 *
 * 用法（在 tests/e2e 目录）：
 *   node scripts/verify-single-instance.js              # 打包产物
 *   node scripts/verify-single-instance.js --mode dev   # dev 源码
 */
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const {
  makeIsolatedEnv,
  launchDev,
  launchPackaged,
  firstWindowReady,
  DEV_ELECTRON,
  PACKAGED_EXE,
  DESKTOP_DIR,
} = require('../lib/desktop');
const { snapshotProcesses, processTree, listeningPids, waitFor, waitAgentBoardReady, httpGet } = require('../lib/proc');

const args = process.argv.slice(2);
const mode = args.includes('--mode') ? args[args.indexOf('--mode') + 1] : 'packaged';

/** 用裸 spawn 起第二个实例，返回 { pid, exited, code, stdout, stderr } */
function spawnSecondInstance(env, userDataDir) {
  const exe = mode === 'dev' ? DEV_ELECTRON : PACKAGED_EXE;
  const spawnArgs = mode === 'dev' ? ['.', `--user-data-dir=${userDataDir}`] : [`--user-data-dir=${userDataDir}`];
  const child = spawn(exe, spawnArgs, {
    cwd: mode === 'dev' ? DESKTOP_DIR : undefined,
    env: { ...env, AGENTBOARD_PORT: env.AGENTBOARD_PORT },
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

async function main() {
  const report = { mode, ok: false, steps: [] };
  const env = await makeIsolatedEnv();
  let first;
  try {
    first = mode === 'dev'
      ? await launchDev({ env: env.env, args: env.userDataArgs })
      : await launchPackaged({ env: env.env, args: env.userDataArgs });
    const { window } = await firstWindowReady(first, { timeout: 60000 });
    const ready = await waitAgentBoardReady(env.port, { timeoutMs: 40000 });
    if (!ready.ok) throw new Error(`第一个实例服务未就绪：${ready.detail}`);

    const firstPid = first.process().pid;
    const tree1 = processTree(await snapshotProcesses(), firstPid);
    const serverChildren1 = tree1.filter((p) => p.name.toLowerCase() === 'node.exe' && p.pid !== firstPid);
    const listeners1 = await listeningPids(env.port);
    report.steps.push({
      step: '第一个实例就绪',
      firstPid,
      listeners: listeners1,
      serverChildren: serverChildren1.map((p) => p.pid),
    });
    if (listeners1.length !== 1) throw new Error(`期望 1 个监听进程，实际 ${listeners1.length}：${listeners1}`);
    if (serverChildren1.length !== 1) throw new Error(`期望 1 个服务子进程，实际 ${serverChildren1.length}`);

    // 第二个实例：同 userData、同端口
    const second = spawnSecondInstance(env.env, env.userDataDir);
    const secondExited = await Promise.race([
      second.exited,
      new Promise((resolve) => setTimeout(() => resolve('timeout'), 30000)),
    ]);
    const out = second.output();
    if (secondExited === 'timeout') {
      second.child.kill();
      throw new Error('第二个实例 30s 内未退出（单实例锁未生效）');
    }
    report.steps.push({
      step: '第二个实例启动',
      pid: second.child.pid,
      exitCode: secondExited,
      stdoutHead: out.stdout.slice(0, 400),
      stderrHead: out.stderr.slice(0, 400),
    });

    // 第二个实例退出后：监听数不变、第一个实例仍可用
    const listeners2 = await listeningPids(env.port);
    const tree2 = processTree(await snapshotProcesses(), firstPid);
    const serverChildren2 = tree2.filter((p) => p.name.toLowerCase() === 'node.exe' && p.pid !== firstPid);
    const health = await httpGet(`http://127.0.0.1:${env.port}/api/workspaces`);
    const title = await window.title();
    report.steps.push({
      step: '第二个实例退出后',
      listeners: listeners2,
      serverChildren: serverChildren2.map((p) => p.pid),
      firstInstanceHttpStatus: health.status,
      firstInstanceTitle: title,
    });
    if (listeners2.length !== 1) throw new Error(`第二个实例退出后监听进程数变成 ${listeners2.length}`);
    if (serverChildren2.length !== 1) throw new Error(`第二个实例退出后服务子进程数变成 ${serverChildren2.length}`);
    if (health.status !== 200) throw new Error(`第一个实例 HTTP 不可用：status=${health.status}`);
    if (title !== 'AgentBoard') throw new Error(`第一个实例窗口标题异常：${title}`);

    // 主进程日志里不应出现第二条「==== 启动」（第二个实例在 whenReady 前就退出）
    let log = '';
    try {
      log = fs.readFileSync(env.mainLog, 'utf8');
    } catch {
      log = '';
    }
    const startLines = log.split(/\r?\n/).filter((l) => l.includes('==== 启动'));
    report.steps.push({ step: '主进程启动记录', startLines });
    if (startLines.length !== 1) throw new Error(`主进程启动记录应为 1 条，实际 ${startLines.length} 条`);

    report.ok = true;
    return report;
  } finally {
    if (first) await first.close().catch(() => undefined);
    env.dispose();
  }
}

main()
  .then((report) => {
    console.log(`单实例验证（${report.mode}）：${report.ok ? '通过' : '失败'}`);
    for (const step of report.steps) console.log(` - ${step.step}: ${JSON.stringify(step)}`);
    process.exit(report.ok ? 0 : 1);
  })
  .catch((err) => {
    console.error(`单实例验证失败：${err && err.message ? err.message : err}`);
    process.exit(2);
  });
