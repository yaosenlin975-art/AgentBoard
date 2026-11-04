/**
 * ACC-KB-B2S：Trae CN 的「添加账号」协议解析器（OAuth 授权码 + PKCE S256 + 固定本地回调）。
 *
 * 协议形状来自本机 Trae CN 客户端源码 `resources/app/out/main.js`（`loginUrlBuilder`）与
 * `resources/app/product.json`，与共享知识页 `89c72721` §2 的 Trae 段一致：
 * - 授权页：`{login_host}/authorization`，参数含 `code_challenge`/`code_challenge_method=S256`、
 *   `auth_callback_url=http://127.0.0.1:{port}/authorize`、`login_trace_id`（= CSRF 校验）、
 *   `machine_id`/`device_id` 与 `x_*` 同源设备字段；
 * - 回调：授权页 302 回 `auth_callback_url`，带 `authCodeInfo` + `userInfo` + `host` + `userRegion` +
 *   `loginTraceID`；`loginTraceID` 必须等于发起时的 trace id；
 * - 换 token：`POST {host}/trae/api/v3/oauth/ExchangeToken`，body `{ClientID, AuthCode, CodeVerifier, DeviceInfo, IDEVersion}`。
 *
 * 两条现实约束（本卡内处理，不越界）：
 * 1. `device_id` 必须与客户端设备凭证**同源**，自造值服务端会拒（20403/20405）。因此设备身份
 *    一律从**本机已装客户端**只读取出（product.json / state.vscdb / aha/TinyStorage），
 *    绝不自己编；读不到就明确报 `TRAE_DEVICE_IDENTITY_UNAVAILABLE`，不假装能加号。
 * 2. 回调端口固定 17388，与正在运行的 Trae 客户端冲突时同样明确报错，不静默降级。
 *
 * 与知识页的两处差异：知识页写 `authCodeInfo` 携带授权码；本实现对回调参数做**宽松解析**
 * （`authCodeInfo` JSON / `authCode` / `code` 三个来源都认），因为回调帧的真实形状需浏览器实跑才见分晓，
 * 宽松解析不改变服务端契约。
 */
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { ApiError } from '../../errors.js';
import {
  asRecord,
  decodePending,
  encodePending,
  num,
  requestJson,
  str,
  type AddAccountPoll,
  type AddAccountProviderSpec,
  type AddAccountRegion,
  type AddAccountStart,
} from './addAccountProtocol.js';

const TRAE_CALLBACK_PATH = '/authorize';
const DEFAULT_TRAE_CALLBACK_PORT = 17388;
const DEFAULT_TIMEOUT_MS = 15_000;

/** 加号需要的本机信息（全部来自已装客户端，只读） */
export interface TraeEnvironment {
  /** 授权页 host，例如 https://www.trae.cn */
  login_host: string;
  /** product.json 的 iCubeApp.authConfig.TRAE[quality] */
  client_id: string;
  /** state.vscdb 的 storage.serviceMachineId */
  machine_id: string;
  /** aha/TinyStorage 的 aha.device.device_id */
  device_id: string;
  app_version: string;
  plugin_version: string;
  device_brand?: string;
  device_type?: string;
  os_version?: string;
}

export interface TraeAddAccountOptions {
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  /** 显式注入设备身份（测试用）；缺省时从本机客户端只读取出 */
  environment?: TraeEnvironment | null;
  callbackPort?: number;
  appDir?: string;
  userDataDir?: string;
}

interface TraePending {
  login_trace_id: string;
  code_verifier: string;
  client_id: string;
  machine_id: string;
  device_id: string;
  app_version: string;
  plugin_version: string;
  device_brand?: string;
  device_type?: string;
  os_version?: string;
  port: number;
}

interface TraeCallback {
  auth_code: string;
  host: string | null;
  user_region: string | null;
  user_id: string | null;
  display_name: string | null;
}

// ---------- 本机设备身份（只读） ----------

/**
 * 默认安装目录 / 用户数据目录。
 *
 * 安装盘**不固定**（本机装在 D:\Program Files，而 ProgramFiles 环境变量指向 C:），
 * 所以按候选顺序找第一个真正带 `resources/app/product.json` 的安装根，找不到就用 ProgramFiles 兜底。
 */
