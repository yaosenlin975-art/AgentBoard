/**
 * kb autostart：开机自启管理。
 * - Windows：HKCU Run 键 → wscript.exe 启动 scripts/agentboard.vbs autostart；install 把
 *   node 路径/仓库/端口/日志目录写进 vbs 顶部常量区（正则重写，重复 install 可更新端口）。
 * - macOS：~/Library/LaunchAgents/com.agentboard.server.plist（launchd LaunchAgent，RunAtLoad）。
 * 零 npm 依赖。
 */
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { request } from '../api.js';
import type { Ctx, Io } from '../io.js';
import { firstLine, type Runner, spawnRunner } from '../winrun.js';

/** 供命令层消费者复用（测试注入假 Runner）；类型本体在 winrun.ts */
export type { Runner };

/** HKCU Run 注册表键（用户级，无需管理员） */
export const RUN_KEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run';
/** Run 键下的值名 */
export const RUN_VALUE_NAME = 'AgentBoard';
/** config.json 缺失/损坏时的缺省端口（与服务端默认一致） */
export const DEFAULT_PORT = 8787;

/** 相关路径集合；install/uninstall/status/shortcut 共用 */
export interface AutostartPaths {
  repoRoot: string;
  vbsPath: string;
  /** 服务端构建产物（前置检查） */
  serverEntry: string;
  /** %APPDATA%\AgentBoard\config.json（端口来源） */
  configPath: string;
  logDir: string;
  logFile: string;
  iconPath: string;
}

export function resolveAutostartPaths(repoRoot: string, appData: string | undefined): AutostartPaths {
  if (!appData) throw new Error('APPDATA 环境变量未设置，无法定位配置与日志目录');
  const agentDir = join(appData, 'AgentBoard');
  return {
    repoRoot,
    vbsPath: join(repoRoot, 'scripts', 'agentboard.vbs'),
    serverEntry: join(repoRoot, 'apps', 'server', 'dist', 'index.js'),
    configPath: join(agentDir, 'config.json'),
    logDir: join(agentDir, 'logs'),
    logFile: join(agentDir, 'logs', 'server.log'),
    iconPath: join(repoRoot, 'apps', 'web', 'public', 'agentboard.ico'),
  };
}

/** 从 startDir 逐级向上找 pnpm-workspace.yaml 定位仓库根（src 与 dist 布局均适用） */
export function findRepoRoot(startDir: string): string {
  let dir = startDir;
  for (;;) {
    if (existsSync(join(dir, 'pnpm-workspace.yaml'))) return dir;
    const parent = dirname(dir);
    if (parent === dir) throw new Error(`未找到仓库根（pnpm-workspace.yaml）：从 ${startDir} 向上遍历失败`);
    dir = parent;
  }
}

/** 默认路径（真实执行）：仓库根从本模块位置推导 */
export function defaultPaths(): AutostartPaths {
  return resolveAutostartPaths(findRepoRoot(dirname(fileURLToPath(import.meta.url))), process.env.APPDATA);
}

/** 非 Windows 统一报错（三命令入口先调用；shortcut 复用）；可注入平台便于单测 */
export function requireWindows(platform: NodeJS.Platform = process.platform): void {
  if (platform !== 'win32') throw new Error('仅支持 Windows');
}

/** config.json 文本 → 端口；缺失/损坏/非法回缺省 8787 */
export function parsePort(configText: string, fallback: number = DEFAULT_PORT): number {
  try {
    const data = JSON.parse(configText) as { port?: unknown };
    if (typeof data.port === 'number' && Number.isInteger(data.port) && data.port > 0 && data.port < 65536) {
      return data.port;
    }
  } catch {
    /* 损坏回缺省 */
  }
  return fallback;
}

/** 读 config.json 端口；文件不存在/不可读回缺省 */
export function readPortFile(configPath: string): number {
  try {
    return parsePort(readFileSync(configPath, 'utf8'));
  } catch {
    return DEFAULT_PORT;
  }
}

