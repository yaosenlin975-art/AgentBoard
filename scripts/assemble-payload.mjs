#!/usr/bin/env node
/**
 * 便携产物 payload 组装（公共模块，B10 抽取）。
 *
 * 两个调用方共用：
 *   - scripts/package-portable.mjs（Windows 便携包：<stage>/app + runtime/node.exe）
 *   - scripts/desktop/build-macos.mjs（macOS .app：desktop/src-tauri/payload/，经 tauri.macos.conf.json
 *     的 bundle.resources 落进 Contents/Resources/payload/，.app 与 .dmg 同源）
 *
 * 组装内容（appDir 布局与 Windows 便携包一致，壳的 resolve_server_entry/resolve_node 按同一路径找）：
 *   appDir/apps/server/dist/index.js   esbuild 单文件 server 包（external: better-sqlite3 / sherpa-onnx-node）
 *   appDir/apps/web/dist/              web 静态产物
 *   appDir/apps/server/package.json    server 包描述（bindings 解析用）
 *   appDir/node_modules/…              better-sqlite3（含原生 .node）/ bindings / file-uri-to-path /
 *                                      sherpa-onnx-node + 平台二进制包（调用方按平台传 sherpaPlatformPackages）
 *   appDir/package.json                ESM stub
 *   appDir/cli/index.js                仅 includeCli:true（Windows 便携包携带 kb CLI；mac .app 不带）
 */
import { spawnSync } from 'node:child_process';
import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

function fail(message) {
  console.error(`[payload] 失败：${message}`);
  process.exit(1);
}

function log(message) {
  console.log(`[payload] ${message}`);
}

function run(command, commandArgs, options = {}) {
  const result = spawnSync(command, commandArgs, {
    cwd: ROOT,
    stdio: options.quiet ? 'pipe' : 'inherit',
    encoding: 'utf8',
    shell: false,
    timeout: options.timeout ?? 600_000,
  });
  if (result.status !== 0) {
    fail(`${command} ${commandArgs.join(' ')} 退出码 ${result.status}${result.stderr ? `\n${result.stderr}` : ''}`);
  }
  return result;
}

/** CR-13：软链（含 Windows junction）处理统计，组装/打包结束统一打印。目录软链跳过防展开/环，文件软链解引用复制。 */
const symlinkStats = { dereferenced: [], skipped: [] };

function recordSymlink(kind, src, note) {
  const path = relative(ROOT, src).split('\\').join('/');
  if (kind === 'deref') symlinkStats.dereferenced.push(`${path}${note}`);
  else symlinkStats.skipped.push(`${path}${note}`);
}

export function copyTree(src, dest, filter) {
  copyTreeEntry(src, dest, filter, true);
}

/**
 * CR-13：遍历复制改用 lstatSync，软链显式决策，不再 statSync 盲目跟随：
 * - 文件软链 → 解引用复制并计数（保持既有「不漏文件」语义）；
 * - 目录软链 → 跳过并计数（根路径除外：调用方显式指定的来源目录，如技能目录是 junction 时解引用进入）；
 * - 悬空软链 → 跳过并计数。
 * 子级目录软链一律跳过后，遍历只走真实目录树，不可能因软链成环或把目标整树展开。
 */
function copyTreeEntry(src, dest, filter, isRoot) {
  let stat = lstatSync(src);
  if (stat.isSymbolicLink()) {
    let target;
    try {
      target = statSync(src);
    } catch {
      recordSymlink('skip', src, ' → 悬空软链');
      log(`跳过悬空软链：${relative(ROOT, src)}`);
      return;
    }
    if (target.isFile()) {
      recordSymlink('deref', src, ' → 文件软链解引用');
      stat = target;
    } else if (isRoot) {
      recordSymlink('deref', src, ' → 根目录软链解引用');
      stat = target;
    } else {
      recordSymlink('skip', src, ' → 目录软链');
      log(`跳过目录软链（防展开/环）：${relative(ROOT, src)}`);
      return;
    }
  }
  if (stat.isFile()) {
    if (filter && !filter(src, false)) return;
    mkdirSync(dirname(dest), { recursive: true });
    copyFileSync(src, dest);
    return;
  }
  if (filter && !filter(src, true)) return;
  mkdirSync(dest, { recursive: true });
  for (const entry of readdirSync(src, { withFileTypes: true })) {
    copyTreeEntry(join(src, entry.name), join(dest, entry.name), filter, false);
  }
}

/** 打包结束打印软链处理统计（各列表最多展示 20 条，全部路径见逐条日志与计数）。 */
export function logSymlinkStats() {
  const { dereferenced, skipped } = symlinkStats;
  if (dereferenced.length === 0 && skipped.length === 0) return;
  log(`软链处理：解引用复制 ${dereferenced.length} 个，跳过 ${skipped.length} 个`);
  for (const item of dereferenced.slice(0, 20)) log(`  解引用：${item}`);
  for (const item of skipped.slice(0, 20)) log(`  跳过：${item}`);
  if (dereferenced.length > 20 || skipped.length > 20) log('  （仅展示前 20 条）');
}

/** pnpm 虚拟仓库中按包名取一个已安装目录（多个版本时取字典序最后，即最高版本）。 */
export function pnpmPackage(name) {
  const store = join(ROOT, 'node_modules', '.pnpm');
  if (!existsSync(store)) fail('缺少 node_modules/.pnpm，请先执行 pnpm install');
  const dirs = readdirSync(store)
    .filter((entry) => entry.startsWith(`${name}@`))
    .sort();
  if (dirs.length === 0) fail(`node_modules/.pnpm 中找不到 ${name}，请先执行 pnpm install`);
  return join(store, dirs[dirs.length - 1], 'node_modules', name);
}

