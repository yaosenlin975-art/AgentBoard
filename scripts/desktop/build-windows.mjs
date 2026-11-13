#!/usr/bin/env node
/**
 * Windows 桌面壳构建（DESKTOP-WIN）：Tauri 壳 → agentboard-desktop.exe（+ 可选 NSIS 安装包）。
 *
 * 两个存在理由：
 *  1) 本机 rustup 装在 D 盘且用了 --no-modify-path，rustc/cargo 默认不可见；直接调
 *     D:\tools\rust\cargo\bin\cargo.exe 也会因为 rustup 推断家目录到 %USERPROFILE%\.rustup
 *     而报「could not choose a version of cargo to run」。两个家目录必须显式给，本脚本负责，
 *     不写任何用户级环境变量，别人 clone 后只要有 rustup 就能跑。
 *  2) 打安装包时的运行时树（node.exe + server 部署树 + web dist）必须由脚本预置，
 *     手工拷贝下次构建就断。见 prepareRuntime()。
 *
 * 用法：
 *   node scripts/desktop/build-windows.mjs                # 只出 exe（tauri build --no-bundle）
 *   node scripts/desktop/build-windows.mjs --bundles nsis # 出 exe + NSIS 安装包（含运行时）
 *   node scripts/desktop/build-windows.mjs --dry-run      # 只做前置核查并打印计划（同 --check）
 *
 * 环境坑（pnpm 非 TTY 阻塞、corepack spawn 陷阱）与安装包内嵌 exe 的新旧判定方法见
 * `Docs/desktop-build-pitfalls.md`。
 *   node scripts/desktop/build-windows.mjs --skip-runtime # 跳过运行时预置（只验壳本体编译）
 *
 * 退出码：0 成功 / 1 前置缺失或构建失败 / 2 平台不支持
 *
 * 环境覆盖（可选）：
 *   AGENTBOARD_RUSTUP_HOME / AGENTBOARD_CARGO_HOME  自定义 rustup、cargo 家目录
 *   AGENTBOARD_NODE_EXE                           指定内嵌 node.exe（默认发现真 node）
 */
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnFailure } from './spawn-failure.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const DESKTOP = join(ROOT, 'desktop');
const TAURI_DIR = join(DESKTOP, 'src-tauri');
const EXE = join(TAURI_DIR, 'target', 'release', 'agentboard-desktop.exe');
const BUNDLE_DIR = join(TAURI_DIR, 'target', 'release', 'bundle');

/**
 * 运行时暂存树。Tauri 的 bundle.resources 在 Windows 上落到**exe 同级目录**，
 * 而壳的查找顺序（desktop/src-tauri/src/server_process.rs:237-273）按 exe_dir 相对定位：
 *   exe_dir/apps/server/dist/index.js       ← 候选 3
 *   exe_dir/runtime/node.exe                ← 候选 4
 * 所以暂存树做成 apps/ + runtime/ 两棵，resources 直接映射到 exe 根下的同名目录。
 */
const STAGE_DIR = join(TAURI_DIR, 'bundle-stage');
const STAGE_APPS = join(STAGE_DIR, 'apps');
const STAGE_RUNTIME = join(STAGE_DIR, 'runtime');
const STAGE_SERVER = join(STAGE_APPS, 'server');
const STAGE_WEB = join(STAGE_APPS, 'web', 'dist');
const STAGE_NODE = join(STAGE_RUNTIME, 'node.exe');

const args = process.argv.slice(2);
const valueOf = (name, fallback) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] !== undefined ? args[i + 1] : fallback;
};
const checkOnly = args.includes('--check') || args.includes('--dry-run');
const skipRuntime = args.includes('--skip-runtime');
const bundles = valueOf('--bundles', null);

/** 本机 rustup 布局：D 盘、未改 PATH。可用环境变量覆盖，便于换机器。 */
const RUSTUP_HOME = process.env.AGENTBOARD_RUSTUP_HOME ?? 'D:\\tools\\rust\\rustup';
const CARGO_HOME = process.env.AGENTBOARD_CARGO_HOME ?? 'D:\\tools\\rust\\cargo';

/** deploy 树里只需要运行期真正要用的部分（src/test/tsconfig 是源码与测试，不进包） */
const SERVER_KEEP = ['dist', 'node_modules', 'package.json'];

