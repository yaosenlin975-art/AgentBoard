/**
 * 客户端进程探测与停止（B4S-1，切换骨架 S0/S1 的共用实现）。
 *
 * 为什么要真探测：Windows 上客户端是否在跑**不能靠文件判断**（8bac607e §3：靠命名互斥与进程内状态），
 * 所以切换前必须查真实进程表。MiniMax 之前默认 `isRunning: async () => false`，等于客户端在跑时直接
 * 覆盖 `auth.json` —— 本模块的首要职责就是把这条路径堵死。
 *
 * 语义约定（调用方按此实现 fail-fast）：
 * - **探测失败/平台不支持 → 抛错**，绝不静默返回 false（静默 false 会退化成"以为没在跑"）；
 * - `stop()` 只在确认在跑时调用，内部轮询 `isRunning` 直到退出或超时；
 * - 错误码固定且可读：`CLIENT_PROCESS_PROBE_FAILED` / `CLIENT_PROCESS_CONTROL_UNAVAILABLE` / `CLIENT_STOP_TIMEOUT`。
 *
 * 本模块只做进程，不碰快照（B4S-2）、不碰设备身份（B6 `deviceIdentity.ts`）。
 */
import { ApiError } from '../../errors.js';

export const CLIENT_PROCESS_ERROR_CODES = {
  /** 进程表查询本身失败（PowerShell 不可用、超时、输出不可解析） */
  probeFailed: 'CLIENT_PROCESS_PROBE_FAILED',
  /** 当前平台没有进程控制能力（非 Windows）——调用方应据此阻断切换 */
  controlUnavailable: 'CLIENT_PROCESS_CONTROL_UNAVAILABLE',
  /** 已发停止指令但客户端在超时内没有退出 */
  stopTimeout: 'CLIENT_STOP_TIMEOUT',
} as const;

export interface ClientProcessControl {
  /** 客户端是否在跑（按可执行文件全路径精确匹配，同名不同路径不算） */
  isRunning(exePath: string): Promise<boolean>;
  /** 停止客户端并等待退出；超时抛 `CLIENT_STOP_TIMEOUT` */
  stop(exePath: string, options?: { timeoutMs?: number; pollMs?: number }): Promise<void>;
}

export interface ClientProcessOptions {
  /** 执行 PowerShell 脚本（测试注入；缺省 spawn pwsh -NoProfile -Command） */
  run?: (script: string) => Promise<string>;
  platform?: NodeJS.Platform;
  /** stop 的默认等待上限 */
  exitTimeoutMs?: number;
  /** stop 的轮询间隔 */
  pollMs?: number;
}

const PS_QUOTE = (value: string): string => `'${value.replace(/'/g, "''")}'`;

/** 默认执行器：与 workbuddyDesktopProvider 的 runPowerShell 同口径（无 PowerShell 时抛错，不静默） */
const defaultRun = async (script: string): Promise<string> => {
  const { execFile } = await import('node:child_process');
  const shell = process.env.AGENTBOARD_POWERSHELL ?? 'powershell.exe';
  return new Promise<string>((resolve, reject) => {
    execFile(shell, ['-NoProfile', '-NonInteractive', '-Command', script], { timeout: 20_000, windowsHide: true }, (error, stdout) => {
      if (error) {
        reject(new ApiError(409, CLIENT_PROCESS_ERROR_CODES.probeFailed, `查询客户端进程失败：${error.message}`));
        return;
      }
      resolve(stdout.trim());
    });
  });
};

/** `Get-CimInstance Win32_Process`：按进程名过滤 + 全路径精确比对（不区分大小写） */
function runningPidsScript(exePath: string): string {
  const name = exePath.split(/[\\/]/).pop() ?? exePath;
  return `$exe=${PS_QUOTE(exePath)}.ToLower(); Get-CimInstance Win32_Process -Filter ${PS_QUOTE(`Name='${name}'`)} | Where-Object { $_.ExecutablePath -and $_.ExecutablePath.ToLower() -eq $exe } | ForEach-Object { $_.ProcessId }`;
}

function stopPidsScript(pids: number[]): string {
  return pids.map((pid) => `Stop-Process -Id ${pid} -Force -ErrorAction SilentlyContinue`).join('; ');
}

export function createClientProcessControl(options: ClientProcessOptions = {}): ClientProcessControl {
  const platform = options.platform ?? process.platform;
  const run = options.run ?? defaultRun;
  const exitTimeoutMs = options.exitTimeoutMs ?? 15_000;
  const pollMs = options.pollMs ?? 250;

  const requireWindows = (): void => {
    if (platform !== 'win32') {
      throw new ApiError(
        409,
        CLIENT_PROCESS_ERROR_CODES.controlUnavailable,
        `当前平台（${platform}）没有客户端进程控制能力，切换前无法确认客户端已退出`,
      );
    }
  };

  const pidsOf = async (exePath: string): Promise<number[]> => {
    requireWindows();
    const out = await run(runningPidsScript(exePath));
    if (out === '') return [];
    const pids = out
      .split(/\r?\n/)
      .map((line) => Number.parseInt(line.trim(), 10))
      .filter((pid) => Number.isInteger(pid) && pid > 0);
    return pids;
  };

  return {
    async isRunning(exePath: string): Promise<boolean> {
      return (await pidsOf(exePath)).length > 0;
    },

    async stop(exePath: string, stopOptions: { timeoutMs?: number; pollMs?: number } = {}): Promise<void> {
      const timeoutMs = stopOptions.timeoutMs ?? exitTimeoutMs;
      const interval = stopOptions.pollMs ?? pollMs;
      const pids = await pidsOf(exePath);
      if (pids.length === 0) return;
      await run(stopPidsScript(pids));
      const startedAt = Date.now();
      while (Date.now() - startedAt <= timeoutMs) {
        if ((await pidsOf(exePath)).length === 0) return;
        await new Promise((resolve) => setTimeout(resolve, interval));
      }
      throw new ApiError(
        409,
        CLIENT_PROCESS_ERROR_CODES.stopTimeout,
        `客户端在 ${timeoutMs}ms 内没有退出，已中止切换（不覆盖凭据文件）`,
      );
    },
  };
}
