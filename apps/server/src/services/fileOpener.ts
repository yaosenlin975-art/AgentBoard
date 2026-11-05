/**
 * PROV-B：知识页证据「打开本地文件」端点的实现层。
 *
 * 定位：本机单机服务（既有 127.0.0.1 前提，不新增鉴权），只做一件事——
 * 把知识页里的一条仓库相对路径交给本机编辑器 / 资源管理器。
 * 因此本模块的契约是「**不读内容、不列目录**」：全链路只 stat/realpath，从不 open-读，
 * 响应里也只有 opened_with 与工作区相对路径，永不回传文件字节。
 *
 * 安全边界判定顺序（单测逐条对应；放宽任何一步都必须先改这段说明并补测试）：
 *  ① 字符集：控制字符与 shell/cmd 元字符 → FILE_PATH_INVALID
 *     （路径最终会以裸参数形式进 cmd.exe（start / code.cmd），这些字符会让命令行被重新切分；
 *      真实文件名带元字符属极少数，前端会自动降级成「已复制路径」，不损失可用性）
 *  ② 协议白名单：只接受裸路径或**本机** file:// → 其它协议（http:/cmd:/ftp:…）与 file://主机名
 *     形态 → FILE_SCHEME_NOT_ALLOWED
 *  ③ 段级 `..`：出现即拒（先于任何 fs 调用，不让 `..` 进到解析器）→ FILE_PATH_ESCAPE
 *  ④ workspace_id 必须存在（取库里的根，绝不接受调用方传根路径）→ WORKSPACE_NOT_FOUND；
 *     根目录本身不存在 → WORKSPACE_PATH_MISSING
 *  ⑤ path.resolve(根, 输入) 后必须严格落在 realpath(根) 之内 → 越界绝对路径 → FILE_PATH_ESCAPE
 *  ⑥ 必须是常规文件（statSync().isFile()）→ FILE_NOT_FOUND / FILE_NOT_A_FILE（挡目录遍历）
 *  ⑦ 对解析结果 realpath 后**再比一次**根 → symlink 逃逸 → FILE_PATH_ESCAPE
 *
 * 打开顺序（卡面固定）：code -g <path>:<line>（PATH 探测）→ explorer /select,<path> → 系统默认；
 * 三者全部失败返回结构化 OPEN_FAILED（details.attempts），由前端降级为「已复制路径」+ 可见提示。
 */
import { spawn, type ChildProcess, type SpawnOptions } from 'node:child_process';
import { existsSync, realpathSync, statSync, type Stats } from 'node:fs';
import path from 'node:path';
import type { Db } from '../db/connection.js';
import { getWorkspace } from '../db/repos/workspace.js';
import { ApiError, ValidationError } from '../errors.js';

/** 结构化错误码：前端按 message 提示、按 code 分支，不解析文案 */
export const FileOpenErrorCode = {
  invalidPath: 'FILE_PATH_INVALID',
  scheme: 'FILE_SCHEME_NOT_ALLOWED',
  escape: 'FILE_PATH_ESCAPE',
  notFound: 'FILE_NOT_FOUND',
  notAFile: 'FILE_NOT_A_FILE',
  workspaceNotFound: 'WORKSPACE_NOT_FOUND',
  workspacePathMissing: 'WORKSPACE_PATH_MISSING',
  openFailed: 'OPEN_FAILED',
} as const;

export interface OpenFileInput {
  workspace_id: string;
  path: string;
  line?: number | undefined;
}

export interface ResolvedLocalFile {
  /** 已 realpath 的工作区根（判定用） */
  root: string;
  /** 落在根内的绝对路径（真正交给打开器的东西） */
  absolutePath: string;
  /** 反斜杠统一成 / 的工作区相对路径（唯一回传给前端的定位信息） */
  relativePath: string;
  line?: number | undefined;
}

export interface FileSystemDeps {
  statSync: (p: string) => Stats;
  realpathSync: (p: string) => string;
  platform: NodeJS.Platform;
}

export const defaultFileSystemDeps: FileSystemDeps = {
  statSync: (p) => statSync(p),
  realpathSync: (p) => realpathSync(p),
  platform: process.platform,
};

