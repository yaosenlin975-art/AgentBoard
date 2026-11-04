/**
 * ACC-KB-B2S：四个远端平台的「添加账号」协议解析器（MiniMax / ZCode / Qoder / WorkBuddy）。
 *
 * 每个实现的请求形状都来自**本机产品源码或线上实测**，逐条注在代码里：
 * - MiniMax：`~/.minimax-code/releases/0.6.12/.../chunk-QJ2FEPC2.js`（官方 CLI 的 device grant 实现）
 *   + 线上实测 `POST https://account.minimax.cn/oauth2/device/code` → 200。
 * - ZCode：`D:\Program Files\ZCode\resources\app.asar`（CLI 轮询流）+ 线上实测 init → 200。
 * - Qoder：`D:\Program Files\Qoder CN\.../qoder-worker-runtime.obf.mjs`（设备码流 + userinfo）
 *   + 线上实测 poll 未授权 → 404、userinfo 无 token → 401。
 * - WorkBuddy：`D:\Program Files\WorkBuddy\.../codebuddy-lite-wb.mjs`（插件登录流）
 *   + 线上实测 `POST /v2/plugin/auth/state` → 200、轮询未授权 → code 11217。
 *
 * 与共享知识页 `89c72721` 的两处冲突（以源码/实测为准，差异已写进卡评论）：
 * 1. MiniMax `interval` 单位：知识页写「毫秒需 /1000」，源码只在**legacy user_code 轮询分支**
 *    才除 1000，device_code 分支直接当秒用；线上实测 interval=3 且 CLI 按秒 sleep ⇒ 本实现按**秒**。
 * 2. Qoder `client_id`：知识页写 `1c5e33e1-…`，本机 SDK 解出的 CN 实测值是
 *    `e883ade2-e6e3-4d6d-adf7-f92ceff5fdcb` ⇒ 本实现用 SDK 实测值。
 */
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { arch, hostname, platform as osPlatform } from 'node:os';
import type { ManagedAppId } from '@agentboard/shared';
import { ApiError } from '../../errors.js';
import {
  asRecord,
  decodePending,
  encodePending,
  jwtSubject,
  num,
  requestJson,
  str,
  type AddAccountPoll,
  type AddAccountProviderSpec,
  type AddAccountRegion,
  type AddAccountStart,
} from './addAccountProtocol.js';
import { createTraeAddAccountProvider } from './traeAddAccountProvider.js';

const DEFAULT_TIMEOUT_MS = 15_000;

// ---------------- MiniMax：RFC 8628 device grant + PKCE S256 ----------------

/** 官方 CLI 的账号 origin（源码 `Ie={cn:…account.minimax.cn, en:…account.minimax.io}`） */
const MINIMAX_ORIGIN: Record<AddAccountRegion, string> = {
  cn: 'https://account.minimax.cn',
  global: 'https://account.minimax.io',
};
const MINIMAX_CLIENT_ID = 'mcode-public';
const MINIMAX_SCOPE = 'agent.default';
const MINIMAX_AUDIENCE = 'agent-backend';
const MINIMAX_DEVICE_GRANT = 'urn:ietf:params:oauth:grant-type:device_code';

interface MinimaxPending { origin: string; device_code: string; code_verifier: string }

