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
/**
 * ACC-CHK-MX-TZ 真机实证（2026-11-07，账号 2c8f498f）：
 * signin/status、signin/claim 不带 timezone_id 时服务端 HTTP 200 但 `base_resp.status_code=1406010011`
 * （invalid timezone_id）——status 拿不到 days（queryStatus 恒 unknown，runner 每次都盲发 claim）、
 * claim 实际未落地却被旧判定读成成功（顶层无 code → `?? 0` 误判 succeeded，当天批次 447ec295 假阳性）。
 * 仅 query 参数形态生效（header 形态无效），与 minimaxDesktopProvider 切换探针同参。
 */
const MINIMAX_TIMEZONE_QUERY = '?timezone_id=Asia/Shanghai';
const TRAE_BASE = 'https://api.trae.cn/trae/api/v2/ug';
/** ACC-FIX-3：minimax 续期 token 与官方 CLI 的账号 origin 同源（见 addAccountProvider.ts） */
const MINIMAX_ORIGIN: Record<'cn' | 'global', string> = {
  cn: 'https://account.minimax.cn',
  global: 'https://account.minimax.io',
};
const MINIMAX_CLIENT_ID = 'mcode-public';

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
  /** ACC-FIX-3：从凭据字节取 access_token；缺省把凭据当裸串 */
  token?: (credential: Buffer) => string;
  /** ACC-FIX-3：凭据失效时的续期实现 */
  refresh?: (credential: Buffer) => Promise<Buffer | null>;
}): CheckinProviderSpec {
  const tokenOfCredential = parts.token ?? tokenOf;
  return {
    app_id: config.app_id,
    region: config.region,
    provider_version: config.provider_version,
    startAuthorization: async () => {
      // 这三个平台走「凭据导入」（ACC-11），不使用 OAuth 授权流程
      throw new ApiError(409, 'CHECKIN_AUTH_UNSUPPORTED', '该平台通过本机凭据导入，不支持授权流程');
    },
    pollAuthorization: async () => ({ status: 'failed', safe_error_code: 'CHECKIN_AUTH_UNSUPPORTED' }),
    queryStatus: async (credential) => parts.status(tokenOfCredential(credential)),
    submitCheckin: async (credential) => parts.claim(tokenOfCredential(credential)),
    ...(parts.refresh ? { refreshCredential: parts.refresh } : {}),
    ...(parts.afterCheckin ? { afterCheckin: async (credential: Buffer) => parts.afterCheckin!(tokenOfCredential(credential)) } : {}),
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

/** ACC-FIX-3：minimax 凭据载荷（新）或裸 access_token（旧）；旧裸串无 refresh_token，无法续期 */
export interface MinimaxCredentialPayload {
  access_token: string;
  refresh_token?: string;
  expires_at?: number | null;
}

export function parseMinimaxCredential(credential: Buffer): MinimaxCredentialPayload {
  const raw = credential.toString('utf8').trim();
  if (raw.startsWith('{')) {
    try {
      const record = asRecord(JSON.parse(raw) as unknown);
      const access = typeof record.access_token === 'string' ? record.access_token : '';
      if (access !== '') {
        return {
          access_token: access,
          ...(typeof record.refresh_token === 'string' && record.refresh_token !== '' ? { refresh_token: record.refresh_token } : {}),
          expires_at: typeof record.expires_at === 'number' ? record.expires_at : null,
        };
      }
    } catch {
      // 不是 JSON：按旧裸串处理
    }
  }
  return { access_token: raw };
}

/**
 * ACC-TOKEN-2：refresh grant 的区分化结果。既有 `refreshMinimaxCredential` 的行为保持不变
 * （任何失败一律 null）；refresh-credential 端点需要区分 invalid_grant（refresh token 被官方
 * 客户端轮换作废 → 409 CREDENTIAL_RELOGIN_REQUIRED）与网络/非 2xx/缺字段（409 CREDENTIAL_REFRESH_FAILED）。
 */
export type MinimaxRefreshOutcome =
  | { ok: true; payload: { access_token: string; refresh_token: string; expires_at: number | null } }
  | { ok: false; reason: 'no_refresh_token' | 'invalid_grant' | 'failed' };

/** 复用既有刷新实现（同端点同 form 同判定顺序）：POST {account.minimax.cn|io}/oauth2/token */
export async function attemptMinimaxRefresh(
  parsed: MinimaxCredentialPayload,
  region: 'cn' | 'global',
  options: { fetchImpl?: typeof fetch; timeoutMs?: number } = {},
): Promise<MinimaxRefreshOutcome> {
  if (parsed.refresh_token === undefined) return { ok: false, reason: 'no_refresh_token' };
  const origin = region === 'global' ? MINIMAX_ORIGIN.global : MINIMAX_ORIGIN.cn;
  const fetchImpl = options.fetchImpl ?? fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? 15_000);
  try {
    const response = await fetchImpl(`${origin}/oauth2/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
      body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: parsed.refresh_token, client_id: MINIMAX_CLIENT_ID }),
      signal: controller.signal,
    });
    let body: unknown = null;
    try { body = await response.json(); } catch { body = null; }
    if (!response.ok) {
      // G13 实测：refresh token 一次性+轮换作废时 HTTP 400 + body.error=invalid_grant
      if (asRecord(body).error === 'invalid_grant') return { ok: false, reason: 'invalid_grant' };
      return { ok: false, reason: 'failed' };
    }
    const record = asRecord(body);
    const access = typeof record.access_token === 'string' ? record.access_token : '';
    if (access === '') return { ok: false, reason: 'failed' };
    const nextRefresh = typeof record.refresh_token === 'string' && record.refresh_token !== '' ? record.refresh_token : parsed.refresh_token;
    const expiresIn = typeof record.expires_in === 'number' ? record.expires_in : null;
    return {
      ok: true,
      payload: {
        access_token: access,
        refresh_token: nextRefresh,
        expires_at: expiresIn === null ? null : Date.now() + expiresIn * 1000,
      },
    };
  } catch {
    return { ok: false, reason: 'failed' };
  } finally {
    clearTimeout(timer);
  }
}

/** ACC-FIX-3：用 refresh_token 换新 access_token；失败/无 refresh_token 一律 null（不重试、不透传错误体） */
async function refreshMinimaxCredential(config: HttpCheckinConfig, credential: Buffer): Promise<Buffer | null> {
  const parsed = parseMinimaxCredential(credential);
  const outcome = await attemptMinimaxRefresh(parsed, config.region === 'global' ? 'global' : 'cn', {
    ...(config.fetchImpl !== undefined ? { fetchImpl: config.fetchImpl } : {}),
    ...(config.timeoutMs !== undefined ? { timeoutMs: config.timeoutMs } : {}),
  });
  if (!outcome.ok) return null;
  return Buffer.from(JSON.stringify({
    access_token: outcome.payload.access_token,
    refresh_token: outcome.payload.refresh_token,
    expires_at: outcome.payload.expires_at,
  }), 'utf8');
}

/** minimax：`days[]` 里 `is_today` 那条的 `status` 3=已领 / 2=可领 */
export function createMinimaxCheckinProvider(config: HttpCheckinConfig): CheckinProviderSpec {
  const request = (path: string, token: string, init: Partial<RequestInit> = {}) =>
    requestJson(config, `${MINIMAX_BASE}${path}`, { token, ...init });

  return baseSpec(config, {
    token: credential => parseMinimaxCredential(credential).access_token,
    refresh: credential => refreshMinimaxCredential(config, credential),
    status: async (token) => {
      const result = await request(`/signin/status${MINIMAX_TIMEZONE_QUERY}`, token);
      // 200 但业务层报错（base_resp.status_code != 0）= 服务端没服务这次调用，按 unknown（不误读空 days）
      if (Number(asRecord(asRecord(result.body).base_resp).status_code ?? 0) !== 0) return 'unknown';
      const days = (dataOf(result.body).days ?? []) as Array<Record<string, unknown>>;
      const today = days.find(day => day.is_today === true);
      if (!today) return 'unknown';
      if (Number(today.status) === 3) return 'already_done';
      if (Number(today.status) === 2) return 'not_done';
      return 'unknown';
    },
    claim: async (token) => {
      const result = await request(`/signin/claim${MINIMAX_TIMEZONE_QUERY}`, token, { method: 'POST', body: '{}' });
      if (result.status === 429) return 'rate_limited';
      if (result.status >= 200 && result.status < 300) {
        const record = asRecord(result.body);
        const code = Number(record.code ?? 0);
        // 业务错藏在 base_resp.status_code（顶层无 code 时旧判定 `?? 0` 会误判 succeeded）
        const baseCode = Number(asRecord(record.base_resp).status_code ?? 0);
        if (code === 0 && baseCode === 0) return 'succeeded';
        const msg = `${String(record.msg ?? '')}${String(asRecord(record.base_resp).msg ?? '')}`;
        if (code === 3 || baseCode === 3 || msg.includes('已')) return 'already_done';
        return 'failed';
      }
      return classifyFailure(result);
    },
  });
}

/**
 * ACC-TOKEN-2：trae 捕获线落 JSON 载荷 `{token, refresh_token, expires_at}`（设计页 §2 trae 行——
 * 旧实现只落裸 token，refreshToken/expiredAt 被丢弃）。旧裸串仍可读，签到/导入/切换不受影响。
 */
export function parseTraeCredential(credential: Buffer): { token: string; refresh_token?: string; expires_at?: number | null } {
  const raw = credential.toString('utf8').trim();
  if (raw.startsWith('{')) {
    try {
      const record = asRecord(JSON.parse(raw) as unknown);
      const token = typeof record.token === 'string' ? record.token : '';
      if (token !== '') {
        return {
          token,
          ...(typeof record.refresh_token === 'string' && record.refresh_token !== '' ? { refresh_token: record.refresh_token } : {}),
          expires_at: typeof record.expires_at === 'number' ? record.expires_at : null,
        };
      }
    } catch {
      // 不是 JSON：按旧裸串处理
    }
  }
  return { token: raw };
}

/** trae：`checkin_credits/status` 的 `data.checked_in` */
export function createTraeCheckinProvider(config: HttpCheckinConfig): CheckinProviderSpec {
  const request = (path: string, token: string, init: Partial<RequestInit> = {}) =>
    requestJson(config, `${TRAE_BASE}${path}`, { token, ...init });

  return baseSpec(config, {
    // ACC-TOKEN-2：凭据可能是 JSON 载荷（新捕获线）或裸串（旧数据）——统一从这里取 Bearer token
    token: credential => parseTraeCredential(credential).token,
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