export function defaultTraePaths(options: { appDir?: string; userDataDir?: string } = {}): { appDir: string; userDataDir: string } {
  const programFiles = process.env.ProgramFiles ?? 'C:\\Program Files';
  const appData = process.env.APPDATA ?? '';
  const userDataDir = options.userDataDir ?? join(appData, 'Trae CN');
  if (options.appDir) return { appDir: options.appDir, userDataDir };
  const candidates = [
    join(programFiles, 'Trae CN'),
    ...['C', 'D', 'E', 'F'].map(drive => join(`${drive}:\\Program Files`, 'Trae CN')),
    join(process.env.LOCALAPPDATA ?? '', 'Programs', 'Trae CN'),
  ];
  for (const root of candidates) {
    const appDir = join(root, 'resources', 'app');
    if (existsSync(join(appDir, 'product.json'))) return { appDir, userDataDir };
  }
  return { appDir: join(programFiles, 'Trae CN', 'resources', 'app'), userDataDir };
}

/**
 * 只读读取 Trae 加号所需的设备身份与客户端配置。
 * 任何一项读不到就返回 null（调用方报 TRAE_DEVICE_IDENTITY_UNAVAILABLE）——
 * **不自造**：自造的 device_id 会被服务端 20403/20405 拒，反而制造「看起来能加号」的假象。
 *
 * 来源（本机实测）：
 * - `resources/app/product.json` → `iCubeApp.authConfig.TRAE[quality]`（client_id）、
 *   `bootConfig.consoleHost`（授权页 host）、`version`、`tronBuildVersion`（plugin_version）；
 * - `%APPDATA%\Trae CN\User\globalStorage\state.vscdb` → `storage.serviceMachineId`（machine_id）；
 * - `%APPDATA%\Trae CN\aha\TinyStorage` → `tiny_storage_data["aha.device.device_id"]`（device_id）。
 */
export function readTraeEnvironment(options: { appDir?: string; userDataDir?: string } = {}): TraeEnvironment | null {
  const paths = defaultTraePaths(options);
  const productPath = join(paths.appDir, 'product.json');
  if (!existsSync(productPath)) return null;
  let product: Record<string, unknown>;
  try {
    product = asRecord(JSON.parse(readFileSync(productPath, 'utf8')));
  } catch {
    return null;
  }
  const iCubeApp = asRecord(product.iCubeApp);
  const authConfig = asRecord(iCubeApp.authConfig);
  const state = readTraeStateKeys(join(paths.userDataDir, 'User', 'globalStorage', 'state.vscdb'));
  const quality = str(state['sync.productQuality']) ?? 'stable';
  const client_id = str(asRecord(authConfig.TRAE)[quality]);
  const machine_id = str(state['storage.serviceMachineId']);
  const device_id = readTraeDeviceId(join(paths.userDataDir, 'aha', 'TinyStorage'));
  const consoleHost = str(asRecord(product.bootConfig).consoleHost) ?? str(product.consoleHost);
  const version = str(product.version);
  if (!client_id || !machine_id || !device_id || !consoleHost || !version) return null;
  return {
    login_host: consoleHost.replace(/\/+$/, ''),
    client_id,
    machine_id,
    device_id,
    app_version: version,
    plugin_version: str(product.tronBuildVersion) ?? 'local',
  };
}

/** state.vscdb 的 ItemTable 键值（只读打开；打不开就当没有） */
function readTraeStateKeys(vscdbPath: string): Record<string, string> {
  if (!existsSync(vscdbPath)) return {};
  let db: Database.Database | undefined;
  try {
    db = new Database(vscdbPath, { readonly: true, fileMustExist: true });
    const rows = db.prepare('SELECT key, value FROM ItemTable').all() as Array<{ key: string; value: string | null }>;
    const out: Record<string, string> = {};
    for (const row of rows) if (typeof row.value === 'string') out[row.key] = row.value;
    return out;
  } catch {
    return {};
  } finally {
    try { db?.close(); } catch { /* 关闭失败不影响结果 */ }
  }
}

/** aha/TinyStorage 的 aha.device.device_id（只读） */
function readTraeDeviceId(tinyStoragePath: string): string | null {
  if (!existsSync(tinyStoragePath)) return null;
  try {
    const parsed = asRecord(JSON.parse(readFileSync(tinyStoragePath, 'utf8')));
    return str(asRecord(parsed.tiny_storage_data)['aha.device.device_id']);
  } catch {
    return null;
  }
}