function log(message) {
  process.stdout.write(`[win] ${message}\n`);
}

function fail(message, code = 1) {
  process.stderr.write(`[win] 失败：${message}\n`);
  process.exit(code);
}

function mb(bytes) {
  return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
}

function dirSize(dir) {
  let total = 0;
  const stack = [dir];
  while (stack.length > 0) {
    const cur = stack.pop();
    let entries;
    try {
      entries = readdirSync(cur, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const full = join(cur, entry.name);
      if (entry.isDirectory()) stack.push(full);
      else if (entry.isFile()) {
        try {
          total += statSync(full).size;
        } catch {
          // 忽略断裂链接
        }
      }
    }
  }
  return total;
}

function sha256(file) {
  return createHash('sha256').update(readFileSync(file)).digest('hex');
}

/** 构建环境：把 rustup/cargo 家目录与 cargo bin 显式塞进子进程环境，不碰系统环境 */
function buildEnv() {
  const cargoBin = join(CARGO_HOME, 'bin');
  return {
    ...process.env,
    RUSTUP_HOME,
    CARGO_HOME,
    PATH: `${cargoBin};${process.env.PATH ?? ''}`,
  };
}

function run(cmd, cmdArgs, options = {}) {
  log(`$ ${cmd} ${cmdArgs.join(' ')}`);
  const result = spawnSync(cmd, cmdArgs, {
    cwd: options.cwd ?? ROOT,
    stdio: 'inherit',
    shell: false,
    env: options.env ?? buildEnv(),
  });
  const failure = spawnFailure(cmd, result);
  if (failure) fail(failure);
}

/** Windows 下跑 .cmd 垫片：显式经 cmd.exe，避免 spawnSync(shell:true) 的 DEP0190 与参数拼接问题 */
function runCmdShim(shimPath, shimArgs, options = {}) {
  run(process.env.COMSPEC ?? 'cmd.exe', ['/d', '/s', '/c', shimPath, ...shimArgs], options);
}

/** 前置核查：工程、rust 工具链、tauri CLI，以及（出包时）server/web 构建产物 */
function preflight(needsRuntime) {
  const problems = [];

  const shellOk = existsSync(join(TAURI_DIR, 'Cargo.toml')) && existsSync(join(TAURI_DIR, 'tauri.conf.json'));
  log(`${shellOk ? 'OK  ' : 'MISS'} Tauri 壳工程 ${TAURI_DIR}`);
  if (!shellOk) problems.push('desktop/src-tauri 缺 Cargo.toml 或 tauri.conf.json');

  for (const [label, file] of [
    ['rustup home', RUSTUP_HOME],
    ['cargo home', CARGO_HOME],
    ['rustc', join(CARGO_HOME, 'bin', 'rustc.exe')],
    ['cargo', join(CARGO_HOME, 'bin', 'cargo.exe')],
  ]) {
    const ok = existsSync(file);
    log(`${ok ? 'OK  ' : 'MISS'} ${label} ${file}`);
    if (!ok) problems.push(`缺少 ${label}: ${file}`);
  }

  const tauriCli = join(DESKTOP, 'node_modules', '.bin', 'tauri.cmd');
  const tauriOk = existsSync(tauriCli);
  log(`${tauriOk ? 'OK  ' : 'MISS'} tauri CLI ${tauriCli}`);
  if (!tauriOk) problems.push('缺 Tauri CLI：先 corepack pnpm --dir desktop install');

  if (needsRuntime) {
    for (const [label, file] of [
      ['server 构建产物', join(ROOT, 'apps', 'server', 'dist', 'index.js')],
      ['web 构建产物', join(ROOT, 'apps', 'web', 'dist', 'index.html')],
    ]) {
      const ok = existsSync(file);
      log(`${ok ? 'OK  ' : 'MISS'} ${label} ${file}`);
      if (!ok) problems.push(`缺 ${label}：先在仓库根执行 corepack pnpm -r build`);
    }
  }

  if (!checkOnly) {
    const rustc = spawnSync(join(CARGO_HOME, 'bin', 'rustc.exe'), ['-V'], { encoding: 'utf8', env: buildEnv() });
    if (rustc.status === 0) log(`OK   rustc ${rustc.stdout.trim()}`);
    else {
      log('MISS rustc 无法执行');
      problems.push('rustc 执行失败，检查 RUSTUP_HOME/CARGO_HOME');
    }
    const cargo = spawnSync(join(CARGO_HOME, 'bin', 'cargo.exe'), ['-V'], { encoding: 'utf8', env: buildEnv() });
    if (cargo.status === 0) log(`OK   cargo ${cargo.stdout.trim()}`);
    else {
      log('MISS cargo 无法执行');
      problems.push('cargo 执行失败，检查 RUSTUP_HOME/CARGO_HOME');
    }
  }

  if (problems.length > 0) fail(`前置未通过：\n  ${problems.join('\n  ')}`);
  log('前置核查通过');
}

/**
 * 找出**真** node.exe：能直接 `<path> -v` 输出 vX.Y.Z 的才算，
 * 排除 pnpm/corepack 的 .cmd 垫片（它们不是 exe，spawn 不出这种输出）。
 */
function resolveNodeExe() {
  const candidates = [];
  if (process.env.AGENTBOARD_NODE_EXE) candidates.push(['AGENTBOARD_NODE_EXE', process.env.AGENTBOARD_NODE_EXE]);
  candidates.push(['process.execPath', process.execPath]);
  candidates.push(['Program Files', 'C:\\Program Files\\nodejs\\node.exe']);

  for (const [label, candidate] of candidates) {
    if (!candidate || !candidate.toLowerCase().endsWith('.exe') || !existsSync(candidate)) continue;
    const probe = spawnSync(candidate, ['-v'], { encoding: 'utf8' });
    const version = probe.status === 0 ? (probe.stdout ?? '').trim() : '';
    if (/^v\d+\.\d+\.\d+$/.test(version)) {
      return { label, path: candidate, version };
    }
    log(`跳过 ${label}：${candidate} 不是可执行的 node（-v 输出 "${version}"）`);
  }
  fail(
    '找不到真实 node.exe。已尝试 process.execPath 与 C:\\Program Files\\nodejs\\node.exe。\n' +
      '  用 AGENTBOARD_NODE_EXE=<path> 指定一个能独立跑 `-v` 的 node。',
  );
}

/** 用 pnpm deploy 出 server 的真实目录树（hoisted，无 pnpm 符号链接），只保留运行期需要的部分 */
function deployServer() {
  const staging = join(STAGE_DIR, '.server-deploy');
  rmSync(staging, { recursive: true, force: true });
  mkdirSync(dirname(staging), { recursive: true });

  runCmdShim(
    'pnpm.cmd',
    [
      '--config.verify-deps-before-run=false',
      '--filter',
      '@agentboard/server',
      'deploy',
      staging,
      '--prod',
      '--legacy',
      '--config.node-linker=hoisted',
    ],
    { cwd: ROOT },
  );

  rmSync(STAGE_SERVER, { recursive: true, force: true });
  mkdirSync(STAGE_SERVER, { recursive: true });
  for (const name of SERVER_KEEP) {
    const from = join(staging, name);
    if (!existsSync(from)) fail(`deploy 结果缺 ${name}：${from}`);
    cpSync(from, join(STAGE_SERVER, name), { recursive: true });
  }

  // 关键运行期依赖与原生二进制必须在位（better-sqlite3 12.x 走 build/Release，13.x 走 prebuilds）
  const required = [
    join(STAGE_SERVER, 'node_modules', 'better-sqlite3'),
    join(STAGE_SERVER, 'node_modules', '@agentboard', 'adapters'),
    join(STAGE_SERVER, 'node_modules', '@agentboard', 'shared'),
    join(STAGE_SERVER, 'node_modules', 'express'),
    join(STAGE_SERVER, 'node_modules', 'ws'),
    join(STAGE_SERVER, 'node_modules', 'zod'),
  ];
  const missing = required.filter((p) => !existsSync(p));
  if (missing.length > 0) fail(`server 部署树缺运行期依赖：\n  ${missing.join('\n  ')}`);

  const native = [
    join(STAGE_SERVER, 'node_modules', 'better-sqlite3', 'prebuilds', 'win32-x64.node'),
    join(STAGE_SERVER, 'node_modules', 'better-sqlite3', 'build', 'Release', 'better_sqlite3.node'),
  ];
  if (!native.some(existsSync)) {
    fail(`better-sqlite3 原生二进制缺失（已找 prebuilds/win32-x64.node 与 build/Release/better_sqlite3.node）`);
  }

  // 部署树里可能混入测试/源码残留，清掉免得进包
  for (const junk of ['src', 'test', 'scripts', 'B'])
    rmSync(join(STAGE_SERVER, junk), { recursive: true, force: true });
  rmSync(staging, { recursive: true, force: true });

  const bytes = dirSize(STAGE_SERVER);
  log(`server 部署树 ${STAGE_SERVER}  ${mb(bytes)}`);
  return bytes;
}

function copyWeb() {
  const source = join(ROOT, 'apps', 'web', 'dist');
  rmSync(STAGE_WEB, { recursive: true, force: true });
  mkdirSync(dirname(STAGE_WEB), { recursive: true });
  cpSync(source, STAGE_WEB, { recursive: true });
  const bytes = dirSize(STAGE_WEB);
  log(`web 产物 ${STAGE_WEB}  ${mb(bytes)}`);
  return bytes;
}

function copyNode() {
  const found = resolveNodeExe();
  rmSync(STAGE_RUNTIME, { recursive: true, force: true });
  mkdirSync(STAGE_RUNTIME, { recursive: true });
  cpSync(found.path, STAGE_NODE);
  const hash = sha256(STAGE_NODE);
  const bytes = statSync(STAGE_NODE).size;
  log(`node ${found.version} 来源 ${found.label} ${found.path}`);
  log(`    → ${STAGE_NODE}  ${mb(bytes)}  sha256 ${hash}`);
  return { version: found.version, source: found.path, sha256: hash, bytes };
}

/** 预置 runtime 树 + 写清单，供 tauri.conf.json 的 bundle.resources 收集 */
function prepareRuntime() {
  log('预置运行时树（node + server 部署树 + web 产物）');
  mkdirSync(STAGE_DIR, { recursive: true });
  const serverBytes = deployServer();
  const webBytes = copyWeb();
  const node = copyNode();

  const manifest = {
    generatedBy: 'scripts/desktop/build-windows.mjs',
    generatedAt: new Date().toISOString(),
    node,
    sizes: { server: serverBytes, web: webBytes, total: dirSize(STAGE_DIR) },
  };
  writeFileSync(join(STAGE_DIR, 'runtime-manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  log(`运行时树合计 ${mb(manifest.sizes.total)}`);
  return manifest;
}

function build() {
  const tauriArgs = ['build'];
  if (bundles === null) tauriArgs.push('--no-bundle');
  else tauriArgs.push('--bundles', bundles);

  runCmdShim(join(DESKTOP, 'node_modules', '.bin', 'tauri.cmd'), tauriArgs, { cwd: DESKTOP });
}

function report() {
  if (existsSync(EXE)) {
    log(`exe ${EXE}  ${mb(statSync(EXE).size)}`);
  } else {
    fail(`未产出 ${EXE}`);
  }

  if (existsSync(BUNDLE_DIR)) {
    const found = [];
    const walk = (dir) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (/\.(exe|msi)$/i.test(entry.name)) found.push(full);
      }
    };
    walk(BUNDLE_DIR);
    if (found.length > 0) {
      log('安装包：');
      for (const file of found) log(`    ${file}  ${mb(statSync(file).size)}`);
    }
  }
}

function main() {
  if (process.platform !== 'win32') fail(`当前 ${process.platform}，本脚本只做 Windows 构建`, 2);
  log(`RUSTUP_HOME=${RUSTUP_HOME}`);
  log(`CARGO_HOME=${CARGO_HOME}`);

  // 只有出安装包（--bundles）才需要运行时树；--no-bundle 只编壳本体
  const needsRuntime = bundles !== null && !skipRuntime;
  log(`运行时预置：${needsRuntime ? '需要' : '跳过（--no-bundle 或 --skip-runtime）'}`);

  preflight(needsRuntime);
  if (checkOnly) {
    log('--dry-run/--check：只打印计划，不构建');
    return;
  }

  const startedAt = Date.now();
  if (needsRuntime) prepareRuntime();
  build();
  log(`构建耗时 ${Math.round((Date.now() - startedAt) / 1000)}s`);
  report();
}

main();
