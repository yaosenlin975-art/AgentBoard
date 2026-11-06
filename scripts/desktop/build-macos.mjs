#!/usr/bin/env node
/**
 * macOS 桌面壳构建（DESKTOP-3）：Tauri 壳 → .app / .dmg，含 codesign 与 notarization 分支。
 *
 * 口径（设计 §8.4，方案 C/Tauri 已定稿，本脚本只做平台分支，不改架构）：
 *   - 渲染：WKWebView（wry 在 macOS 上默认就是它，无 WebView2/Chromium 依赖，无可安装运行时）。
 *   - 托盘：Tauri 官方托盘 API，同一套代码在 mac 上落到菜单栏图标，不写平台私有实现。
 *   - node：按平台分发。mac 取 darwin 版 node（runtime/darwin-<arch>/node 或 PATH 上的 node），
 *           绝不接受 node.exe，避免把 Windows 二进制交叉打进 mac 包。
 *
 * 用法：
 *   node scripts/desktop/build-macos.mjs --dry-run          # 任意平台可跑：只做前置核查并打印计划
 *   node scripts/desktop/build-macos.mjs                    # 仅 macOS：前置 → 构建 → 签名 → 公证
 *   node scripts/desktop/build-macos.mjs --arch arm64|x64|universal [--json]
 *   node scripts/desktop/build-macos.mjs --no-notarize      # 跳过公证，只留签名
 *
 * 退出码：0 成功 / 1 前置缺失或步骤失败 / 2 平台不支持（非 darwin 且未加 --dry-run）
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const DESKTOP = join(ROOT, 'desktop');
const TAURI_DIR = join(DESKTOP, 'src-tauri');

const args = process.argv.slice(2);
const hasFlag = (name) => args.includes(name);
const valueOf = (name, fallback) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] !== undefined ? args[i + 1] : fallback;
};

const dryRun = hasFlag('--dry-run');
const asJson = hasFlag('--json');
const skipNotarize = hasFlag('--no-notarize');
const arch = valueOf('--arch', process.arch === 'arm64' ? 'arm64' : 'x64');

/** arch → rust target；universal 用 tauri 的 universal-apple-darwin 产出双架构 .app */
const RUST_TARGETS = {
  arm64: ['aarch64-apple-darwin'],
  x64: ['x86_64-apple-darwin'],
  universal: ['aarch64-apple-darwin', 'x86_64-apple-darwin'],
};
const UNIVERSAL_TARGET = 'universal-apple-darwin';

const report = { platform: process.platform, arch, dryRun, steps: [], missing: [], ok: false };

function step(name, status, detail) {
  report.steps.push({ name, status, detail });
  if (status === 'missing' || status === 'fail') report.missing.push({ name, detail });
  if (!asJson) {
    const tag = { ok: 'OK  ', skip: 'SKIP', missing: 'MISS', fail: 'FAIL', info: 'INFO' }[status] ?? status;
    console.log(`[mac] ${tag} ${name}${detail ? `：${detail}` : ''}`);
  }
}

/** 跑命令并抓 stdout；失败返回 null（前置核查要能继续往下走） */
function tryRun(cmd, cmdArgs) {
  try {
    return execFileSync(cmd, cmdArgs, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 20000 }).trim();
  } catch {
    return null;
  }
}

function runOrFail(cmd, cmdArgs, label) {
  if (dryRun) {
    step(label, 'info', `将执行：${cmd} ${cmdArgs.join(' ')}`);
    return;
  }
  if (!asJson) console.log(`[mac] $ ${cmd} ${cmdArgs.join(' ')}`);
  const r = spawnSync(cmd, cmdArgs, { stdio: 'inherit', cwd: ROOT });
  if (r.status !== 0) {
    step(label, 'fail', `${cmd} 退出码 ${r.status}`);
    finish(1);
  }
}

/**
 * 分平台 node 二进制（卡面验收 2）。
 * 顺序：AGENTBOARD_NODE_DARWIN → runtime/darwin-<arch>/node → runtime/darwin/node → runtime/node → PATH 的 node。
 * 候选命中 .exe 即判失败：Windows 二进制不得进 mac 包。
 */
