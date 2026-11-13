#!/usr/bin/env node
/**
 * 一键重打桌面端两条分发产物（D9）：便携包 zip + NSIS 安装包。
 *
 * 环境坑与校验口径的完整说明见 `Docs/desktop-build-pitfalls.md`：
 * pnpm 非 TTY 阻塞（CI=true 会静默删光 devDependencies）、corepack 三层 spawn 陷阱、
 * 产物归档约定、zip 双判据、安装包内嵌 exe 的新旧判定。
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
const DESKTOP_EXE = join(ROOT, 'desktop', 'src-tauri', 'target', 'release', 'agentboard-desktop.exe');
/** 便携包内层的壳（portable-package 布局：AgentBoard/app/desktop/agentboard-desktop.exe） */
const PKG_DESKTOP_EXE = join(PKG_ROOT, 'app', 'desktop', 'agentboard-desktop.exe');
/** 壳源码目录：判定壳产物是否新鲜时的基准 */
const DESKTOP_SRC_DIR = join(ROOT, 'desktop', 'src-tauri', 'src');

const args = new Set(process.argv.slice(2));
const skipBuild = args.has('--skip-build');
const verifyOnly = args.has('--verify-only');
const portableOnly = args.has('--portable-only');
const nsisOnly = args.has('--nsis-only');
/** 跳过壳编译（壳已在别处编好时用）；此时会强制做壳新鲜度校验，旧壳直接 fail */
const skipShellBuild = args.has('--skip-shell-build');

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

/**
 * 读 PE 头里的编译时间戳（COFF TimeDateStamp，位于 PE 签名后 +8 处，Unix 秒）。
 *
 * 为什么不用文件 mtime / sha256 判壳产物的新旧（D13 的教训）：
 * - 文件 mtime 会被打包改写：Tauri 打 NSIS 时会 `Patching … with bundle type information`
 *   重写 exe（实测与 release 只差 3 字节，`_NSIS` vs `_UNK`），mtime 随之后移。
 * - sha256 对同一次编译的两个副本可能不同（上述 3 字节），拿来比对会误判成「旧构建」。
 * - PE 时间戳代表**编译时刻**，不随打包改写，是唯一可靠判据。
 *
 * 跨容器更要看内层：zip 外层 mtime 是打包时刻（永远是新的），只有内层 exe 的 PE 才说明
 * 里面装的是哪次编译。详见 `Docs/desktop-build-pitfalls.md`。
 */
function readPeTimestamp(file) {
  if (!existsSync(file)) return null;
  const buffer = readFileSync(file);
  if (buffer.length < 0x40) return null;
  if (buffer[0] !== 0x4d || buffer[1] !== 0x5a) return null; // "MZ"
  const peOffset = buffer.readInt32LE(0x3c);
  if (peOffset <= 0 || peOffset + 12 > buffer.length) return null;
  const seconds = buffer.readUInt32LE(peOffset + 8);
  if (seconds === 0) return null;
  return { file, seconds, iso: new Date(seconds * 1000).toISOString(), size: buffer.length };
}

/** 壳源码里最新的 mtime（判定壳产物是否对应当前源码） */
function newestDesktopSrcMtimeMs() {
  if (!existsSync(DESKTOP_SRC_DIR)) return 0;
  let newest = 0;
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile()) {
        const mtimeMs = statSync(full).mtimeMs;
        if (mtimeMs > newest) newest = mtimeMs;
      }
    }
  };
  walk(DESKTOP_SRC_DIR);
  // Cargo.toml / tauri.conf.json 变动同样要求重编
  for (const extra of ['desktop/src-tauri/Cargo.toml', 'desktop/src-tauri/tauri.conf.json']) {
    const full = join(ROOT, extra);
    if (existsSync(full)) {
      const mtimeMs = statSync(full).mtimeMs;
      if (mtimeMs > newest) newest = mtimeMs;
    }
  }
  return Math.round(newest);
}

function git(gitArgs) {
  const result = spawnSync('git', gitArgs, { cwd: ROOT, encoding: 'utf8' });
  return result.status === 0 ? result.stdout.trim() : null;
}

/**
 * 解析 pnpm 的真实 JS 入口，让本脚本能用 `node <pnpm.js>` 的方式调用 pnpm，
 * 完全绕开 corepack.cmd / pnpm.cmd 在 Windows 上的三层陷阱（详见
 * `Docs/desktop-build-pitfalls.md` 坑 2）：
 *   1) spawnSync 直接调 `corepack` 报 ENOENT（PATH 里那份无扩展名，不是 exe）；
 *   2) 解析到 `corepack.cmd` 后必须经 cmd.exe 包装（.cmd 不能 CreateProcess）；
 *   3) 经 cmd /c 时路径含空格会被截断（"'C:\Program' is not recognized"），
 *      而加引号在 spawnSync 的数组参数里又被二次包裹，依然失败。
 * 直接 `node pnpm.js` 实测可用，且不依赖 corepack 的 shim 形式。
 */
