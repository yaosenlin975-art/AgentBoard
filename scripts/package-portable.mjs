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
 *   4. 携带配套规则到 app/rules/（AGENTS.md、README.md、Docs/api.md、8 个技能）
 *   5. 生成 app/rules-manifest.json 并跑包内自检 app/verify-rules.mjs
 *   6. 打 zip（顶层目录 AgentBoard）
 *
 * 规则来源：仓库 skills/ 优先；缺失的从 %AGENTBOARD_SKILLS_SRC%（默认 %USERPROFILE%\.agents\skills）取。
 * 外部技能不受本仓库 git 跟踪，来源会写进 rules-manifest.json。
 * 注：ask-user 属本仓库技能（DEC-5），不会回落到全局 ~/.agents/AGENTS.md 原文。
 * server/cli/web/原生模块的组装逻辑在 scripts/assemble-payload.mjs（B10 起与 build-macos.mjs 共用）。
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { assembleAppPayload, copyTree, logSymlinkStats, verifyNativeLoad } from './assemble-payload.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const TEMPLATES = join(ROOT, 'scripts', 'portable');
const PKG_NAME = 'AgentBoard';
/** Tauri 壳的 release 产物（来源只读；壳按相对路径找 ../apps/server/dist 与 ../../runtime/node.exe）。 */
const DESKTOP_EXE = join(ROOT, 'desktop', 'src-tauri', 'target', 'release', 'agentboard-desktop.exe');
const REQUIRED_SKILLS = [
  'using-agentboard',
  'writing-task',
  'executing-task',
  'handoff',
  'swing-dev',
  'ask-user',
  'brainstorming',
  'kb-curator',
];
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
// --out 一律转绝对路径：包内自检以 appDir 为 cwd 用相对路径 spawn 会解析错位（B10 修）。
for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (a === '--out') opts.out = resolve(args[++i]);
  else if (a === '--zip') opts.zip = resolve(args[++i]);
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
 * 读 PE 头 TimeDateStamp（COFF，PE 签名后 +8，Unix 秒）。
 * 判壳产物新鲜度用它而不是文件 mtime：Tauri 打包会改写 exe 字节与 mtime，
 * PE 编译时刻才稳定。详见 `Docs/desktop-build-pitfalls.md`。
 */
function readPeTimestamp(file) {
  if (!existsSync(file)) return null;
  const buffer = readFileSync(file);
  if (buffer.length < 0x40 || buffer[0] !== 0x4d || buffer[1] !== 0x5a) return null;
  const peOffset = buffer.readInt32LE(0x3c);
  if (peOffset <= 0 || peOffset + 12 > buffer.length) return null;
  const seconds = buffer.readUInt32LE(peOffset + 8);
  if (seconds === 0) return null;
  return { seconds, iso: new Date(seconds * 1000).toISOString() };
}

/** 壳源码（含 Cargo.toml / tauri.conf.json）的最新 mtime */
function newestDesktopSrcMtimeMs() {
  const srcDir = join(ROOT, 'desktop', 'src-tauri', 'src');
  let newest = 0;
  const walk = (dir) => {
    if (!existsSync(dir)) return;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile()) {
        const mtimeMs = statSync(full).mtimeMs;
        if (mtimeMs > newest) newest = mtimeMs;
      }
    }
  };
  walk(srcDir);
  for (const extra of ['desktop/src-tauri/Cargo.toml', 'desktop/src-tauri/tauri.conf.json']) {
    const full = join(ROOT, extra);
    if (existsSync(full)) {
      const mtimeMs = statSync(full).mtimeMs;
      if (mtimeMs > newest) newest = mtimeMs;
    }
  }
  return Math.round(newest);
}

/**
 * 桌面壳 release 产物：必须对应当前壳源码，否则重新构建。
 * 壳不随 `pnpm -r build` 构建（desktop 是独立子工程，不在根 workspace 内）。
 *
 * D13：原实现只判 `existsSync(DESKTOP_EXE)`，壳文件在就直接用，于是「上一轮编译的旧壳」
 * 被打进新 zip——而 zip 外层 mtime 是打包时刻，看起来完全正常，实际装的是旧壳。
 * 现在改为按 PE 编译时刻判定新鲜度：早于壳源码最新 mtime 就重建（--skip-build 时 fail）。
 */
function ensureDesktopExe() {
  const srcMtimeMs = newestDesktopSrcMtimeMs();
  const exePe = readPeTimestamp(DESKTOP_EXE);

  if (exePe !== null && exePe.seconds * 1000 >= srcMtimeMs) {
    log(`桌面壳产物新鲜（PE ${exePe.iso}）`);
    return;
  }

  if (exePe !== null) {
    log(`桌面壳产物过期：PE ${exePe.iso} 早于壳源码最新 ${new Date(srcMtimeMs).toISOString()}，需要重建`);
  }

  if (opts.skipBuild) {
    fail(
      `桌面壳产物${exePe === null ? '缺失' : '过期'}且指定了 --skip-build：${relative(ROOT, DESKTOP_EXE)}\n` +
        `  ${exePe === null ? '文件不存在' : `PE ${exePe.iso} < 源码 ${new Date(srcMtimeMs).toISOString()}`}\n` +
        `  → 先跑 node scripts/desktop/build-windows.mjs --no-bundle，或去掉 --skip-build。\n` +
        `  → 否则便携包会被打进旧壳（D13 故障模式）。`,
    );
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

log('组装 server / cli / web / 原生依赖（公共模块 assemble-payload）…');
assembleAppPayload({ appDir, includeCli: true, sherpaPlatformPackages: ['sherpa-onnx-win-x64'] });

log('校验原生模块与运行时匹配 …');
const nativeCheck = verifyNativeLoad({ nodeBinary: join(stageRoot, 'runtime', 'node.exe'), appDir });
if (!nativeCheck.ok) {
  fail(`better-sqlite3 原生模块无法在包内运行时加载（ABI 不匹配？请用构建时的 Node 版本运行本脚本）：
${nativeCheck.stderr}`);
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
