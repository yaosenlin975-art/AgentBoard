/**
 * ACC-12：三平台签到 provider + workbuddy 猫猫旅行。
 * 全部用 fake fetch，不打真实接口；重点是「先查状态再领」「401/403→凭据失效」「429→限流」「旅行失败不影响签到」。
 */
import { describe, expect, it } from 'vitest';
import { ApiError } from '../src/errors.js';
import {
  createCheckinProviders,
  createMinimaxCheckinProvider,
  createTraeCheckinProvider,
  createWorkbuddyCheckinProvider,
} from '../src/services/accounts/httpCheckinProviders.js';

const TOKEN = Buffer.from('fake-token-abc', 'utf8');
const base = { app_id: 'workbuddy_desktop' as const, region: 'cn' as const, provider_version: 'test' };

interface Call { url: string; method: string; body?: string; authorization?: string }
const fakeFetch = (routes: Array<{ match: (url: string, method: string) => boolean; status?: number; body?: unknown; rawBody?: string }>) => {
  const calls: Call[] = [];
  const impl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = String(init?.method ?? 'GET').toUpperCase();
    calls.push({ url, method, body: init?.body === undefined ? undefined : String(init.body), authorization: new Headers(init?.headers).get('authorization') ?? undefined });
    const route = routes.find(item => item.match(url, method));
    const status = route === undefined ? 404 : route.status ?? 200;
    return new Response(route?.rawBody ?? JSON.stringify(route?.body ?? {}), { status, headers: { 'content-type': 'application/json' } });
  }) as unknown as typeof fetch;
  return { impl, calls };
};

describe('workbuddy checkin provider', () => {
  it('uses checkin-activity-status (not checkin-status) and claims when not done', async () => {
    const { impl, calls } = fakeFetch([
      { match: url => url.endsWith('/billing/meter/checkin-activity-status'), body: { data: { today_checked_in: false } } },
      { match: url => url.endsWith('/billing/meter/daily-checkin'), status: 200, body: { code: 0 } },
    ]);
    const provider = createWorkbuddyCheckinProvider({ ...base, fetchImpl: impl });
    expect(await provider.queryStatus(TOKEN)).toBe('not_done');
    expect(await provider.submitCheckin(TOKEN)).toBe('succeeded');
    expect(calls.map(call => call.url)).toEqual([
      'https://www.codebuddy.cn/billing/meter/checkin-activity-status',
      'https://www.codebuddy.cn/billing/meter/daily-checkin',
    ]);
    expect(calls.some(call => /\/billing\/meter\/checkin-status$/.test(call.url))).toBe(false);
  });

  it('reports already_done from today_checked_in without claiming', async () => {
    const { impl, calls } = fakeFetch([{ match: url => url.endsWith('/checkin-activity-status'), body: { data: { today_checked_in: true } } }]);
    const provider = createWorkbuddyCheckinProvider({ ...base, fetchImpl: impl });
    expect(await provider.queryStatus(TOKEN)).toBe('already_done');
    expect(calls).toHaveLength(1);
  });

  it('maps 401 to credential-invalid error', async () => {
    const { impl } = fakeFetch([{ match: () => true, status: 401 }]);
    const provider = createWorkbuddyCheckinProvider({ ...base, fetchImpl: impl });
    await expect(provider.queryStatus(TOKEN)).rejects.toMatchObject({ code: 'CHECKIN_CREDENTIAL_INVALID' });
    await expect(provider.queryStatus(TOKEN)).rejects.toBeInstanceOf(ApiError);
  });

  it('maps 429 to rate_limited', async () => {
    const { impl } = fakeFetch([{ match: url => url.endsWith('/daily-checkin'), status: 429 }]);
    const provider = createWorkbuddyCheckinProvider({ ...base, fetchImpl: impl });
    expect(await provider.submitCheckin(TOKEN)).toBe('rate_limited');
  });
});

