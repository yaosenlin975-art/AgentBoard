/**
 * MINIMAX-PATH：MiniMax 桌面客户端可执行文件探测（唯一入口）。
 *
 * 为什么需要：旧实现把默认 exe 写死成 `%LOCALAPPDATA%\Programs\MiniMax\MiniMax.exe`，
 * 本机实际装在 `D:\Program Files\MiniMax Code\MiniMax Code.exe`（HKCU 卸载项 `MiniMax Code 3.1.10`
 * 的 UninstallString/DisplayIcon 都指向该目录），于是能力矩阵误报 `CLIENT_NOT_INSTALLED`。
 *
 * 探测顺序（命中即用，不猜）：
 *   1. 显式配置 `AGENTBOARD_MINIMAX_EXE`（绝对路径，存在即用）；
 *   2. 默认候选：LocalAppData / Program Files / Program Files (x86)，逐个固定盘符的同名变体；
 *   3. 卸载注册表（HKCU / HKLM / Wow6432Node）：从 `UninstallString` / `DisplayIcon` / `InstallLocation`
 *      取安装目录，再在该目录内找已知 exe 名。
 * 三种结论：
 *   - `CLIENT_READY`：定位到 exe；
 *   - `CLIENT_NOT_INSTALLED`：默认候选与注册表都没有 MiniMax 痕迹；
 *   - `CLIENT_PATH_UNRESOLVED`：注册表有 MiniMax 卸载项但定位不到 exe（装在非常规位置/目录结构不同），
 *     文案指向 `AGENTBOARD_MINIMAX_EXE`。
 *
 * 只读探测：不读 token、不启停客户端。结果按 TTL 缓存（默认 60s），`reset()` 供测试清缓存。
 */
import { execFile } from 'node:child_process';
import { promises as nodeFs } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

export type MinimaxClientReasonCode = 'CLIENT_READY' | 'CLIENT_NOT_INSTALLED' | 'CLIENT_PATH_UNRESOLVED';
export type MinimaxClientSource = 'override' | 'default' | 'registry';

export interface MinimaxClientStatus {
  installed: boolean;
  exe: string | null;
  source: MinimaxClientSource | null;
  reason_code: MinimaxClientReasonCode;
  /** 面向用户的中文说明（能力矩阵透传给 UI） */
  message: string;
  /** 实际探测过的路径（排查用；不含敏感信息） */
  probed: string[];
}

export const MINIMAX_CLIENT_EXE_ENV = 'AGENTBOARD_MINIMAX_EXE';
/** 两种产品形态的可执行文件名 */
const EXE_NAMES = ['MiniMax Code.exe', 'MiniMax.exe'];
const DEFAULT_PROBE_TTL_MS = 60_000;

/** 卸载注册表根（HKCU 优先：MiniMax Code 是 per-user 安装） */
const UNINSTALL_ROOTS = [
  'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
  'HKLM\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
  'HKLM\\Software\\Wow6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
];

export interface MinimaxRegistryEvidence {
  /** 命中 MiniMax 的 DisplayName（有即代表装过） */
  displayName: string | null;
  /** 从 UninstallString / DisplayIcon / InstallLocation 推出的安装目录 */
  installDirs: string[];
}

export interface MinimaxProbeDeps {
  env?: NodeJS.ProcessEnv;
  exists?: (path: string) => Promise<boolean>;
  /** 默认候选路径（测试注入用） */
  candidates?: string[];
  /** 卸载注册表探测（测试注入用） */
  readRegistry?: () => Promise<MinimaxRegistryEvidence>;
}

async function fileExists(path: string): Promise<boolean> {
  return nodeFs.access(path).then(() => true, () => false);
}

/** 固定盘符：A–Z 里能 `access` 到 `<X>:\` 的（本机为 C、D） */
async function fixedDriveRoots(exists: (path: string) => Promise<boolean>): Promise<string[]> {
  const letters = 'CDEFGHIJKLMNOPQRSTUVWXYZ'.split('');
  const roots: string[] = [];
  for (const letter of letters) {
    if (await exists(`${letter}:\\`)) roots.push(`${letter}:`);
  }
  return roots;
}

