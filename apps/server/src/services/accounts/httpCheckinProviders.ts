/**
 * ACC-12：三平台签到 provider（workbuddy / minimax / trae）。
 *
 * 契约要点（与 `checkinProvider.ts` 对齐）：
 * - `queryStatus` 先查状态：`already_done` 时 runner 直接跳过 claim（幂等，不重复领）；
 * - `submitCheckin` 返回 `succeeded | already_done | rate_limited | failed | unknown`；
 * - **401/403 = 凭据失效** → 抛 `ApiError(409, 'CHECKIN_CREDENTIAL_INVALID')`（提示重新导入凭据）；
 * - **429 = 限流** → 返回 `rate_limited`（runner 映射成 `CHECKIN_RATE_LIMITED`）；
 * - 网络异常/未知响应 → 返回 `unknown`（runner 映射成 `OPERATION_UNKNOWN`，不自动重发）；
 * - workbuddy 额外实现 `afterCheckin`（猫猫旅行）：签到成功后执行，失败不影响签到结果。
 *
 * 所有 HTTP 走可注入的 `fetchImpl`，测试用 fake fetch，不打真实接口。
 */
import { ApiError } from '../../errors.js';
import type {
  CheckinAfterActivity,
  CheckinProviderSpec,
  CheckinRegion,
  CheckinStatusQuery,
  CheckinSubmission,
} from './checkinProvider.js';
import type { ManagedAppId } from '@agentboard/shared';
import { workbuddyBillingUrl } from './platformHosts.js';

const MINIMAX_BASE = 'https://agent.minimaxi.com/minimax-cloud/api/v1';
const TRAE_BASE = 'https://api.trae.cn/trae/api/v2/ug';

export interface HttpCheckinConfig {
  app_id: ManagedAppId;
  region: CheckinRegion;
  provider_version: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

interface HttpResult { status: number; body: unknown }

const tokenOf = (credential: Buffer): string => credential.toString('utf8').trim();

async function requestJson(config: HttpCheckinConfig, url: string, init: RequestInit & { token: string }): Promise<HttpResult> {
  const fetchImpl = config.fetchImpl ?? fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.timeoutMs ?? 15_000);
  try {
    const response = await fetchImpl(url, {
      method: init.method ?? 'GET',
      headers: {
        authorization: `Bearer ${init.token}`,
        'content-type': 'application/json',
        ...(init.headers as Record<string, string> | undefined),
      },
      ...(init.body === undefined ? {} : { body: String(init.body) }),
      signal: controller.signal,
    });
    let body: unknown = null;
    try { body = await response.json(); } catch { body = null; }
    if (response.status === 401 || response.status === 403) {
      throw new ApiError(409, 'CHECKIN_CREDENTIAL_INVALID', '凭据已失效，请重新导入本机凭据');
    }
    return { status: response.status, body };
  } finally {
    clearTimeout(timer);
  }
}

const asRecord = (value: unknown): Record<string, unknown> =>
  (value && typeof value === 'object' ? value as Record<string, unknown> : {});
const dataOf = (body: unknown): Record<string, unknown> => asRecord(asRecord(body).data);

/** 401/403 已抛；429/其它分类交给各平台判定 */
const classifyFailure = (result: HttpResult): CheckinSubmission => (result.status === 429 ? 'rate_limited' : result.status >= 500 ? 'unknown' : 'failed');

function baseSpec(config: HttpCheckinConfig, parts: {
  status: (token: string) => Promise<CheckinStatusQuery>;
  claim: (token: string) => Promise<CheckinSubmission>;
  afterCheckin?: (token: string) => Promise<CheckinAfterActivity | null>;
}): CheckinProviderSpec {
  return {
    app_id: config.app_id,
    region: config.region,
    provider_version: config.provider_version,
    startAuthorization: async () => {
      // 这三个平台走「凭据导入」（ACC-11），不使用 OAuth 授权流程
      throw new ApiError(409, 'CHECKIN_AUTH_UNSUPPORTED', '该平台通过本机凭据导入，不支持授权流程');
    },
    pollAuthorization: async () => ({ status: 'failed', safe_error_code: 'CHECKIN_AUTH_UNSUPPORTED' }),
    queryStatus: async (credential) => parts.status(tokenOf(credential)),
    submitCheckin: async (credential) => parts.claim(tokenOf(credential)),
    ...(parts.afterCheckin ? { afterCheckin: async (credential: Buffer) => parts.afterCheckin!(tokenOf(credential)) } : {}),
  };
}