describe('workbuddy cat travel (afterCheckin)', () => {
  type Reply = { method: 'GET' | 'POST'; path: string; status?: number; body?: unknown };
  const scriptedTravelProvider = (replies: Reply[]) => {
    const calls: Call[] = [];
    let next = 0;
    const impl = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = String(init?.method ?? 'GET').toUpperCase();
      const path = new URL(url).pathname;
      calls.push({ url, method, body: init?.body === undefined ? undefined : String(init.body) });
      const reply = replies[next++];
      const matches = reply?.method === method && reply.path === path;
      return new Response(JSON.stringify(matches ? reply.body ?? {} : { code: 'UNEXPECTED_REQUEST' }), {
        status: matches ? reply.status ?? 200 : 500,
        headers: { 'content-type': 'application/json' },
      });
    }) as unknown as typeof fetch;
    return { provider: createWorkbuddyCheckinProvider({ ...base, fetchImpl: impl }), calls };
  };
  const travelProvider = (routes: Parameters<typeof fakeFetch>[0]) => {
    const fake = fakeFetch(routes);
    return { provider: createWorkbuddyCheckinProvider({ ...base, fetchImpl: fake.impl }), calls: fake.calls };
  };

  it('uses configured locations and verifies departure against source status', async () => {
    const { provider, calls } = scriptedTravelProvider([
      { method: 'GET', path: '/activity/growth/buddy/travel/status', body: { code: 0, data: { state: 'idle', daily_limit_reached: false } } },
      { method: 'GET', path: '/activity/growth/buddy/travel/config', body: { code: 0, data: { locations: [{ id: 7, reward_credit_min: 5, reward_credit_max: 10 }] } } },
      { method: 'POST', path: '/activity/growth/buddy/travel/depart', body: { code: 0 } },
      { method: 'GET', path: '/activity/growth/buddy/travel/status', body: { code: 0, data: { state: 'traveling', daily_limit_reached: true } } },
    ]);
    expect(await provider.afterCheckin!(TOKEN)).toEqual({ kind: 'travel', status: 'dispatched' });
    expect(calls.map(call => call.url)).toEqual([
      'https://www.codebuddy.cn/activity/growth/buddy/travel/status',
      'https://www.codebuddy.cn/activity/growth/buddy/travel/config',
      'https://www.codebuddy.cn/activity/growth/buddy/travel/depart',
      'https://www.codebuddy.cn/activity/growth/buddy/travel/status',
    ]);
    expect(calls[2]?.body).toBe(JSON.stringify({ location_id: 7 }));
  });

  it('returns dispatched when already traveling', async () => {
    const { provider } = travelProvider([{ match: url => url.endsWith('/travel/status'), body: { code: 0, data: { state: 'traveling' } } }]);
    expect(await provider.afterCheckin!(TOKEN)).toEqual({ kind: 'travel', status: 'dispatched' });
  });

  it('claims an arrived trip once, confirms source state, and skips an already claimed trip', async () => {
    const arrived = scriptedTravelProvider([
      { method: 'GET', path: '/activity/growth/buddy/travel/status', body: { code: 0, data: { state: 'arrived', reward_credit: 8 } } },
      { method: 'POST', path: '/activity/growth/buddy/travel/claim', body: { code: 0, data: { reward_credit: 8 } } },
      { method: 'GET', path: '/activity/growth/buddy/travel/status', body: { code: 0, data: { state: 'idle', daily_limit_reached: true } } },
    ]);
    expect(await arrived.provider.afterCheckin!(TOKEN)).toEqual({ kind: 'travel', status: 'claimed' });
    expect(arrived.calls.filter(call => call.method === 'POST')).toHaveLength(1);

    const claimedToday = travelProvider([{ match: url => url.endsWith('/travel/status'), body: { code: 0, data: { state: 'arrived', claimed_today: true } } }]);
    expect(await claimedToday.provider.afterCheckin!(TOKEN)).toEqual({ kind: 'travel', status: 'already_done' });
    expect(claimedToday.calls).toHaveLength(1);
  });

  it('does not treat unknown status or failed business codes as idle', async () => {
    const unknown = travelProvider([{ match: url => url.endsWith('/travel/status'), body: { code: 0, data: { state: 'paused' } } }]);
    expect(await unknown.provider.afterCheckin!(TOKEN)).toEqual({ kind: 'travel', status: 'failed', safe_error_code: 'TRAVEL_STATUS_UNKNOWN' });
    expect(unknown.calls).toHaveLength(1);

    const noCode = travelProvider([{ match: url => url.endsWith('/travel/status'), body: { data: { state: 'idle', daily_limit_reached: false } } }]);
    expect(await noCode.provider.afterCheckin!(TOKEN)).toEqual({ kind: 'travel', status: 'failed', safe_error_code: 'TRAVEL_STATUS_CODE_MISSING' });
    expect(noCode.calls).toHaveLength(1);

    const businessFailure = travelProvider([{ match: url => url.endsWith('/travel/status'), body: { code: 1001, data: { state: 'idle', daily_limit_reached: false } } }]);
    expect(await businessFailure.provider.afterCheckin!(TOKEN)).toEqual({ kind: 'travel', status: 'failed', safe_error_code: 'TRAVEL_STATUS_BUSINESS_1001' });
    expect(businessFailure.calls).toHaveLength(1);
  });

  it('does not report 2xx business failures or unconfirmed departure as success', async () => {
    const configFailure = scriptedTravelProvider([
      { method: 'GET', path: '/activity/growth/buddy/travel/status', body: { code: 0, data: { state: 'idle', daily_limit_reached: false } } },
      { method: 'GET', path: '/activity/growth/buddy/travel/config', body: { code: 1401, data: { locations: [{ id: 1 }] } } },
    ]);
    expect(await configFailure.provider.afterCheckin!(TOKEN)).toEqual({ kind: 'travel', status: 'failed', safe_error_code: 'TRAVEL_CONFIG_BUSINESS_1401' });
    expect(configFailure.calls).toHaveLength(2);

    const departFailure = scriptedTravelProvider([
      { method: 'GET', path: '/activity/growth/buddy/travel/status', body: { code: 0, data: { state: 'idle', daily_limit_reached: false } } },
      { method: 'GET', path: '/activity/growth/buddy/travel/config', body: { code: 0, data: { locations: [{ id: 1 }] } } },
      { method: 'POST', path: '/activity/growth/buddy/travel/depart', body: { code: 1402 } },
    ]);
    expect(await departFailure.provider.afterCheckin!(TOKEN)).toEqual({ kind: 'travel', status: 'failed', safe_error_code: 'TRAVEL_DEPART_BUSINESS_1402' });
    expect(departFailure.calls.filter(call => call.method === 'POST')).toHaveLength(1);
    expect(departFailure.calls).toHaveLength(3);

    const unconfirmed = scriptedTravelProvider([
      { method: 'GET', path: '/activity/growth/buddy/travel/status', body: { code: 0, data: { state: 'idle', daily_limit_reached: false } } },
      { method: 'GET', path: '/activity/growth/buddy/travel/config', body: { code: 0, data: { locations: [{ id: 1 }] } } },
      { method: 'POST', path: '/activity/growth/buddy/travel/depart', body: { code: 0 } },
      { method: 'GET', path: '/activity/growth/buddy/travel/status', body: { code: 0, data: { state: 'idle', daily_limit_reached: false } } },
    ]);
    expect(await unconfirmed.provider.afterCheckin!(TOKEN)).toEqual({ kind: 'travel', status: 'failed', safe_error_code: 'TRAVEL_DEPART_UNCONFIRMED' });
    expect(unconfirmed.calls.filter(call => call.method === 'POST')).toHaveLength(1);
  });

  it('reports failed with code instead of throwing', async () => {
    const broken = travelProvider([{ match: url => url.endsWith('/travel/status'), status: 500 }]);
    expect(await broken.provider.afterCheckin!(TOKEN)).toEqual({ kind: 'travel', status: 'failed', safe_error_code: 'TRAVEL_STATUS_HTTP_500' });

    const unauthorized = travelProvider([{ match: () => true, status: 401 }]);
    expect(await unauthorized.provider.afterCheckin!(TOKEN)).toMatchObject({ kind: 'travel', status: 'failed', safe_error_code: 'CHECKIN_CREDENTIAL_INVALID' });
  });
});