function resolveDarwinNode() {
  const macArch = arch === 'x64' ? 'x64' : 'arm64';
  const candidates = [];
  if (process.env.AGENTBOARD_NODE_DARWIN) candidates.push(['AGENTBOARD_NODE_DARWIN', process.env.AGENTBOARD_NODE_DARWIN]);
  candidates.push([`runtime/darwin-${macArch}/node`, join(ROOT, 'runtime', `darwin-${macArch}`, 'node')]);
  candidates.push(['runtime/darwin/node', join(ROOT, 'runtime', 'darwin', 'node')]);
  candidates.push(['runtime/node', join(ROOT, 'runtime', 'node')]);

  for (const [label, path] of candidates) {
    if (path.toLowerCase().endsWith('.exe')) {
      step('node 二进制', 'fail', `${label} 是 Windows 二进制（.exe），不得交叉打包给 mac`);
      return null;
    }
    if (existsSync(path)) {
      step('node 二进制', 'ok', `${label} → ${path}`);
      return path;
    }
  }

  const fromPath = process.platform === 'darwin' ? tryRun('which', ['node']) : null;
  if (fromPath) {
    step('node 二进制', 'ok', `PATH 上的 node → ${fromPath}（不在包内；目标机需有 Node，或改放 runtime/darwin-${macArch}/node）`);
    return fromPath;
  }
  step('node 二进制', 'missing', `未找到 darwin 版 node：设 AGENTBOARD_NODE_DARWIN，或放 runtime/darwin-${macArch}/node`);
  return null;
}

function preflight() {
  const shellOk = existsSync(join(TAURI_DIR, 'Cargo.toml')) && existsSync(join(TAURI_DIR, 'tauri.conf.json'));
  step('Tauri 壳工程', shellOk ? 'ok' : 'missing', TAURI_DIR);

  const targets = RUST_TARGETS[arch];
  if (!targets) {
    step('目标架构', 'fail', `未知 --arch ${arch}（只接受 arm64 / x64 / universal）`);
    return;
  }
  step('目标架构', 'ok', arch === 'universal' ? `${arch} → ${targets.join(', ')} + ${UNIVERSAL_TARGET}` : `${arch} → ${targets.join(', ')}`);

  if (process.platform !== 'darwin') {
    step('运行平台', dryRun ? 'info' : 'fail', `当前 ${process.platform}；真实构建只能在 macOS 上跑（--dry-run 仅打印计划）`);
    return;
  }

  const swVers = tryRun('sw_vers', ['-productVersion']);
  step('macOS 版本', swVers ? 'ok' : 'missing', swVers ?? 'sw_vers 不可用');
  const xcode = tryRun('xcode-select', ['-p']);
  step('Xcode Command Line Tools', xcode ? 'ok' : 'missing', xcode ?? '先跑 xcode-select --install');
  step('rustc', tryRun('rustc', ['-V']) ? 'ok' : 'missing', '装 Rust 工具链（rustup）');
  step('cargo', tryRun('cargo', ['-V']) ? 'ok' : 'missing', '装 Rust 工具链（rustup）');

  const installed = tryRun('rustup', ['target', 'list', '--installed']);
  for (const target of targets) {
    const label = `rust target ${target}`;
    if (!installed) {
      step(label, 'missing', `rustup 不可用，需 rustup target add ${target}`);
      continue;
    }
    const has = installed.split('\n').map((l) => l.trim()).includes(target);
    step(label, has ? 'ok' : 'missing', `rustup target add ${target}`);
  }

  resolveDarwinNode();

  const identity = process.env.APPLE_SIGNING_IDENTITY;
  step('签名身份', identity ? 'ok' : 'missing', identity ? identity : '未设 APPLE_SIGNING_IDENTITY → 产物未签名，外部分发会被 Gatekeeper 拦');

  if (skipNotarize) {
    step('公证凭据', 'skip', '--no-notarize');
  } else {
    const appleIdOk = Boolean(process.env.APPLE_ID && process.env.APPLE_TEAM_ID && process.env.APPLE_APP_SPECIFIC_PASSWORD);
    const apiKeyOk = Boolean(process.env.APPLE_API_KEY && process.env.APPLE_API_KEY_ID && process.env.APPLE_API_ISSUER);
    step('公证凭据', appleIdOk || apiKeyOk ? 'ok' : 'missing',
      appleIdOk ? 'APPLE_ID + APPLE_TEAM_ID + APPLE_APP_SPECIFIC_PASSWORD'
        : apiKeyOk ? 'APPLE_API_KEY + APPLE_API_KEY_ID + APPLE_API_ISSUER'
          : '未提供 Apple ID 或 API Key 三件套 → 跳过公证');
  }
}

function build() {
  const targets = RUST_TARGETS[arch];
  const bundleDirs = [];
  for (const target of targets) {
    runOrFail('pnpm', ['--dir', DESKTOP, 'run', 'build', '--', '--target', target, '--bundles', 'app,dmg'], `tauri build (${target})`);
    bundleDirs.push(join(TAURI_DIR, 'target', target, 'release', 'bundle'));
  }
  const primary = bundleDirs[0] ?? join(TAURI_DIR, 'target', 'release', 'bundle');
  step('产物目录', existsSync(primary) ? 'ok' : 'missing', primary);
  return primary;
}

