/**
 * ACC-KB-B2S：五个平台的协议解析器测试（fake fetch，不打真实接口）。
 *
 * 断言的是**真实请求形状**（端点、头、请求体、状态判定），因为这些形状来自本机产品源码与线上实测，
 * 是本卡最容易被回归改坏的部分；平台侧的最终裁决留给真机验收。
 */
import { describe, expect, it } from 'vitest';
import {
  createMinimaxAddAccountProvider,
  createQoderAddAccountProvider,
  createWorkbuddyAddAccountProvider,
  createZcodeAddAccountProvider,
} from '../src/services/accounts/addAccountProvider.js';

interface FetchCall { url: string; method: string; headers: Record<string, string>; body: string | null }

function jsonResponse(status: number, body: unknown): Response {
  return {
    status,
    ok: status >= 200 && status < 300,
    json: async () => body,
  } as unknown as Response;
}

/** 按 URL 前缀路由的 fake fetch；记录每次调用便于断言请求形状 */
class FakeFetch {
  readonly calls: FetchCall[] = [];
  constructor(private readonly handler: (url: string, method: string) => { status: number; body: unknown }) {}

  fetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    const headers = { ...(init?.headers as Record<string, string> | undefined) };
    const raw = init?.body;
    const body = typeof raw === 'string' ? raw : raw instanceof URLSearchParams ? raw.toString() : null;
    this.calls.push({ url, method, headers, body });
    return jsonResponse(this.handler(url, method).status, this.handler(url, method).body);
  };

  last(): FetchCall { return this.calls[this.calls.length - 1]!; }
}

/** 造一个带 sub 声明的 JWT（payload 段 base64url） */
function jwtWithSub(sub: string): string {
  const payload = Buffer.from(JSON.stringify({ sub }), 'utf8').toString('base64url');
  return `header.${payload}.signature`;
}