describe('minimax checkin provider', () => {
  const provider = (routes: Parameters<typeof fakeFetch>[0]) => {
    const fake = fakeFetch(routes);
    return { provider: createMinimaxCheckinProvider({ app_id: 'minimax', region: 'cn', provider_version: 'test', fetchImpl: fake.impl }), calls: fake.calls };
  };

  it('status 3 → already_done；status 2 → not_done → claim succeeded；请求带 timezone_id query（ACC-CHK-MX-TZ）', async () => {
    const done = provider([{ match: url => url.endsWith('/signin/status?timezone_id=Asia/Shanghai'), body: { data: { days: [{ is_today: true, status: 3 }] } } }]);
    expect(await done.provider.queryStatus(TOKEN)).toBe('already_done');
    expect(done.calls[0]?.url).toBe('https://agent.minimaxi.com/minimax-cloud/api/v1/signin/status?timezone_id=Asia/Shanghai');

    const claimable = provider([
      { match: url => url.endsWith('/signin/status?timezone_id=Asia/Shanghai'), body: { data: { days: [{ is_today: true, status: 2 }] } } },
      { match: url => url.endsWith('/signin/claim?timezone_id=Asia/Shanghai'), status: 200, body: { code: 0 } },
    ]);
    expect(await claimable.provider.queryStatus(TOKEN)).toBe('not_done');
    expect(await claimable.provider.submitCheckin(TOKEN)).toBe('succeeded');
    expect(claimable.calls.at(-1)?.url).toBe('https://agent.minimaxi.com/minimax-cloud/api/v1/signin/claim?timezone_id=Asia/Shanghai');
  });

  it('ACC-CHK-MX-TZ：无 timezone_id 恒业务错 1406010011 的形态 → status unknown、claim failed（不误判 succeeded）', async () => {
    const businessError = { base_resp: { status_code: 1406010011 } };
    expect(await provider([{ match: () => true, body: businessError }]).provider.queryStatus(TOKEN)).toBe('unknown');
    expect(await provider([{ match: () => true, body: businessError }]).provider.submitCheckin(TOKEN)).toBe('failed');
  });

  it('ACC-CHK-MX-TZ：claim 成功形态含 base_resp.status_code=0 → succeeded', async () => {
    expect(await provider([{ match: () => true, body: { base_resp: { status_code: 0 } } }]).provider.submitCheckin(TOKEN)).toBe('succeeded');
  });

  it('401 → credential invalid；429 → rate_limited；无 is_today → unknown', async () => {
    await expect(provider([{ match: () => true, status: 403 }]).provider.queryStatus(TOKEN)).rejects.toMatchObject({ code: 'CHECKIN_CREDENTIAL_INVALID' });
    expect(await provider([{ match: url => url.endsWith('/signin/claim?timezone_id=Asia/Shanghai'), status: 429 }]).provider.submitCheckin(TOKEN)).toBe('rate_limited');
    expect(await provider([{ match: url => url.endsWith('/signin/status?timezone_id=Asia/Shanghai'), body: { data: { days: [] } } }]).provider.queryStatus(TOKEN)).toBe('unknown');
  });

  it('ACC-FIX-3：JSON 凭据取 access_token，旧裸串兼容', async () => {
    const jsonCredential = Buffer.from(JSON.stringify({ access_token: 'json-token', refresh_token: 'rt' }));
    const done = provider([{ match: url => url.endsWith('/signin/status?timezone_id=Asia/Shanghai'), body: { data: { days: [{ is_today: true, status: 3 }] } } }]);
    expect(await done.provider.queryStatus(jsonCredential)).toBe('already_done');
    expect(await done.provider.queryStatus(TOKEN)).toBe('already_done');
  });

  it('ACC-FIX-3：refresh_token 换新 access_token，写回 JSON 载荷', async () => {
    const fake = fakeFetch([{ match: url => url.endsWith('/oauth2/token'), body: { access_token: 'new-token', refresh_token: 'rt2', expires_in: 3600 } }]);
    const p = createMinimaxCheckinProvider({ app_id: 'minimax', region: 'cn', provider_version: 'test', fetchImpl: fake.impl });
    const next = await p.refreshCredential!(Buffer.from(JSON.stringify({ access_token: 'old-token', refresh_token: 'rt1', expires_at: 1 })));
    expect(next).not.toBeNull();
    const payload = JSON.parse(next!.toString('utf8')) as { access_token: string; refresh_token: string; expires_at: number };
    expect(payload.access_token).toBe('new-token');
    expect(payload.refresh_token).toBe('rt2');
    expect(payload.expires_at).toBeGreaterThan(Date.now());
    expect(fake.calls[0]!.url).toBe('https://account.minimax.cn/oauth2/token');
  });

  it('ACC-FIX-3：裸串/无 refresh_token 不请求；平台拒绝 → null', async () => {
    const rejected = fakeFetch([{ match: () => true, status: 400, body: { error: 'invalid_grant' } }]);
    const p = createMinimaxCheckinProvider({ app_id: 'minimax', region: 'cn', provider_version: 'test', fetchImpl: rejected.impl });
    expect(await p.refreshCredential!(TOKEN)).toBeNull();
    expect(rejected.calls).toHaveLength(0);
    expect(await p.refreshCredential!(Buffer.from(JSON.stringify({ access_token: 'a', refresh_token: 'r' })))).toBeNull();
    expect(rejected.calls).toHaveLength(1);
  });
});

