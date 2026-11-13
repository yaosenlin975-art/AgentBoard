#!/usr/bin/env node
/**
 * 一键重打桌面端两条分发产物（D9）：便携包 zip + NSIS 安装包。
 *
 * 只做编排，不重写既有逻辑：
 *   pnpm -r build
 *   → node scripts/package-portable.mjs                        （便携包，先出）
 *   → node scripts/desktop/build-windows.mjs --bundles nsis    （NSIS，主交付，后出）
 *
 * 为什么需要这个脚本：两条分发路径必须以**同一份 server dist** 为前提。手工两步极易
 * 出现「NSIS 用新 dist、便携包用旧 dist」，而跨包修复（如 D8 的 dotfiles）重打后
 * 只看体积完全看不出差异。
 *
 * ── 一致性校验的三条口径（重要，别简化） ──────────────────────────────
 * 1. **NSIS**：`desktop/src-tauri/bundle-stage/apps/server/dist` 是 `apps/server/dist`
 *    的**整树字节拷贝**（build-windows.mjs 的 deployServer 里 cpSync）。所以这里做严格相等：
 *    逐文件 sha256 比对整棵 dist 目录。任何陈旧拷贝都会被抓住。
 * 2. **便携包**：`dist-package/AgentBoard/app/apps/server/dist/index.js` 是 esbuild 打的
 *    **单文件 bundle**（3.2MB vs 源码 28KB），和源码 dist 不可能字节相等——卡面写的
 *    「两份产物共用同一 index.js sha256」对便携包不成立。这里改用三条组合判定：
 *      a) 便携包构建步骤期间 `apps/server/dist` 指纹未变（说明打包时用的是当前 dist）
 *      b) 便携包 bundle 的 mtime 晚于 dist 内最新文件（说明是新构建而非复用旧树）
 *      c) 内容包含性抽查：从 dist 的若干 .js 里取最长代码行，要求出现在 bundle 里
 *    （package-portable.mjs 每次都会 rmSync 重建 stageRoot，所以 a+b 已足够；c 是加保险。）
 * 3. 每个构建步骤前后都复取一次 `apps/server/dist` 指纹；中途变了即 fail（有别的进程在动它）。
 *
 * 用法：
 *   node scripts/desktop/build-all.mjs               # 完整重打
 *   node scripts/desktop/build-all.mjs --skip-build  # 跳过 pnpm -r build（复用现有 dist）
 *   node scripts/desktop/build-all.mjs --verify-only # 只校验既有产物，不重打
 *   node scripts/desktop/build-all.mjs --portable-only | --nsis-only
 *
 * 退出码：0 全部成功且校验通过 / 1 构建失败或一致性校验失败
 *
 * 记录文件：.logs/build-all-record.json（.logs/ 已 gitignore）
 */
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SERVER_DIST_DIR = join(ROOT, 'apps', 'server', 'dist');
const SERVER_DIST = join(SERVER_DIST_DIR, 'index.js');
const STAGE_SERVER_DIST = join(ROOT, 'desktop', 'src-tauri', 'bundle-stage', 'apps', 'server', 'dist');
const PKG_ROOT = join(ROOT, 'dist-package', 'AgentBoard');
const PKG_SERVER_DIST = join(PKG_ROOT, 'app', 'apps', 'server', 'dist', 'index.js');
const LOG_DIR = join(ROOT, '.logs');
const RECORD_PATH = join(LOG_DIR, 'build-all-record.json');
const NSIS_DIR = join(ROOT, 'desktop', 'src-tauri', 'target', 'release', 'bundle', 'nsis');

const args = new Set(process.argv.slice(2));
const skipBuild = args.has('--skip-build');
const verifyOnly = args.has('--verify-only');
const portableOnly = args.has('--portable-only');
const nsisOnly = args.has('--nsis-only');

const startedAt = Date.now();
const steps = [];

function log(message) {
  process.stdout.write(`[build-all] ${message}\n`);
}

function fail(message) {
  process.stderr.write(`\n[build-all] 失败：${message}\n`);
  process.exit(1);
}

function mb(bytes) {
  return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
}

function sha256Buf(buffer) {
  return createHash('sha256').update(buffer).digest('hex');
}

function sha256File(file) {
  return sha256Buf(readFileSync(file));
}

