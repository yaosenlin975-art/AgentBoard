import type { ManagedAppId } from '@agentboard/shared';

export interface AccountProviderCapability {
  app_id: ManagedAppId;
  capture: boolean;
  switch: boolean;
  checkin: boolean;
  reason_code: string;
}

/**
 * 账号 provider 注册表（ACC-05）。
 * workbuddy_desktop：捕获/切换已按验证契约实现（Docs/verification/2026-11-01-workbuddy-desktop-contract.md），
 * 签到 provider 未验证 → checkin 关闭；codebuddy_desktop 契约未确认，全部关闭。
 */
const CAPABILITIES: AccountProviderCapability[] = [
  { app_id: 'workbuddy_desktop', capture: true, switch: true, checkin: false, reason_code: 'CHECKIN_PROVIDER_UNVERIFIED' },
  { app_id: 'codebuddy_desktop', capture: false, switch: false, checkin: false, reason_code: 'TARGET_KIND_UNCONFIRMED' },
  // ACC-10：先登记平台，能力由后续子卡开启（capture: ACC-13、checkin: ACC-12、switch: ACC-13）
  { app_id: 'minimax', capture: false, switch: false, checkin: false, reason_code: 'CAPTURE_PROVIDER_PENDING' },
  { app_id: 'trae', capture: false, switch: false, checkin: false, reason_code: 'CAPTURE_PROVIDER_PENDING' },
];

export function accountProviderCapabilities(): AccountProviderCapability[] {
  return CAPABILITIES.map(capability => ({ ...capability }));
}

export function accountProviderCapability(app: ManagedAppId): AccountProviderCapability | undefined {
  return accountProviderCapabilities().find(capability => capability.app_id === app);
}