/** ①：控制字符 + shell/cmd 元字符（会被重新切分命令行的一类）；其余字符（含中文路径）放行 */
const UNSAFE_CHARS = /[\u0000-\u001f\u007f"'`&|<>^%;=,()%!]/;
/** 协议前缀（scheme:）；单字母是 Windows 盘符，不算协议 */
const SCHEME_PREFIX = /^([A-Za-z][A-Za-z0-9+.-]*):/;

function reject(code: string, status: number, message: string, details?: Record<string, unknown>): never {
  throw new ApiError(status, code, message, details);
}

/** 段级 `..` 判定：反斜杠与正斜杠都按分隔符拆，`..` 出现即拒（不给任何解释机会） */
function hasParentSegment(value: string): boolean {
  return value.split(/[/\\]/).some((segment) => segment === '..');
}

/**
 * ②：协议白名单。裸路径直接放行；`file:` 只接受本机形态（file:///C:/x、file://C:/x、file:C:/x），
 * 带主机名（file://server/share）按越界协议拒掉；其它协议（http:/https:/cmd:/ftp:/mailto:…）一律拒。
 * 返回剥掉协议后的纯路径。
 */
function stripFileScheme(value: string): string {
  const match = SCHEME_PREFIX.exec(value);
  if (!match) return value;
  const scheme = (match[1] ?? '').toLowerCase();
  if (scheme.length > 1 && scheme !== 'file') {
    reject(FileOpenErrorCode.scheme, 400, `只接受本地 file 协议，收到 ${scheme}:（该取证条目不是本地文件路径）`);
  }
  if (scheme !== 'file') return value; // 单字母 = Windows 盘符
  const rest = value.slice('file:'.length);
  // file:// 形态的路径分隔符只认正斜杠（反斜杠留给下面的 UNC/绝对路径判定）
  const slashes = /^[\/]*/.exec(rest)?.[0] ?? '';
  const after = rest.slice(slashes.length);
  // file:// 之后第一段既不是空（file:///）也不是盘符 → 当成远程主机名
  const firstSegment = /^[^/\\]*/.exec(after)?.[0] ?? '';
  if (slashes.length >= 2 && firstSegment !== '' && !/^[A-Za-z]:$/.test(firstSegment)) {
    reject(FileOpenErrorCode.scheme, 400, 'file:// 带主机名（网络共享）不在允许范围内，只接受本机路径');
  }
  if (after.trim() === '') {
    reject(FileOpenErrorCode.invalidPath, 400, 'file:// 后面没有路径');
  }
  return after;
}

/** target 是否严格位于 root 之内（relative 非空、不以 `..` 开头、不是绝对路径） */
function isInside(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return relative !== '' && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

/**
 * 路径安全边界：按 workspace_id 从库取根 → 逐级校验 → 返回绝对路径。
 * 只认 file 形态、只落根内、只指常规文件；判定完即止，本函数不打开任何东西。
 */
export function resolveLocalFile(db: Db, input: OpenFileInput, deps: FileSystemDeps = defaultFileSystemDeps): ResolvedLocalFile {
  const raw = (input.path ?? '').trim();
  if (raw === '') reject(FileOpenErrorCode.invalidPath, 400, 'path 不能为空');
  if (UNSAFE_CHARS.test(raw)) {
    reject(FileOpenErrorCode.invalidPath, 400, '路径含引号 / 分号 / 重定向等命令行元字符，已拒绝（可用「复制路径」自行打开）');
  }
  if (input.line !== undefined && (!Number.isInteger(input.line) || input.line < 1)) {
    throw new ValidationError('line 必须是正整数');
  }
  // ② 协议 → ③ 段级 ..
  const withoutScheme = stripFileScheme(raw);
  if (hasParentSegment(withoutScheme)) reject(FileOpenErrorCode.escape, 400, '路径含 ..，已拒绝');

  // ④ 工作区与根路径只能来自库
  const workspace = getWorkspace(db, input.workspace_id);
  if (workspace === null) reject(FileOpenErrorCode.workspaceNotFound, 404, '工作空间不存在');
  const root = (workspace.path ?? '').trim();
  if (root === '') reject(FileOpenErrorCode.workspacePathMissing, 404, `工作空间 ${workspace.name} 没有登记本地路径`);
  let realRoot: string;
  try {
    realRoot = deps.realpathSync(root);
  } catch {
    reject(FileOpenErrorCode.workspacePathMissing, 404, `工作空间目录不存在或不可访问：${root}`);
  }

  // ⑤ resolve 后落根内（绝对路径外溢与 .. 逃逸都在这一步兜住）
  const absolute = path.resolve(realRoot, withoutScheme);
  if (!isInside(realRoot, absolute)) {
    reject(FileOpenErrorCode.escape, 400, '路径解析后不在该工作区内，已拒绝');
  }

  // ⑥ 必须存在且是常规文件（目录 → 拒，端点不提供遍历）
  let stats: Stats;
  try {
    stats = deps.statSync(absolute);
  } catch {
    reject(FileOpenErrorCode.notFound, 404, `文件不存在：${withoutScheme}`);
  }
  if (!stats.isFile()) reject(FileOpenErrorCode.notAFile, 400, '只接受普通文件，不接受目录或设备');

  // ⑦ symlink 逃逸：realpath 之后重新比根（Windows 上 junction 也会被 realpath 解开）
  let realTarget: string;
  try {
    realTarget = deps.realpathSync(absolute);
  } catch {
    reject(FileOpenErrorCode.notFound, 404, `文件不可解析：${withoutScheme}`);
  }
  if (!isInside(realRoot, realTarget)) {
    reject(FileOpenErrorCode.escape, 400, '路径经 symlink 指向工作区外，已拒绝');
  }

  const relative = path.relative(realRoot, absolute).split('\\').join('/');
  return { root: realRoot, absolutePath: absolute, relativePath: relative, line: input.line };
}

/* ============================ 打开器 ============================ */

export type OpenMethod = 'vscode' | 'explorer' | 'system_default';

export interface OpenAttempt {
  method: OpenMethod;
  status: 'opened' | 'failed' | 'skipped';
  reason?: string;
}

export interface SpawnedChild {
  once(event: 'spawn', listener: () => void): void;
  once(event: 'error', listener: (error: unknown) => void): void;
  unref(): void;
}

export interface OpenProcessDeps {
  /** 起进程；测试注入 fake，绝不在单测里真开编辑器 */
  spawn: (command: string, args: readonly string[]) => SpawnedChild;
  env: NodeJS.ProcessEnv;
  platform: NodeJS.Platform;
  existsSync: (p: string) => boolean;
  /** spawn 事件超时：超时算这一种方式失败，继续下一种 */
  timeoutMs: number;
}

const REAL_SPAWN_OPTIONS: SpawnOptions = { detached: true, stdio: 'ignore', windowsHide: true };

export const defaultOpenProcessDeps: OpenProcessDeps = {
  spawn: (command, args) => spawn(command, [...args], REAL_SPAWN_OPTIONS) as unknown as ChildProcess as SpawnedChild,
  env: process.env,
  platform: process.platform,
  existsSync: (p) => existsSync(p),
  timeoutMs: 2000,
};

/** PATH 变量（Windows 上大小写不敏感，按实际键名取） */
function pathEnv(env: NodeJS.ProcessEnv): string {
  const key = Object.keys(env).find((name) => name.toUpperCase() === 'PATH');
  return key === undefined ? '' : env[key] ?? '';
}

/**
 * PATH 探测：Windows 先 .exe（真可执行，能直接 spawn），再 PATHEXT 其余项，最后裸名；
 * 其它平台只找同名文件。命中的是完整路径，避免「spawn('code') 只匹配到 code.cmd」那类失败。
 */
export function findExecutableOnPath(name: string, deps: Pick<OpenProcessDeps, 'env' | 'platform' | 'existsSync'>): string | null {
  const dirs = pathEnv(deps.env).split(path.delimiter).filter((dir) => dir !== '');
  if (dirs.length === 0) return null;
  const hasExtension = /\.[A-Za-z0-9]+$/.test(name);
  let suffixes: string[] = [''];
  if (deps.platform === 'win32' && !hasExtension) {
    const pathext = (deps.env.PATHEXT ?? '.EXE;.CMD;.BAT;.COM').split(';').map((ext) => ext.trim()).filter((ext) => ext !== '');
    const lower = pathext.map((ext) => ext.toLowerCase());
    suffixes = ['.exe', ...lower.filter((ext) => ext !== '.exe'), ''];
  } else if (deps.platform !== 'win32' && !hasExtension) {
    suffixes = ['', '.exe'];
  }
  for (const dir of dirs) {
    for (const suffix of suffixes) {
      const candidate = path.join(dir, name + suffix);
      if (deps.existsSync(candidate)) return candidate;
    }
  }
  return null;
}

/** 起一个进程，只等它「真的起来了」（不等退出：编辑器/资源管理器是长期进程） */
function launch(deps: OpenProcessDeps, command: string, args: readonly string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    let child: SpawnedChild;
    try {
      child = deps.spawn(command, args);
    } catch (error) {
      // Node 对 .cmd/.bat 直投会同步抛 EINVAL，走下面的 cmd.exe 包装
      reject(error instanceof Error ? error : new Error(String(error)));
      return;
    }
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      reject(new Error(`启动超时（${deps.timeoutMs}ms）：${command}`));
    }, deps.timeoutMs);
    child.once('spawn', () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.unref();
      resolve();
    });
    child.once('error', (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(error instanceof Error ? error : new Error(String(error)));
    });
  });
}