/** Run 键值：wscript.exe 隐藏启动 vbs autostart 模式 */
export function buildRunValue(vbsPath: string): string {
  return `wscript.exe "${vbsPath}" autostart`;
}

export function buildRegQueryArgs(): string[] {
  return ['query', RUN_KEY, '/v', RUN_VALUE_NAME];
}

export function buildRegAddArgs(value: string): string[] {
  return ['add', RUN_KEY, '/v', RUN_VALUE_NAME, '/t', 'REG_SZ', '/d', value, '/f'];
}

export function buildRegDeleteArgs(): string[] {
  return ['delete', RUN_KEY, '/v', RUN_VALUE_NAME, '/f'];
}

/** reg query 输出 → AgentBoard 值数据；无 REG_SZ 行（未安装/找不到）返回 null */
export function parseRegQueryValue(stdout: string): string | null {
  for (const line of stdout.split(/\r?\n/)) {
    const idx = line.indexOf('REG_SZ');
    if (idx === -1) continue;
    const value = line.slice(idx + 'REG_SZ'.length).trim();
    if (value !== '') return value;
  }
  return null;
}

/** Run 键值是否本工具写入（值里含 agentboard.vbs；大小写不敏感） */
export function ownsAutostartValue(value: string): boolean {
  return value.toLowerCase().includes('agentboard.vbs');
}

/** 查询 Run 键当前值；reg query 非 0 视为未安装（HKCU 下非 0 基本只有"找不到"） */
export async function queryRunValue(run: Runner): Promise<string | null> {
  const res = await run('reg.exe', buildRegQueryArgs());
  return res.code === 0 ? parseRegQueryValue(res.stdout) : null;
}

// ---- vbs 常量重写 ----

export interface VbsConfig {
  nodePath: string;
  repoRoot: string;
  logDir: string;
  port: number;
}

const VBS_CONST_NAMES = ['NODE_PATH', 'REPO_ROOT', 'LOG_DIR', 'PORT'] as const;

/**
 * 读 vbs：UTF-16LE BOM → utf16le（install 写回的已配置状态），否则 utf8（仓库模板）。
 * 与 writeVbsText 配对，重复 install 幂等。
 */
export function readVbsText(path: string): string {
  const buf = readFileSync(path);
  if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) return buf.subarray(2).toString('utf16le');
  return buf.toString('utf8');
}

/**
 * 写 vbs：固定 UTF-16LE + BOM。wscript 对无 BOM 脚本按 ANSI 码页解码，
 * UTF-8 直写的中文仓库路径在 ACP≠65001 机器上会乱码导致启动失败。
 */
export function writeVbsText(path: string, text: string): void {
  writeFileSync(path, `\uFEFF${text}`, 'utf16le');
}

/** vbs 内 `"` 转义（VBScript 字符串内双写） */
function vbsEscape(value: string): string {
  return value.split('"').join('""');
}

/** 重写一行 `Const <NAME> = "..."`（占位符与已配置状态均可重写，重复 install 可更新端口） */
function setVbsConst(content: string, name: string, value: string): string {
  const re = new RegExp(`^Const ${name} = ".*"$`, 'm');
  if (!re.test(content)) throw new Error(`agentboard.vbs 缺少常量 ${name}（模板结构不符）`);
  const line = `Const ${name} = "${vbsEscape(value)}"`;
  // replacer 函数形式：路径含 $ 时避免被 String.replace 当作 $&/$1 替换模式展开
  return content.replace(re, () => line);
}

/** 把 node/仓库/日志目录/端口写进 vbs 常量区；返回新内容 */
export function applyVbsConstants(content: string, cfg: VbsConfig): string {
  let out = setVbsConst(content, 'NODE_PATH', cfg.nodePath);
  out = setVbsConst(out, 'REPO_ROOT', cfg.repoRoot);
  out = setVbsConst(out, 'LOG_DIR', cfg.logDir);
  out = setVbsConst(out, 'PORT', String(cfg.port));
  return out;
}

/** vbs 是否已配置（任一常量仍为 %NAME% 占位符 → 未配置） */
export function isVbsConfigured(content: string): boolean {
  for (const name of VBS_CONST_NAMES) {
    if (content.includes(`Const ${name} = "%${name}%"`)) return false;
  }
  return true;
}