export function createMinimaxAddAccountProvider(options: { fetchImpl?: typeof fetch; timeoutMs?: number } = {}): AddAccountProviderSpec {
  const fetchImpl = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  return {
    app_id: 'minimax',
    protocol: 'minimax_device',
    provider_version: 'acc-kb-b2s-v1',
    regions: ['cn', 'global'],
    async startAuthorization({ region }): Promise<AddAccountStart> {
      const origin = MINIMAX_ORIGIN[region];
      // 源码：verifier = base64url(32B 随机)，challenge = base64url(sha256(verifier, ascii))
      const code_verifier = randomBytes(32).toString('base64url');
      const code_challenge = createHash('sha256').update(code_verifier, 'ascii').digest('base64url');
      const body = new URLSearchParams({
        client_id: MINIMAX_CLIENT_ID,
        scope: MINIMAX_SCOPE,
        audience: MINIMAX_AUDIENCE,
        code_challenge,
        code_challenge_method: 'S256',
      });
      const outcome = await requestJson(fetchImpl, `${origin}/oauth2/device/code`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
        body,
      }, timeoutMs);
      const data = asRecord(outcome.body);
      const device_code = str(data.device_code);
      const user_code = str(data.user_code);
      const verification_uri = str(data.verification_uri) ?? str(data.verification_url);
      if (!outcome.ok || !device_code || !user_code || !verification_uri) {
        throw new ApiError(502, 'MINIMAX_DEVICE_CODE_INVALID', 'MiniMax 设备码响应不完整，无法发起授权');
      }
      const expires_in = num(data.expires_in) ?? 300;
      const pending: MinimaxPending = { origin, device_code, code_verifier };
      return {
        authorization_url: str(data.verification_uri_complete) ?? verification_uri,
        user_code,
        expires_at: Date.now() + expires_in * 1000,
        pending_secret: encodePending(pending),
      };
    },
    async pollAuthorization(pendingSecret: Buffer): Promise<AddAccountPoll> {
      const pending = decodePending<MinimaxPending>(pendingSecret);
      const body = new URLSearchParams({
        grant_type: MINIMAX_DEVICE_GRANT,
        device_code: pending.device_code,
        client_id: MINIMAX_CLIENT_ID,
        code_verifier: pending.code_verifier,
      });
      const outcome = await requestJson(fetchImpl, `${pending.origin}/oauth2/token`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
        body,
      }, timeoutMs);
      const data = asRecord(outcome.body);
      // 源码的判定顺序：先看 body.status，再看 body.error，最后才当成功响应解析
      const status = str(data.status);
      if (status === 'pending' || status === 'slow_down') return { status: 'pending' };
      if (status === 'denied' || status === 'access_denied') return { status: 'failed', safe_error_code: 'MINIMAX_ACCESS_DENIED' };
      if (status === 'expired' || status === 'expired_token') return { status: 'expired' };
      const error = str(data.error);
      if (error === 'authorization_pending' || error === 'slow_down') return { status: 'pending' };
      if (error === 'access_denied') return { status: 'failed', safe_error_code: 'MINIMAX_ACCESS_DENIED' };
      if (error === 'expired_token') return { status: 'expired' };
      if (!outcome.ok) return { status: 'failed', safe_error_code: `MINIMAX_TOKEN_HTTP_${outcome.status}` };
      // 源码要求：access_token + refresh_token + token_type=bearer + expires_in + scope 含 agent.default
      const access_token = str(data.access_token);
      const refresh_token = str(data.refresh_token);
      const token_type = str(data.token_type);
      const expires_in = num(data.expires_in);
      const scope = str(data.scope);
      if (!access_token || !refresh_token || token_type?.toLowerCase() !== 'bearer' || expires_in === null || !scope?.split(/\s+/).includes(MINIMAX_SCOPE)) {
        return { status: 'failed', safe_error_code: 'MINIMAX_TOKEN_RESPONSE_INVALID' };
      }
      const uid = jwtSubject(access_token) ?? str(data.account_id);
      if (!uid) return { status: 'failed', safe_error_code: 'MINIMAX_IDENTITY_MISSING' };
      return { status: 'authorized', uid, display_name: null, credential: Buffer.from(access_token, 'utf8') };
    },
  };
}

// ---------------- ZCode：CLI 轮询流（最省人） ----------------

const ZCODE_API = 'https://zcode.z.ai';
/** 国内 BigModel / 国际 Z.ai，双区互斥（知识页 §2；实测 authorize_url 里 client_id=client_P8X5CMWmlaRO9gyO-KSqtg） */
const ZCODE_PROVIDER_BY_REGION: Record<AddAccountRegion, 'zai' | 'bigmodel'> = { cn: 'bigmodel', global: 'zai' };

interface ZcodePending { flow_id: string; poll_token: string; provider: 'zai' | 'bigmodel' }