describe('add account providers', () => {
  describe('minimax device grant', () => {
    it('minimaxStartUsesDeviceCodeEndpointWithPkce', async () => {
      const fake = new FakeFetch(() => ({
        status: 200,
        body: { device_code: 'dev-1', user_code: 'ABCD-EFGH', verification_uri: 'https://account.minimax.cn/oauth-authorize', verification_uri_complete: 'https://account.minimax.cn/oauth-authorize?user_code=ABCD-EFGH', expires_in: 300, interval: 3 },
      }));
      const provider = createMinimaxAddAccountProvider({ fetchImpl: fake.fetch as unknown as typeof fetch });
      const started = await provider.startAuthorization({ region: 'cn' });
      const call = fake.last();
      expect(call.url).toBe('https://account.minimax.cn/oauth2/device/code');
      expect(call.method).toBe('POST');
      expect(call.body).toContain('client_id=mcode-public');
      expect(call.body).toContain('scope=agent.default');
      expect(call.body).toContain('audience=agent-backend');
      expect(call.body).toContain('code_challenge_method=S256');
      expect(started.user_code).toBe('ABCD-EFGH');
      expect(started.authorization_url).toContain('user_code=ABCD-EFGH');
      // 待激活凭据里含 device_code 与 verifier，但不含任何 token
      const pending = JSON.parse(started.pending_secret.toString('utf8')) as Record<string, string>;
      expect(pending.device_code).toBe('dev-1');
      expect(pending.code_verifier).toBeTruthy();
      expect(JSON.stringify(pending)).not.toContain('access_token');
    });

    it('minimaxGlobalUsesInternationalOrigin', async () => {
      const fake = new FakeFetch(() => ({ status: 200, body: { device_code: 'd', user_code: 'u', verification_uri: 'https://account.minimax.io/oauth-authorize', expires_in: 300 } }));
      const provider = createMinimaxAddAccountProvider({ fetchImpl: fake.fetch as unknown as typeof fetch });
      await provider.startAuthorization({ region: 'global' });
      expect(fake.last().url).toBe('https://account.minimax.io/oauth2/device/code');
    });

    it('minimaxPollTreatsAuthorizationPendingAsPending', async () => {
      const fake = new FakeFetch((url) => url.includes('/oauth2/token')
        ? { status: 400, body: { error: 'authorization_pending' } }
        : { status: 200, body: { device_code: 'd', user_code: 'u', verification_uri: 'https://x', expires_in: 300 } });
      const provider = createMinimaxAddAccountProvider({ fetchImpl: fake.fetch as unknown as typeof fetch });
      const started = await provider.startAuthorization({ region: 'cn' });
      const polled = await provider.pollAuthorization(started.pending_secret);
      expect(polled.status).toBe('pending');
      expect(fake.last().url).toBe('https://account.minimax.cn/oauth2/token');
      expect(fake.last().body).toContain('grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Adevice_code');
    });

    it('minimaxPollReadsIdentityFromJwtSubject', async () => {
      const fake = new FakeFetch((url) => url.includes('/oauth2/token')
        ? { status: 200, body: { access_token: jwtWithSub('mm-user-1'), refresh_token: 'r', token_type: 'bearer', expires_in: 3600, scope: 'agent.default' } }
        : { status: 200, body: { device_code: 'd', user_code: 'u', verification_uri: 'https://x', expires_in: 300 } });
      const provider = createMinimaxAddAccountProvider({ fetchImpl: fake.fetch as unknown as typeof fetch });
      const started = await provider.startAuthorization({ region: 'cn' });
      const polled = await provider.pollAuthorization(started.pending_secret);
      expect(polled.status).toBe('authorized');
      expect(polled.status === 'authorized' && polled.uid).toBe('mm-user-1');
    });

    // ACC-FIX-6：真实 accessToken 是 60ch mmoat_ 裸串非 JWT——身份从 signin/status 服务端探测
    it('minimaxPollProbesSigninStatusForOpaqueToken', async () => {
      const fake = new FakeFetch((url) => {
        if (url.includes('/oauth2/token')) return { status: 200, body: { access_token: 'mmoat_opaque_60chars_fixture_token_not_a_jwt_0000000000', refresh_token: 'mmort_r', token_type: 'bearer', expires_in: 3600, scope: 'agent.default' } };
        if (url.includes('/signin/status')) return { status: 200, body: { data: { user_id: 'mm-uid-9', days: [] } } };
        return { status: 200, body: { device_code: 'd', user_code: 'u', verification_uri: 'https://x', expires_in: 300 } };
      });
      const provider = createMinimaxAddAccountProvider({ fetchImpl: fake.fetch as unknown as typeof fetch });
      const started = await provider.startAuthorization({ region: 'cn' });
      const polled = await provider.pollAuthorization(started.pending_secret);
      expect(polled.status).toBe('authorized');
      expect(polled.status === 'authorized' && polled.uid).toBe('mm-uid-9');
      const probe = fake.calls.find(c => c.url.includes('/signin/status'));
      expect(probe?.url).toBe('https://agent.minimaxi.com/minimax-cloud/api/v1/signin/status');
      expect(probe?.headers.authorization).toContain('Bearer mmoat_');
    });

    // ACC-FIX-6：signin/status 也不给 uid 时兜底 sha256(token) 前 16 位，授权不再 100% 失败
    it('minimaxPollFallsBackToTokenHashWhenIdentityUnavailable', async () => {
      const fake = new FakeFetch((url) => {
        if (url.includes('/oauth2/token')) return { status: 200, body: { access_token: 'mmoat_opaque_60chars_fixture_token_not_a_jwt_0000000000', refresh_token: 'mmort_r', token_type: 'bearer', expires_in: 3600, scope: 'agent.default' } };
        if (url.includes('/signin/status')) return { status: 401, body: { error: 'invalid access token' } };
        return { status: 200, body: { device_code: 'd', user_code: 'u', verification_uri: 'https://x', expires_in: 300 } };
      });
      const provider = createMinimaxAddAccountProvider({ fetchImpl: fake.fetch as unknown as typeof fetch });
      const started = await provider.startAuthorization({ region: 'cn' });
      const polled = await provider.pollAuthorization(started.pending_secret);
      expect(polled.status).toBe('authorized');
      expect(polled.status === 'authorized' && polled.uid).toMatch(/^[0-9a-f]{16}$/);
    });

    it('minimaxPollRejectsIncompleteTokenResponse', async () => {
      const fake = new FakeFetch((url) => url.includes('/oauth2/token')
        ? { status: 200, body: { access_token: 'a', token_type: 'bearer' } }
        : { status: 200, body: { device_code: 'd', user_code: 'u', verification_uri: 'https://x', expires_in: 300 } });
      const provider = createMinimaxAddAccountProvider({ fetchImpl: fake.fetch as unknown as typeof fetch });
      const started = await provider.startAuthorization({ region: 'cn' });
      const polled = await provider.pollAuthorization(started.pending_secret);
      expect(polled).toEqual({ status: 'failed', safe_error_code: 'MINIMAX_TOKEN_RESPONSE_INVALID' });
    });

    it('minimaxPollTreatsDeniedAsFailed', async () => {
      const fake = new FakeFetch((url) => url.includes('/oauth2/token')
        ? { status: 400, body: { error: 'access_denied' } }
        : { status: 200, body: { device_code: 'd', user_code: 'u', verification_uri: 'https://x', expires_in: 300 } });
      const provider = createMinimaxAddAccountProvider({ fetchImpl: fake.fetch as unknown as typeof fetch });
      const started = await provider.startAuthorization({ region: 'cn' });
      expect(await provider.pollAuthorization(started.pending_secret)).toEqual({ status: 'failed', safe_error_code: 'MINIMAX_ACCESS_DENIED' });
    });
  });

  describe('zcode cli poll flow', () => {
    it('zcodeStartUsesCliInitWithBearerPollToken', async () => {
      const fake = new FakeFetch(() => ({ status: 200, body: { code: 0, data: { flow_id: 'flow-1', poll_token: 'pt', authorize_url: 'https://chat.z.ai/api/oauth/authorize?x=1', expires_at: 1800000000, poll_interval_sec: 2 } } }));
      const provider = createZcodeAddAccountProvider({ fetchImpl: fake.fetch as unknown as typeof fetch });
      const started = await provider.startAuthorization({ region: 'cn' });
      const call = fake.last();
      expect(call.url).toBe('https://zcode.z.ai/api/v1/oauth/cli/init');
      expect(call.headers.authorization).toMatch(/^Bearer [0-9a-f]{64}$/);
      expect(call.body).toBe(JSON.stringify({ provider: 'bigmodel' }));
      expect(started.authorization_url).toContain('chat.z.ai');
      expect(started.expires_at).toBe(1800000000 * 1000);
    });

    it('zcodeGlobalUsesZaiProvider', async () => {
      const fake = new FakeFetch(() => ({ status: 200, body: { code: 0, data: { flow_id: 'f', authorize_url: 'https://chat.z.ai/a' } } }));
      const provider = createZcodeAddAccountProvider({ fetchImpl: fake.fetch as unknown as typeof fetch });
      await provider.startAuthorization({ region: 'global' });
      expect(fake.last().body).toBe(JSON.stringify({ provider: 'zai' }));
    });

    it('zcodePollPendingAndReady', async () => {
      let ready = false;
      const fake = new FakeFetch((url) => {
        if (!url.includes('/oauth/cli/poll/')) return { status: 200, body: { code: 0, data: { flow_id: 'flow-1', authorize_url: 'https://chat.z.ai/a' } } };
        if (!ready) return { status: 200, body: { code: 0, data: { status: 'pending' } } };
        return { status: 200, body: { code: 0, data: { status: 'ready', token: 'zcode-jwt', zai: { access_token: 'zai-access' }, user: { user_id: 'zc-user-1' } } } };
      });
      const provider = createZcodeAddAccountProvider({ fetchImpl: fake.fetch as unknown as typeof fetch });
      const started = await provider.startAuthorization({ region: 'global' });
      expect((await provider.pollAuthorization(started.pending_secret)).status).toBe('pending');
      ready = true;
      const polled = await provider.pollAuthorization(started.pending_secret);
      expect(polled.status).toBe('authorized');
      expect(polled.status === 'authorized' && polled.uid).toBe('zc-user-1');
      expect(polled.status === 'authorized' && polled.credential.toString('utf8')).toBe('zai-access');
      expect(fake.last().url).toContain('/api/v1/oauth/cli/poll/flow-1');
    });
  });

  describe('qoder device flow', () => {
    it('qoderStartBuildsSelectAccountsUrl', async () => {
      const provider = createQoderAddAccountProvider({ machineId: 'machine-1' });
      const started = await provider.startAuthorization({ region: 'cn' });
      expect(started.authorization_url).toContain('https://qoder.com.cn/device/selectAccounts?');
      expect(started.authorization_url).toContain('challenge_method=S256');
      expect(started.authorization_url).toContain('nonce=');
      expect(started.authorization_url).toContain('machine_id=machine-1');
      // SDK 实测 client_id（知识页写的 1c5e33e1-… 与本机 SDK 不一致，以 SDK 为准）
      expect(started.authorization_url).toContain('client_id=e883ade2-e6e3-4d6d-adf7-f92ceff5fdcb');
    });

    it('qoderPollTreats404AsPendingThenReadsUserInfo', async () => {
      let authorized = false;
      const fake = new FakeFetch((url) => {
        if (url.includes('/api/v1/userinfo')) return { status: 200, body: { id: 'qoder-user-1', name: '张三' } };
        if (!authorized) return { status: 404, body: { error: 'NotFound' } };
        return { status: 200, body: { token: 'dt-token-1' } };
      });
      const provider = createQoderAddAccountProvider({ fetchImpl: fake.fetch as unknown as typeof fetch, machineId: 'machine-1' });
      const started = await provider.startAuthorization({ region: 'cn' });
      expect((await provider.pollAuthorization(started.pending_secret)).status).toBe('pending');
      authorized = true;
      const polled = await provider.pollAuthorization(started.pending_secret);
      expect(polled.status).toBe('authorized');
      expect(polled.status === 'authorized' && polled.uid).toBe('qoder-user-1');
      expect(polled.status === 'authorized' && polled.credential.toString('utf8')).toBe('dt-token-1');
      expect(fake.calls[1]!.url).toContain('/api/v1/deviceToken/poll?');
      expect(fake.calls[1]!.url).toContain('challenge_method=S256');
    });

    it('qoderPollRejectsMissingIdentity', async () => {
      const fake = new FakeFetch((url) => url.includes('/api/v1/userinfo')
        ? { status: 200, body: { name: 'no id' } }
        : { status: 200, body: { token: 'dt-token-1' } });
      const provider = createQoderAddAccountProvider({ fetchImpl: fake.fetch as unknown as typeof fetch });
      const started = await provider.startAuthorization({ region: 'cn' });
      expect(await provider.pollAuthorization(started.pending_secret)).toEqual({ status: 'failed', safe_error_code: 'QODER_IDENTITY_MISSING' });
    });
  });

  describe('workbuddy oneid flow', () => {
    it('workbuddyStartCreatesStateAndAuthUrl', async () => {
      const fake = new FakeFetch(() => ({ status: 200, body: { code: 0, data: { state: 'state-1', authUrl: 'https://www.codebuddy.cn/login?platform=workbuddy&state=state-1' } } }));
      const provider = createWorkbuddyAddAccountProvider({ fetchImpl: fake.fetch as unknown as typeof fetch });
      const started = await provider.startAuthorization({ region: 'cn' });
      expect(fake.last().url).toBe('https://www.codebuddy.cn/v2/plugin/auth/state?platform=workbuddy');
      expect(started.authorization_url).toContain('state=state-1');
      const pending = JSON.parse(started.pending_secret.toString('utf8')) as Record<string, string>;
      expect(pending.state).toBe('state-1');
    });

    it('workbuddyPollTreats11217AsPending', async () => {
      const fake = new FakeFetch((url) => url.includes('/auth/token')
        ? { status: 200, body: { code: 11217, msg: 'login ing...' } }
        : { status: 200, body: { code: 0, data: { state: 'state-1', authUrl: 'https://www.codebuddy.cn/login?platform=workbuddy&state=state-1' } } });
      const provider = createWorkbuddyAddAccountProvider({ fetchImpl: fake.fetch as unknown as typeof fetch });
      const started = await provider.startAuthorization({ region: 'cn' });
      expect((await provider.pollAuthorization(started.pending_secret)).status).toBe('pending');
      expect(fake.last().url).toContain('/v2/plugin/auth/token?state=state-1');
    });

    it('workbuddyPollReadsAccountAfterToken', async () => {
      const fake = new FakeFetch((url) => url.includes('/auth/state')
        ? { status: 200, body: { code: 0, data: { state: 'state-1', authUrl: 'https://www.codebuddy.cn/login?platform=workbuddy&state=state-1' } } }
        : url.includes('/auth/token')
          ? { status: 200, body: { code: 0, data: { accessToken: 'wb-access', expiresIn: 3600 } } }
          : { status: 200, body: { code: 0, data: { oneidAccountId: 'wb-user-1', nickname: '工作搭子' } } });
      const provider = createWorkbuddyAddAccountProvider({ fetchImpl: fake.fetch as unknown as typeof fetch });
      const started = await provider.startAuthorization({ region: 'cn' });
      const polled = await provider.pollAuthorization(started.pending_secret);
      expect(polled.status).toBe('authorized');
      expect(polled.status === 'authorized' && polled.uid).toBe('wb-user-1');
      expect(polled.status === 'authorized' && polled.display_name).toBe('工作搭子');
      expect(polled.status === 'authorized' && polled.credential.toString('utf8')).toBe('wb-access');
      const accountCall = fake.calls[fake.calls.length - 1]!;
      expect(accountCall.url).toContain('/v2/plugin/login/account?state=state-1');
      expect(accountCall.headers.authorization).toBe('Bearer wb-access');
    });
  });
});