// ---- 命令实现 ----

export interface AutostartOptions {
  runner?: Runner;
  paths?: AutostartPaths;
  /** 覆盖 node 路径（默认 process.execPath）；测试注入 */
  nodePath?: string;
  /** 覆盖平台判定（测试注入 darwin）；默认 process.platform */
  platform?: NodeJS.Platform;
  /** 覆盖 LaunchAgent 路径（测试注入临时目录）；默认按 HOME 推导 */
  launchPaths?: LaunchAgentPaths;
  /** launchctl 的 gui/<uid> 会话（测试注入；默认 process.getuid） */
  uid?: number;
  /** 覆盖 systemd user unit 路径（测试注入临时目录）；默认按 HOME 推导 */
  systemdPaths?: SystemdPaths;
}

/** 三平台自启实现名；status --json 的 provider 字段取值 */
export type AutostartProvider = 'hkcu-run' | 'launchagent' | 'systemd-user';

/** 统一抽象：同一组 install/uninstall/status 背后按平台落不同机制 */
export interface AutostartBackend {
  readonly provider: AutostartProvider;
  install(io: Io): Promise<void>;
  uninstall(io: Io): Promise<void>;
  status(ctx: Ctx): Promise<void>;
}

/**
 * 平台 → 自启后端。darwin=LaunchAgent，linux=systemd user unit，win32=HKCU Run + vbs。
 * 其余平台直接报错（不静默退化），便于用户明确知道不支持。
 */
export function createAutostartBackend(platform: NodeJS.Platform, opts: AutostartOptions = {}): AutostartBackend {
  if (platform === 'darwin') {
    return {
      provider: 'launchagent',
      install: (io) => installLaunchAgent(io, opts),
      uninstall: (io) => uninstallLaunchAgent(io, opts),
      status: (ctx) => statusLaunchAgent(ctx, opts),
    };
  }
  if (platform === 'linux') {
    return {
      provider: 'systemd-user',
      install: (io) => installSystemdUnit(io, opts),
      uninstall: (io) => uninstallSystemdUnit(io, opts),
      status: (ctx) => statusSystemdUnit(ctx, opts),
    };
  }
  if (platform === 'win32') {
    return {
      provider: 'hkcu-run',
      install: (io) => installWindowsAutostart(io, opts),
      uninstall: (io) => uninstallWindowsAutostart(io, opts),
      status: (ctx) => statusWindowsAutostart(ctx, opts),
    };
  }
  throw new Error(`不支持的开机自启平台：${platform}（仅 Windows / macOS / Linux）`);
}

/** 安装：按平台分派到 LaunchAgent / systemd user unit / HKCU Run */
export async function installAutostart(io: Io, opts: AutostartOptions = {}): Promise<void> {
  return createAutostartBackend(opts.platform ?? process.platform, opts).install(io);
}

/** 卸载：按平台分派；三平台都要求撤销后无残留自启项 */
export async function uninstallAutostart(io: Io, opts: AutostartOptions = {}): Promise<void> {
  return createAutostartBackend(opts.platform ?? process.platform, opts).uninstall(io);
}

/** 状态：安装情况 + 服务可达性 + 日志路径 */
export async function statusAutostart(ctx: Ctx, opts: AutostartOptions = {}): Promise<void> {
  return createAutostartBackend(opts.platform ?? process.platform, opts).status(ctx);
}