/**
 * 整棵 dist 目录的指纹：逐文件 sha256 + 相对路径排序后整体哈希。
 * 单文件 sha 不够——tsc 输出的 index.js 只是入口薄壳，真正代码在 api/ db/ services/ 等子目录。
 */
function fingerprintDist(dir) {
  if (!existsSync(dir)) return null;
  const files = [];
  let newestMtimeMs = 0;
  const walk = (current) => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const full = join(current, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile()) {
        const stats = statSync(full);
        files.push(`${relative(dir, full).split('\\').join('/')}:${sha256File(full)}`);
        if (stats.mtimeMs > newestMtimeMs) newestMtimeMs = stats.mtimeMs;
      }
    }
  };
  walk(dir);
  files.sort();
  return {
    dir,
    treeSha256: sha256Buf(Buffer.from(files.join('\n'), 'utf8')),
    fileCount: files.length,
    indexSha256: existsSync(join(dir, 'index.js')) ? sha256File(join(dir, 'index.js')) : null,
    newestMtimeMs: Math.round(newestMtimeMs),
  };
}

/** 单文件指纹（便携包 bundle 用） */
function fingerprintFile(file) {
  if (!existsSync(file)) return null;
  const stats = statSync(file);
  return { file, sha256: sha256File(file), size: stats.size, mtimeMs: Math.round(stats.mtimeMs) };
}

function git(gitArgs) {
  const result = spawnSync('git', gitArgs, { cwd: ROOT, encoding: 'utf8' });
  return result.status === 0 ? result.stdout.trim() : null;
}

function run(label, command, commandArgs) {
  const stepStart = Date.now();
  log(`▶ ${label}：${command} ${commandArgs.join(' ')}`);

  // 两级显式处理，避免两条 Windows 陷阱：
  //  1) .cmd/.bat（corepack、pnpm）不能直接 CreateProcess，必须经 cmd.exe 包装；
  //  2) spawnSync(shell:true) 会触发 Node DEP0190（参数拼接不转义），所以显式走 cmd /d /s /c。
  const isCmdShim = /\.(cmd|bat)$/i.test(command);
  const [realCommand, realArgs] = isCmdShim
    ? [process.env.COMSPEC ?? 'cmd.exe', ['/d', '/s', '/c', command, ...commandArgs]]
    : [command, commandArgs];

  const result = spawnSync(realCommand, realArgs, {
    cwd: ROOT,
    stdio: 'inherit',
    shell: false,
    env: process.env,
  });
  const took = Date.now() - stepStart;
  if (result.error) fail(`${label} 启动失败：${result.error.message}`);
  if (result.status !== 0) fail(`${label} 退出码 ${result.status}`);
  steps.push({ label, tookMs: took });
  log(`✔ ${label} 完成（${Math.round(took / 1000)}s）`);
}

/**
 * 源码新鲜度：`apps/server/src` 里最新的 .ts 不能比 dist 里最新的产物更新。
 * 这条专门抓「改了 src 但忘了 build」——D8 这类跨包修复最容易栽在这里：
 * 打包一路绿灯，产物里却是旧代码，只看体积完全看不出来。
 */
function assertDistFresh() {
  const srcDir = join(ROOT, 'apps', 'server', 'src');
  if (!existsSync(srcDir)) return;
  let newestSrcMs = 0;
  let newestSrcFile = '';
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile() && entry.name.endsWith('.ts')) {
        const mtimeMs = statSync(full).mtimeMs;
        if (mtimeMs > newestSrcMs) {
          newestSrcMs = mtimeMs;
          newestSrcFile = relative(ROOT, full);
        }
      }
    }
  };
  walk(srcDir);

  const dist = fingerprintDist(SERVER_DIST_DIR);
  if (dist === null) fail(`缺少 ${SERVER_DIST_DIR}`);
  if (newestSrcMs > dist.newestMtimeMs) {
    fail(
      `apps/server/dist 比源码旧——改了 src 但没重新构建：\n` +
        `  最新源码   ${newestSrcFile}\n             ${new Date(newestSrcMs).toISOString()}\n` +
        `  dist 最新  ${new Date(dist.newestMtimeMs).toISOString()}\n` +
        `  → 先执行 corepack pnpm --filter @agentboard/server build（或去掉 --skip-build 让本脚本代跑）。`,
    );
  }
  log(
    `✔ dist 新鲜度：源码最新 ${new Date(newestSrcMs).toISOString()} ≤ dist 最新 ${new Date(dist.newestMtimeMs).toISOString()}`,
  );
}

