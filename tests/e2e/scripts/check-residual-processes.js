'use strict';

/**
 * 辅助脚本 2：残留进程检查（C5 验收项 4「退出无残留 node 子进程」）。
 *
 * 判定口径：按**进程树**，不按进程名。启动前先给全机进程拍快照，启动后取桌面端进程树，
 * 记录主进程下的 node.exe 服务子进程 PID；关闭应用后轮询这些 PID 是否全部消失。
 * 本机常驻别的 node.exe（看板服务等），按名字判会把它们误算成残留。
 *
 * 用法（在 tests/e2e 目录）：
 *   node scripts/check-residual-processes.js              # 打包产物
 *   node scripts/check-residual-processes.js --mode dev   # dev 源码
 *   node scripts/check-residual-processes.js --wait 8000  # 关闭后等待上限（毫秒）
 */
const { makeIsolatedEnv, launchDev, launchPackaged, firstWindowReady } = require('../lib/desktop');
const { snapshotProcesses, processTree, isAlive, waitFor, listeningPids, waitAgentBoardReady } = require('../lib/proc');

const args = process.argv.slice(2);
const mode = args.includes('--mode') ? args[args.indexOf('--mode') + 1] : 'packaged';
const waitMs = args.includes('--wait') ? Number(args[args.indexOf('--wait') + 1]) : 20000;

async function main() {
  const report = { mode, waitMs, ok: false, steps: [] };

  const before = await snapshotProcesses();
  report.steps.push({ step: '启动前进程快照', total: before.length });

  const env = await makeIsolatedEnv();
  let app;
  let treeBefore = [];
  try {
    app =
      mode === 'packaged'
        ? await launchPackaged({ env: env.env, args: env.userDataArgs })
        : await launchDev({ env: env.env, args: env.userDataArgs });
    const { window } = await firstWindowReady(app, { timeout: 60000 });
    await window.title();
    const ready = await waitAgentBoardReady(env.port, { timeoutMs: 40000 });
    if (!ready.ok) throw new Error(`服务未就绪：${ready.detail}`);

    // 找到 Electron 主进程 PID：Playwright 的 process() 给的是 electron 可执行进程
    const mainPid = app.process().pid;
    const tree = await snapshotProcesses();
    treeBefore = processTree(tree, mainPid);
    const nodeChildren = treeBefore.filter((p) => p.name.toLowerCase() === 'node.exe' && p.pid !== mainPid);
    const listenPids = await listeningPids(env.port);

    report.steps.push({
      step: '运行期进程树',
      mainPid,
      treeSize: treeBefore.length,
      nodeChildren: nodeChildren.map((p) => ({ pid: p.pid, ppid: p.ppid, cmd: p.commandLine.slice(0, 160) })),
      listeningPids: listenPids,
    });

    if (nodeChildren.length === 0) throw new Error('运行期未发现 node.exe 服务子进程（子进程可能没起来）');
    if (listenPids.length === 0) throw new Error(`端口 ${env.port} 无监听者`);

    // 关闭应用（等价用户点关闭按钮 → window-all-closed → app.quit）
    await app.close();
    app = null;

    // 关闭后等进程树全部消失
    const tracked = treeBefore.map((p) => p.pid);
    const allGone = await waitFor(() => tracked.every((pid) => !isAlive(pid)), {
      timeoutMs: waitMs,
      intervalMs: 250,
    });
    const survivors = tracked.filter((pid) => isAlive(pid));
    const survivorsInfo = survivors.length === 0 ? [] : (await snapshotProcesses()).filter((p) => survivors.includes(p.pid));

    // 端口必须已释放
    const portGone = await waitFor(async () => (await listeningPids(env.port)).length === 0, {
      timeoutMs: 8000,
      intervalMs: 250,
    });

    report.steps.push({
      step: '关闭后残留检查',
      trackedPids: tracked,
      allGone,
      survivors: survivorsInfo.map((p) => ({ pid: p.pid, name: p.name, cmd: p.commandLine.slice(0, 160) })),
      portReleased: portGone,
    });

    if (!allGone) throw new Error(`关闭后仍有残留进程：${JSON.stringify(survivors)}`);
    if (!portGone) throw new Error(`端口 ${env.port} 关闭后仍被监听`);

    report.ok = true;
    return report;
  } finally {
    if (app) await app.close().catch(() => undefined);
    env.dispose();
  }
}

main()
  .then((report) => {
    console.log(`残留进程检查（${report.mode}）：${report.ok ? '通过' : '失败'}`);
    for (const step of report.steps) console.log(` - ${step.step}: ${JSON.stringify(step)}`);
    process.exit(report.ok ? 0 : 1);
  })
  .catch((err) => {
    console.error(`残留进程检查失败：${err && err.message ? err.message : err}`);
    process.exit(2);
  });