async function installWindowsAutostart(io: Io, opts: AutostartOptions): Promise<void> {
  requireWindows();
  const run = opts.runner ?? spawnRunner;
  const paths = opts.paths ?? defaultPaths();
  const nodePath = opts.nodePath ?? process.execPath;
  if (!existsSync(paths.serverEntry)) {
    throw new Error(`服务未构建：${paths.serverEntry} 不存在，先 corepack pnpm -r build`);
  }
  const port = readPortFile(paths.configPath);
  const desired = buildRunValue(paths.vbsPath);
  // vbs 常量每次 install 都重写（Run 键值不含端口，改端口后重新 install 靠这里生效）
  const template = readVbsText(paths.vbsPath);
  writeVbsText(paths.vbsPath, applyVbsConstants(template, { nodePath, repoRoot: paths.repoRoot, logDir: paths.logDir, port }));
  const current = await queryRunValue(run);
  if (current === desired) {
    io.write(`开机自启已安装（Run 键值一致，无需变更）\n`);
    io.write(`日志: ${paths.logFile}\n`);
    io.write(`端口 ${port} 已写入 vbs；改端口后需重新执行 kb autostart install\n`);
    return;
  }
  if (current !== null) io.write(`覆盖已有 Run 键值：${current}\n`);
  const res = await run('reg.exe', buildRegAddArgs(desired));
  if (res.code !== 0) throw new Error(`写入注册表失败：${firstLine(res.stderr)}`);
  io.write(`已安装开机自启：${RUN_KEY} → ${RUN_VALUE_NAME}\n`);
  io.write(`启动: ${desired}\n`);
  io.write(`日志: ${paths.logFile}\n`);
  io.write(`端口 ${port} 已写入 vbs；改端口后需重新执行 kb autostart install\n`);
}

/** 卸载：仅当 Run 键值含 agentboard.vbs 才删（非自家值不动）；vbs 文件保留 */
async function uninstallWindowsAutostart(io: Io, opts: AutostartOptions): Promise<void> {
  requireWindows();
  const run = opts.runner ?? spawnRunner;
  const current = await queryRunValue(run);
  if (current === null) {
    io.write('未安装开机自启\n');
    return;
  }
  if (!ownsAutostartValue(current)) {
    throw new Error(`Run 键 ${RUN_VALUE_NAME} 为其他程序占用（${current}），未删除`);
  }
  const res = await run('reg.exe', buildRegDeleteArgs());
  if (res.code !== 0) throw new Error(`删除注册表失败：${firstLine(res.stderr)}`);
  io.write('已移除开机自启（scripts/agentboard.vbs 文件保留）\n');
}

/** 状态：Run 键安装情况 + 服务可达性（GET /api/version，端口取 config.json）+ 日志路径 */
async function statusWindowsAutostart(ctx: Ctx, opts: AutostartOptions): Promise<void> {
  requireWindows();
  const run = opts.runner ?? spawnRunner;
  const paths = opts.paths ?? defaultPaths();
  const port = readPortFile(paths.configPath);
  const base = `http://127.0.0.1:${port}`;
  const value = await queryRunValue(run);
  const probe = await probeService(base);
  if (ctx.json) {
    ctx.io.write(
      `${JSON.stringify(
        {
          autostart: { installed: value !== null, provider: 'hkcu-run', value, run_key: RUN_KEY },
          service: { base, ...probe },
          log: paths.logFile,
        },
        null,
        2,
      )}\n`,
    );
    return;
  }
  ctx.io.write(`自启: ${value !== null ? `已安装（${value}）` : '未安装'}\n`);
  ctx.io.write(`服务: ${probe.reachable ? `可达 ${base}${probe.version !== null ? `（版本 ${probe.version}）` : ''}` : `不可达 ${base}（${probe.error}）`}\n`);
  ctx.io.write(`日志: ${paths.logFile}\n`);
}

// ---- macOS launchd（LaunchAgent）----

/** LaunchAgent label（plist 文件名与 launchctl 标识一致） */
export const LAUNCH_LABEL = 'com.agentboard.server';

export interface LaunchAgentPaths {
  repoRoot: string;
  /** ~/Library/LaunchAgents/com.agentboard.server.plist */
  plistPath: string;
  /** 服务端构建产物（前置检查） */
  serverEntry: string;
  /** ~/.config/AgentBoard/config.json（端口来源；与 apps/server/src/config.ts 的 appDataDir 同口径） */
  configPath: string;
  logDir: string;
  logFile: string;
}