export function createZcodeAddAccountProvider(options: { fetchImpl?: typeof fetch; timeoutMs?: number } = {}): AddAccountProviderSpec {
  const fetchImpl = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  return {
    app_id: 'zcode',
    protocol: 'zcode_cli',
    provider_version: 'acc-kb-b2s-v1',
    regions: ['cn', 'global'],
    async startAuthorization({ region }): Promise<AddAccountStart> {
      const provider = ZCODE_PROVIDER_BY_REGION[region];
      // 源码：pollToken = 32B 随机 hex，放在 Authorization 头；服务端原样回显（实测 same=True）
      const poll_token = randomBytes(32).toString('hex');
      const outcome = await requestJson(fetchImpl, `${ZCODE_API}/api/v1/oauth/cli/init`, {
        method: 'POST',
        headers: { authorization: `Bearer ${poll_token}`, 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify({ provider }),
      }, timeoutMs);
      const data = asRecord(asRecord(outcome.body).data);
      const flow_id = str(data.flow_id);
      const authorize_url = str(data.authorize_url);
      if (!outcome.ok || !flow_id || !authorize_url) {
        throw new ApiError(502, 'ZCODE_INIT_INVALID', 'ZCode 授权初始化失败');
      }
      const expires_at_sec = num(data.expires_at);
      const pending: ZcodePending = { flow_id, poll_token, provider };
      return {
        authorization_url: authorize_url,
        user_code: null,
        expires_at: expires_at_sec === null ? Date.now() + 300_000 : expires_at_sec * 1000,
        pending_secret: encodePending(pending),
      };
    },
    async pollAuthorization(pendingSecret: Buffer): Promise<AddAccountPoll> {
      const pending = decodePending<ZcodePending>(pendingSecret);
      const outcome = await requestJson(fetchImpl, `${ZCODE_API}/api/v1/oauth/cli/poll/${encodeURIComponent(pending.flow_id)}`, {
        method: 'GET',
        headers: { authorization: `Bearer ${pending.poll_token}`, accept: 'application/json' },
      }, timeoutMs);
      const data = asRecord(asRecord(outcome.body).data);
      const status = str(data.status);
      if (status === 'pending') return { status: 'pending' };
      if (status === 'failed') return { status: 'failed', safe_error_code: 'ZCODE_FLOW_FAILED' };
      if (status !== 'ready') return { status: 'pending' };
      const providerData = asRecord(data[pending.provider]);
      const access_token = str(providerData.access_token) ?? str(data.access_token);
      const user = asRecord(data.user);
      const uid = str(user.user_id) ?? str(user.id) ?? str(data.user_id);
      if (!access_token || !uid) return { status: 'failed', safe_error_code: 'ZCODE_TOKEN_INVALID' };
      return { status: 'authorized', uid, display_name: str(user.name) ?? str(user.nickname), credential: Buffer.from(access_token, 'utf8') };
    },
  };
}

// ---------------- Qoder CN：自研设备授权（challenge S256 + nonce + machine_id） ----------------

/** SDK 解出的 client_id（`_$d` = base64 + XOR）：CN = e883ade2-…，另一区 = e93fe488-… */
const QODER_CLIENT_ID = 'e883ade2-e6e3-4d6d-adf7-f92ceff5fdcb';
const QODER_AUTH_ORIGIN = 'https://qoder.com.cn';
const QODER_OPENAPI_ORIGIN = 'https://openapi.qoder.com.cn';

interface QoderPending { nonce: string; verifier: string; machine_id: string }

/**
 * 机器码：SDK 优先读 `~/.qoder-cn/.auth/machine_id`，没有就自造并落盘（持久化失败是硬失败）。
 * 我们**不写客户端目录**（红线：不改客户端账号文件），改为按本机稳定信息派生：同机恒定、跨机不同。
 * 设备流本身只靠 nonce + verifier 收口（SDK 的 poll 参数里没有 machine_id），故与客户端的机器码不同源不影响。
 */
export function deriveQoderMachineId(): string {
  const seed = [hostname(), osPlatform(), arch(), process.env.PROCESSOR_IDENTIFIER ?? ''].join('\0');
  return createHash('sha256').update(`agentboard/qoder/machine-id/v1\0${seed}`).digest('hex');
}

export function createQoderAddAccountProvider(options: { fetchImpl?: typeof fetch; timeoutMs?: number; machineId?: string } = {}): AddAccountProviderSpec {
  const fetchImpl = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const machine_id = options.machineId ?? deriveQoderMachineId();
  return {
    app_id: 'qoder_cn',
    protocol: 'qoder_device',
    provider_version: 'acc-kb-b2s-v1',
    regions: ['cn'],
    async startAuthorization(): Promise<AddAccountStart> {
      const verifier = randomBytes(32).toString('base64url');
      const challenge = createHash('sha256').update(verifier).digest('base64url');
      const nonce = randomUUID();
      const params = new URLSearchParams({
        challenge,
        challenge_method: 'S256',
        nonce,
        machine_id,
        client_id: QODER_CLIENT_ID,
      });
      const pending: QoderPending = { nonce, verifier, machine_id };
      return {
        authorization_url: `${QODER_AUTH_ORIGIN}/device/selectAccounts?${params.toString()}`,
        user_code: null,
        // SDK 的设备流总超时 300s（GXc=3e5）
        expires_at: Date.now() + 300_000,
        pending_secret: encodePending(pending),
      };
    },
    async pollAuthorization(pendingSecret: Buffer): Promise<AddAccountPoll> {
      const pending = decodePending<QoderPending>(pendingSecret);
      const params = new URLSearchParams({
        nonce: pending.nonce,
        verifier: pending.verifier,
        challenge_method: 'S256',
      });
      const outcome = await requestJson(fetchImpl, `${QODER_OPENAPI_ORIGIN}/api/v1/deviceToken/poll?${params.toString()}`, {
        method: 'GET',
        headers: { accept: 'application/json' },
      }, timeoutMs);
      // SDK：404 = 未授权（继续轮询）；2xx 但没有 token 同样视为未授权
      if (outcome.status === 404 || outcome.status === 202) return { status: 'pending' };
      if (!outcome.ok) return { status: 'failed', safe_error_code: `QODER_POLL_HTTP_${outcome.status}` };
      const data = asRecord(outcome.body);
      const token = str(data.token) ?? str(data.device_token);
      if (!token) return { status: 'pending' };
      const info = await requestJson(fetchImpl, `${QODER_OPENAPI_ORIGIN}/api/v1/userinfo`, {
        method: 'GET',
        headers: { authorization: `Bearer ${token}`, accept: 'application/json' },
      }, timeoutMs);
      if (!info.ok) return { status: 'failed', safe_error_code: `QODER_USERINFO_HTTP_${info.status}` };
      const user = asRecord(info.body);
      const uid = str(user.id) ?? str(user.user_id) ?? str(user.uid);
      if (!uid) return { status: 'failed', safe_error_code: 'QODER_IDENTITY_MISSING' };
      return { status: 'authorized', uid, display_name: str(user.name) ?? str(user.username), credential: Buffer.from(token, 'utf8') };
    },
  };
}

// ---------------- WorkBuddy：OneID 插件式 state → token → account ----------------

/** CN = www.codebuddy.cn（平台主机 ACC-KB-A1 实测）；国际 = www.workbuddy.ai（知识页 §2） */
const WORKBUDDY_ORIGIN: Record<AddAccountRegion, string> = {
  cn: 'https://www.codebuddy.cn',
  global: 'https://www.workbuddy.ai',
};
/** 插件登录流的 pending 码（源码常量 LOGIN_TOKEN_PENDING_CODE / LOGIN_ACCOUNT_PENDING_CODE） */
const WORKBUDDY_TOKEN_PENDING_CODE = 11217;
const WORKBUDDY_ACCOUNT_PENDING_CODE = 12151;

interface WorkbuddyPending { origin: string; state: string }

export function createWorkbuddyAddAccountProvider(options: { fetchImpl?: typeof fetch; timeoutMs?: number } = {}): AddAccountProviderSpec {
  const fetchImpl = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  return {
    app_id: 'workbuddy_desktop',
    protocol: 'workbuddy_oneid',
    provider_version: 'acc-kb-b2s-v1',
    regions: ['cn', 'global'],
    async startAuthorization({ region }): Promise<AddAccountStart> {
      const origin = WORKBUDDY_ORIGIN[region];
      const outcome = await requestJson(fetchImpl, `${origin}/v2/plugin/auth/state?platform=workbuddy`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json', 'x-no-authorization': 'true' },
        body: JSON.stringify({}),
      }, timeoutMs);
      const data = asRecord(asRecord(outcome.body).data);
      const state = str(data.state);
      const authUrl = str(data.authUrl);
      if (!outcome.ok || !state || !authUrl) {
        throw new ApiError(502, 'WORKBUDDY_STATE_INVALID', 'WorkBuddy 授权初始化失败');
      }
      const pending: WorkbuddyPending = { origin, state };
      return {
        authorization_url: authUrl,
        user_code: null,
        expires_at: Date.now() + 300_000,
        pending_secret: encodePending(pending),
      };
    },
    async pollAuthorization(pendingSecret: Buffer): Promise<AddAccountPoll> {
      const pending = decodePending<WorkbuddyPending>(pendingSecret);
      const origin = pending.origin;
      const tokenOutcome = await requestJson(fetchImpl, `${origin}/v2/plugin/auth/token?state=${encodeURIComponent(pending.state)}`, {
        method: 'GET',
        headers: { accept: 'application/json', 'x-no-authorization': 'true' },
      }, timeoutMs);
      const tokenBody = asRecord(tokenOutcome.body);
      const code = num(tokenBody.code);
      if (code === WORKBUDDY_TOKEN_PENDING_CODE) return { status: 'pending' };
      const tokenData = asRecord(tokenBody.data);
      const access_token = str(tokenData.accessToken);
      if (!access_token) {
        return { status: 'failed', safe_error_code: `WORKBUDDY_TOKEN_HTTP_${tokenOutcome.status}` };
      }
      // 拉账号资料：源码用 Authorization: Bearer <accessToken> + X-Domain（企业域名头）
      const host = new URL(origin).host;
      const accountOutcome = await requestJson(fetchImpl, `${origin}/v2/plugin/login/account?state=${encodeURIComponent(pending.state)}`, {
        method: 'GET',
        headers: { authorization: `Bearer ${access_token}`, 'x-domain': host, accept: 'application/json' },
      }, timeoutMs);
      const accountBody = asRecord(accountOutcome.body);
      if (num(accountBody.code) === WORKBUDDY_ACCOUNT_PENDING_CODE) return { status: 'pending' };
      const accountData = asRecord(accountBody.data);
      const uid = str(accountData.oneidAccountId) ?? str(accountData.uin) ?? str(accountData.sub) ?? str(accountData.id);
      if (!uid) return { status: 'failed', safe_error_code: 'WORKBUDDY_IDENTITY_MISSING' };
      const displayName = str(accountData.nickname) ?? str(accountData.name) ?? str(accountData.email);
      return { status: 'authorized', uid, display_name: displayName, credential: Buffer.from(access_token, 'utf8') };
    },
  };
}

// ---------------- 装配 ----------------

export interface AddAccountProviderOptions {
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  /** Trae 的设备身份/客户端配置（读不到时 Trae 加号不可用，见 traeAddAccountProvider.ts） */
  trae?: Parameters<typeof createTraeAddAccountProvider>[0];
}

/** 五个平台的协议 provider（按 app_id）；Trae 需要本机设备身份，缺失时该平台不可用 */
export function createAddAccountProviders(options: AddAccountProviderOptions = {}): Partial<Record<ManagedAppId, AddAccountProviderSpec>> {
  return {
    minimax: createMinimaxAddAccountProvider(options),
    zcode: createZcodeAddAccountProvider(options),
    qoder_cn: createQoderAddAccountProvider(options),
    workbuddy_desktop: createWorkbuddyAddAccountProvider(options),
    trae: createTraeAddAccountProvider(options.trae ?? {}),
  };
}