/** 严格相等：整树指纹比对（NSIS 暂存树是 dist 的字节拷贝） */
function assertTreeSame(label, expected, actual) {
  if (actual === null) fail(`${label}：目录不存在（${label}）`);
  if (actual.treeSha256 === expected.treeSha256) {
    log(`✔ ${label}：整树指纹一致（${expected.fileCount} 个文件，tree ${expected.treeSha256.slice(0, 12)}…）`);
    return;
  }
  const diffs = [];
  if (actual.fileCount !== expected.fileCount)
    diffs.push(`  文件数 期望 ${expected.fileCount} 实际 ${actual.fileCount}`);
  if (actual.indexSha256 !== expected.indexSha256) {
    diffs.push(
      `  index.js 期望 ${String(expected.indexSha256).slice(0, 16)}… 实际 ${String(actual.indexSha256).slice(0, 16)}…`,
    );
  }
  fail(
    `${label}：与本次构建的 apps/server/dist 不一致\n${diffs.join('\n')}\n` +
      `  期望：${expected.dir}  tree ${expected.treeSha256}\n` +
      `  实际：${actual.dir}  tree ${actual.treeSha256}\n` +
      `  → 这份产物用了旧 dist。重新执行本脚本（不要手工分步）。`,
  );
}

/** 构建期间 dist 不得变化 */
function assertUnchangedDuring(label, expected) {
  assertTreeSame(`${label} 期间 apps/server/dist`, expected, fingerprintDist(SERVER_DIST_DIR));
}

/**
 * 便携包内容包含性抽查：从源码 dist 抽标识符，要求大部分出现在 esbuild bundle 中。
 *
 * 为什么不能用 sha256 相等：便携包里的 server/dist/index.js 是 esbuild 打的**单文件 bundle**
 * （3.2MB vs 源码 dist 28KB 入口 + 子模块），和源码 dist 不可能字节相等。卡面「两份产物共用
 * 同一 index.js sha256」对便携包不成立，这里改用三种判据组合（见 verifyPortable）。
 *
 * 标识符命中率实测：当前 dist 1519 个唯一标识符，bundle 命中 1441（94.9%）。未命中的是
 * 被 tree-shake 掉或改名（如 DbLockedError）的少数符号。阈值取 85%：能抓住「整份 bundle 来自
 * 另一个版本」，又不会被正常的摇树误判。
 */
const IDENTIFIER_HIT_THRESHOLD = 0.85;

function assertBundleContainsSource(bundleFile) {
  const bundle = readFileSync(bundleFile, 'utf8');
  const identifiers = new Set();
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile() && entry.name.endsWith('.js')) {
        const text = readFileSync(full, 'utf8');
        for (const match of text.matchAll(/(?:function|const|class)\s+([A-Za-z_][A-Za-z0-9_]{12,})/g)) {
          identifiers.add(match[1]);
        }
      }
    }
  };
  walk(SERVER_DIST_DIR);

  const all = [...identifiers];
  if (all.length === 0) fail('内容抽查失败：源码 dist 里没抽到任何标识符（dist 是否是空壳？）');
  const hits = all.filter((id) => bundle.includes(id));
  const ratio = hits.length / all.length;
  const detail = `命中 ${hits.length}/${all.length}（${(ratio * 100).toFixed(1)}%）`;
  if (ratio < IDENTIFIER_HIT_THRESHOLD) {
    const missing = all.filter((id) => !bundle.includes(id)).slice(0, 8);
    fail(
      `便携包 bundle 与当前 dist 的代码差异过大：${detail}，低于阈值 ${(IDENTIFIER_HIT_THRESHOLD * 100).toFixed(0)}%\n` +
        `  抽样未命中：${missing.join(', ')}\n  → 便携包很可能是用旧 dist 打的。重新执行本脚本。`,
    );
  }
  log(`✔ 便携包内容抽查：${detail}（阈值 ${(IDENTIFIER_HIT_THRESHOLD * 100).toFixed(0)}%）`);
}

