#!/usr/bin/env node
/**
 * Windows 桌面壳构建（DESKTOP-WIN）：Tauri 壳 → agentboard-desktop.exe（+ 可选 NSIS 安装包）。
 *
 * 存在的唯一理由：本机 rustup 装在 D 盘且用了 --no-modify-path，rustc/cargo 默认不可见；
 * 直接调 D:\tools\rust\cargo\bin\cargo.exe 也会因为 rustup 推断家目录到 %USERPROFILE%\.rustup
 * 而报「could not choose a version of cargo to run」。所以两个家目录必须显式给，本脚本负责这件事，
 * 不写任何用户级环境变量，别人 clone 后只要有 rustup 就能跑。
 *
 * 用法：
 *   node scripts/desktop/build-windows.mjs                # 只出 exe（tauri build --no-bundle）
 *   node scripts/desktop/build-windows.mjs --bundles nsis # 出 exe + NSIS 安装包
 *   node scripts/desktop/build-windows.mjs --dry-run      # 只做前置核查并打印计划（同 --check）
 *
 * 退出码：0 成功 / 1 前置缺失或构建失败 / 2 平台不支持
 *
 * 环境覆盖（可选）：
 *   AGENTBOARD_RUSTUP_HOME / AGENTBOARD_CARGO_HOME  自定义 rustup、cargo 家目录
 */
import { existsSync, readdirSync, statSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnFailure } from './spawn-failure.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const DESKTOP = join(ROOT, 'desktop');
const TAURI_DIR = join(DESKTOP, 'src-tauri');
const EXE = join(TAURI_DIR, 'target', 'release', 'agentboard-desktop.exe');
const BUNDLE_DIR = join(TAURI_DIR, 'target', 'release', 'bundle');

const args = process.argv.slice(2);
const valueOf = (name, fallback) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] !== undefined ? args[i + 1] : fallback;
};
const checkOnly = args.includes('--check') || args.includes('--dry-run');
const bundles = valueOf('--bundles', null);

/** 本机 rustup 布局：D 盘、未改 PATH。可用环境变量覆盖，便于换机器。 */
const RUSTUP_HOME = process.env.AGENTBOARD_RUSTUP_HOME ?? 'D:\\tools\\rust\\rustup';
const CARGO_HOME = process.env.AGENTBOARD_CARGO_HOME ?? 'D:\\tools\\rust\\cargo';

function log(message) {
  process.stdout.write(`[win] ${message}\n`);
}

function fail(message, code = 1) {
  process.stderr.write(`[win] 失败：${message}\n`);
  process.exit(code);
}

/** 构建环境：把 rustup/cargo 家目录与 cargo bin 显式塞进子进程环境，不碰系统环境 */
function buildEnv() {
  const sep = ';';
  const cargoBin = join(CARGO_HOME, 'bin');
  const env = {
    ...process.env,
    RUSTUP_HOME,
    CARGO_HOME,
    PATH: `${cargoBin}${sep}${process.env.PATH ?? ''}`,
  };
  return env;
}

function run(cmd, cmdArgs, options = {}) {
  log(`$ ${cmd} ${cmdArgs.join(' ')}`);
  const result = spawnSync(cmd, cmdArgs, {
    cwd: options.cwd ?? ROOT,
    stdio: 'inherit',
    shell: options.shell ?? false,
    env: options.env ?? buildEnv(),
  });
  const failure = spawnFailure(cmd, result);
  if (failure) fail(failure);
}

/** 前置核查：工程、rust 工具链、tauri CLI、MSVC 链接器 */
function preflight() {
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

function build() {
  const tauriArgs = ['build'];
  if (bundles === null) tauriArgs.push('--no-bundle');
  else tauriArgs.push('--bundles', bundles);

  // .cmd 垫片必须经 shell 启动（Windows 不能直接 CreateProcess 一个 .cmd）
  run(join(DESKTOP, 'node_modules', '.bin', 'tauri.cmd'), tauriArgs, {
    cwd: DESKTOP,
    shell: true,
  });
}

function report() {
  if (existsSync(EXE)) {
    const size = statSync(EXE).size;
    log(`exe ${EXE}`);
    log(`    ${(size / 1024 / 1024).toFixed(2)} MB`);
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
      for (const file of found) {
        log(`    ${file}  ${(statSync(file).size / 1024 / 1024).toFixed(2)} MB`);
      }
    }
  }
}

function main() {
  if (process.platform !== 'win32') fail(`当前 ${process.platform}，本脚本只做 Windows 构建`, 2);
  log(`RUSTUP_HOME=${RUSTUP_HOME}`);
  log(`CARGO_HOME=${CARGO_HOME}`);
  preflight();
  if (checkOnly) {
    log('--dry-run/--check：只打印计划，不构建');
    return;
  }
  const startedAt = Date.now();
  build();
  log(`构建耗时 ${Math.round((Date.now() - startedAt) / 1000)}s`);
  report();
}

main();
