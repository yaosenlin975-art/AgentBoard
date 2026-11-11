#!/usr/bin/env node
/**
 * macOS 桌面壳构建（DESKTOP-3）：Tauri 壳 → .app / .dmg，含 codesign 与 notarization 分支。
 *
 * 口径（设计 §8.4，方案 C/Tauri 已定稿，本脚本只做平台分支，不改架构）：
 *   - 渲染：WKWebView（wry 在 macOS 上默认就是它，无 WebView2/Chromium 依赖，无可安装运行时）。
 *   - 托盘：Tauri 官方托盘 API，同一套代码在 mac 上落到菜单栏图标，不写平台私有实现。
 *   - node（B10 / MAC-TRIAL-B10）：mac 产物自带 darwin 版 node 与 server payload，目标机免装 Node。
 *     node 来源只认 AGENTBOARD_NODE_DARWIN 或仓库 runtime/darwin-<arch>/node（复制进
 *     desktop/src-tauri/payload/runtime/node，经 tauri.macos.conf.json 的 bundle.resources 落到
 *     .app 的 Contents/Resources/payload/，.app 与 .dmg 同源）；PATH 上的 node 仅作构建期兜底，
 *     不随包（目标机需自备 Node）。绝不接受 node.exe，避免把 Windows 二进制交叉打进 mac 包。
 *     server payload（server bundle + web dist + darwin 原生模块）由 scripts/assemble-payload.mjs
 *     组装进 desktop/src-tauri/payload/app/，与 Windows 便携包同一布局（壳按同一路径找）。
 *
 * 用法：
 *   node scripts/desktop/build-macos.mjs --dry-run          # 任意平台可跑：只做前置核查并打印计划
 *   node scripts/desktop/build-macos.mjs                    # 仅 macOS：前置 → 组装 payload → 构建 → 签名 → 公证
 *   node scripts/desktop/build-macos.mjs --arch arm64|x64|universal [--json]
 *   node scripts/desktop/build-macos.mjs --no-notarize      # 跳过公证，只留签名
 *
 * 退出码：0 成功 / 1 前置缺失或步骤失败 / 2 平台不支持（非 darwin 且未加 --dry-run）
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { spawnFailure } from './spawn-failure.mjs';
import { chmodSync, copyFileSync, existsSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { assembleAppPayload, verifyNativeLoad } from '../assemble-payload.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const DESKTOP = join(ROOT, 'desktop');
const TAURI_DIR = join(DESKTOP, 'src-tauri');
/** B10：随包 payload 组装目录（构建产物，gitignore）；tauri.macos.conf.json 把它声明为 bundle.resources。 */
const PAYLOAD_DIR = join(TAURI_DIR, 'payload');
const PAYLOAD_NODE = join(PAYLOAD_DIR, 'runtime', 'node');

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
  const failure = spawnFailure(cmd, r);
  if (failure) {
    step(label, 'fail', failure);
    finish(1);
  }
}

/**
 * 分平台 node 二进制（卡面验收 2）。
 * 顺序：AGENTBOARD_NODE_DARWIN → runtime/darwin-<arch>/node → runtime/darwin/node → runtime/node → PATH 的 node。
 * 候选命中 .exe 即判失败：Windows 二进制不得进 mac 包。
 * 返回 { path, label, source }，source ∈ 'env' | 'runtime' | 'path'；未找到返回 null。
 * 只有 env/runtime 来源会随包（PATH 上的 node 仅构建期兜底，B10 口径）。
 */
function resolveDarwinNode() {
  const macArch = arch === 'x64' ? 'x64' : 'arm64';
  const candidates = [];
  if (process.env.AGENTBOARD_NODE_DARWIN) candidates.push(['AGENTBOARD_NODE_DARWIN', process.env.AGENTBOARD_NODE_DARWIN, 'env']);
  candidates.push([`runtime/darwin-${macArch}/node`, join(ROOT, 'runtime', `darwin-${macArch}`, 'node'), 'runtime']);
  candidates.push(['runtime/darwin/node', join(ROOT, 'runtime', 'darwin', 'node'), 'runtime']);
  candidates.push(['runtime/node', join(ROOT, 'runtime', 'node'), 'runtime']);

  for (const [label, path, source] of candidates) {
    if (path.toLowerCase().endsWith('.exe')) {
      step('node 二进制', 'fail', `${label} 是 Windows 二进制（.exe），不得交叉打包给 mac`);
      return null;
    }
    if (existsSync(path)) {
      step('node 二进制', 'ok', `${label} → ${path}${source === 'env' || source === 'runtime' ? '（随包）' : ''}`);
      return { path, label, source };
    }
  }

  const fromPath = process.platform === 'darwin' ? tryRun('which', ['node']) : null;
  if (fromPath) {
    step('node 二进制', 'ok', `PATH 上的 node → ${fromPath}（不随包；目标机需有 Node，或改放 runtime/darwin-${macArch}/node / 设 AGENTBOARD_NODE_DARWIN 使其随包）`);
    return { path: fromPath, label: 'PATH 上的 node', source: 'path' };
  }
  step('node 二进制', 'missing', `未找到 darwin 版 node：设 AGENTBOARD_NODE_DARWIN，或放 runtime/darwin-${macArch}/node`);
  return null;
}

