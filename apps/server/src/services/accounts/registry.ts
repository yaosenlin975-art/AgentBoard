import type { ManagedAppId } from '@agentboard/shared';
import type { MinimaxClientStatus } from './minimaxClientProbe.js';
import { traeStorageAvailable } from './traeProvider.js';

export interface AccountProviderCapability {
  app_id: ManagedAppId;
  capture: boolean;
  switch: boolean;
  checkin: boolean;
  reason_code: string;
}

/** MiniMax 未探测（静态登记/离线）时 switch 的保留根因码：探测前无法给出切换可用性结论 */
export const MINIMAX_SWITCH_UNAVAILABLE = 'CLIENT_PROCESS_CONTROL_UNAVAILABLE';

/**
 * 账号 provider 注册表（ACC-05）。
 * workbuddy_desktop：捕获/切换已按验证契约实现（Docs/evidence/workbuddy-desktop-contract-2026-11-01.md），
 * 签到 provider 未验证 → checkin 关闭；codebuddy_desktop 契约未确认，全部关闭。
 *
 * MINIMAX-PATH：minimax 的 capture/switch 与根因码由客户端探测结果推导（`minimaxClientProbe.ts`）——
 * 默认安装位置、其它盘、卸载注册表三路都探过才判定「未安装」，不再把「装在非默认位置」误报成
 * `CLIENT_NOT_INSTALLED`。ACC-SW-MAX：停止/启动（clientProcess.ts）已装配，定位到 exe 即 switch 可用；
 * 未探测时保留 `MINIMAX_SWITCH_UNAVAILABLE`（探测前不结论）。
 */
const CAPABILITIES: AccountProviderCapability[] = [
  { app_id: 'workbuddy_desktop', capture: true, switch: true, checkin: true, reason_code: 'CHECKIN_READY' },
  { app_id: 'codebuddy_desktop', capture: false, switch: false, checkin: false, reason_code: 'TARGET_KIND_UNCONFIRMED' },
  // ACC-10：先登记平台，能力由后续子卡开启（capture: ACC-13、checkin: ACC-12、switch: ACC-SW-MAX）
  { app_id: 'minimax', capture: true, switch: false, checkin: true, reason_code: MINIMAX_SWITCH_UNAVAILABLE },
  // ACC-SW-TRAE：trae 行的 capture/switch 实际值一律由 withTraeStorage 按 storage.json 存在推导（静态行只是占位）
  { app_id: 'trae', capture: true, switch: true, checkin: true, reason_code: 'OK' },
  // ACC-KB-B1S：先登记平台 id，provider 行为分别由 B1S2 / B4S / B5S 落地；在此之前一律全关，
  // 用固定码 PROVIDER_NOT_IMPLEMENTED 说明「不是不可用，是还没实现」，避免与 CLIENT_NOT_INSTALLED 混淆。
  { app_id: 'qoder_cn', capture: false, switch: false, checkin: false, reason_code: 'PROVIDER_NOT_IMPLEMENTED' },
  { app_id: 'zcode', capture: false, switch: false, checkin: false, reason_code: 'PROVIDER_NOT_IMPLEMENTED' },
];

/**
 * minimax 行按探测结果改写：定位到 exe → capture/switch 可用（ACC-SW-MAX：start/stop 已装配）；
 * 未安装 / 路径不可解析 → capture/switch 关闭并给出对应原因码。
 * 未传探测结果时沿用静态登记（兼容既有同步调用方与离线场景）。
 */
function withMinimaxClient(capability: AccountProviderCapability, minimaxClient?: MinimaxClientStatus): AccountProviderCapability {
  if (capability.app_id !== 'minimax' || !minimaxClient) return capability;
  if (minimaxClient.installed) return { ...capability, capture: true, switch: true, reason_code: 'OK' };
  return { ...capability, capture: false, switch: false, reason_code: minimaxClient.reason_code };
}

/**
 * trae 行按「本机是否真的有可读 storage.json」推导（ACC-SW-TRAE）：有 → capture/switch 可用
 * （15 条目录级快照切换已实现，traeProvider.switchAccount）；没有 → 关闭并给 TRAE_STORAGE_MISSING。
 * `traeAvailable` 供测试注入（缺省探真实本机）。
 */
function withTraeStorage(capability: AccountProviderCapability, traeAvailable: boolean): AccountProviderCapability {
  if (capability.app_id !== 'trae') return capability;
  return traeAvailable
    ? { ...capability, capture: true, switch: true, reason_code: 'OK' }
    : { ...capability, capture: false, switch: false, reason_code: 'TRAE_STORAGE_MISSING' };
}

export function accountProviderCapabilities(minimaxClient?: MinimaxClientStatus, traeAvailable: boolean = traeStorageAvailable()): AccountProviderCapability[] {
  return CAPABILITIES.map(capability => ({ ...withTraeStorage(withMinimaxClient(capability, minimaxClient), traeAvailable) }));
}

export function accountProviderCapability(app: ManagedAppId, minimaxClient?: MinimaxClientStatus, traeAvailable: boolean = traeStorageAvailable()): AccountProviderCapability | undefined {
  return accountProviderCapabilities(minimaxClient, traeAvailable).find(capability => capability.app_id === app);
}