function resolvePnpmEntry() {
  const candidates = [];
  // corepack 随 Node 附带的标准位置
  if (process.platform === 'win32') {
    const nodeDir = dirname(process.execPath);
    candidates.push(join(nodeDir, 'node_modules', 'corepack', 'dist', 'pnpm.js'));
  }
  // 已解出的 corepack 缓存（`corepack enable` 后的 pnpm 实际入口）
  const store = join(process.env.LOCALAPPDATA ?? '', 'node', 'corepack', 'v1', 'pnpm');
  if (existsSync(store)) {
    for (const version of readdirSync(store).sort().reverse()) {
      candidates.push(join(store, version, 'dist', 'pnpm.mjs'));
    }
  }
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

/**
 * 调用 pnpm：优先 `node <pnpm.js>`（无 shim 陷阱），解析不到才回退 `corepack`。
 */
function runPnpm(label, pnpmArgs) {
  const entry = resolvePnpmEntry();
  if (entry === null) {
    log(`未解析到 pnpm 入口，回退 corepack shim`);
    run(label, 'corepack', ['pnpm', ...pnpmArgs]);
    return;
  }
  run(label, process.execPath, [entry, ...pnpmArgs]);
}

function run(label, command, commandArgs) {
  const stepStart = Date.now();
  log(`▶ ${label}：${command} ${commandArgs.join(' ')}`);

  const result = spawnSync(command, commandArgs, {
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

/**
 * D8 修复旁证：bundle 里 `dotfiles: "allow"` 的出现次数。
 *
 * 为什么是旁证而不是门禁（lead 裁决：≥5 通过 / <5 只警告）：
 * - esbuild 会把单引号统一成双引号（实测 0.28.2），所以源码的 `dotfiles: 'allow'`
 *   在 bundle 里变成 `dotfiles: "allow"`；计数依赖这个行为。
 * - 未来 esbuild 升级、换 minify 配置或改用别的打包器，计数就会失效。
 * - 真正的门禁是「点开头路径实跑 GET / 返 200」，那条不依赖任何打包器行为。
 *
 * 实测基线：旧 bundle（无 D8）= 3 处；含 D8 的 dist 经 esbuild = 5 处。
 * 因此重打后的期望值是 5。
 */
const DOTFILES_ALLOW_EXPECTED = 5;

function warnBundleDotfilesAllow(bundleFile) {
  const text = readFileSync(bundleFile, 'utf8');
  const actual = (text.match(/dotfiles:\s*"allow"/g) ?? []).length;
  if (actual >= DOTFILES_ALLOW_EXPECTED) {
    log(`✔ 旁证：bundle 中 dotfiles: "allow" = ${actual} 处（期望 ≥${DOTFILES_ALLOW_EXPECTED}）`);
  } else {
    log(
      `⚠ 旁证不足：bundle 中 dotfiles: "allow" = ${actual} 处，低于期望 ${DOTFILES_ALLOW_EXPECTED} 处。` +
        `可能是打包器行为变化使本项失效——以实跑 GET / 200 为准。`,
    );
  }
  return actual;
}

/**
 * 壳产物新鲜度门禁（D13）：`target/release/agentboard-desktop.exe` 必须对应当前壳源码。
 *
 * 这个检查存在的原因：`package-portable.mjs` 的 `ensureDesktopExe()` 原先只判 `existsSync`，
 * 壳文件在就直接用——于是「上一轮编译的旧壳」被打进新 zip，而 zip 外层 mtime 是打包时刻，
 * 看起来完全正常。D11 就是这样漏掉了便携包里的旧壳（PE 14:52 vs 源码 release 16:11）。
 *
 * 判据用 PE 时间戳而非 mtime：打包会改写 exe 的字节与 mtime（见 readPeTimestamp 注释）。
 */
function assertShellFresh() {
  const exe = readPeTimestamp(DESKTOP_EXE);
  if (exe === null) {
    fail(`缺少桌面壳产物或不是有效 PE：${DESKTOP_EXE}\n  → 先跑 node scripts/desktop/build-windows.mjs --no-bundle`);
  }
  const srcMs = newestDesktopSrcMtimeMs();
  if (srcMs === 0) {
    log('壳源码目录不可读，跳过新鲜度判定');
    return exe;
  }
  const exeMs = exe.seconds * 1000;
  if (exeMs < srcMs) {
    fail(
      `桌面壳产物比壳源码旧（PE 编译时刻早于源码最后修改）：\n` +
        `  壳 PE      ${exe.iso}（${new Date(exeMs).toLocaleString('zh-CN', { hour12: false })}）\n` +
        `  源码最新   ${new Date(srcMs).toISOString()}\n` +
        `  → 重编壳：node scripts/desktop/build-windows.mjs --no-bundle\n` +
        `  → 否则便携包会被打进旧壳（D13 的故障模式：zip 外层新、内层壳旧）。`,
    );
  }
  log(`✔ 壳新鲜度：PE ${exe.iso} ≥ 壳源码最新 ${new Date(srcMs).toISOString()}`);
  return exe;
}

/**
 * 包内壳一致性（D13 核心校验）：便携包内层的 `agentboard-desktop.exe` 必须与源码 release 壳
 * 来自同一次编译。
 *
 * 比 PE 时间戳，不比 sha256：Tauri 打包会写 bundle 类型标记（`_NSIS` / `_UNK`，3 字节），
 * 同一次编译的两个副本 sha256 也不同。
 */
function assertPackagedShellMatches(referencePe, label = '便携包内层壳') {
  const inner = readPeTimestamp(PKG_DESKTOP_EXE);
  if (inner === null) {
    fail(`${label}缺少或不是有效 PE：${PKG_DESKTOP_EXE}\n  → 便携包未产出或布局变了`);
  }
  if (inner.seconds !== referencePe.seconds) {
    fail(
      `${label}与源码 release 壳不是同一次编译：\n` +
        `  包内壳      PE ${inner.iso}  ${inner.size} B\n` +
        `  源码 release PE ${referencePe.iso}  ${referencePe.size} B\n` +
        `  → 便携包被打进了旧壳（zip 外层 mtime 是打包时刻，不代表内层是新的）。\n` +
        `  → 重新执行本脚本；它会先构建壳再打包。`,
    );
  }
  log(`✔ ${label}：PE ${inner.iso} 与源码 release 一致（${inner.size} B）`);
  return inner;
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
  const dotfilesAllow = warnBundleDotfilesAllow(PKG_SERVER_DIST);

  // D13：包内壳必须与源码 release 壳同一次编译。zip 外层 mtime 是打包时刻，
  // 只比外层会把「新容器装旧内容」判成通过（D11 就漏了这里）。
  const referencePe = readPeTimestamp(DESKTOP_EXE);
  if (referencePe === null) {
    fail(`缺少桌面壳产物：${DESKTOP_EXE}\n  → 先跑 node scripts/desktop/build-windows.mjs --no-bundle`);
  }
  const packagedPe = assertPackagedShellMatches(referencePe);

  /**
   * 找便携包 zip。仓库根可能残留多个（历史包），取 mtime 最新的那个，
   * 再靠下面的 mtime 判据确认它确实由当前 bundle 产出。
   * 归档约定（旧包移入 `.logs/archive/`，仓库根只留当前有效产物）见
   * `Docs/desktop-build-pitfalls.md` 坑 3。
   */
  const zipCandidates = readdirSync(ROOT)
    .filter((name) => /^AgentBoard-win-x64-[^\\/]+\.zip$/.test(name))
    .map((name) => join(ROOT, name))
    .map((file) => ({ file, mtimeMs: statSync(file).mtimeMs }))
    .sort((a, b) => b.mtimeMs - a.mtimeMs);
  if (zipCandidates.length === 0) fail(`便携包 zip 不存在：仓库根下没有 AgentBoard-win-x64-*.zip`);
  const zip = zipCandidates[0].file;
  if (zipCandidates.length > 1) {
    log(
      `注意：仓库根有 ${zipCandidates.length} 个便携包 zip，取最新的 ${relative(ROOT, zip)}；` +
        `其余：${zipCandidates
          .slice(1)
          .map((c) => relative(ROOT, c.file))
          .join('、')}`,
    );
  }

  const head = git(['rev-parse', '--short', 'HEAD']);
  const nameHead = /AgentBoard-win-x64-(.+)\.zip$/.exec(zip)?.[1] ?? '';

  /**
   * zip 名里的 HEAD 用「祖先」而不是「相等」判定。
   *
   * 为什么不能要求相等：`package-portable.mjs` 用**构建那一刻**的 HEAD 给 zip 命名，
   * 而构建完成后提交（如 D11 提交脚本修复）会产生新 HEAD。要求相等的话，
   * 每次「构建 → 提交 → 复验」都必然报失败——产物永远落后于它自己的提交。
   *
   * 祖先判定能接受「包里是当前 HEAD 的某个祖先提交」，同时仍能拒绝
   * 来自其它分支 / 未合并提交打出的包（那种 zip 名不是 HEAD 的祖先）。
   * 提交对象不存在（exit 128）视为无效名，直接失败。
   */
  if (head !== null && nameHead !== '') {
    const ancestor = spawnSync('git', ['merge-base', '--is-ancestor', nameHead, 'HEAD'], {
      cwd: ROOT,
      encoding: 'utf8',
    });
    if (ancestor.status !== 0) {
      fail(
        `便携包 zip 的 HEAD 不是当前 HEAD 的祖先：\n` +
          `  文件名   ${nameHead}\n  当前 HEAD ${head}\n` +
          `  → 这份 zip 来自其它分支或未合并的提交。用当前分支重新执行本脚本。`,
      );
    }
    log(
      nameHead === head
        ? `✔ 便携包 zip：文件名 HEAD=${nameHead} 与当前 HEAD 一致`
        : `✔ 便携包 zip：文件名 HEAD=${nameHead} 是当前 HEAD=${head} 的祖先（构建后又有提交，属正常）`,
    );
  }

  /**
   * zip 必须由当前这次构建产出，而不是仓库根残留的旧包。
   * 单靠祖先判定会放过旧包——旧包的 HEAD 同样是祖先（实测 b83a269 也是祖先）。
   * 用 mtime 排除：zip 不能早于它内部 bundle 的 mtime。
   */
  const zipMtimeMs = statSync(zip).mtimeMs;
  if (zipMtimeMs < bundle.mtimeMs) {
    fail(
      `便携包 zip 比它自己的 bundle 还旧，说明是残留的旧包：\n` +
        `  zip     ${zip}\n          ${new Date(Math.round(zipMtimeMs)).toISOString()}\n` +
        `  bundle  ${new Date(bundle.mtimeMs).toISOString()}\n` +
        `  → 仓库根有旧 zip 干扰判定。删掉或移到 .logs/archive/ 后重试。`,
    );
  }

  log(`✔ 便携包 server bundle：${bundle.size} B（源码 dist ${expected.fileCount} 个文件）`);
  return {
    kind: 'portable',
    path: zip,
    size: statSync(zip).size,
    bundleSha256: bundle.sha256,
    dotfilesAllow,
    zipHead: nameHead,
  };
}

function verifyNsis(expected) {
  if (!existsSync(STAGE_SERVER_DIST)) {
    fail(`NSIS 暂存树未就绪：${STAGE_SERVER_DIST} 不存在（先跑一次不带 --verify-only 的完整构建）`);
  }
  assertTreeSame('NSIS 暂存树 apps/server/dist', expected, fingerprintDist(STAGE_SERVER_DIST));

  // D13 第 4 条：NSIS 内嵌的壳同样必须来自本次编译。
  // 判据用 PE 时间戳：Tauri 会给内嵌副本写 bundle 类型标记（`_NSIS`），sha256 必然不同。
  const referencePe = readPeTimestamp(DESKTOP_EXE);
  if (referencePe === null) {
    fail(`缺少桌面壳产物：${DESKTOP_EXE}\n  → 先跑 node scripts/desktop/build-windows.mjs --no-bundle`);
  }

  const setup = findFile(NSIS_DIR, /-setup\.exe$/);
  if (setup === null) fail(`NSIS 安装包不存在：${NSIS_DIR} 下没有 *-setup.exe`);
  const nsisPe = assertNsisEmbedsShell(setup, referencePe);
  return { kind: 'nsis', path: setup, size: statSync(setup).size, embeddedShellPe: nsisPe.iso };
}

/**
 * 从 NSIS 安装包里取出内嵌的 `agentboard-desktop.exe` 并比对 PE 时间戳。
 *
 * 用 7-Zip 静态解包（无需真机安装），只取那一个条目。7-Zip 不在时降级为警告：
 * 这条校验的目标是抓「旧壳被打进包」，不能因为缺工具就让整个校验崩掉。
 */
function assertNsisEmbedsShell(setupPath, referencePe) {
  const sevenZip = ['C:/Program Files/7-Zip/7z.exe', 'C:/Program Files (x86)/7-Zip/7z.exe'].find((p) => existsSync(p));
  if (sevenZip === undefined) {
    log('⚠ 未找到 7-Zip，跳过 NSIS 内嵌壳校验（建议装 7-Zip 以启用该判据）');
    return referencePe;
  }
  const tempDir = join(LOG_DIR, '.nsis-pe-probe');
  rmSync(tempDir, { recursive: true, force: true });
  mkdirSync(tempDir, { recursive: true });
  const result = spawnSync(sevenZip, ['e', setupPath, `-o${tempDir}`, 'agentboard-desktop.exe', '-y'], {
    encoding: 'utf8',
  });
  const extracted = join(tempDir, 'agentboard-desktop.exe');
  if (!existsSync(extracted)) {
    rmSync(tempDir, { recursive: true, force: true });
    fail(
      `从 NSIS 安装包取内嵌壳失败（7-Zip exit=${result.status}）：\n` +
        `  ${String(result.stderr ?? '')
          .trim()
          .split('\n')
          .slice(-2)
          .join('\n  ')}`,
    );
  }
  const embedded = readPeTimestamp(extracted);
  rmSync(tempDir, { recursive: true, force: true });
  if (embedded === null) fail(`NSIS 内嵌的 agentboard-desktop.exe 不是有效 PE`);

  if (embedded.seconds !== referencePe.seconds) {
    fail(
      `NSIS 内嵌壳与源码 release 壳不是同一次编译：\n` +
        `  安装包内嵌   PE ${embedded.iso}  ${embedded.size} B\n` +
        `  源码 release PE ${referencePe.iso}  ${referencePe.size} B\n` +
        `  → 安装包被打进了旧壳。重新执行本脚本。`,
    );
  }
  log(`✔ NSIS 内嵌壳：PE ${embedded.iso} 与源码 release 一致（${embedded.size} B）`);
  return embedded;
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

    // pnpm 的 deps-status 检查会在 build 前尝试 `pnpm install --production`；
    // 在非 TTY（后台/CI/被父进程 spawn）下它会以 ERR_PNPM_ABORTED_REMOVE_MODULES_DIR_NO_TTY
    // 中止。环境变量 npm_config_verify_deps_before_run 不生效（实测），必须走 --config 参数。
    // 切勿改用 CI=true：那会真的执行 install --production 并静默删光 devDependencies。
    // 详见 `Docs/desktop-build-pitfalls.md` 坑 1。
    if (!skipBuild) {
      runPnpm('构建 workspace', ['--config.verify-deps-before-run=false', '-r', 'build']);
    } else {
      log('跳过 pnpm -r build（--skip-build）');
    }

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

    /**
     * D13：壳必须在打便携包**之前**编译好。
     *
     * 原顺序「便携包先、NSIS 后」有个致命问题：打便携包时 `tauri build` 还没跑，
     * `target/release/agentboard-desktop.exe` 是上一轮留下的；只有 NSIS 步骤内部才 cargo build。
     * 结果 zip 外层 mtime 是新的、里面装的却是旧壳（D11 实测 PE 14:52 vs 源码 release 16:11）。
     *
     * 现在拆成四段：pnpm -r build → 构建壳 → 便携包 → NSIS。
     * 壳步骤用 `--no-bundle`：只编译 exe，不预置运行时树也不打安装包。
     */
    let shellPe = null;
    if (!skipShellBuild) {
      const shellStepStart = Date.now();
      run('构建桌面壳', process.execPath, [join(ROOT, 'scripts', 'desktop', 'build-windows.mjs'), '--no-bundle']);
      const builtPe = readPeTimestamp(DESKTOP_EXE);
      if (builtPe === null || builtPe.seconds * 1000 < shellStepStart) {
        fail(
          `桌面壳构建后产物不新鲜：${DESKTOP_EXE}\n` +
            `  PE ${builtPe === null ? '（读不到）' : builtPe.iso}\n` +
            `  步骤启动 ${new Date(shellStepStart).toISOString()}\n` +
            `  → cargo 可能因缓存跳过了编译。检查 desktop/src-tauri/src 是否真的改过。`,
        );
      }
      shellPe = builtPe;
      log(`✔ 桌面壳 PE ${shellPe.iso}（${shellPe.size} B）`);
    } else {
      log('跳过桌面壳构建（--skip-shell-build）：接下来会校验壳与源码是否匹配');
      shellPe = assertShellFresh();
    }

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
    record.shell = shellPe;
    record.totalMs = Date.now() - startedAt;
    record.steps = steps;
    writeFileSync(RECORD_PATH, `${JSON.stringify(record, null, 2)}\n`, 'utf8');
    printSummary(record);
    return;
  }

  log('verify-only：只校验既有产物，不重打');
  // verify-only 也要查新鲜度：产物再自洽，dist 本身是旧的也白搭
  assertDistFresh();
  // D13 第 5 条：壳新鲜度也要在 verify-only 下查，不能只在构建期查
  assertShellFresh();
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