/** workbuddy：签到 + 猫猫旅行 */
export function createWorkbuddyCheckinProvider(config: HttpCheckinConfig): CheckinProviderSpec {
  const base = workbuddyBillingUrl(config.region, '');
  const request = (path: string, token: string, init: Partial<RequestInit> = {}) =>
    requestJson(config, `${base}${path}`, { token, ...init });

  return baseSpec(config, {
    // 注意：`/billing/meter/checkin-status` 恒返回 active=false，真实状态只有 activity-status 给
    status: async (token) => {
      const result = await request('/billing/meter/checkin-activity-status', token);
      if (result.status === 429) return 'unknown';
      const data = dataOf(result.body);
      if (data.today_checked_in === true) return 'already_done';
      if (data.today_checked_in === false) return 'not_done';
      return 'unknown';
    },
    claim: async (token) => {
      const result = await request('/billing/meter/daily-checkin', token, { method: 'POST', body: '{}' });
      if (result.status === 429) return 'rate_limited';
      if (result.status >= 200 && result.status < 300) return 'succeeded';
      const data = dataOf(result.body);
      if (data.already_checked_in === true || data.code === 'ALREADY_CHECKED_IN') return 'already_done';
      return classifyFailure(result);
    },
    // 猫猫旅行：idle → depart（派出） / traveling → 已派出 / arrived → claim（领取） / 其它异常 → 失败
    afterCheckin: async (token) => {
      try {
        const statusResult = await request('/activity/growth/buddy/travel/status', token);
        if (statusResult.status === 429) return { kind: 'travel', status: 'failed', safe_error_code: 'TRAVEL_RATE_LIMITED' };
        if (statusResult.status >= 400) return { kind: 'travel', status: 'failed', safe_error_code: `TRAVEL_HTTP_${statusResult.status}` };
        const status = dataOf(statusResult.body);
        const state = String(status.state ?? status.status ?? '').toLowerCase();
        if (status.claimed_today === true || state === 'claimed' || state === 'done') return { kind: 'travel', status: 'already_done' };
        if (state === 'arrived' || state === 'ready') {
          const claimed = await request('/activity/growth/buddy/travel/claim', token, { method: 'POST', body: '{}' });
          if (claimed.status >= 200 && claimed.status < 300) return { kind: 'travel', status: 'claimed' };
          return { kind: 'travel', status: 'failed', safe_error_code: `TRAVEL_CLAIM_HTTP_${claimed.status}` };
        }
        if (state === 'traveling' || state === 'on_the_way') return { kind: 'travel', status: 'dispatched' };
        const config = await request('/activity/growth/buddy/travel/config', token);
        const spots = (dataOf(config.body).spots ?? []) as Array<Record<string, unknown>>;
        const spot = spots[0];
        if (!spot || spot.id === undefined) return { kind: 'travel', status: 'failed', safe_error_code: 'TRAVEL_NO_SPOT' };
        const departed = await request('/activity/growth/buddy/travel/depart', token, { method: 'POST', body: JSON.stringify({ location_id: spot.id }) });
        if (departed.status >= 200 && departed.status < 300) return { kind: 'travel', status: 'dispatched' };
        return { kind: 'travel', status: 'failed', safe_error_code: `TRAVEL_DEPART_HTTP_${departed.status}` };
      } catch (error) {
        const code = error instanceof ApiError ? error.code : 'TRAVEL_FAILED';
        return { kind: 'travel', status: 'failed', safe_error_code: code };
      }
    },
  });
}

/** minimax：`days[]` 里 `is_today` 那条的 `status` 3=已领 / 2=可领 */
export function createMinimaxCheckinProvider(config: HttpCheckinConfig): CheckinProviderSpec {
  const request = (path: string, token: string, init: Partial<RequestInit> = {}) =>
    requestJson(config, `${MINIMAX_BASE}${path}`, { token, ...init });

  return baseSpec(config, {
    status: async (token) => {
      const result = await request('/signin/status', token);
      const days = (dataOf(result.body).days ?? []) as Array<Record<string, unknown>>;
      const today = days.find(day => day.is_today === true);
      if (!today) return 'unknown';
      if (Number(today.status) === 3) return 'already_done';
      if (Number(today.status) === 2) return 'not_done';
      return 'unknown';
    },
    claim: async (token) => {
      const result = await request('/signin/claim', token, { method: 'POST', body: '{}' });
      if (result.status === 429) return 'rate_limited';
      if (result.status >= 200 && result.status < 300) {
        const code = Number(asRecord(result.body).code ?? 0);
        if (code === 0) return 'succeeded';
        if (code === 3 || String(asRecord(result.body).msg ?? '').includes('已')) return 'already_done';
        return 'failed';
      }
      return classifyFailure(result);
    },
  });
}

/** trae：`checkin_credits/status` 的 `data.checked_in` */
export function createTraeCheckinProvider(config: HttpCheckinConfig): CheckinProviderSpec {
  const request = (path: string, token: string, init: Partial<RequestInit> = {}) =>
    requestJson(config, `${TRAE_BASE}${path}`, { token, ...init });

  return baseSpec(config, {
    status: async (token) => {
      const result = await request('/checkin_credits/status', token, { method: 'POST', body: '{}' });
      const data = dataOf(result.body);
      const flag = data.checked_in ?? data.today_checked_in ?? data.checkedIn;
      if (flag === true) return 'already_done';
      if (flag === false) return 'not_done';
      return 'unknown';
    },
    claim: async (token) => {
      const result = await request('/checkin_credits/claim', token, { method: 'POST', body: '{}' });
      if (result.status === 429) return 'rate_limited';
      if (result.status >= 200 && result.status < 300) {
        const data = dataOf(result.body);
        if (data.already_checked_in === true || data.checked_in === true) return 'already_done';
        return 'succeeded';
      }
      return classifyFailure(result);
    },
  });
}

export function createCheckinProviders(options: { fetchImpl?: typeof fetch; region?: CheckinRegion } = {}): Partial<Record<ManagedAppId, CheckinProviderSpec>> {
  const fetchImpl = options.fetchImpl;
  const region = options.region ?? 'cn';
  return {
    workbuddy_desktop: createWorkbuddyCheckinProvider({ app_id: 'workbuddy_desktop', region, provider_version: 'acc12-v1', fetchImpl }),
    minimax: createMinimaxCheckinProvider({ app_id: 'minimax', region, provider_version: 'acc12-v1', fetchImpl }),
    trae: createTraeCheckinProvider({ app_id: 'trae', region, provider_version: 'acc12-v1', fetchImpl }),
  };
}
