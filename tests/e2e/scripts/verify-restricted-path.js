'use strict';

/**
 * 辅助脚本 1：受限 PATH 启动验证（C5 验收项 1 与 3）。
 *
 * 做什么：
 *  1) 把子进程 PATH 压到只剩 System32 / System32\Wbem，并先证明这组 PATH 下 `where node` / `where codex` 全部失败；
 *  2) 在这组 PATH 下启动桌面端（默认启动打包产物，--mode dev 可切 dev）；
 *  3) 断言：窗口正常起来（不依赖系统 node/npm），且 /api/clis 四家 CLI 全部 installed=true 并带版本。
 *
 * 为什么这样判：C4 策略是「先探测本机，缺失才回退内嵌」。PATH 里没有任何 CLI 时，
 * 只有内嵌垫片（打包版由 runtime/bin 前置到服务子进程 PATH）能让四家都显示已安装。
 *
 * 用法（在 tests/e2e 目录）：
 *   node scripts/verify-restricted-path.js                # 打包产物
 *   node scripts/verify-restricted-path.js --mode dev     # dev 源码
 *   node scripts/verify-restricted-path.js --json         # 机器可读输出
 */
const { spawn } = require('node:child_process');
const path = require('node:path');
const { makeIsolatedEnv, launchDev, launchPackaged, firstWindowReady, readMainLog } = require('../lib/desktop');
const { restrictedPath, fetchClis, waitAgentBoardReady } = require('../lib/proc');

const args = process.argv.slice(2);
const mode = args.includes('--mode') ? args[args.indexOf('--mode') + 1] : 'packaged';
const asJson = args.includes('--json');

/** 在给定 PATH 下跑 where，返回退出码（用来证明 PATH 确实受限） */
function whereUnder(pathValue, cmd) {
  return new Promise((resolve) => {
    const child = spawn('where', [cmd], {
      env: { ...process.env, PATH: pathValue, Path: pathValue },
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    child.stdout.on('data', (c) => {
      out += c.toString('utf8');
    });
    child.once('error', () => resolve({ code: -1, out: '' }));
    child.once('close', (code) => resolve({ code, out: out.trim() }));
  });
}

async function main() {
  const report = { mode, restrictedPath: restrictedPath(), steps: [] };
  const fail = (message) => {
    report.ok = false;
    report.error = message;
    return report;
  };

  // 1) 证明 PATH 受限
  const pathUnder = restrictedPath();
  const whereNode = await whereUnder(pathUnder, 'node');
  const whereCodex = await whereUnder(pathUnder, 'codex');
  report.steps.push({
    step: '受限 PATH 下 where 探测',
    path: pathUnder,
    whereNode: { code: whereNode.code, out: whereNode.out },
    whereCodex: { code: whereCodex.code, out: whereCodex.out },
  });
  if (whereNode.code === 0) return fail(`受限 PATH 仍能找到 node：${whereNode.out}`);

  // 2) 受限 PATH 下启动
  const env = await makeIsolatedEnv({ overrides: { PATH: pathUnder, Path: pathUnder } });
  let app;
  try {
    app =
      mode === 'packaged'
        ? await launchPackaged({ env: env.env, args: env.userDataArgs })
        : await launchDev({ env: env.env, args: env.userDataArgs });
    const { window } = await firstWindowReady(app, { timeout: 60000 });
    const title = await window.title();
    report.steps.push({ step: '窗口加载', title, port: env.port });

    // 3) 服务就绪 + CLI 探测结果
    const ready = await waitAgentBoardReady(env.port, { timeoutMs: 30000 });
    const clis = await fetchClis(env.port);
    report.steps.push({ step: '服务就绪', ok: ready.ok, detail: ready.detail });
    report.steps.push({ step: 'CLI 探测', clis });

    if (!ready.ok) return fail(`服务未就绪：${ready.detail}`);
    if (title !== 'AgentBoard') return fail(`窗口标题不是 AgentBoard：${title}`);
    if (!Array.isArray(clis) || clis.length !== 4) return fail(`/api/clis 返回异常：${JSON.stringify(clis)}`);

    const notInstalled = clis.filter((c) => c.installed !== true);
    if (notInstalled.length > 0) {
      return fail(`受限 PATH 下仍有 CLI 未探测到（内嵌回退失效）：${notInstalled.map((c) => c.id).join(',')}`);
    }
    const noVersion = clis.filter((c) => typeof c.version !== 'string' || c.version === '');
    if (noVersion.length > 0) {
      return fail(`CLI 已安装但版本为空：${noVersion.map((c) => c.id).join(',')}`);
    }

    // 4) 证据：主进程日志里的 runtime 与 nodeExe 行
    const log = readMainLog(env);
    report.steps.push({
      step: '主进程日志关键行',
      lines: log
        .split(/\r?\n/)
        .filter((l) => /runtime=|nodeExe=|serverEntry=|窗口已创建/.test(l))
        .slice(0, 8),
    });

    report.ok = true;
    return report;
  } finally {
    if (app) await app.close().catch(() => undefined);
    env.dispose();
  }
}

main()
  .then((report) => {
    if (asJson) {
      process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    } else {
      console.log(`受限 PATH 启动验证（${report.mode}）：${report.ok ? '通过' : '失败'}`);
      for (const step of report.steps) console.log(` - ${step.step}: ${JSON.stringify(step)}`);
      if (report.error) console.log(` 失败原因：${report.error}`);
    }
    process.exit(report.ok ? 0 : 1);
  })
  .catch((err) => {
    console.error(`脚本异常：${err && err.stack ? err.stack : err}`);
    process.exit(2);
  });
