/**
 * ACC-INCOGNITO：用「无痕窗口」打开授权地址。
 *
 * 定位：账号授权抽屉要求「点开始授权 / 点授权地址」都直接弹无痕窗口，与账号平台无关。
 * 浏览器只能在服务端拉起——前端（含 Tauri webview）无法指定普通窗口，也无 opener 插件，
 * 所以能力落在本机服务（既有 127.0.0.1 单机前提，不新增鉴权）。
 *
 * 选择顺序（卡面固定）：
 *  ① Windows 按 Chrome → Edge → Brave 探测常见安装路径，分别带
 *     `--incognito --new-window`（Chrome/Brave）/ `--inprivate --new-window`（Edge）；
 *  ② macOS 用 `open -na "Google Chrome" --args --incognito`，再试 Edge 的 `--inprivate`；
 *  ③ Linux 依次试 google-chrome / chromium / microsoft-edge；
 *  ④ 全都不可用 → 降级系统默认浏览器打开普通窗口，返回 mode='normal' + degraded_reason，
 *     由前端展示可见提示（用户能感知「这次不是无痕」）；
 *  ⑤ 连默认浏览器都起不来 → 502 BROWSER_OPEN_FAILED，attempts 进 details 便于排障。
 *
 * 安全边界：只接受 http/https（授权页一定是网页）；spawn 用参数数组、不经 shell 拼串；
 * 单个候选失败只记 attempt，不中断后续候选。
 */
import { spawn, type ChildProcess, type SpawnOptions } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { ApiError } from '../errors.js';

export type IncognitoBrowserId = 'chrome' | 'edge' | 'brave';

export interface BrowserOpenResult {
  opened_with: IncognitoBrowserId | 'default';
  mode: 'incognito' | 'normal';
  /** 仅 mode='normal'（降级）时非空：给前端展示的中文原因 */
  degraded_reason: string | null;
}

/** URL 长度上限：授权地址远短于此，超长一律当异常输入 */
export const MAX_AUTHORIZATION_URL_LENGTH = 2048;

export const BrowserOpenErrorCode = {
  invalidUrl: 'BROWSER_URL_INVALID',
  openFailed: 'BROWSER_OPEN_FAILED',
} as const;

/** 只依赖 spawn / existsSync / 平台 / env，测试可整体注入（不真开窗） */
export interface BrowserOpenerDeps {
  spawn: (command: string, args: readonly string[]) => SpawnedChild;
  existsSync: (p: string) => boolean;
  platform: NodeJS.Platform;
  env: NodeJS.ProcessEnv;
  /** 起进程超时：超时算该候选失败，继续下一个 */
  timeoutMs: number;
}

/** launch 只关心「进程起来了」，不等退出（浏览器是长期进程） */
export interface SpawnedChild {
  once(event: 'spawn', listener: () => void): unknown;
  once(event: 'error', listener: (error: Error) => void): unknown;
  unref(): void;
}

const REAL_SPAWN_OPTIONS: SpawnOptions = { detached: true, stdio: 'ignore', windowsHide: true };

export const defaultBrowserOpenerDeps: BrowserOpenerDeps = {
  spawn: (command, args) => spawn(command, [...args], REAL_SPAWN_OPTIONS) as unknown as ChildProcess as SpawnedChild,
  existsSync: (p) => existsSync(p),
  platform: process.platform,
  env: process.env,
  timeoutMs: 3000,
};

interface BrowserCandidate {
  id: IncognitoBrowserId;
  /** Windows/macOS 用绝对路径或命令；Linux 用 PATH 上的命令名 */
  command: string;
  /** 只用于探测是否存在（macOS 是 .app 目录，command 是 open） */
  probePath?: string;
  args: string[];
}

interface Attempt {
  browser: IncognitoBrowserId | 'default';
  status: 'opened' | 'failed' | 'skipped';
  reason?: string;
}

/** ① URL 校验：只接受 http/https，空串/超长/非法协议一律 400 */
export function validateAuthorizationUrl(raw: unknown): string {
  if (typeof raw !== 'string') {
    throw new ApiError(400, BrowserOpenErrorCode.invalidUrl, '缺少授权地址（url 必须是字符串）');
  }
  const url = raw.trim();
  if (url === '') {
    throw new ApiError(400, BrowserOpenErrorCode.invalidUrl, '授权地址不能为空');
  }
  if (url.length > MAX_AUTHORIZATION_URL_LENGTH) {
    throw new ApiError(400, BrowserOpenErrorCode.invalidUrl, `授权地址过长（上限 ${MAX_AUTHORIZATION_URL_LENGTH} 字符）`);
  }
  if (!/^https?:\/\//i.test(url)) {
    throw new ApiError(400, BrowserOpenErrorCode.invalidUrl, '只接受 http/https 授权地址');
  }
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new ApiError(400, BrowserOpenErrorCode.invalidUrl, '授权地址不是合法 URL');
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new ApiError(400, BrowserOpenErrorCode.invalidUrl, '只接受 http/https 授权地址');
  }
  return url;
}

function envPath(env: NodeJS.ProcessEnv, name: string): string | null {
  const key = Object.keys(env).find((candidate) => candidate.toUpperCase() === name.toUpperCase());
  const value = key === undefined ? undefined : env[key];
  return value === undefined || value === '' ? null : value;
}