function findEsbuild() {
  const store = join(ROOT, 'node_modules', '.pnpm');
  const dirs = readdirSync(store)
    .filter((entry) => entry.startsWith('esbuild@'))
    .sort()
    .reverse();
  for (const dir of dirs) {
    const bin = join(store, dir, 'node_modules', 'esbuild', 'bin', 'esbuild');
    if (existsSync(bin)) return bin;
  }
  fail('找不到 esbuild（pnpm 虚拟仓库），请先执行 pnpm install');
}

function bundle(entry, outfile, extra = []) {
  const esbuild = findEsbuild();
  run(
    process.execPath,
    [
      esbuild,
      entry,
      '--bundle',
      '--platform=node',
      '--format=esm',
      // README 前置 Node ≥20：构建机（PATH node）与随包 node（如 mac 的 darwin 22.x）版本可能不同，
      // 取最低支持版本的语法档，产物在新旧 node 上都能跑。
      '--target=node20',
      '--banner:js=import{createRequire as __cr}from\'node:module\';const require=__cr(import.meta.url);',
      ...extra,
      `--outfile=${outfile}`,
      '--log-level=warning',
    ],
    { quiet: true },
  );
}

/**
 * 组装 server payload 到 appDir（布局见文件头注释）。
 * @param {object} options
 * @param {string} options.appDir                目标 app 目录（调用方先建好或由本函数隐式创建）
 * @param {boolean} [options.includeCli=true]    是否携带 kb CLI 单文件包（Windows 便携包 true；mac .app false）
 * @param {string[]} [options.sherpaPlatformPackages=[]] sherpa 平台二进制包名（Windows: ['sherpa-onnx-win-x64']；
 *                                                mac: ['sherpa-onnx-darwin-<arm64|x64>]，由 pnpm 装平台 optionalDependencies）
 */
export function assembleAppPayload({ appDir, includeCli = true, sherpaPlatformPackages = [] }) {
  mkdirSync(join(appDir, 'apps', 'server', 'dist'), { recursive: true });
  if (includeCli) mkdirSync(join(appDir, 'cli'), { recursive: true });

  log('打包 server' + (includeCli ? ' / cli' : '') + ' …');
  bundle(
    join(ROOT, 'apps', 'server', 'dist', 'index.js'),
    join(appDir, 'apps', 'server', 'dist', 'index.js'),
    ['--external:better-sqlite3', '--external:sherpa-onnx-node'],
  );
  if (includeCli) bundle(join(ROOT, 'packages', 'cli', 'dist', 'index.js'), join(appDir, 'cli', 'index.js'));

  log('复制 web 产物与原生依赖 …');
  copyTree(join(ROOT, 'apps', 'web', 'dist'), join(appDir, 'apps', 'web', 'dist'));
  copyFileSync(join(ROOT, 'apps', 'server', 'package.json'), join(appDir, 'apps', 'server', 'package.json'));

  const betterSqlite = pnpmPackage('better-sqlite3');
  const nativeNode = join(betterSqlite, 'build', 'Release', 'better_sqlite3.node');
  if (!existsSync(nativeNode)) fail(`缺少 better_sqlite3.node：${nativeNode}（请先 pnpm install / 重新编译）`);
  mkdirSync(join(appDir, 'node_modules', 'better-sqlite3', 'build', 'Release'), { recursive: true });
  copyTree(join(betterSqlite, 'lib'), join(appDir, 'node_modules', 'better-sqlite3', 'lib'));
  copyFileSync(join(betterSqlite, 'package.json'), join(appDir, 'node_modules', 'better-sqlite3', 'package.json'));
  copyFileSync(join(betterSqlite, 'binding.gyp'), join(appDir, 'node_modules', 'better-sqlite3', 'binding.gyp'));
  copyFileSync(nativeNode, join(appDir, 'node_modules', 'better-sqlite3', 'build', 'Release', 'better_sqlite3.node'));
  const depFilter = (path) => !['test', 'tests', '__tests__'].includes(basename(path)) && !/\.bak$/i.test(basename(path));
  copyTree(pnpmPackage('bindings'), join(appDir, 'node_modules', 'bindings'), depFilter);
  copyTree(pnpmPackage('file-uri-to-path'), join(appDir, 'node_modules', 'file-uri-to-path'), depFilter);
  copyTree(pnpmPackage('sherpa-onnx-node'), join(appDir, 'node_modules', 'sherpa-onnx-node'), depFilter);
  for (const platformPackage of sherpaPlatformPackages) {
    copyTree(pnpmPackage(platformPackage), join(appDir, 'node_modules', platformPackage), depFilter);
  }
  writeFileSync(
    join(appDir, 'package.json'),
    `${JSON.stringify({ name: 'agentboard', version: '0.1.0', private: true, type: 'module' }, null, 2)}\n`,
    'utf8',
  );
}

/**
 * 用指定 node 二进制加载 appDir 内的 better-sqlite3，校验原生模块与随包运行时 ABI 匹配。
 * 返回 { ok, status, stderr }；失败处置（报错文案）由调用方决定。
 */
export function verifyNativeLoad({ nodeBinary, appDir }) {
  const target = join(appDir, 'node_modules', 'better-sqlite3').replace(/\\/g, '/');
  const result = spawnSync(nodeBinary, ['-e', `require(${JSON.stringify(target)})`], {
    cwd: appDir,
    encoding: 'utf8',
  });
  return { ok: result.status === 0, status: result.status, stderr: result.stderr ?? result.error?.message ?? '(无输出)' };
}