function preflight() {
  const shellOk = existsSync(join(TAURI_DIR, 'Cargo.toml')) && existsSync(join(TAURI_DIR, 'tauri.conf.json'));
  step('Tauri 壳工程', shellOk ? 'ok' : 'missing', TAURI_DIR);
  const macConf = join(TAURI_DIR, 'tauri.macos.conf.json');
  step('mac 平台覆盖配置', existsSync(macConf) ? 'ok' : 'missing', `${relative(ROOT, macConf)}（声明 bundle.resources=payload，随包进 .app/.dmg）`);
  const serverDist = existsSync(join(ROOT, 'apps', 'server', 'dist', 'index.js'));
  step('server 构建产物', serverDist ? 'ok' : 'missing', 'apps/server/dist/index.js（先 pnpm -r build）');
  const webDist = existsSync(join(ROOT, 'apps', 'web', 'dist', 'index.html'));
  step('web 构建产物', webDist ? 'ok' : 'missing', 'apps/web/dist/index.html（先 pnpm -r build）');

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
    runOrFail('pnpm', ['--dir', DESKTOP, 'exec', 'tauri', 'build', '--bundles', 'app,dmg', '--target', target], `tauri build (${target})`);
    bundleDirs.push(join(TAURI_DIR, 'target', target, 'release', 'bundle'));
  }
  const primary = bundleDirs[0] ?? join(TAURI_DIR, 'target', 'release', 'bundle');
  step('产物目录', existsSync(primary) ? 'ok' : 'missing', primary);
  return bundleDirs;
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

/**
 * B10：随包 payload 组装（构建前跑，产物在 desktop/src-tauri/payload/，tauri build 经
 * tauri.macos.conf.json 的 bundle.resources 把它复制进 .app 与 .dmg 的 Contents/Resources/payload/）。
 * - node：仅 env/runtime 来源随包（PATH node 不随包，见 resolveDarwinNode）；随包后立即用其加载
 *   payload 内 better-sqlite3 校验 ABI。
 * - server payload：与 Windows 便携包同一布局（app/apps/server/dist + app/node_modules/…），
 *   壳的 resolve_server_entry/resolve_node 按同一路径候选找到（server_process.rs 的 mac 分支）。
 */
function stagePayload() {
  const node = resolveDarwinNode();
  rmSync(PAYLOAD_DIR, { recursive: true, force: true });
  let nodeBundled = false;
  if (node && (node.source === 'env' || node.source === 'runtime')) {
    mkdirSync(dirname(PAYLOAD_NODE), { recursive: true });
    copyFileSync(node.path, PAYLOAD_NODE);
    chmodSync(PAYLOAD_NODE, 0o755);
    nodeBundled = true;
    step('随包 node', 'ok', `${node.label} → ${relative(ROOT, PAYLOAD_NODE)}（.app 内 Contents/Resources/payload/runtime/node）`);
  } else if (node) {
    step('随包 node', 'skip', 'PATH 上的 node 不随包：目标机需自备 Node；放 runtime/darwin-<arch>/node 或设 AGENTBOARD_NODE_DARWIN 可随包');
  } else {
    step('随包 node', 'missing', '无 darwin node 可随包（仅影响免装 Node；server payload 仍会随包）');
  }

  const appDir = join(PAYLOAD_DIR, 'app');
  const sherpaArch = arch === 'x64' ? 'x64' : 'arm64';
  assembleAppPayload({ appDir, includeCli: false, sherpaPlatformPackages: [`sherpa-onnx-darwin-${sherpaArch}`] });
  step('随包 server payload', 'ok', `${relative(ROOT, appDir)}（server bundle + web dist + darwin 原生模块，与 Windows 便携包同布局）`);

  if (nodeBundled) {
    const check = verifyNativeLoad({ nodeBinary: PAYLOAD_NODE, appDir });
    step('随包原生模块校验', check.ok ? 'ok' : 'fail', check.ok ? 'better-sqlite3 可被随包 node 加载' : String(check.stderr).split('\n')[0]);
    if (!check.ok) finish(1);
  }
}

/** 构建后兜底：确保 .app 内随包 node 有执行位（resources 复制丢权限时 mac 上直接可跑）。 */
function fixupAppPayloadPermissions(bundleDirs) {
  for (const bundleRoot of bundleDirs) {
    const app = join(bundleRoot, 'macos', 'AgentBoard.app');
    const bundled = join(app, 'Contents', 'Resources', 'payload', 'runtime', 'node');
    if (existsSync(bundled)) {
      chmodSync(bundled, 0o755);
      step('随包 node 执行位', 'ok', relative(ROOT, bundled));
    }
  }
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
  step('随包 payload', 'info', `计划：组装 ${relative(ROOT, PAYLOAD_DIR)}（server bundle + web dist + darwin 原生模块，node 来源 AGENTBOARD_NODE_DARWIN / runtime/darwin-<arch>/node），经 tauri.macos.conf.json 的 bundle.resources 进 .app/.dmg`);
  step('构建', 'info', `计划：pnpm --dir desktop exec tauri build --bundles app,dmg --target ${RUST_TARGETS[arch].join(' / ')}${arch === 'universal' ? ` + ${UNIVERSAL_TARGET}` : ''}`);
  step('签名', 'info', 'codesign --force --deep --options runtime --sign <APPLE_SIGNING_IDENTITY> AgentBoard.app');
  step('公证', 'info', 'xcrun notarytool submit <dmg> --wait；xcrun stapler staple <dmg>');
  step('WKWebView / 托盘', 'info', 'Tauri v2 在 macOS 走 wry → WKWebView；托盘用官方 API 的菜单栏分支，本脚本无需平台开关');
  step('node 二进制', 'info', 'mac 随包用 runtime/darwin-<arch>/node 或 AGENTBOARD_NODE_DARWIN（PATH node 不随包）；Windows 便携包仍取 runtime/node.exe，两条路径互不交叉');
  finish();
}

stagePayload();
const bundleDirs = build();
fixupAppPayloadPermissions(bundleDirs);
const { app, dmg } = findArtifacts(bundleDirs[0]);
sign(app);
notarize(dmg);
finish();