// ---------- 回调参数解析 ----------

/** 宽松解析回调 query：授权码可能藏在 authCodeInfo(JSON) / authCode / code 三处 */
export function parseTraeCallback(query: Record<string, string | string[] | undefined>): TraeCallback | null {
  const pick = (name: string): string | null => {
    const value = query[name];
    const first = Array.isArray(value) ? value[0] : value;
    return str(first);
  };
  let auth_code = pick('authCode') ?? pick('code');
  const infoRaw = pick('authCodeInfo');
  if (infoRaw) {
    try {
      const info = asRecord(JSON.parse(infoRaw));
      auth_code = auth_code ?? str(info.authCode) ?? str(info.code) ?? str(info.token);
    } catch {
      // authCodeInfo 不是 JSON：按原样当授权码再试一次
      auth_code = auth_code ?? infoRaw;
    }
  }
  if (!auth_code) return null;
  const userRaw = pick('userInfo');
  let user_id: string | null = null;
  let display_name: string | null = null;
  if (userRaw) {
    try {
      const user = asRecord(JSON.parse(userRaw));
      user_id = str(user.uid) ?? str(user.userId) ?? str(user.id);
      display_name = str(user.nickname) ?? str(user.name);
    } catch {
      user_id = null;
    }
  }
  return {
    auth_code,
    host: pick('host'),
    user_region: pick('userRegion'),
    user_id,
    display_name,
  };
}

/** 回调 host 白名单：只允许 Trae 自家域名，避免被任意 host 把 code 送到别处 */
export function traeHostAllowed(host: string): boolean {
  try {
    const url = new URL(host);
    if (url.protocol !== 'https:') return false;
    const hostname = url.hostname.toLowerCase();
    return hostname === 'trae.cn' || hostname.endsWith('.trae.cn') || hostname === 'trae.ai' || hostname.endsWith('.trae.ai');
  } catch {
    return false;
  }
}

// ---------- provider ----------