/**
 * mac 路径集合。configDir 口径必须与 apps/server/src/config.ts 的 appDataDir() 一致：
 * mac 无 APPDATA 环境变量 → `~/.config/AgentBoard`（不是 Windows 的 `%APPDATA%\AgentBoard`）。
 */
export function resolveLaunchAgentPaths(repoRoot: string, home: string | undefined): LaunchAgentPaths {
  if (!home) throw new Error('HOME 环境变量未设置，无法定位 ~/Library/LaunchAgents');
  const agentDir = join(home, '.config', 'AgentBoard');
  return {
    repoRoot,
    plistPath: join(home, 'Library', 'LaunchAgents', `${LAUNCH_LABEL}.plist`),
    serverEntry: join(repoRoot, 'apps', 'server', 'dist', 'index.js'),
    configPath: join(agentDir, 'config.json'),
    logDir: join(agentDir, 'logs'),
    logFile: join(agentDir, 'logs', 'server.log'),
  };
}

/** 默认 mac 路径（真实执行） */
export function defaultLaunchPaths(): LaunchAgentPaths {
  return resolveLaunchAgentPaths(findRepoRoot(dirname(fileURLToPath(import.meta.url))), homedir());
}

export interface PlistConfig {
  nodePath: string;
  serverEntry: string;
  repoRoot: string;
  logFile: string;
}