/**
 * 便携包校验。三条判据（bundle 与源码 dist 不可能字节相等，所以不用 sha256）：
 *   a) bundle mtime 不早于 dist 最新文件（防复用旧产物）
 *   b) **构建期内**：bundle mtime 不早于本次便携包步骤的启动时刻（同一次运行内的强判据）
 *   c) zip 文件名里的 HEAD 必须等于当前 HEAD（package-portable.mjs 用 HEAD 命名，:458）
 * 再加内容抽查作为跨版本的旁证。
 */
function verifyPortable(expected, portableStepStartMs) {
  if (!existsSync(PKG_SERVER_DIST)) {
    fail(`便携包未就绪：${PKG_SERVER_DIST} 不存在（先跑一次不带 --verify-only 的完整构建）`);
  }
  const bundle = fingerprintFile(PKG_SERVER_DIST);

  if (portableStepStartMs !== null && bundle.mtimeMs < portableStepStartMs) {
    fail(
      `便携包 bundle 早于本次构建步骤的启动时刻，说明这一步没有真正重新打包：\n` +
        `  bundle mtime      ${new Date(bundle.mtimeMs).toISOString()}\n` +
        `  步骤启动时刻      ${new Date(portableStepStartMs).toISOString()}`,
    );
  }
  if (bundle.mtimeMs < expected.newestMtimeMs) {
    fail(
      `便携包 bundle 比源码 dist 旧，说明是复用旧产物：\n` +
        `  bundle mtime      ${new Date(bundle.mtimeMs).toISOString()}\n` +
        `  dist 最新文件     ${new Date(expected.newestMtimeMs).toISOString()}\n` +
        `  → 重新执行本脚本。`,
    );
  }

  assertBundleContainsSource(PKG_SERVER_DIST);

  const zip = findFile(ROOT, /^AgentBoard-win-x64-[^\\/]+\.zip$/);
  if (zip === null) fail(`便携包 zip 不存在：仓库根下没有 AgentBoard-win-x64-*.zip`);

  const head = git(['rev-parse', '--short', 'HEAD']);
  const nameHead = /AgentBoard-win-x64-(.+)\.zip$/.exec(zip)?.[1] ?? '';
  if (head !== null && nameHead !== head) {
    fail(
      `便携包 zip 的文件名带的是旧 HEAD：\n` +
        `  文件名   ${nameHead}\n  当前 HEAD ${head}\n` +
        `  → 这份 zip 是别的提交打出来的。重新执行本脚本。`,
    );
  }

  log(`✔ 便携包 server bundle：${bundle.size} B（源码 dist ${expected.fileCount} 个文件）`);
  log(`✔ 便携包 zip：文件名 HEAD=${nameHead} 与当前 HEAD 一致`);
  return { kind: 'portable', path: zip, size: statSync(zip).size, bundleSha256: bundle.sha256 };
}

function verifyNsis(expected) {
  if (!existsSync(STAGE_SERVER_DIST)) {
    fail(`NSIS 暂存树未就绪：${STAGE_SERVER_DIST} 不存在（先跑一次不带 --verify-only 的完整构建）`);
  }
  assertTreeSame('NSIS 暂存树 apps/server/dist', expected, fingerprintDist(STAGE_SERVER_DIST));
  const setup = findFile(NSIS_DIR, /-setup\.exe$/);
  if (setup === null) fail(`NSIS 安装包不存在：${NSIS_DIR} 下没有 *-setup.exe`);
  return { kind: 'nsis', path: setup, size: statSync(setup).size };
}

function findFile(dir, pattern) {
  if (!existsSync(dir)) return null;
  const stack = [dir];
  while (stack.length > 0) {
    const current = stack.pop();
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const full = join(current, entry.name);
      if (entry.isDirectory()) stack.push(full);
      else if (pattern.test(entry.name)) return full;
    }
  }
  return null;
}

function verifyArtifacts(expected, portableStepStartMs = null) {
  const artifacts = [];
  if (!nsisOnly) artifacts.push(verifyPortable(expected, portableStepStartMs));
  if (!portableOnly) artifacts.push(verifyNsis(expected));
  return artifacts;
}