/** ① Windows：三处常见安装根 × 三家 Chromium 浏览器 */
function windowsCandidates(env: NodeJS.ProcessEnv, url: string): BrowserCandidate[] {
  const roots = [envPath(env, 'LOCALAPPDATA'), envPath(env, 'ProgramFiles'), envPath(env, 'ProgramFiles(x86)')]
    .filter((root): root is string => root !== null);
  const chromiumArgs = ['--incognito', '--new-window', url];
  const candidates: BrowserCandidate[] = [];
  for (const root of roots) {
    const chrome = path.join(root, 'Google', 'Chrome', 'Application', 'chrome.exe');
    candidates.push({ id: 'chrome', command: chrome, probePath: chrome, args: chromiumArgs });
  }
  for (const root of roots) {
    const edge = path.join(root, 'Microsoft', 'Edge', 'Application', 'msedge.exe');
    candidates.push({ id: 'edge', command: edge, probePath: edge, args: ['--inprivate', '--new-window', url] });
  }
  for (const root of roots) {
    const brave = path.join(root, 'BraveSoftware', 'Brave-Browser', 'Application', 'brave.exe');
    candidates.push({ id: 'brave', command: brave, probePath: brave, args: chromiumArgs });
  }
  return candidates;
}

/** ② macOS：用 open -na 指定应用启动，避免复用普通窗口 */
function macCandidates(url: string): BrowserCandidate[] {
  return [
    { id: 'chrome', command: 'open', probePath: '/Applications/Google Chrome.app', args: ['-na', 'Google Chrome', '--args', '--incognito', url] },
    { id: 'edge', command: 'open', probePath: '/Applications/Microsoft Edge.app', args: ['-na', 'Microsoft Edge', '--args', '--inprivate', url] },
    { id: 'brave', command: 'open', probePath: '/Applications/Brave Browser.app', args: ['-na', 'Brave Browser', '--args', '--incognito', url] },
  ];
}

/** ③ Linux：按命令名探测（找不到时 spawn 会 ENOENT，记 failed 继续下一个） */
function linuxCandidates(url: string): BrowserCandidate[] {
  return [
    { id: 'chrome', command: 'google-chrome', args: ['--incognito', '--new-window', url] },
    { id: 'chrome', command: 'chromium', args: ['--incognito', '--new-window', url] },
    { id: 'edge', command: 'microsoft-edge', args: ['--inprivate', '--new-window', url] },
    { id: 'brave', command: 'brave-browser', args: ['--incognito', '--new-window', url] },
  ];
}

function chromiumCandidates(deps: BrowserOpenerDeps, url: string): BrowserCandidate[] {
  if (deps.platform === 'win32') return windowsCandidates(deps.env, url);
  if (deps.platform === 'darwin') return macCandidates(url);
  return linuxCandidates(url);
}

/** ④ 降级：系统默认浏览器普通窗口 */
function openWithSystemDefault(deps: BrowserOpenerDeps, url: string): Promise<void> {
  if (deps.platform === 'win32') {
    // Bypass cmd: valid authorization URLs can contain shell metacharacters such as &.
    return launch(deps, 'rundll32.exe', ['url.dll,FileProtocolHandler', url]);
  }
  if (deps.platform === 'darwin') return launch(deps, 'open', [url]);
  return launch(deps, 'xdg-open', [url]);
}

/** 起一个进程，只等它「真的起来了」（不等退出） */
function launch(deps: BrowserOpenerDeps, command: string, args: readonly string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    let child: SpawnedChild;
    try {
      child = deps.spawn(command, args);
    } catch (error) {
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

/**
 * 用无痕窗口打开授权地址。降级（找不到 Chromium 系浏览器）不算失败，
 * 返回值里 mode='normal' + degraded_reason 让前端明确提示。
 */
export async function openAuthorizationUrlIncognito(
  rawUrl: unknown,
  deps: BrowserOpenerDeps = defaultBrowserOpenerDeps,
): Promise<BrowserOpenResult> {
  const url = validateAuthorizationUrl(rawUrl);
  const attempts: Attempt[] = [];

  for (const candidate of chromiumCandidates(deps, url)) {
    if (candidate.probePath !== undefined && !deps.existsSync(candidate.probePath)) {
      attempts.push({ browser: candidate.id, status: 'skipped', reason: `未安装：${candidate.probePath}` });
      continue;
    }
    try {
      await launch(deps, candidate.command, candidate.args);
      return { opened_with: candidate.id, mode: 'incognito', degraded_reason: null };
    } catch (error) {
      attempts.push({ browser: candidate.id, status: 'failed', reason: error instanceof Error ? error.message : String(error) });
    }
  }

  try {
    await openWithSystemDefault(deps, url);
    return {
      opened_with: 'default',
      mode: 'normal',
      degraded_reason: '未找到 Chrome / Edge / Brave，已用系统默认浏览器普通窗口打开（非无痕）',
    };
  } catch (error) {
    attempts.push({ browser: 'default', status: 'failed', reason: error instanceof Error ? error.message : String(error) });
    throw new ApiError(502, BrowserOpenErrorCode.openFailed, '没有可用的浏览器可以打开授权地址', { attempts });
  }
}