function xmlEscape(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/**
 * 生成 LaunchAgent plist（纯函数，便于单测断言结构）。
 * RunAtLoad：登录即拉起；KeepAlive=false：由服务自身单例锁兜底，不在这里做崩溃重启，
 * 避免与 server.lock 的单例拒绝逻辑互相打架（重启策略不在本卡范围）。
 */
export function buildLaunchAgentPlist(cfg: PlistConfig): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${LAUNCH_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${xmlEscape(cfg.nodePath)}</string>
    <string>${xmlEscape(cfg.serverEntry)}</string>
  </array>
  <key>WorkingDirectory</key>
  <string>${xmlEscape(cfg.repoRoot)}</string>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <false/>
  <key>StandardOutPath</key>
  <string>${xmlEscape(cfg.logFile)}</string>
  <key>StandardErrorPath</key>
  <string>${xmlEscape(cfg.logFile)}</string>
</dict>
</plist>
`;
}

/**
 * launchctl 入口。macOS 10.10+ 官方推荐 bootstrap/bootout（load/unload 已废弃），
 * 服务目标写作 gui/<uid>/<label>（当前登录用户会话，无需 root）。
 */
export function launchServiceTarget(uid: number, label: string = LAUNCH_LABEL): string {
  return `gui/${uid}/${label}`;
}

export function buildBootstrapArgs(uid: number, plistPath: string): string[] {
  return ['bootstrap', `gui/${uid}`, plistPath];
}

export function buildBootoutArgs(uid: number, label: string = LAUNCH_LABEL): string[] {
  return ['bootout', launchServiceTarget(uid, label)];
}

/** launchctl list <label> 是否已加载（退出码 0 = 已加载） */
export async function queryLaunchLoaded(run: Runner, label: string = LAUNCH_LABEL): Promise<boolean> {
  const res = await run('launchctl', ['list', label]);
  return res.code === 0;
}

function requireUid(uid: number | undefined): number {
  const value = uid ?? (typeof process.getuid === 'function' ? process.getuid() : null);
  if (value === null || value === undefined) throw new Error('无法确定当前 uid（launchctl 需要 gui/<uid>）');
  return value;
}

/** bootout 报「未加载」不算失败：目标语义是「不再自启」，后续删 plist 已达成 */
function isBootoutNotLoaded(stderr: string): boolean {
  return /could not find|no such process|input\/output error|not find/i.test(stderr);
}

async function installLaunchAgent(io: Io, opts: AutostartOptions): Promise<void> {
  const run = opts.runner ?? spawnRunner;
  const paths = opts.launchPaths ?? defaultLaunchPaths();
  const nodePath = opts.nodePath ?? process.execPath;
  const uid = requireUid(opts.uid);
  if (!existsSync(paths.serverEntry)) {
    throw new Error(`服务未构建：${paths.serverEntry} 不存在，先 corepack pnpm -r build`);
  }
  mkdirSync(paths.logDir, { recursive: true });
  mkdirSync(dirname(paths.plistPath), { recursive: true });
  const plist = buildLaunchAgentPlist({ nodePath, serverEntry: paths.serverEntry, repoRoot: paths.repoRoot, logFile: paths.logFile });
  const existed = existsSync(paths.plistPath);
  writeFileSync(paths.plistPath, plist, 'utf8');
  // 已加载时 bootstrap 会因重复而失败：先 bootout 再 bootstrap，重复 install 幂等且新 plist 生效
  if (await queryLaunchLoaded(run)) {
    const bootout = await run('launchctl', buildBootoutArgs(uid));
    if (bootout.code !== 0 && !isBootoutNotLoaded(bootout.stderr)) {
      throw new Error(`卸载已有 LaunchAgent 失败：${firstLine(bootout.stderr)}`);
    }
  }
  const res = await run('launchctl', buildBootstrapArgs(uid, paths.plistPath));
  if (res.code !== 0) throw new Error(`launchctl bootstrap 失败：${firstLine(res.stderr)}`);
  io.write(`已安装开机自启：LaunchAgent ${LAUNCH_LABEL}${existed ? '（覆盖已有 plist）' : ''}\n`);
  io.write(`plist: ${paths.plistPath}\n`);
  io.write(`启动: ${nodePath} ${paths.serverEntry}\n`);
  io.write(`日志: ${paths.logFile}\n`);
  io.write(`检查: launchctl list ${LAUNCH_LABEL}\n`);
}

/** 卸载：先 bootout（未加载不算失败），再删 plist；日志目录保留 */
async function uninstallLaunchAgent(io: Io, opts: AutostartOptions): Promise<void> {
  const run = opts.runner ?? spawnRunner;
  const paths = opts.launchPaths ?? defaultLaunchPaths();
  const uid = requireUid(opts.uid);
  if (!existsSync(paths.plistPath)) {
    io.write('未安装开机自启\n');
    return;
  }
  const res = await run('launchctl', buildBootoutArgs(uid));
  if (res.code !== 0 && !isBootoutNotLoaded(res.stderr)) {
    throw new Error(`launchctl bootout 失败：${firstLine(res.stderr)}`);
  }
  unlinkSync(paths.plistPath);
  io.write('已移除开机自启（LaunchAgent 已卸载并删除 plist）\n');
}

async function statusLaunchAgent(ctx: Ctx, opts: AutostartOptions): Promise<void> {
  const run = opts.runner ?? spawnRunner;
  const paths = opts.launchPaths ?? defaultLaunchPaths();
  const port = readPortFile(paths.configPath);
  const base = `http://127.0.0.1:${port}`;
  const installed = existsSync(paths.plistPath);
  const loaded = installed ? await queryLaunchLoaded(run) : false;
  const probe = await probeService(base);
  if (ctx.json) {
    ctx.io.write(
      `${JSON.stringify(
        {
          autostart: { installed, provider: 'launchagent', label: LAUNCH_LABEL, plist: paths.plistPath, loaded },
          service: { base, ...probe },
          log: paths.logFile,
        },
        null,
        2,
      )}\n`,
    );
    return;
  }
  ctx.io.write(`自启: ${installed ? `已安装（LaunchAgent ${LAUNCH_LABEL}${loaded ? '，已加载' : '，未加载'}）` : '未安装'}\n`);
  ctx.io.write(`服务: ${probe.reachable ? `可达 ${base}${probe.version !== null ? `（版本 ${probe.version}）` : ''}` : `不可达 ${base}（${probe.error}）`}\n`);
  ctx.io.write(`plist: ${paths.plistPath}\n`);
  ctx.io.write(`日志: ${paths.logFile}\n`);
}

// ---- Linux systemd（user unit）----

/** systemd user unit 名 */
export const SYSTEMD_UNIT_NAME = 'agentboard.service';

export interface SystemdPaths {
  repoRoot: string;
  /** ~/.config/systemd/user/agentboard.service */
  unitPath: string;
  /** 服务端构建产物（前置检查） */
  serverEntry: string;
  /** ~/.config/AgentBoard/config.json（端口来源；与服务端 appDataDir 同口径） */
  configPath: string;
  logDir: string;
  logFile: string;
}

export function resolveSystemdPaths(repoRoot: string, home: string | undefined): SystemdPaths {
  if (!home) throw new Error('HOME 环境变量未设置，无法定位 ~/.config/systemd/user');
  const configBase = join(home, '.config');
  return {
    repoRoot,
    unitPath: join(configBase, 'systemd', 'user', SYSTEMD_UNIT_NAME),
    serverEntry: join(repoRoot, 'apps', 'server', 'dist', 'index.js'),
    configPath: join(configBase, 'AgentBoard', 'config.json'),
    logDir: join(configBase, 'AgentBoard', 'logs'),
    logFile: join(configBase, 'AgentBoard', 'logs', 'server.log'),
  };
}

export function defaultSystemdPaths(): SystemdPaths {
  return resolveSystemdPaths(findRepoRoot(dirname(fileURLToPath(import.meta.url))), homedir());
}

export interface SystemdUnitConfig {
  nodePath: string;
  serverEntry: string;
  repoRoot: string;
  logFile: string;
}

/** systemd 参数含空格时用双引号；内部 \ 与 " 转义 */
function systemdQuote(value: string): string {
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

/**
 * 生成 systemd user unit（纯函数，便于单测断言）。
 * Restart=no 与 LaunchAgent 的 KeepAlive=false 同口径：服务自身单例锁，不在这里做崩溃重启。
 */
export function buildSystemdUnit(cfg: SystemdUnitConfig): string {
  return `[Unit]
Description=AgentBoard server
After=network.target

[Service]
Type=simple
WorkingDirectory=${systemdQuote(cfg.repoRoot)}
ExecStart=${systemdQuote(cfg.nodePath)} ${systemdQuote(cfg.serverEntry)}
Restart=no
StandardOutput=append:${cfg.logFile}
StandardError=append:${cfg.logFile}

[Install]
WantedBy=default.target
`;
}

export function buildSystemctlDaemonReloadArgs(): string[] {
  return ['--user', 'daemon-reload'];
}

export function buildSystemctlEnableArgs(unit: string = SYSTEMD_UNIT_NAME): string[] {
  return ['--user', 'enable', '--now', unit];
}

export function buildSystemctlDisableArgs(unit: string = SYSTEMD_UNIT_NAME): string[] {
  return ['--user', 'disable', '--now', unit];
}

export function buildSystemctlIsEnabledArgs(unit: string = SYSTEMD_UNIT_NAME): string[] {
  return ['--user', 'is-enabled', unit];
}

export function buildSystemctlIsActiveArgs(unit: string = SYSTEMD_UNIT_NAME): string[] {
  return ['--user', 'is-active', unit];
}

/** disable 报「未加载/不存在」不算失败：后续删 unit 文件已达成「不再自启」 */
function isSystemdNotLoaded(stderr: string): boolean {
  return /not loaded|no such file|does not exist|could not be found/i.test(stderr);
}

async function installSystemdUnit(io: Io, opts: AutostartOptions): Promise<void> {
  const run = opts.runner ?? spawnRunner;
  const paths = opts.systemdPaths ?? defaultSystemdPaths();
  const nodePath = opts.nodePath ?? process.execPath;
  if (!existsSync(paths.serverEntry)) {
    throw new Error(`服务未构建：${paths.serverEntry} 不存在，先 corepack pnpm -r build`);
  }
  mkdirSync(paths.logDir, { recursive: true });
  mkdirSync(dirname(paths.unitPath), { recursive: true });
  const existed = existsSync(paths.unitPath);
  writeFileSync(
    paths.unitPath,
    buildSystemdUnit({ nodePath, serverEntry: paths.serverEntry, repoRoot: paths.repoRoot, logFile: paths.logFile }),
    'utf8',
  );
  const reload = await run('systemctl', buildSystemctlDaemonReloadArgs());
  if (reload.code !== 0) throw new Error(`systemctl --user daemon-reload 失败：${firstLine(reload.stderr)}`);
  const res = await run('systemctl', buildSystemctlEnableArgs());
  if (res.code !== 0) {
    throw new Error(`systemctl --user enable --now 失败：${firstLine(res.stderr)}（无用户 systemd 会话的容器/WSL 环境不可用）`);
  }
  io.write(`已安装开机自启：systemd user unit ${SYSTEMD_UNIT_NAME}${existed ? '（覆盖已有 unit）' : ''}\n`);
  io.write(`unit: ${paths.unitPath}\n`);
  io.write(`启动: ${nodePath} ${paths.serverEntry}\n`);
  io.write(`日志: ${paths.logFile}\n`);
  io.write(`检查: systemctl --user status ${SYSTEMD_UNIT_NAME}\n`);
}

/** 卸载：disable --now → 删 unit 文件 → daemon-reload；日志目录保留 */
async function uninstallSystemdUnit(io: Io, opts: AutostartOptions): Promise<void> {
  const run = opts.runner ?? spawnRunner;
  const paths = opts.systemdPaths ?? defaultSystemdPaths();
  if (!existsSync(paths.unitPath)) {
    io.write('未安装开机自启\n');
    return;
  }
  const res = await run('systemctl', buildSystemctlDisableArgs());
  if (res.code !== 0 && !isSystemdNotLoaded(res.stderr)) {
    throw new Error(`systemctl --user disable 失败：${firstLine(res.stderr)}`);
  }
  unlinkSync(paths.unitPath);
  const reload = await run('systemctl', buildSystemctlDaemonReloadArgs());
  if (reload.code !== 0) io.write(`提示：daemon-reload 未生效（${firstLine(reload.stderr)}），unit 文件已删除\n`);
  io.write('已移除开机自启（systemd unit 已删除）\n');
}

async function statusSystemdUnit(ctx: Ctx, opts: AutostartOptions): Promise<void> {
  const run = opts.runner ?? spawnRunner;
  const paths = opts.systemdPaths ?? defaultSystemdPaths();
  const port = readPortFile(paths.configPath);
  const base = `http://127.0.0.1:${port}`;
  const installed = existsSync(paths.unitPath);
  const enabled = installed ? (await run('systemctl', buildSystemctlIsEnabledArgs())).code === 0 : false;
  const active = installed ? (await run('systemctl', buildSystemctlIsActiveArgs())).code === 0 : false;
  const probe = await probeService(base);
  if (ctx.json) {
    ctx.io.write(
      `${JSON.stringify(
        {
          autostart: { installed, provider: 'systemd-user', unit: SYSTEMD_UNIT_NAME, unit_path: paths.unitPath, enabled, active },
          service: { base, ...probe },
          log: paths.logFile,
        },
        null,
        2,
      )}\n`,
    );
    return;
  }
  ctx.io.write(`自启: ${installed ? `已安装（systemd ${SYSTEMD_UNIT_NAME}，${enabled ? '已启用' : '未启用'}，${active ? '运行中' : '未运行'}）` : '未安装'}\n`);
  ctx.io.write(`服务: ${probe.reachable ? `可达 ${base}${probe.version !== null ? `（版本 ${probe.version}）` : ''}` : `不可达 ${base}（${probe.error}）`}\n`);
  ctx.io.write(`unit: ${paths.unitPath}\n`);
  ctx.io.write(`日志: ${paths.logFile}\n`);
}

/** GET /api/version 探测（三平台状态命令共用） */
async function probeService(base: string): Promise<{ reachable: boolean; version: string | null; error?: string }> {
  try {
    const data = await request<{ version?: unknown }>(base, 'GET', '/api/version');
    return { reachable: true, version: typeof data?.version === 'string' ? data.version : null };
  } catch (err) {
    const error = ((err instanceof Error ? err.message : String(err)).split(/\r?\n/, 1)[0] ?? '').trim();
    return { reachable: false, version: null, error };
  }
}
