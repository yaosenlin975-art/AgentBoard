import type { ManagedAppId } from '@agentboard/shared';
import type { MinimaxClientStatus } from './minimaxClientProbe.js';

export interface AccountProviderCapability {
  app_id: ManagedAppId;
  capture: boolean;
  switch: boolean;
  checkin: boolean;
  reason_code: string;
}

/** MiniMax 已安装但生产未装配进程控制（停止/启动）时的 switch 根因码 */
export const MINIMAX_SWITCH_UNAVAILABLE = 'CLIENT_PROCESS_CONTROL_UNAVAILABLE';

/**
 * 账号 provider 注册表（ACC-05）。
 * workbuddy_desktop：捕获/切换已按验证契约实现（Docs/verification/2026-11-01-workbuddy-desktop-contract.md），
 * 签到 provider 未验证 → checkin 关闭；codebuddy_desktop 契约未确认，全部关闭。
 *
 * MINIMAX-PATH：minimax 的 capture 与根因码由客户端探测结果推导（`minimaxClientProbe.ts`）——
 * 默认安装位置、其它盘、卸载注册表三路都探过才判定「未安装」，不再把「装在非默认位置」误报成
 * `CLIENT_NOT_INSTALLED`。switch 恒为 false：生产未装配客户端停止/启动能力。
 */
const CAPABILITIES: AccountProviderCapability[] = [
  { app_id: 'workbuddy_desktop', capture: true, switch: true, checkin: true, reason_code: 'CHECKIN_READY' },
  { app_id: 'codebuddy_desktop', capture: false, switch: false, checkin: false, reason_code: 'TARGET_KIND_UNCONFIRMED' },
  // ACC-10：先登记平台，能力由后续子卡开启（capture: ACC-13、checkin: ACC-12、switch: ACC-13）
  { app_id: 'minimax', capture: true, switch: false, checkin: true, reason_code: 'CLIENT_NOT_INSTALLED' },
  { app_id: 'trae', capture: false, switch: false, checkin: true, reason_code: 'LOGIN_STATE_NOT_FILE_BASED' },
  // ACC-KB-B1S：先登记平台 id，provider 行为分别由 B1S2 / B4S / B5S 落地；在此之前一律全关，
  // 用固定码 PROVIDER_NOT_IMPLEMENTED 说明「不是不可用，是还没实现」，避免与 CLIENT_NOT_INSTALLED 混淆。
  { app_id: 'qoder_cn', capture: false, switch: false, checkin: false, reason_code: 'PROVIDER_NOT_IMPLEMENTED' },
  { app_id: 'zcode', capture: false, switch: false, checkin: false, reason_code: 'PROVIDER_NOT_IMPLEMENTED' },
];

/**
 * minimax 行按探测结果改写：定位到 exe → capture 可用（根因码说明 switch 为何仍不可用）；
 * 未安装 / 路径不可解析 → capture 关闭并给出对应原因码。
 * 未传探测结果时沿用静态登记（兼容既有同步调用方与离线场景）。
 */
function withMinimaxClient(capability: AccountProviderCapability, minimaxClient?: MinimaxClientStatus): AccountProviderCapability {
  if (capability.app_id !== 'minimax' || !minimaxClient) return capability;
  if (minimaxClient.installed) return { ...capability, capture: true, switch: false, reason_code: MINIMAX_SWITCH_UNAVAILABLE };
  return { ...capability, capture: false, switch: false, reason_code: minimaxClient.reason_code };
}

export function accountProviderCapabilities(minimaxClient?: MinimaxClientStatus): AccountProviderCapability[] {
  return CAPABILITIES.map(capability => ({ ...withMinimaxClient(capability, minimaxClient) }));
}

export function accountProviderCapability(app: ManagedAppId, minimaxClient?: MinimaxClientStatus): AccountProviderCapability | undefined {
  return accountProviderCapabilities(minimaxClient).find(capability => capability.app_id === app);
}