function printSummary(record) {
  log('');
  log('──────── 汇总 ────────');
  log(`HEAD                 ${record.head}`);
  log(`server dist 整树     ${record.expected.treeSha256}`);
  log(`server dist 文件数   ${record.expected.fileCount}`);
  log(`server dist index.js ${String(record.expected.indexSha256).slice(0, 16)}…`);
  for (const artifact of record.artifacts ?? []) {
    const label = artifact.kind === 'nsis' ? 'NSIS 安装包' : '便携包 zip';
    log(`${label.padEnd(19)} ${artifact.path}`);
    log(`${''.padEnd(21)}${artifact.size === null ? '体积未知' : mb(artifact.size)}`);
  }
  const buildSteps = (record.steps ?? []).map((step) => `${step.label} ${Math.round(step.tookMs / 1000)}s`).join('，');
  if (buildSteps !== '') log(`步骤耗时             ${buildSteps}`);
  log(`总耗时               ${Math.round(record.totalMs / 1000)}s`);
  log(`记录文件             ${RECORD_PATH}`);
  log('一致性校验通过');
}

function main() {
  mkdirSync(LOG_DIR, { recursive: true });

  if (!verifyOnly) {
    if (!existsSync(SERVER_DIST)) fail(`缺少 ${SERVER_DIST}：先在仓库根执行 corepack pnpm -r build`);

    const head = git(['rev-parse', '--short', 'HEAD']) ?? 'unknown';
    const baseline = fingerprintDist(SERVER_DIST_DIR);
    log(`构建基准 HEAD=${head}`);
    log(`基线 server dist：tree ${baseline.treeSha256.slice(0, 12)}…（${baseline.fileCount} 个文件）`);

    if (!skipBuild) run('构建 workspace', 'corepack', ['pnpm', '-r', 'build']);
    else log('跳过 pnpm -r build（--skip-build）');

    // --skip-build 时最容易踩「dist 比源码旧」，所以只在跳过构建时强制检查
    if (skipBuild) assertDistFresh();

    const expected = fingerprintDist(SERVER_DIST_DIR);
    if (expected === null) fail(`构建后 ${SERVER_DIST_DIR} 消失`);
    if (expected.treeSha256 === baseline.treeSha256) {
      log(`server dist 未变化（tree ${expected.treeSha256.slice(0, 12)}…）：本次无源码改动，产物仍是同一份。`);
    } else {
      log(`server dist 已更新：${baseline.treeSha256.slice(0, 12)}… → ${expected.treeSha256.slice(0, 12)}…`);
    }

    const record = {
      generatedAt: new Date().toISOString(),
      head,
      baseline,
      expected,
      steps: [],
    };

    let portableStepStartMs = null;
    if (!nsisOnly) {
      portableStepStartMs = Date.now();
      run('打便携包', process.execPath, [join(ROOT, 'scripts', 'package-portable.mjs'), '--skip-build']);
      assertUnchangedDuring('便携包构建', expected);
    }

    if (!portableOnly) {
      run('打 NSIS 安装包', process.execPath, [
        join(ROOT, 'scripts', 'desktop', 'build-windows.mjs'),
        '--bundles',
        'nsis',
      ]);
      assertUnchangedDuring('NSIS 构建', expected);
    }

    record.artifacts = verifyArtifacts(expected, portableStepStartMs);
    record.totalMs = Date.now() - startedAt;
    record.steps = steps;
    writeFileSync(RECORD_PATH, `${JSON.stringify(record, null, 2)}\n`, 'utf8');
    printSummary(record);
    return;
  }

  log('verify-only：只校验既有产物，不重打');
  // verify-only 也要查新鲜度：产物再自洽，dist 本身是旧的也白搭
  assertDistFresh();
  const expected = fingerprintDist(SERVER_DIST_DIR);
  if (expected === null) fail(`缺少 ${SERVER_DIST_DIR}`);
  const previous = existsSync(RECORD_PATH) ? JSON.parse(readFileSync(RECORD_PATH, 'utf8')) : null;
  if (previous !== null && previous.expected.treeSha256 !== expected.treeSha256) {
    log(
      `注意：当前 dist（tree ${expected.treeSha256.slice(0, 12)}…）与上次记录（${previous.expected.treeSha256.slice(0, 12)}…）不同，` +
        `说明源码改过但没重打——这种情况下校验应当失败。`,
    );
  }
  const artifacts = verifyArtifacts(expected);
  printSummary({
    head: git(['rev-parse', '--short', 'HEAD']) ?? 'unknown',
    expected,
    artifacts,
    totalMs: Date.now() - startedAt,
    steps: [],
  });
}

main();