export function createTraeAddAccountProvider(options: TraeAddAccountOptions = {}): AddAccountProviderSpec {
  const fetchImpl = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const port = options.callbackPort ?? DEFAULT_TRAE_CALLBACK_PORT;
  const callbacks = new Map<string, TraeCallback>();
  let server: Server | null = null;

  async function ensureCallbackServer(): Promise<void> {
    if (server) return;
    server = createServer((req, res) => {
      // 授权页会做跨源探活：必须 200 + CORS，否则表现为「一直卡在认证中」
      const headers = {
        'access-control-allow-origin': '*',
        'access-control-allow-headers': '*',
        'access-control-allow-methods': 'GET,POST,OPTIONS',
        'content-type': 'text/plain; charset=utf-8',
      };
      if (req.method === 'OPTIONS') {
        res.writeHead(204, headers);
        res.end();
        return;
      }
      const url = new URL(req.url ?? '/', `http://127.0.0.1:${port}`);
      const query = Object.fromEntries(url.searchParams.entries());
      const trace = str(query.loginTraceID) ?? str(query.login_trace_id);
      if (trace) {
        const payload = parseTraeCallback(query);
        if (payload) callbacks.set(trace, payload);
      }
      res.writeHead(200, headers);
      res.end('ok');
    });
    await new Promise<void>((accept, reject) => {
      server!.once('error', reject);
      server!.listen(port, '127.0.0.1', () => accept());
    }).catch((error: unknown) => {
      server = null;
      throw new ApiError(503, 'TRAE_CALLBACK_PORT_UNAVAILABLE', `Trae 授权回调端口 ${port} 被占用（可能 Trae 客户端正在运行）`, { reason_code: 'TRAE_CALLBACK_PORT_UNAVAILABLE' });
    });
  }

  function closeCallbackServer(): void {
    if (!server) return;
    const current = server;
    server = null;
    try { current.close(); } catch { /* 关闭失败不影响结果 */ }
  }

  return {
    app_id: 'trae',
    protocol: 'trae_oauth',
    provider_version: 'acc-kb-b2s-v1',
    regions: ['cn'],
    async startAuthorization(_input: { region: AddAccountRegion }): Promise<AddAccountStart> {
      const env = options.environment !== undefined ? options.environment : readTraeEnvironment(options);
      if (!env) {
        throw new ApiError(503, 'TRAE_DEVICE_IDENTITY_UNAVAILABLE', '读不到本机 Trae 客户端的设备身份，Trae 加号不可用（ACC-KB-B6 设备身份裁决未落地）');
      }
      await ensureCallbackServer();
      // 源码：verifier = base64url(48B 随机)，challenge = base64url(sha256(verifier))
      const code_verifier = randomBytes(48).toString('base64url');
      const code_challenge = createHash('sha256').update(code_verifier).digest('base64url');
      const login_trace_id = randomUUID();
      const pending: TraePending = {
        login_trace_id,
        code_verifier,
        client_id: env.client_id,
        machine_id: env.machine_id,
        device_id: env.device_id,
        app_version: env.app_version,
        plugin_version: env.plugin_version,
        device_brand: env.device_brand,
        device_type: env.device_type,
        os_version: env.os_version,
        port,
      };
      const deviceParams = new URLSearchParams({
        x_device_id: env.device_id,
        x_machine_id: env.machine_id,
        x_device_brand: env.device_brand ?? '',
        x_device_type: env.device_type ?? '',
        x_os_version: env.os_version ?? '',
        x_app_version: env.app_version,
        x_app_type: 'trae',
        code_challenge,
        code_challenge_method: 'S256',
      });
      const params = new URLSearchParams({
        login_version: '1',
        auth_from: 'trae',
        login_channel: 'native_ide',
        plugin_version: env.plugin_version,
        auth_type: 'local',
        client_id: env.client_id,
        redirect: '0',
        login_trace_id,
        auth_callback_url: `http://127.0.0.1:${port}${TRAE_CALLBACK_PATH}`,
        machine_id: env.machine_id,
        device_id: env.device_id,
      });
      for (const [key, value] of deviceParams.entries()) params.append(key, value);
      return {
        authorization_url: `${env.login_host}/authorization?${params.toString()}`,
        user_code: null,
        expires_at: Date.now() + 300_000,
        pending_secret: encodePending(pending),
      };
    },
    async pollAuthorization(pendingSecret: Buffer): Promise<AddAccountPoll> {
      const pending = decodePending<TraePending>(pendingSecret);
      const callback = callbacks.get(pending.login_trace_id);
      if (!callback) return { status: 'pending' };
      const host = callback.host ?? '';
      if (!traeHostAllowed(host)) return { status: 'failed', safe_error_code: 'TRAE_CALLBACK_HOST_REJECTED' };
      const deviceInfo = {
        machine_id: pending.machine_id,
        device_id: pending.device_id,
        device_brand: pending.device_brand ?? '',
        device_type: pending.device_type ?? '',
        os_version: pending.os_version ?? '',
      };
      const outcome = await requestJson(fetchImpl, `${host.replace(/\/+$/, '')}/trae/api/v3/oauth/ExchangeToken`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify({
          ClientID: pending.client_id,
          AuthCode: callback.auth_code,
          CodeVerifier: pending.code_verifier,
          DeviceInfo: deviceInfo,
          IDEVersion: pending.app_version,
        }),
      }, timeoutMs);
      if (!outcome.ok) return { status: 'failed', safe_error_code: `TRAE_EXCHANGE_HTTP_${outcome.status}` };
      const data = asRecord(outcome.body);
      const token = str(data.token) ?? str(data.access_token) ?? str(data.jwt);
      if (!token) return { status: 'failed', safe_error_code: 'TRAE_TOKEN_INVALID' };
      const uid = callback.user_id;
      if (!uid) return { status: 'failed', safe_error_code: 'TRAE_IDENTITY_MISSING' };
      callbacks.delete(pending.login_trace_id);
      const normalized = token.replace(/^Cloud-IDE-JWT\s+/i, '');
      return { status: 'authorized', uid, display_name: callback.display_name, credential: Buffer.from(normalized, 'utf8') };
    },
    async dispose(pendingSecret: Buffer): Promise<void> {
      const pending = decodePending<TraePending>(pendingSecret);
      callbacks.delete(pending.login_trace_id);
      if (callbacks.size === 0) closeCallbackServer();
    },
  };
}