function findArtifacts(bundleRoot) {
  const appDir = join(bundleRoot, 'macos');
  const app = existsSync(appDir) ? join(appDir, 'AgentBoard.app') : null;
  step('AgentBoard.app', app ? 'ok' : 'missing', app ?? appDir);

  const dmgDir = join(bundleRoot, 'dmg');
  let dmg = null;
  if (existsSync(dmgDir)) {
    const hit = readdirSync(dmgDir).find((n) => n.endsWith('.dmg'));
    if (hit) dmg = join(dmgDir, hit);
  }
  step('dmg', dmg ? 'ok' : 'missing', dmg ?? dmgDir);
  return { app, dmg };
}

function sign(app) {
  if (!app) return;
  const identity = process.env.APPLE_SIGNING_IDENTITY;
  if (!identity) {
    step('codesign', 'skip', '无签名身份，产物保持未签名');
    return;
  }
  const signArgs = ['--force', '--deep', '--options', 'runtime'];
  const entitlements = join(TAURI_DIR, 'entitlements.plist');
  if (existsSync(entitlements)) signArgs.push('--entitlements', entitlements);
  signArgs.push('--sign', identity, app);
  runOrFail('codesign', signArgs, 'codesign');
}

function notarize(dmg) {
  if (skipNotarize) return step('notarization', 'skip', '--no-notarize');
  if (!dmg) return step('notarization', 'skip', '无 dmg');

  const hasAppleId = process.env.APPLE_ID && process.env.APPLE_TEAM_ID && process.env.APPLE_APP_SPECIFIC_PASSWORD;
  const hasApiKey = process.env.APPLE_API_KEY && process.env.APPLE_API_KEY_ID && process.env.APPLE_API_ISSUER;
  if (!hasAppleId && !hasApiKey) return step('notarization', 'skip', '无凭据，跳过；外部分发前必须补公证');

  const submit = ['notarytool', 'submit', dmg, '--wait'];
  if (hasApiKey) submit.push('--key', process.env.APPLE_API_KEY, '--key-id', process.env.APPLE_API_KEY_ID, '--issuer', process.env.APPLE_API_ISSUER);
  else submit.push('--apple-id', process.env.APPLE_ID, '--team-id', process.env.APPLE_TEAM_ID, '--password', process.env.APPLE_APP_SPECIFIC_PASSWORD);
  runOrFail('xcrun', submit, 'notarization');
  runOrFail('xcrun', ['stapler', 'staple', dmg], 'stapler');
}

function finish(forcedCode) {
  const missingCount = report.missing.length;
  report.ok = forcedCode === undefined && (missingCount === 0 || (dryRun && report.missing.every((m) => m.name === '运行平台')));
  if (asJson) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log(`[mac] 结果：${report.ok ? 'OK' : '有未满足项'}（未满足 ${missingCount} 项）`);
    for (const m of report.missing) console.log(`  - ${m.name}：${m.detail}`);
    if (process.platform !== 'darwin') {
      console.log('[mac] 提示：未在 macOS 真机验证（开发机为 Windows）；构建、签名、公证需在 mac 上复核。');
    }
  }
  process.exit(forcedCode ?? (report.ok ? 0 : 1));
}

// ---- 主流程 ----
if (process.platform !== 'darwin' && !dryRun) {
  step('运行平台', 'fail', `非 darwin（${process.platform}）：macOS 构建只能在 mac 上跑；用 --dry-run 只看计划`);
  finish(2);
}

preflight();

if (dryRun) {
  step('构建', 'info', `计划：pnpm --dir desktop run build -- --target ${RUST_TARGETS[arch].join(' / ')}${arch === 'universal' ? ` + ${UNIVERSAL_TARGET}` : ''} --bundles app,dmg`);
  step('签名', 'info', 'codesign --force --deep --options runtime --sign <APPLE_SIGNING_IDENTITY> AgentBoard.app');
  step('公证', 'info', 'xcrun notarytool submit <dmg> --wait；xcrun stapler staple <dmg>');
  step('WKWebView / 托盘', 'info', 'Tauri v2 在 macOS 走 wry → WKWebView；托盘用官方 API 的菜单栏分支，本脚本无需平台开关');
  step('node 二进制', 'info', 'mac 用 runtime/darwin-<arch>/node；Windows 仍取 runtime/node.exe，两条路径互不交叉');
  finish();
}

const bundleRoot = build();
const { app, dmg } = findArtifacts(bundleRoot);
sign(app);
notarize(dmg);
finish();
