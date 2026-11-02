/**
 * kb autostart：Windows 开机自启管理（HKCU Run 键 → wscript.exe 启动 scripts/agentboard.vbs autostart）。
 * 零 npm 依赖；install 同时把 node 路径/仓库/端口/日志目录写进 vbs 顶部常量区（正则重写，重复 install 可更新端口）。
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
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

/** 非 Windows 统一报错（三命令入口先调用） */
export function requireWindows(): void {
  if (process.platform !== 'win32') throw new Error('仅支持 Windows');
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
}

/** 安装：前置检查 → 写 vbs 常量 → reg add（幂等：同值直接成功；异值覆盖提示） */
export async function installAutostart(io: Io, opts: AutostartOptions = {}): Promise<void> {
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
export async function uninstallAutostart(io: Io, opts: AutostartOptions = {}): Promise<void> {
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
export async function statusAutostart(ctx: Ctx, opts: AutostartOptions = {}): Promise<void> {
  requireWindows();
  const run = opts.runner ?? spawnRunner;
  const paths = opts.paths ?? defaultPaths();
  const port = readPortFile(paths.configPath);
  const base = `http://127.0.0.1:${port}`;
  const value = await queryRunValue(run);
  let reachable = false;
  let version: string | null = null;
  let errText = '';
  try {
    const data = await request<{ version?: unknown }>(base, 'GET', '/api/version');
    reachable = true;
    version = typeof data?.version === 'string' ? data.version : null;
  } catch (err) {
    errText = ((err instanceof Error ? err.message : String(err)).split(/\r?\n/, 1)[0] ?? '').trim();
  }
  if (ctx.json) {
    ctx.io.write(
      `${JSON.stringify(
        {
          autostart: { installed: value !== null, value, run_key: RUN_KEY },
          service: { base, reachable, version, error: reachable ? undefined : errText },
          log: paths.logFile,
        },
        null,
        2,
      )}\n`,
    );
    return;
  }
  ctx.io.write(`自启: ${value !== null ? `已安装（${value}）` : '未安装'}\n`);
  ctx.io.write(`服务: ${reachable ? `可达 ${base}${version !== null ? `（版本 ${version}）` : ''}` : `不可达 ${base}（${errText}）`}\n`);
  ctx.io.write(`日志: ${paths.logFile}\n`);
}
