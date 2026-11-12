/**
 * SETTINGS-AUTOSTART：桌面壳开机自启的纯逻辑层。
 *
 * 状态唯一权威是桌面壳（读注册表 / LaunchAgent / systemd），浏览器没有该能力：
 * `window.__TAURI_INTERNALS__` 不存在时调用方应展示「不可用」，不得假装成功。
 * 命令与错误码契约见卡 f21a02a7（壳侧实现 desktop/src-tauri/src/autostart.rs）。
 */

export type AutostartOwner = 'desktop' | 'cli' | 'none' | 'other' | 'unknown';
export type AutostartProvider = 'hkcu-run' | 'launchagent' | 'systemd-user' | 'unsupported';

export interface AutostartStatus {
  supported: boolean;
  enabled: boolean;
  owner: AutostartOwner;
  provider: AutostartProvider;
  detail?: string;
  error?: string;
}

/** Tauri invoke 的最小签名（只依赖壳暴露的 IPC，不引入 @tauri-apps/api） */
export type TauriInvoke = (cmd: string, args?: Record<string, unknown>) => Promise<unknown>;

interface TauriInternals {
  invoke?: TauriInvoke;
}

/** 探测桌面壳；浏览器里返回 null（不能用它判断「没装」——见 unavailable 文案） */
export function getTauriInvoke(): TauriInvoke | null {
  const w = (globalThis as { window?: { __TAURI_INTERNALS__?: TauriInternals } }).window;
  const invoke = w?.__TAURI_INTERNALS__?.invoke;
  return typeof invoke === 'function' ? invoke : null;
}

export const AUTOSTART_UNAVAILABLE_TEXT = '浏览器访问时不可用：开机自启由桌面应用管理';

export const AUTOSTART_TAKEOVER_CONFIRM =
  '当前开机自启由 CLI（kb autostart）注册，是否改为由桌面应用接管？（会改写同一系统入口）';

/** 读真实状态；「未安装」是正常返回，只有 IPC 失败才 reject */
export async function fetchAutostartStatus(invoke: TauriInvoke): Promise<AutostartStatus> {
  const raw = await invoke('autostart_status');
  if (raw === null || typeof raw !== 'object') {
    throw new Error('AUTOSTART_IO: 壳返回的状态格式非法');
  }
  const value = raw as Partial<AutostartStatus>;
  return {
    supported: value.supported === true,
    enabled: value.enabled === true,
    owner: value.owner ?? 'unknown',
    provider: value.provider ?? 'unsupported',
    ...(typeof value.detail === 'string' ? { detail: value.detail } : {}),
    ...(typeof value.error === 'string' ? { error: value.error } : {}),
  };
}

/**
 * 开启/关闭；成功以壳回读的新状态为准（不本地猜测）。
 * owner=cli 且要开启时必须由调用方先确认，然后带 takeOver:true。
 */
export async function setAutostart(
  invoke: TauriInvoke,
  options: { enabled: boolean; takeOver?: boolean },
): Promise<AutostartStatus> {
  const args: Record<string, unknown> = { enabled: options.enabled };
  if (options.takeOver === true) args.takeOver = true;
  const raw = await invoke('autostart_set', args);
  if (raw === null || typeof raw !== 'object') {
    throw new Error('AUTOSTART_IO: 壳返回的状态格式非法');
  }
  const value = raw as Partial<AutostartStatus>;
  return {
    supported: value.supported === true,
    enabled: value.enabled === true,
    owner: value.owner ?? 'unknown',
    provider: value.provider ?? 'unsupported',
    ...(typeof value.detail === 'string' ? { detail: value.detail } : {}),
    ...(typeof value.error === 'string' ? { error: value.error } : {}),
  };
}

export interface AutostartFailure {
  code: string;
  detail: string;
}

/** Tauri reject 的 message 是 `{"code":"AUTOSTART_...","detail":"..."}`（也可能是 Error） */
export function parseAutostartError(error: unknown): AutostartFailure {
  const raw =
    typeof error === 'string'
      ? error
      : error instanceof Error
        ? error.message
        : error === null || error === undefined
          ? ''
          : String(error);
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed !== null && typeof parsed === 'object') {
      const value = parsed as { code?: unknown; detail?: unknown };
      if (typeof value.code === 'string') {
        return { code: value.code, detail: typeof value.detail === 'string' ? value.detail : '' };
      }
    }
  } catch {
    // 不是 JSON：落到下面的兜底
  }
  return { code: 'AUTOSTART_IO', detail: raw.trim() };
}

const ERROR_TEXT: Record<string, string> = {
  AUTOSTART_UNSUPPORTED: '当前环境不支持开机自启',
  AUTOSTART_CONFLICT: '开机自启入口已被占用，未做改动',
  AUTOSTART_NOT_OWNED: '该自启项不归桌面应用管理，未做改动',
  AUTOSTART_PERMISSION: '系统拒绝修改开机自启（权限不足）',
  AUTOSTART_IO: '读写开机自启状态失败',
};

/** 错误码 → 人话（detail 优先，绝不直接展示 JSON） */
export function autostartErrorText(failure: AutostartFailure): string {
  const base = ERROR_TEXT[failure.code] ?? `开机自启操作失败（${failure.code}）`;
  return failure.detail === '' ? base : `${base}：${failure.detail}`;
}

const OWNER_TEXT: Record<AutostartOwner, string> = {
  desktop: '由桌面应用管理',
  cli: '由 CLI（kb autostart）注册',
  other: '入口指向其他程序',
  none: '未注册',
  unknown: '状态未知',
};

/** 主状态文案；supported=false 一律按「不可用」表述，不写成「已关闭」 */
export function autostartStatusText(status: AutostartStatus): string {
  if (!status.supported) {
    return status.detail !== undefined && status.detail !== ''
      ? `当前环境不可用：${status.detail}`
      : '当前环境不可用：开机自启由桌面应用管理';
  }
  return `${status.enabled ? '已启用' : '未启用'} · ${OWNER_TEXT[status.owner]}（${status.provider}）`;
}