describe('trae checkin provider', () => {
  const provider = (routes: Parameters<typeof fakeFetch>[0]) => {
    const fake = fakeFetch(routes);
    return { provider: createTraeCheckinProvider({ app_id: 'trae', region: 'cn', provider_version: 'test', fetchImpl: fake.impl }), calls: fake.calls };
  };

  it('uses Cloud-IDE-JWT and the top-level source status contract', async () => {
    const notDone = provider([{ match: url => url.endsWith('/checkin_credits/status'), body: { code: 0, checked_in: false, enable: true } }]);
    const done = provider([{ match: url => url.endsWith('/checkin_credits/status'), body: { code: 0, checked_in: true, enable: true } }]);
    expect(await notDone.provider.queryStatus(TOKEN)).toBe('not_done');
    expect(await done.provider.queryStatus(TOKEN)).toBe('already_done');
    expect([...notDone.calls, ...done.calls].map(call => call.authorization)).toEqual(['Cloud-IDE-JWT fake-token-abc', 'Cloud-IDE-JWT fake-token-abc']);
    expect([...notDone.calls, ...done.calls].every(call => call.method === 'POST')).toBe(true);
  });

  it('requires a successful business code and a verified post-claim status', async () => {
    const { provider: p, calls } = provider([
      { match: url => url.endsWith('/checkin_credits/claim'), body: { code: 0 } },
      { match: url => url.endsWith('/checkin_credits/status'), body: { code: 0, checked_in: true, enable: true } },
    ]);
    expect(await p.submitCheckin(TOKEN)).toBe('succeeded');
    expect(calls.map(call => call.url)).toEqual([
      expect.stringContaining('/checkin_credits/claim'),
      expect.stringContaining('/checkin_credits/status'),
    ]);
  });

  it('does not report success for business errors, missing codes, or unconfirmed claims', async () => {
    expect(await provider([
      { match: url => url.endsWith('/checkin_credits/claim'), body: { code: 1001, checked_in: false } },
      { match: url => url.endsWith('/checkin_credits/status'), body: { code: 0, checked_in: false, enable: true } },
    ]).provider.submitCheckin(TOKEN)).toBe('failed');
    expect(await provider([{ match: url => url.endsWith('/checkin_credits/claim'), body: {} }]).provider.submitCheckin(TOKEN)).toBe('unknown');
    expect(await provider([
      { match: url => url.endsWith('/checkin_credits/claim'), body: { code: 0 } },
      { match: url => url.endsWith('/checkin_credits/status'), body: { code: 0, checked_in: false, enable: true } },
    ]).provider.submitCheckin(TOKEN)).toBe('unknown');
    expect(await provider([{ match: url => url.endsWith('/checkin_credits/claim'), rawBody: 'not json' }]).provider.submitCheckin(TOKEN)).toBe('unknown');
    expect(await provider([{ match: url => url.endsWith('/checkin_credits/status'), body: { code: 1001, checked_in: false, enable: false } }]).provider.queryStatus(TOKEN)).toBe('unknown');
  });

  it('401 → credential invalid；429 → rate_limited', async () => {
    await expect(provider([{ match: () => true, status: 401 }]).provider.queryStatus(TOKEN)).rejects.toMatchObject({ code: 'CHECKIN_CREDENTIAL_INVALID' });
    expect(await provider([{ match: url => url.endsWith('/claim'), status: 429 }]).provider.submitCheckin(TOKEN)).toBe('rate_limited');
  });
});

describe('provider factory', () => {
  it('creates exactly the three checkin-capable platforms', () => {
    const providers = createCheckinProviders({ fetchImpl: (async () => new Response('{}', { status: 200 })) as unknown as typeof fetch });
    expect(Object.keys(providers).sort()).toEqual(['minimax', 'trae', 'workbuddy_desktop']);
    expect(providers.codebuddy_desktop).toBeUndefined();
  });

  it('authorization flow is explicitly unsupported for import-based platforms', async () => {
    const providers = createCheckinProviders({ fetchImpl: (async () => new Response('{}', { status: 200 })) as unknown as typeof fetch });
    await expect(providers.minimax!.startAuthorization({ account: {} as never })).rejects.toMatchObject({ code: 'CHECKIN_AUTH_UNSUPPORTED' });
  });
});
