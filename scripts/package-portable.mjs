#!/usr/bin/env node
/**
 * 便携包打包（Windows x64，免装 Node）。
 *
 * 用法：
 *   pnpm package:portable
 *   node scripts/package-portable.mjs [--out <目录>] [--zip <文件>] [--skip-build] [--no-zip]
 *
 * 固定步骤（不可省）：
 *   1. 构建 server / web / cli（+ 桌面壳；已存在 release exe 时直接复用）
 *   2. 组装 runtime(node.exe) + server 单文件包 + web 静态产物 + cli + 原生模块
 *   3. 携带桌面壳到 app/desktop/（start-desktop.cmd 调用；缺失时降级为浏览器模式）
 *   4. 携带配套规则到 app/rules/（AGENTS.md、README.md、Docs/api.md、7 个技能）
 *   5. 生成 app/rules-manifest.json 并跑包内自检 app/verify-rules.mjs
 *   6. 打 zip（顶层目录 AgentBoard）
 *
 * 规则来源：仓库 skills/ 优先；缺失的从 %AGENTBOARD_SKILLS_SRC%（默认 %USERPROFILE%\.agents\skills）取。
 * 外部技能不受本仓库 git 跟踪，来源会写进 rules-manifest.json。
 * 注：ask-user 属本仓库技能（DEC-5），不会回落到全局 ~/.agents/AGENTS.md 原文。
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const TEMPLATES = join(ROOT, 'scripts', 'portable');
const PKG_NAME = 'AgentBoard';
/** Tauri 壳的 release 产物（来源只读；壳按相对路径找 ../apps/server/dist 与 ../../runtime/node.exe）。 */
const DESKTOP_EXE = join(ROOT, 'desktop', 'src-tauri', 'target', 'release', 'agentboard-desktop.exe');
const REQUIRED_SKILLS = ['using-agentboard', 'writing-task', 'executing-task', 'handoff', 'swing-dev', 'ask-user', 'brainstorming'];
const RULE_DOCS = [
  { src: 'AGENTS.md', dest: 'AGENTS.md' },
  { src: 'README.md', dest: 'README.md' },
  { src: join('Docs', 'api.md'), dest: join('Docs', 'api.md') },
];

const args = process.argv.slice(2);
const opts = {
  out: join(ROOT, 'dist-package'),
  zip: null,
  skipBuild: false,
  noZip: false,
};
for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (a === '--out') opts.out = args[++i];
  else if (a === '--zip') opts.zip = args[++i];
  else if (a === '--skip-build') opts.skipBuild = true;
  else if (a === '--no-zip') opts.noZip = true;
  else fail(`未知参数: ${a}`);
}

function fail(message) {
  console.error(`[package] 失败：${message}`);
  process.exit(1);
}

function log(message) {
  console.log(`[package] ${message}`);
}

function run(command, commandArgs, options = {}) {
  const result = spawnSync(command, commandArgs, {
    cwd: ROOT,
    stdio: options.quiet ? 'pipe' : 'inherit',
    encoding: 'utf8',
    shell: options.shell ?? false,
    timeout: options.timeout ?? 600_000,
  });
  if (result.status !== 0) {
    fail(`${command} ${commandArgs.join(' ')} 退出码 ${result.status}${result.stderr ? `\n${result.stderr}` : ''}`);
  }
  return result;
}

function git(...commandArgs) {
  const result = spawnSync('git', commandArgs, { cwd: ROOT, encoding: 'utf8' });
  return result.status === 0 ? result.stdout.trim() : '';
}

function sha256(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function walk(dir, base = dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full, base));
    else if (entry.isFile()) out.push(relative(base, full).split('\\').join('/'));
  }
  return out;
}

/** CR-13：软链（含 Windows junction）处理统计，打包结束统一打印。目录软链跳过防展开/环，文件软链解引用复制。 */
const symlinkStats = { dereferenced: [], skipped: [] };

function recordSymlink(kind, src, note) {
  const path = relative(ROOT, src).split('\\').join('/');
  if (kind === 'deref') symlinkStats.dereferenced.push(`${path}${note}`);
  else symlinkStats.skipped.push(`${path}${note}`);
}

