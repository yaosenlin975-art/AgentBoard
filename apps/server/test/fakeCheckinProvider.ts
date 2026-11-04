/**
 * ACC-07 签到 provider 替身：只用于验证编排、状态机与脱敏，**不代表任何真实产品契约**。
 * 真实 WorkBuddy / CodeBuddy 签到 gate 仍为 unverified（Docs/verification/2026-11-01-checkin-provider-contracts.md）。
 */
import { createHash } from 'node:crypto';
import type { ManagedAccount, ManagedAppId } from '@agentboard/shared';
import type { CheckinIdentity, CheckinProviderSpec, CheckinVault } from '../src/services/accounts/checkinProvider.js';
import type { CheckinAuthorizationPoll, CheckinAuthorizationStart, CheckinStatusQuery, CheckinSubmission } from '../src/services/accounts/checkinProvider.js';

export const CHECKIN_UID = '11111111-1111-1111-1111-111111111111';
export const CREDENTIAL_MARK = 'FAKE-CHECKIN-CREDENTIAL-DO-NOT-LEAK';
export const REMOTE_STATE_MARK = 'FAKE-REMOTE-STATE-DO-NOT-LEAK';
export const sha256 = (value: string): string => createHash('sha256').update(value).digest('hex');

export class FakeCheckinProvider implements CheckinProviderSpec {
  readonly app_id: ManagedAppId = 'workbuddy_desktop';
  readonly region = 'cn' as const;
  readonly provider_version = 'fake-1.0.0';
  startCalls = 0;
  pollCalls = 0;
  statusCalls = 0;
  submitCalls = 0;
  /** submit 并发峰值（串行断言用） */
  active = 0;
  maxActive = 0;
  submitDelayMs = 0;
  startError: Error | null = null;
  /** 逐次返回的授权轮询结果；用尽后固定返回最后一次 */
  authResults: CheckinAuthorizationPoll[] = [{ status: 'authorized', identity: { app_id: 'workbuddy_desktop', region: 'cn', uid: CHECKIN_UID }, credential: Buffer.from(CREDENTIAL_MARK) }];
  statusResult: CheckinStatusQuery = 'not_done';
  submitResults: CheckinSubmission[] = ['succeeded'];
  submittedAccounts: string[] = [];

  startAuthorization(input: { account: ManagedAccount }): Promise<CheckinAuthorizationStart> {
    this.startCalls += 1;
    this.submittedAccounts.push(`start:${input.account.id}`);
    if (this.startError) return Promise.reject(this.startError);
    return Promise.resolve({ remote_state: REMOTE_STATE_MARK, authorization_url: 'https://example.test/checkin-auth', expires_at: Date.now() + 60_000 });
  }

  pollAuthorization(): Promise<CheckinAuthorizationPoll> {
    this.pollCalls += 1;
    const next = this.authResults.length > 1 ? this.authResults.shift()! : this.authResults[0]!;
    return Promise.resolve(next);
  }

  queryStatus(): Promise<CheckinStatusQuery> {
    this.statusCalls += 1;
    this.submittedAccounts.push('status');
    return Promise.resolve(this.statusResult);
  }

  async submitCheckin(): Promise<CheckinSubmission> {
    this.submitCalls += 1;
    this.submittedAccounts.push('submit');
    this.active += 1;
    this.maxActive = Math.max(this.maxActive, this.active);
    try {
      if (this.submitDelayMs > 0) await new Promise(resolve => setTimeout(resolve, this.submitDelayMs));
      return this.submitResults.length > 1 ? this.submitResults.shift()! : (this.submitResults[0] ?? 'succeeded');
    } finally {
      this.active -= 1;
    }
  }
}

/** 内存 vault：只记 scope + 数据，供断言「不写脏数据 / 响应不泄露」 */
export class FakeCheckinVault implements CheckinVault {
  readonly entries = new Map<string, { data: Buffer; scope: string }>();
  private seq = 0;
  protect(data: Buffer, scope: { app_id: ManagedAppId; client_instance_id: string; identity_hash: string; purpose: 'checkin' }): Promise<string> {
    this.seq += 1;
    const ref = `00000000-0000-4000-8000-${String(this.seq).padStart(12, '0')}`;
    this.entries.set(ref, { data, scope: JSON.stringify(scope) });
    return Promise.resolve(ref);
  }
  unprotect(ref: string, scope: { app_id: ManagedAppId; client_instance_id: string; identity_hash: string; purpose: 'checkin' }): Promise<Buffer> {
    const entry = this.entries.get(ref);
    if (!entry) return Promise.reject(new Error('missing ref'));
    if (entry.scope !== JSON.stringify(scope)) return Promise.reject(new Error('scope mismatch'));
    return Promise.resolve(entry.data);
  }
  get size(): number { return this.entries.size; }
  values(): Buffer[] { return [...this.entries.values()].map(entry => entry.data); }
  /** ACC-DEL-01：删除账号时清理引用（记录被删 ref，便于断言凭据文件确实消失） */
  readonly deletedRefs: string[] = [];
  delete(ref: string): Promise<void> {
    this.entries.delete(ref);
    this.deletedRefs.push(ref);
    return Promise.resolve();
  }
}

export function credentialIdentity(uid = CHECKIN_UID): CheckinIdentity {
  return { app_id: 'workbuddy_desktop', region: 'cn', uid };
}
