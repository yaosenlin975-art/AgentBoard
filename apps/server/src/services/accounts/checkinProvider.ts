import type { ManagedAccount, ManagedAppId } from '@agentboard/shared';

/**
 * ACC-07 签到 provider 契约（每产品一份实现，只有 ACC-03 契约通过的产品才允许落地）。
 *
 * 现状：WorkBuddy / CodeBuddy 两产品的真实签到授权与签到请求 gate 均为 `unverified`
 * （Docs/evidence/checkin-provider-contracts-2026-11-01.md），因此生产装配**不注入**任何
 * CheckinProviderSpec，端点一律 `409 PROVIDER_UNVERIFIED`，不创建授权会话、不发任何请求。
 * 测试用 `apps/server/test/fakeCheckinProvider.ts` 实现本接口，只验证编排与状态机。
 */

export type CheckinRegion = 'cn' | 'global' | 'unknown';

/** 授权响应侧身份；三元组 app_id + region + uid 必须与目标账号全等才允许绑定凭据 */
export interface CheckinIdentity {
  app_id: ManagedAppId;
  region: CheckinRegion;
  uid: string;
}

export interface CheckinAuthorizationStart {
  /** 远端授权 state 原文：只在内存→hash 后落库，不返回给前端 */
  remote_state: string;
  authorization_url: string;
  expires_at: number;
}

export type CheckinAuthorizationPoll =
  | { status: 'pending' }
  | { status: 'authorized'; identity: CheckinIdentity; credential: Buffer }
  | { status: 'failed'; safe_error_code: string }
  | { status: 'expired' };

/** 签到状态查询：'already_done' 才允许跳过请求；'unknown' 视为无可信状态，仍需发一次请求 */
export type CheckinStatusQuery = 'already_done' | 'not_done' | 'unknown';

export type CheckinSubmission = 'succeeded' | 'already_done' | 'failed' | 'rate_limited' | 'unknown';

/** 签到成功后的附加活动（workbuddy 猫猫旅行）：失败不影响签到结果，只在 operation 记录里可见 */
export interface CheckinAfterActivity {
  kind: 'travel';
  status: 'dispatched' | 'claimed' | 'already_done' | 'failed';
  safe_error_code?: string;
}

export interface CheckinProviderSpec {
  readonly app_id: ManagedAppId;
  readonly region: CheckinRegion;
  readonly provider_version: string;
  startAuthorization(input: { account: ManagedAccount }): Promise<CheckinAuthorizationStart>;
  pollAuthorization(remoteState: string): Promise<CheckinAuthorizationPoll>;
  queryStatus(credential: Buffer): Promise<CheckinStatusQuery>;
  submitCheckin(credential: Buffer): Promise<CheckinSubmission>;
  /**
   * ACC-FIX-3：凭据失效（401/403）时用 refresh_token 续期一次。
   * 返回新凭据字节；无法续期（无 refresh_token / 平台拒绝 / 网络失败）返回 null。
   */
  refreshCredential?(credential: Buffer): Promise<Buffer | null>;
  /** 可选：签到成功（succeeded/already_done）后的附加活动；异常/失败都不得影响签到结果 */
  afterCheckin?(credential: Buffer): Promise<CheckinAfterActivity | null>;
  /**
   * TRAVEL-REC：派出后到期回收。语义 = 只查状态并在到达时领取（claim），**绝不重新派出（depart）**；
   * 仍然在途返回 dispatched，供调用方下轮重试。
   */
  claimAfterTravel?(credential: Buffer): Promise<CheckinAfterActivity | null>;
}

/** 授权绑定只需要这两个能力；SecretVault 天然满足（测试注入内存替身） */
export interface CheckinVault {
  protect(data: Buffer, scope: { app_id: ManagedAppId; client_instance_id: string; identity_hash: string; purpose: 'checkin' }): Promise<string>;
  unprotect(ref: string, scope: { app_id: ManagedAppId; client_instance_id: string; identity_hash: string; purpose: 'checkin' }): Promise<Buffer>;
  /** ACC-FIX-3：续期成功后清理旧凭据（可选；缺失时旧记录留给 vault 自身回收） */
  delete?(ref: string): Promise<void>;
}
