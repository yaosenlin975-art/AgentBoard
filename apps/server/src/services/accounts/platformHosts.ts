/**
 * WorkBuddy 计费 origin 的**单一事实源**（ACC-KB-A1）。
 *
 * 636: 之前 `httpCheckinProviders.ts` 里写死 `api.workbuddy.cn`，而该域名在本机 **NXDOMAIN**（探活 GET/POST 均 000，连接失败），
 * 全仓也只出现那一次、没有任何测试断言。同期三份独立证据都指向 `www.codebuddy.cn`：
 * - 公共知识 §1：实测 `POST https://www.codebuddy.cn/billing/meter/get-user-resource-summary` → 200 / code 0；
 * - `Docs/evidence/checkin-provider-contracts-2026-11-01.md`：CN billing origin = `www.codebuddy.cn`（桌面 failover `www.workbuddy.cn` / `copilot.tencent.com`）；
 * - `refs/checkin_scripts_workbuddy_trae_minimax/workbuddy_checkin.py`：默认 `www.codebuddy.cn`。
 *
 * 探活复核（2026-11-04，只读、不带凭据）：
 * | host | DNS | GET /billing/meter/checkin-activity-status | POST /billing/meter/daily-checkin |
 * |---|---|---|---|
 * | api.workbuddy.cn | NXDOMAIN | 000（连接失败） | 000（连接失败） |
 * | www.codebuddy.cn | 可解析 | 401（需认证，host 有效） | 401 |
 * | www.workbuddy.cn | 可解析 | 401 | 401 |
 *
 * 因此：CN 走 `www.codebuddy.cn`（主用，有业务成功证据）；Global 走 `www.workbuddy.cn`（区域备用线路，仅探活有效）。
 * `unknown` 区域**明确报错**，不静默回落 —— 静默回落会让海外账号打到 CN 计费域，签到最后一步才失败。
 */
import { ApiError } from '../../errors.js';
import type { CheckinRegion } from './checkinProvider.js';

/** 有确定 origin 的区域（`unknown` 刻意不在此表内） */
export const WORKBUDDY_BILLING_ORIGIN: Readonly<Record<'cn' | 'global', string>> = {
  cn: 'https://www.codebuddy.cn',
  global: 'https://www.workbuddy.cn',
};

/** 区域 → origin；未知区域立即抛错（URL 拼接与装配期 fail-fast 共用同一判定） */
export function workbuddyBillingOrigin(region: CheckinRegion): string {
  const origin = WORKBUDDY_BILLING_ORIGIN[region as 'cn' | 'global'];
  if (origin === undefined) {
    throw new ApiError(
      400,
      'CHECKIN_REGION_UNSUPPORTED',
      `WorkBuddy 计费域不支持该区域：${String(region)}（可选 cn / global；unknown 需先补区域证据）`,
    );
  }
  return origin;
}

/** `/billing/meter/*` 各端点用的完整 URL */
export function workbuddyBillingUrl(region: CheckinRegion, path: string): string {
  const origin = workbuddyBillingOrigin(region);
  return `${origin}${path.startsWith('/') ? path : `/${path}`}`;
}

/** 额度端点（与签到同源，`get-user-resource-summary`） */
export function workbuddyQuotaUrl(region: CheckinRegion = 'cn'): string {
  return workbuddyBillingUrl(region, '/billing/meter/get-user-resource-summary');
}

/**
 * Trae 额度端点（ACC-QUOTA-ALL）。与签到（`httpCheckinProviders.ts` 的 `TRAE_BASE`）同域 `api.trae.cn`，
 * 但**必须 v2 pay 路径**（公共知识 `3c21b76c` §1：v1 无 usage_summary；Bearer 一律 401，
 * 鉴权前缀是 `Authorization: Cloud-IDE-JWT <token>`——头名前缀构造见 `quotaService.fetchPlatform`）。
 */
export function traeQuotaUrl(): string {
  return 'https://api.trae.cn/trae/api/v2/pay/ide_user_ent_usage';
}