function copyTree(src, dest, filter) {
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
function logSymlinkStats() {
  const { dereferenced, skipped } = symlinkStats;
  if (dereferenced.length === 0 && skipped.length === 0) return;
  log(`软链处理：解引用复制 ${dereferenced.length} 个，跳过 ${skipped.length} 个`);
  for (const item of dereferenced.slice(0, 20)) log(`  解引用：${item}`);
  for (const item of skipped.slice(0, 20)) log(`  跳过：${item}`);
  if (dereferenced.length > 20 || skipped.length > 20) log('  （仅展示前 20 条）');
}

/** pnpm 虚拟仓库中按包名取一个已安装目录（多个版本时取字典序最后，即最高版本）。 */
function pnpmPackage(name) {
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
      '--target=node24',
      '--banner:js=import{createRequire as __cr}from\'node:module\';const require=__cr(import.meta.url);',
      ...extra,
      `--outfile=${outfile}`,
      '--log-level=warning',
    ],
    { quiet: true },
  );
}

function copyRules(appDir) {
  const rulesDir = join(appDir, 'rules');
  const sources = [];
  mkdirSync(rulesDir, { recursive: true });

  for (const doc of RULE_DOCS) {
    const src = join(ROOT, doc.src);
    if (!existsSync(src)) fail(`规则文档缺失：${doc.src}（这是打包硬口径，必须先补齐）`);
    copyTree(src, join(rulesDir, doc.dest));
    sources.push({ name: doc.dest.split('\\').join('/'), path: src, tracked: Boolean(git('ls-files', '--', doc.src)) });
  }

  const externalRoot = process.env.AGENTBOARD_SKILLS_SRC || join(homedir(), '.agents', 'skills');
  const skillFilter = (path) => !/\.bak|test-prompts\.json$|\.DS_Store$|\.log$/i.test(basename(path));
  for (const skill of REQUIRED_SKILLS) {
    const repoDir = join(ROOT, 'skills', skill);
    const srcDir = existsSync(join(repoDir, 'SKILL.md')) ? repoDir : join(externalRoot, skill);
    if (!existsSync(join(srcDir, 'SKILL.md'))) {
      fail(`技能缺失：${skill}（仓库 skills/${skill} 与 ${join(externalRoot, skill)} 都没有 SKILL.md）`);
    }
    copyTree(srcDir, join(rulesDir, 'skills', skill), skillFilter);
    const trackedRoot = git('ls-files', '--', join('skills', skill));
    sources.push({
      name: `skills/${skill}`,
      path: srcDir,
      tracked: trackedRoot.length > 0 && srcDir.startsWith(ROOT),
    });
  }
  return sources;
}