/** 默认候选：常见安装位置 × 两种 exe 名 × 全部固定盘符（纯路径枚举，不做字符串猜测） */
export function defaultMinimaxExeCandidates(
  env: NodeJS.ProcessEnv = process.env,
  driveRoots: readonly string[] = ['C:'],
): string[] {
  const bases: string[] = [];
  const localAppData = env.LOCALAPPDATA ?? join(env.USERPROFILE ?? homedir(), 'AppData', 'Local');
  const programFiles = env.ProgramFiles ?? env.PROGRAMFILES ?? 'C:\\Program Files';
  const programFilesX86 = env['ProgramFiles(x86)'] ?? env['PROGRAMFILES(X86)'] ?? 'C:\\Program Files (x86)';
  bases.push(join(localAppData, 'Programs', 'MiniMax'));
  bases.push(join(localAppData, 'Programs', 'MiniMax Code'));
  for (const root of driveRoots) {
    bases.push(join(`${root}\\`, 'Program Files', 'MiniMax'));
    bases.push(join(`${root}\\`, 'Program Files', 'MiniMax Code'));
    bases.push(join(`${root}\\`, 'Program Files (x86)', 'MiniMax'));
    bases.push(join(`${root}\\`, 'Program Files (x86)', 'MiniMax Code'));
  }
  bases.push(join(programFiles, 'MiniMax'), join(programFiles, 'MiniMax Code'));
  bases.push(join(programFilesX86, 'MiniMax'), join(programFilesX86, 'MiniMax Code'));
  const candidates: string[] = [];
  for (const base of bases) {
    for (const name of EXE_NAMES) {
      const candidate = join(base, name);
      if (!candidates.includes(candidate)) candidates.push(candidate);
    }
  }
  return candidates;
}

