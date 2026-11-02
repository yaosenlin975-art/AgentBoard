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

interface Call { url: string; method: string; body?: string }
const fakeFetch = (routes: Array<{ match: (url: string, method: string) => boolean; status?: number; body?: unknown }>) => {
  const calls: Call[] = [];
  const impl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = String(init?.method ?? 'GET').toUpperCase();
    calls.push({ url, method, body: init?.body === undefined ? undefined : String(init.body) });
    const route = routes.find(item => item.match(url, method));
    const status = route === undefined ? 404 : route.status ?? 200;
    return new Response(JSON.stringify(route?.body ?? {}), { status, headers: { 'content-type': 'application/json' } });
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
      expect.stringContaining('/billing/meter/checkin-activity-status'),
      expect.stringContaining('/billing/meter/daily-checkin'),
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
  const travelProvider = (routes: Parameters<typeof fakeFetch>[0]) => {
    const fake = fakeFetch(routes);
    return { provider: createWorkbuddyCheckinProvider({ ...base, fetchImpl: fake.impl }), calls: fake.calls };
  };

  it('departs when idle', async () => {
    const { provider, calls } = travelProvider([
      { match: url => url.endsWith('/travel/status'), body: { data: { state: 'idle' } } },
      { match: url => url.endsWith('/travel/config'), body: { data: { spots: [{ id: 7 }] } } },
      { match: url => url.endsWith('/travel/depart'), status: 200, body: { code: 0 } },
    ]);
    expect(await provider.afterCheckin!(TOKEN)).toEqual({ kind: 'travel', status: 'dispatched' });
    expect(calls.at(-1)?.body).toBe(JSON.stringify({ location_id: 7 }));
  });

  it('returns dispatched when already traveling', async () => {
    const { provider } = travelProvider([{ match: url => url.endsWith('/travel/status'), body: { data: { state: 'traveling' } } }]);
    expect(await provider.afterCheckin!(TOKEN)).toEqual({ kind: 'travel', status: 'dispatched' });
  });

  it('claims when arrived, and reports already_done when claimed today', async () => {
    const arrived = travelProvider([
      { match: url => url.endsWith('/travel/status'), body: { data: { state: 'arrived' } } },
      { match: url => url.endsWith('/travel/claim'), status: 200, body: { code: 0 } },
    ]);
    expect(await arrived.provider.afterCheckin!(TOKEN)).toEqual({ kind: 'travel', status: 'claimed' });

    const claimedToday = travelProvider([{ match: url => url.endsWith('/travel/status'), body: { data: { claimed_today: true } } }]);
    expect(await claimedToday.provider.afterCheckin!(TOKEN)).toEqual({ kind: 'travel', status: 'already_done' });
  });

  it('reports failed with code instead of throwing', async () => {
    const broken = travelProvider([{ match: url => url.endsWith('/travel/status'), status: 500 }]);
    expect(await broken.provider.afterCheckin!(TOKEN)).toEqual({ kind: 'travel', status: 'failed', safe_error_code: 'TRAVEL_HTTP_500' });

    const unauthorized = travelProvider([{ match: () => true, status: 401 }]);
    expect(await unauthorized.provider.afterCheckin!(TOKEN)).toMatchObject({ kind: 'travel', status: 'failed', safe_error_code: 'CHECKIN_CREDENTIAL_INVALID' });
  });
});

describe('minimax checkin provider', () => {
  const provider = (routes: Parameters<typeof fakeFetch>[0]) => {
    const fake = fakeFetch(routes);
    return { provider: createMinimaxCheckinProvider({ app_id: 'minimax', region: 'cn', provider_version: 'test', fetchImpl: fake.impl }), calls: fake.calls };
  };

  it('status 3 → already_done；status 2 → not_done → claim succeeded', async () => {
    const done = provider([{ match: url => url.endsWith('/signin/status'), body: { data: { days: [{ is_today: true, status: 3 }] } } }]);
    expect(await done.provider.queryStatus(TOKEN)).toBe('already_done');

    const claimable = provider([
      { match: url => url.endsWith('/signin/status'), body: { data: { days: [{ is_today: true, status: 2 }] } } },
      { match: url => url.endsWith('/signin/claim'), status: 200, body: { code: 0 } },
    ]);
    expect(await claimable.provider.queryStatus(TOKEN)).toBe('not_done');
    expect(await claimable.provider.submitCheckin(TOKEN)).toBe('succeeded');
  });

  it('401 → credential invalid；429 → rate_limited；无 is_today → unknown', async () => {
    await expect(provider([{ match: () => true, status: 403 }]).provider.queryStatus(TOKEN)).rejects.toMatchObject({ code: 'CHECKIN_CREDENTIAL_INVALID' });
    expect(await provider([{ match: url => url.endsWith('/signin/claim'), status: 429 }]).provider.submitCheckin(TOKEN)).toBe('rate_limited');
    expect(await provider([{ match: url => url.endsWith('/signin/status'), body: { data: { days: [] } } }]).provider.queryStatus(TOKEN)).toBe('unknown');
  });
});

describe('trae checkin provider', () => {
  const provider = (routes: Parameters<typeof fakeFetch>[0]) => {
    const fake = fakeFetch(routes);
    return { provider: createTraeCheckinProvider({ app_id: 'trae', region: 'cn', provider_version: 'test', fetchImpl: fake.impl }), calls: fake.calls };
  };

  it('checked_in=true → already_done；false → claim succeeded', async () => {
    expect(await provider([{ match: url => url.endsWith('/checkin_credits/status'), body: { data: { checked_in: true } } }]).provider.queryStatus(TOKEN)).toBe('already_done');
    const { provider: p, calls } = provider([
      { match: url => url.endsWith('/checkin_credits/status'), body: { data: { checked_in: false } } },
      { match: url => url.endsWith('/checkin_credits/claim'), status: 200, body: { data: {} } },
    ]);
    expect(await p.queryStatus(TOKEN)).toBe('not_done');
    expect(await p.submitCheckin(TOKEN)).toBe('succeeded');
    expect(calls.every(call => call.method === 'POST')).toBe(true);
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
