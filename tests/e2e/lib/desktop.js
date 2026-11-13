'use strict';

/**
 * Electron 启动与断言公共层（供 tests/e2e/specs 与 standalone 脚本复用）。
 *
 * 设计要点：
 *  - 只做「造隔离环境 → 启动 → 拿窗口 → 收尾」四件事，不塞业务断言，避免用例互相污染；
 *  - 隔离靠 Chromium 开关 `--user-data-dir=<tmp>`：实测 Electron 45 在 Windows 上
 *    取 appData 走 KnownFolder，改 APPDATA 环境变量无效（app.getPath('appData') 仍是 Roaming），
 *    唯独 --user-data-dir 能把 userData 整体挪走 —— 因此 DB、config.json、window-state、
 *    主进程日志全部落到临时目录，绝不碰真实 %APPDATA%\AgentBoard，也就不影响在跑的 8787 现网实例；
 *  - 端口用 AGENTBOARD_PORT 注入，与 apps/desktop/src/main.js 的 resolvePort 同语义；
 *  - 收尾一律走 electronApp.close()，残留进程另由 scripts/check-residual-processes.mjs 判。
 */
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { _electron: electron } = require('@playwright/test');

/** 仓库根：tests/e2e/lib -> ../../.. */
const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');

/** dev 模式 electron 二进制（由 apps/desktop 的 devDependency 提供） */
const DEV_ELECTRON = path.join(REPO_ROOT, 'apps', 'desktop', 'node_modules', 'electron', 'dist', 'electron.exe');

/** apps/desktop 目录（dev 启动时 electron 的工作目录，等价命令行 `electron apps/desktop`） */
const DESKTOP_DIR = path.join(REPO_ROOT, 'apps', 'desktop');

/** 打包产物可执行文件（C3 产出，存在才用） */
const PACKAGED_EXE = path.join(REPO_ROOT, 'dist-desktop', 'out', 'win-unpacked', 'AgentBoard.exe');

/** 便携版（单文件 exe）：扫描 dist-desktop/out 下最新一个 .exe */
function findPortableExe() {
  const outDir = path.join(REPO_ROOT, 'dist-desktop', 'out');
  if (!fs.existsSync(outDir)) return null;
  const hits = fs
    .readdirSync(outDir)
    .filter((name) => name.toLowerCase().endsWith('.exe'))
    .map((name) => path.join(outDir, name))
    .sort();
  return hits.length > 0 ? hits[hits.length - 1] : null;
}

/** 取一个空闲 TCP 端口（绑 0 交给系统分配后立即释放） */
async function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address();
      const port = typeof addr === 'object' && addr !== null ? addr.port : 0;
      srv.close(() => resolve(port));
    });
  });
}

/**
 * 造一份隔离环境：临时 userData 目录 + 独立端口。
 * @param {{port?: number, overrides?: object}} [options]
 */
async function makeIsolatedEnv({ port: fixedPort, overrides = {} } = {}) {
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentboard-e2e-'));
  const port = fixedPort ?? (await freePort());

  /** 继承环境，剔除会把 electron.exe 变成纯 Node 的变量（本机全局有 ELECTRON_RUN_AS_NODE=1） */
  const inherited = { ...process.env };
  for (const key of ['ELECTRON_RUN_AS_NODE', 'NODE_OPTIONS']) delete inherited[key];

  const env = {
    ...inherited,
    AGENTBOARD_PORT: String(port),
    ELECTRON_ENABLE_LOGGING: '1',
    ...overrides,
  };

  return {
    userDataDir,
    port,
    env,
    logDir: path.join(userDataDir, 'logs'),
    mainLog: path.join(userDataDir, 'logs', 'main.log'),
    dbPath: path.join(userDataDir, 'agentboard.db'),
    /** 传给 electron.launch 的额外参数 */
    userDataArgs: [`--user-data-dir=${userDataDir}`],
    dispose() {
      try {
        fs.rmSync(userDataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
      } catch {
        // 目录仍被占用时留给系统清理，不掩盖真实断言结果
      }
    },
  };
}

/**
 * 启动 dev 模式桌面端（等价命令行 `electron apps/desktop`：cwd 在 apps/desktop，参数 '.'）。
 * @param {{env: object, args?: string[], cwd?: string, timeout?: number}} options
 */
async function launchDev({ env, args = [], cwd = DESKTOP_DIR, timeout = 60000 }) {
  if (!fs.existsSync(DEV_ELECTRON)) {
    throw new Error(`找不到 dev 模式 electron：${DEV_ELECTRON}（先在 apps/desktop 装依赖）`);
  }
  return electron.launch({ executablePath: DEV_ELECTRON, args: ['.', ...args], cwd, env, timeout });
}

/**
 * 启动已打包的 win-unpacked 可执行文件。
 * @param {{env: object, args?: string[], timeout?: number}} options
 */
async function launchPackaged({ env, args = [], timeout = 60000 }) {
  if (!fs.existsSync(PACKAGED_EXE)) {
    throw new Error(`找不到打包产物：${PACKAGED_EXE}（先跑 pnpm build:desktop:dir）`);
  }
  return electron.launch({ executablePath: PACKAGED_EXE, args, env, timeout });
}

/** 拿首个窗口并等 DOM 就绪；同时收集渲染进程 console/pageerror，便于失败定位 */
async function firstWindowReady(app, { timeout = 30000 } = {}) {
  const window = await app.firstWindow({ timeout });
  const consoleLines = [];
  window.on('console', (msg) => consoleLines.push(`[${msg.type()}] ${msg.text()}`));
  window.on('pageerror', (err) => consoleLines.push(`[pageerror] ${err.message}`));
  await window.waitForLoadState('domcontentloaded', { timeout });
  return { window, consoleLines };
}

/** 读主进程日志（main.log），缺失返回空串 */
function readMainLog(env) {
  try {
    return fs.readFileSync(env.mainLog, 'utf8');
  } catch {
    return '';
  }
}

/** 读服务子进程日志（server-YYYYMMDD.log，取目录里最新一份） */
function readServerLog(env) {
  try {
    const files = fs
      .readdirSync(env.logDir)
      .filter((name) => name.startsWith('server-') && name.endsWith('.log'))
      .sort();
    if (files.length === 0) return '';
    return fs.readFileSync(path.join(env.logDir, files[files.length - 1]), 'utf8');
  } catch {
    return '';
  }
}

module.exports = {
  REPO_ROOT,
  DESKTOP_DIR,
  DEV_ELECTRON,
  PACKAGED_EXE,
  findPortableExe,
  freePort,
  makeIsolatedEnv,
  launchDev,
  launchPackaged,
  firstWindowReady,
  readMainLog,
  readServerLog,
};