/** .cmd/.bat 不能直接 spawn（Node 会 EINVAL）→ 交给 cmd.exe /d /c 包装 */
function needsCmdWrapper(executable: string, platform: NodeJS.Platform): boolean {
  return platform === 'win32' && /\.(cmd|bat)$/i.test(executable);
}

async function runCommand(deps: OpenProcessDeps, executable: string, args: readonly string[]): Promise<void> {
  if (needsCmdWrapper(executable, deps.platform)) {
    await launch(deps, 'cmd.exe', ['/d', '/c', executable, ...args]);
    return;
  }
  await launch(deps, executable, args);
}

/**
 * 按卡面固定顺序打开：VS Code（-g 跳行）→ 资源管理器（/select, 选中）→ 系统默认程序。
 * 成功返回用了哪一种；全部失败抛 OPEN_FAILED（attempts 进 details，便于排障）。
 */
export async function openLocalFile(
  file: ResolvedLocalFile,
  deps: OpenProcessDeps = defaultOpenProcessDeps,
): Promise<{ opened_with: OpenMethod; attempts: OpenAttempt[] }> {
  const attempts: OpenAttempt[] = [];

  // ① code -g <path>:<line>
  const code = findExecutableOnPath('code', deps);
  if (code === null) {
    attempts.push({ method: 'vscode', status: 'skipped', reason: 'PATH 上没有 code' });
  } else {
    const goto = file.line === undefined ? file.absolutePath : `${file.absolutePath}:${file.line}`;
    try {
      await runCommand(deps, code, ['-g', goto]);
      return { opened_with: 'vscode', attempts };
    } catch (error) {
      attempts.push({ method: 'vscode', status: 'failed', reason: (error as Error).message });
    }
  }

  // ② explorer /select,<path>（仅 Windows）
  if (deps.platform === 'win32') {
    const explorer = findExecutableOnPath('explorer', deps);
    if (explorer === null) {
      attempts.push({ method: 'explorer', status: 'skipped', reason: 'PATH 上没有 explorer' });
    } else {
      try {
        await runCommand(deps, explorer, [`/select,${file.absolutePath}`]);
        return { opened_with: 'explorer', attempts };
      } catch (error) {
        attempts.push({ method: 'explorer', status: 'failed', reason: (error as Error).message });
      }
    }
  } else {
    attempts.push({ method: 'explorer', status: 'skipped', reason: '非 Windows 平台' });
  }

  // ③ 系统默认程序：Windows 走 `cmd /c start ""<path>`，macOS `open`，其它 `xdg-open`
  if (deps.platform === 'win32') {
    // start 的空标题参数不可省：cmd 会把第一个引号参数当成窗口标题
    try {
      await launch(deps, 'cmd.exe', ['/d', '/c', 'start', '', file.absolutePath]);
      return { opened_with: 'system_default', attempts };
    } catch (error) {
      attempts.push({ method: 'system_default', status: 'failed', reason: (error as Error).message });
    }
  } else {
    const openerName = deps.platform === 'darwin' ? 'open' : 'xdg-open';
    const opener = findExecutableOnPath(openerName, deps);
    if (opener === null) {
      attempts.push({ method: 'system_default', status: 'skipped', reason: `PATH 上没有 ${openerName}` });
    } else {
      try {
        await launch(deps, opener, [file.absolutePath]);
        return { opened_with: 'system_default', attempts };
      } catch (error) {
        attempts.push({ method: 'system_default', status: 'failed', reason: (error as Error).message });
      }
    }
  }

  reject(
    FileOpenErrorCode.openFailed,
    500,
    '本机没有可用的打开方式（VS Code / 资源管理器 / 默认程序均失败），已降级为复制路径',
    { attempts },
  );
}
