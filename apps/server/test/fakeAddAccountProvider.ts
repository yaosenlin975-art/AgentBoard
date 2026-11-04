/**
 * ACC-KB-B2S：协议级加号的 provider / vault 替身。
 *
 * 只用于验证编排、状态机与脱敏，**不代表任何真实产品契约**；
 * 协议解析器的真实请求形状见 addAccountProviders.test.ts。
 */
import type { ManagedAppId } from '@agentboard/shared';
import type { AddAccountPoll, AddAccountProviderSpec, AddAccountStart, AddAccountVault } from '../src/services/accounts/addAccountProtocol.js';

export const ADD_ACCOUNT_UID = 'uid-abc-123';
export const ADD_ACCOUNT_CREDENTIAL_MARK = 'FAKE-ADD-ACCOUNT-CREDENTIAL-DO-NOT-LEAK';
export const ADD_ACCOUNT_PENDING_MARK = 'FAKE-PENDING-SECRET-DO-NOT-LEAK';

export class FakeAddAccountProvider implements AddAccountProviderSpec {
  readonly app_id: ManagedAppId = 'minimax';
  readonly protocol = 'minimax_device' as const;
  readonly provider_version = 'fake-1.0.0';
  readonly regions = ['cn', 'global'] as const;
  startCalls = 0;
  pollCalls = 0;
  disposed = 0;
  /** 逐次返回的轮询结果；用尽后固定返回最后一次 */
  pollResults: AddAccountPoll[] = [
    { status: 'authorized', uid: ADD_ACCOUNT_UID, display_name: '测试账号', credential: Buffer.from(ADD_ACCOUNT_CREDENTIAL_MARK) },
  ];

  startAuthorization(): Promise<AddAccountStart> {
    this.startCalls += 1;
    return Promise.resolve({
      authorization_url: 'https://example.test/device?user_code=ABCD-EFGH',
      user_code: 'ABCD-EFGH',
      expires_at: Date.now() + 300_000,
      pending_secret: Buffer.from(ADD_ACCOUNT_PENDING_MARK),
    });
  }

  pollAuthorization(): Promise<AddAccountPoll> {
    this.pollCalls += 1;
    const next = this.pollResults.length > 1 ? this.pollResults.shift()! : this.pollResults[0]!;
    return Promise.resolve(next);
  }

  dispose(): Promise<void> {
    this.disposed += 1;
    return Promise.resolve();
  }
}

/** 内存 vault：只记 scope + 数据，供断言「不写脏数据 / 响应不泄露 / 不留孤儿」 */
export class FakeAddAccountVault implements AddAccountVault {
  readonly entries = new Map<string, { data: Buffer; scope: string }>();
  readonly deletedRefs: string[] = [];
  private seq = 0;

  protect(data: Buffer, scope: { app_id: ManagedAppId; client_instance_id: string; identity_hash: string; purpose: string }): Promise<string> {
    this.seq += 1;
    const ref = `00000000-0000-4000-8000-${String(this.seq).padStart(12, '0')}`;
    this.entries.set(ref, { data, scope: JSON.stringify(scope) });
    return Promise.resolve(ref);
  }

  unprotect(ref: string, scope: { app_id: ManagedAppId; client_instance_id: string; identity_hash: string; purpose: string }): Promise<Buffer> {
    const entry = this.entries.get(ref);
    if (!entry) return Promise.reject(new Error('missing ref'));
    if (entry.scope !== JSON.stringify(scope)) return Promise.reject(new Error('scope mismatch'));
    return Promise.resolve(entry.data);
  }

  delete(ref: string): Promise<void> {
    this.entries.delete(ref);
    this.deletedRefs.push(ref);
    return Promise.resolve();
  }

  get size(): number { return this.entries.size; }

  purposes(): string[] {
    return [...this.entries.values()].map(entry => (JSON.parse(entry.scope) as { purpose: string }).purpose);
  }
}