const WINDOWS_PATH = /([A-Za-z]:\\[^"\r\n]+)/;

/** 解析 `reg query ... /s /f MiniMax` 的文本输出：DisplayName 命中即「装过」，并推出安装目录 */
export function parseMinimaxRegistryEvidence(stdout: string): MinimaxRegistryEvidence {
  let displayName: string | null = null;
  const installDirs: string[] = [];
  for (const rawLine of stdout.split(/\r?\n/)) {
    const line = rawLine.trim();
    const match = WINDOWS_PATH.exec(line);
    if (/^DisplayName\s+REG_SZ/i.test(line) && /minimax/i.test(line)) {
      displayName = line.replace(/^DisplayName\s+REG_SZ\s+/i, '').trim();
      continue;
    }
    if (!match) continue;
    if (!/^(DisplayIcon|InstallLocation|UninstallString)\s/i.test(line)) continue;
    const value = match[1]!.trim();
    // 只从安装目录推导：目录本身可能已经是目录（InstallLocation），也可能是 exe/ico 路径
    const dir = /\.[A-Za-z0-9]{2,4}$/.test(value) ? dirname(value) : value;
    // 排除卸载程序自身
    if (/uninstall/i.test(dir)) continue;
    if (!installDirs.includes(dir)) installDirs.push(dir);
  }
  return { displayName, installDirs };
}

/** 读卸载注册表（只读、无 shell；输出用系统代码页，只解析 ASCII 路径与 MiniMax 名称） */
async function readRegistryEvidence(): Promise<MinimaxRegistryEvidence> {
  const evidence: MinimaxRegistryEvidence = { displayName: null, installDirs: [] };
  for (const root of UNINSTALL_ROOTS) {
    let stdout = '';
    try {
      stdout = await new Promise<string>((resolve, reject) => {
        execFile('reg', ['query', root, '/s', '/f', 'MiniMax'], { windowsHide: true, timeout: 5_000, maxBuffer: 4 * 1024 * 1024 },
          (error, out) => {
            // reg 找不到匹配时返回非 0，按「无痕迹」处理
            if (error) { resolve(typeof out === 'string' ? out : ''); return; }
            resolve(String(out ?? ''));
          });
      });
    } catch {
      continue;
    }
    const parsed = parseMinimaxRegistryEvidence(stdout);
    if (parsed.displayName && !evidence.displayName) evidence.displayName = parsed.displayName;
    for (const dir of parsed.installDirs) if (!evidence.installDirs.includes(dir)) evidence.installDirs.push(dir);
  }
  return evidence;
}

const messageFor = (status: Pick<MinimaxClientStatus, 'reason_code' | 'exe' | 'source'>): string => {
  if (status.reason_code === 'CLIENT_READY') {
    const origin = status.source === 'override' ? '由 AGENTBOARD_MINIMAX_EXE 指定' : status.source === 'registry' ? '由卸载注册表定位' : '默认安装位置';
    return `已定位 MiniMax 客户端（${origin}）：${status.exe}`;
  }
  if (status.reason_code === 'CLIENT_PATH_UNRESOLVED') {
    return '检测到 MiniMax 已安装，但无法定位可执行文件；若安装在非默认位置，用环境变量 AGENTBOARD_MINIMAX_EXE 指定 exe 绝对路径';
  }
  return '未检测到 MiniMax 客户端安装（已探测默认安装位置与卸载注册表）；若装在非默认位置，用环境变量 AGENTBOARD_MINIMAX_EXE 指定 exe 绝对路径';
};

/** 只读探测一次（不缓存）；任何异常都退化为「未安装」而不是抛错 */
export async function probeMinimaxClient(deps: MinimaxProbeDeps = {}): Promise<MinimaxClientStatus> {
  const env = deps.env ?? process.env;
  const exists = deps.exists ?? fileExists;
  const probed: string[] = [];

  const override = (env[MINIMAX_CLIENT_EXE_ENV] ?? '').trim();
  if (override) {
    const hit = await exists(override);
    probed.push(override);
    if (hit) {
      return {
        installed: true, exe: override, source: 'override', reason_code: 'CLIENT_READY',
        message: messageFor({ reason_code: 'CLIENT_READY', exe: override, source: 'override' }), probed,
      };
    }
  }

  const candidates = deps.candidates ?? defaultMinimaxExeCandidates(env, await fixedDriveRoots(exists));
  for (const candidate of candidates) {
    probed.push(candidate);
    if (await exists(candidate)) {
      return {
        installed: true, exe: candidate, source: 'default', reason_code: 'CLIENT_READY',
        message: messageFor({ reason_code: 'CLIENT_READY', exe: candidate, source: 'default' }), probed,
      };
    }
  }

  const evidence = await (deps.readRegistry ?? readRegistryEvidence)();
  for (const dir of evidence.installDirs) {
    for (const name of EXE_NAMES) {
      const candidate = join(dir, name);
      probed.push(candidate);
      if (await exists(candidate)) {
        return {
          installed: true, exe: candidate, source: 'registry', reason_code: 'CLIENT_READY',
          message: messageFor({ reason_code: 'CLIENT_READY', exe: candidate, source: 'registry' }), probed,
        };
      }
    }
  }

  const reasonCode: MinimaxClientReasonCode = evidence.displayName ? 'CLIENT_PATH_UNRESOLVED' : 'CLIENT_NOT_INSTALLED';
  return {
    installed: false, exe: null, source: null, reason_code: reasonCode,
    message: messageFor({ reason_code: reasonCode, exe: null, source: null }), probed,
  };
}

export interface MinimaxClientProbe {
  get(): Promise<MinimaxClientStatus>;
  reset(): void;
}

/** TTL 缓存包装（能力矩阵每次请求都读，避免反复扫盘/查注册表） */
export function createMinimaxClientProbe(deps: MinimaxProbeDeps = {}, ttlMs = DEFAULT_PROBE_TTL_MS): MinimaxClientProbe {
  let cached: { at: number; value: Promise<MinimaxClientStatus> } | null = null;
  const now = () => Date.now();
  return {
    get() {
      if (cached && now() - cached.at < ttlMs) return cached.value;
      const value = probeMinimaxClient(deps);
      cached = { at: now(), value };
      return value;
    },
    reset() {
      cached = null;
    },
  };
}