function writeManifest(appDir, sources, head) {
  const rulesDir = join(appDir, 'rules');
  const files = walk(rulesDir)
    .sort()
    .map((path) => ({ path, sha256: sha256(join(rulesDir, path)) }));
  const manifest = {
    package: PKG_NAME,
    head,
    generated_at: new Date().toISOString(),
    file_count: files.length,
    skills: REQUIRED_SKILLS,
    sources,
    files,
  };
  writeFileSync(join(appDir, 'rules-manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  return manifest;
}

function verify(stageRoot, appDir) {
  const runtime = join(stageRoot, 'runtime', 'node.exe');
  const result = spawnSync(runtime, [join(appDir, 'verify-rules.mjs')], { encoding: 'utf8' });
  if (result.status !== 0) fail(`包内规则自检未通过：\n${result.stdout}${result.stderr}`);
  process.stdout.write(result.stdout);
}

function dirtyFiles() {
  return git('status', '--porcelain')
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => line.slice(3).trim())
    .filter((path) =>
      /^(apps\/[^/]+\/src|apps\/[^/]+\/package\.json|packages\/[^/]+\/src|desktop|skills|AGENTS\.md|README\.md|Docs\/api\.md)/.test(
        path.replace(/\\/g, '/'),
      ),
    );
}

/**
 * 桌面壳 release 产物：有就直接复用；没有时非 --skip-build 才尝试 cargo 构建。
 * 壳不随 `pnpm -r build` 构建（desktop 是独立子工程，不在根 workspace 内）。
 */
function ensureDesktopExe() {
  if (existsSync(DESKTOP_EXE)) return;
  if (opts.skipBuild) {
    fail(`缺少桌面壳产物：${relative(ROOT, DESKTOP_EXE)}（先在 desktop 构建，或去掉 --skip-build）`);
  }
  log('构建桌面壳（cargo build --release）…');
  run(process.env.CARGO || 'cargo', [
    'build',
    '--release',
    '--manifest-path',
    join('desktop', 'src-tauri', 'Cargo.toml'),
  ]);
}

const head = git('rev-parse', '--short', 'HEAD') || 'unknown';
log(`构建基准 HEAD=${head}`);

if (!opts.skipBuild) {
  log('构建 server / web / cli …');
  run(process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm', ['-r', 'build'], { shell: process.platform === 'win32' });
}

for (const required of ['apps/server/dist/index.js', 'apps/server/package.json', 'apps/web/dist/index.html']) {
  if (!existsSync(join(ROOT, required))) fail(`构建产物缺失：${required}`);
}

const stageRoot = join(opts.out, PKG_NAME);
rmSync(opts.out, { recursive: true, force: true });
mkdirSync(stageRoot, { recursive: true });
mkdirSync(join(stageRoot, 'runtime'), { recursive: true });
const appDir = join(stageRoot, 'app');
mkdirSync(join(appDir, 'apps', 'server', 'dist'), { recursive: true });
mkdirSync(join(appDir, 'cli'), { recursive: true });

log('复制 Node 运行时 …');
copyFileSync(process.execPath, join(stageRoot, 'runtime', 'node.exe'));

log('打包 server / cli …');
bundle(
  join(ROOT, 'apps', 'server', 'dist', 'index.js'),
  join(appDir, 'apps', 'server', 'dist', 'index.js'),
  ['--external:better-sqlite3', '--external:sherpa-onnx-node'],
);
bundle(join(ROOT, 'packages', 'cli', 'dist', 'index.js'), join(appDir, 'cli', 'index.js'));

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
copyTree(pnpmPackage('sherpa-onnx-win-x64'), join(appDir, 'node_modules', 'sherpa-onnx-win-x64'), depFilter);
writeFileSync(
  join(appDir, 'package.json'),
  `${JSON.stringify({ name: 'agentboard', version: '0.1.0', private: true, type: 'module' }, null, 2)}\n`,
  'utf8',
);

log('校验原生模块与运行时匹配 …');
const nativeCheck = spawnSync(
  join(stageRoot, 'runtime', 'node.exe'),
  ['-e', `require(${JSON.stringify(join(appDir, 'node_modules', 'better-sqlite3').replace(/\\/g, '/'))})`],
  { cwd: appDir, encoding: 'utf8' },
);
if (nativeCheck.status !== 0) {
  fail(`better-sqlite3 原生模块无法在包内运行时加载（ABI 不匹配？请用构建时的 Node 版本运行本脚本）：\n${nativeCheck.stderr}`);
}

log('携带桌面壳与启动脚本 …');
ensureDesktopExe();
mkdirSync(join(appDir, 'desktop'), { recursive: true });
copyFileSync(DESKTOP_EXE, join(appDir, 'desktop', 'agentboard-desktop.exe'));

log('携带规则文件 …');
const sources = copyRules(appDir);

log('复制启动脚本与包内自检 …');
for (const file of [
  'start.cmd',
  'start-desktop.cmd',
  'start-server.cmd',
  'check-rules.cmd',
  'README.txt',
  'verify-rules.mjs',
]) {
  copyFileSync(join(TEMPLATES, file), join(file === 'verify-rules.mjs' ? appDir : stageRoot, file));
}
copyFileSync(join(TEMPLATES, 'kb.cmd'), join(appDir, 'cli', 'kb.cmd'));

const manifest = writeManifest(appDir, sources, head);
verify(stageRoot, appDir);

let zipPath = opts.zip;
if (!opts.noZip) {
  zipPath = zipPath || join(ROOT, `AgentBoard-win-x64-${head}.zip`);
  log(`打 zip：${zipPath}`);
  rmSync(zipPath, { force: true });
  const tar = spawnSync('tar', ['-a', '-c', '-f', zipPath, '-C', dirname(stageRoot), PKG_NAME], {
    cwd: ROOT,
    stdio: 'inherit',
  });
  if (tar.status !== 0) fail('tar 打 zip 失败（Windows 需自带 tar.exe）');
}

const dirty = dirtyFiles();
console.log('');
log(`完成：${stageRoot}`);
logSymlinkStats();
log(`规则：${manifest.file_count} 个文件 / ${manifest.skills.length} 个技能`);
if (!opts.noZip) log(`压缩包：${zipPath}（${(statSync(zipPath).size / 1048576).toFixed(1)} MB）`);
log(`HEAD=${head}；构建时未提交改动 ${dirty.length} 个文件${dirty.length ? `：${dirty.join(', ')}` : ''}`);
