/**
 * DEC-7：决策通知（两档 + 降级）。
 *
 * - 有 Tauri 壳（`window.__TAURI_INTERNALS__` 存在）：调 `tauri-plugin-notification` 的命令
 *   （`plugin:notification|is_permission_granted / request_permission / notify`）。
 *   项目硬规矩「apps/** 不新增运行时依赖」，因此不引入 `@tauri-apps/plugin-notification`，
 *   直接走壳注入的 IPC 通道；参数形状与官方 JS 包一致。
 * - 无壳：Web Notification（`http://127.0.0.1` 属安全上下文，但需要用户手势授权；页面关掉即失效）。
 * - 两档都失败（权限拒绝 / 系统静音 / 页面关闭）：返回 `inapp`，由调用方保留
 *   侧栏徽标 + 主区汇总条 + 常驻 toast 这套可靠通道（本模块不负责该 UI）。
 *
 * 通知不是事实来源；点击通知的深链由 `focusDecision` 完成（浏览器档已接线，Tauri 档见卡评论）。
 */
import type { DecisionDetailDto } from './types';

export type NotifyChannel = 'tauri' | 'web' | 'inapp';

interface TauriInternals {
  invoke: (command: string, args?: Record<string, unknown>, options?: Record<string, unknown>) => Promise<unknown>;
}

function tauriInternals(): TauriInternals | null {
  const internals = (window as unknown as { __TAURI_INTERNALS__?: TauriInternals }).__TAURI_INTERNALS__;
  return internals && typeof internals.invoke === 'function' ? internals : null;
}

/** 当前可用的通知通道（Tauri 优先；无壳时看 Web Notification 是否存在） */
export function notificationChannel(): NotifyChannel {
  if (tauriInternals() !== null) return 'tauri';
  if (typeof window !== 'undefined' && typeof window.Notification === 'function') return 'web';
  return 'inapp';
}

/** 已授权？Tauri 走插件命令，Web 看 Notification.permission */
export async function isNotificationGranted(): Promise<boolean> {
  const tauri = tauriInternals();
  if (tauri !== null) {
    try {
      return (await tauri.invoke('plugin:notification|is_permission_granted', {})) === true;
    } catch {
      return false;
    }
  }
  if (typeof window !== 'undefined' && typeof window.Notification === 'function') {
    return window.Notification.permission === 'granted';
  }
  return false;
}

/**
 * 申请权限。Web Notification 必须由用户手势调用（按钮点击），自动调用会被浏览器忽略；
 * Tauri 无此限制。返回最终是否可发通知。
 */
export async function requestNotificationPermission(): Promise<boolean> {
  const tauri = tauriInternals();
  if (tauri !== null) {
    try {
      const result = await tauri.invoke('plugin:notification|request_permission', {});
      return result === 'granted';
    } catch {
      return false;
    }
  }
  if (typeof window !== 'undefined' && typeof window.Notification === 'function') {
    try {
      return (await window.Notification.requestPermission()) === 'granted';
    } catch {
      return false;
    }
  }
  return false;
}

export interface DecisionNotification {
  title: string;
  body: string;
  /** 点击通知后的深链目标（浏览器档直接接线；Tauri 档见卡评论） */
  decisionId: string;
  onOpen?: () => void;
}

/** 发一条决策通知；返回实际使用的通道（`inapp` = 两档都不可用，调用方保留应用内提示） */
export async function notifyDecision(input: DecisionNotification): Promise<NotifyChannel> {
  const channel = notificationChannel();
  if (channel === 'tauri') {
    const tauri = tauriInternals();
    if (tauri === null) return 'inapp';
    try {
      if (!(await isNotificationGranted())) return 'inapp';
      await tauri.invoke('plugin:notification|notify', {
        options: { title: input.title, body: input.body },
      });
      return 'tauri';
    } catch {
      return 'inapp';
    }
  }

  if (channel === 'web') {
    try {
      if (window.Notification.permission === 'default') return 'inapp';
      if (window.Notification.permission !== 'granted') return 'inapp';
      const notification = new window.Notification(input.title, { body: input.body, tag: input.decisionId });
      notification.onclick = () => {
        window.focus();
        input.onOpen?.();
        notification.close();
      };
      return 'web';
    } catch {
      return 'inapp';
    }
  }

  return 'inapp';
}

/** 事件 → 通知正文（拿不到详情时用兜底文案，不让通知链路失败） */
export async function describeDecisionForNotification(
  decisionId: string,
  fetchDetail: (id: string) => Promise<DecisionDetailDto>,
): Promise<{ title: string; body: string }> {
  try {
    const detail = await fetchDetail(decisionId);
    return {
      title: `[待决策] ${detail.issue_title}`,
      body: detail.question,
    };
  } catch {
    return { title: '[待决策] 有新的问题需要你拍板', body: '打开 AgentBoard 查看待决策列表' };
  }
}
