/**
 * ACC-QUOTA-01：账号页额度/余额来源聚合。
 *
 * 取证结论（2026-11-03，详见卡评论 bff272c2）：
 * - deepseek：`GET https://api.deepseek.com/user/balance`（Bearer），响应
 *   `{ is_available, balance_infos[{currency,total_balance,granted_balance,topped_up_balance}] }`
 *   → 唯一 supported 的来源；凭据取 `DEEPSEEK_API_KEY` 或 `~/.deepseek/config.toml` 的 `api_key`。
 * - opencode_go：OpenCode Go 只在 console 页面展示用量，无公开配额端点（本机探测 `/models`/`/usage`/`/me`/`/key` 全 404）
 *   → unsupported `NO_PUBLIC_QUOTA_ENDPOINT`，不请求任何第三方。
 * - codex：只有 ChatGPT OAuth 登录态（`~/.codex/auth.json`），`/backend-api/codex/usage` 与 `/rate_limits` 均 403，
 *   本地 sqlite/global-state 也没有额度窗口 → unsupported `NO_PUBLIC_QUOTA_ENDPOINT`，不请求任何第三方。
 *
 * 设计约束：
 * - 逐来源独立结果（单来源失败不影响其它来源）；
 * - 60s 缓存 + 失败指数退避（60s → 2× → … 上限 10min），同来源并发只发一次请求；
 * - 响应与日志不含 token / identity_hash / 文件路径（detail 里只写「已检测到/未检测到」）。
 */
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export type QuotaSourceId = 'deepseek' | 'opencode_go' | 'codex';
export type QuotaStatus = 'ok' | 'unsupported' | 'error';

export interface QuotaWindow {
  /** 窗口名，例如 `5h` / `weekly` / `monthly` */
  name: string;
  /** 剩余额度（与 balance 同单位） */
  remaining: number;
  /** 窗口重置时刻（epoch ms）；无窗口概念时为 null */
  reset_at: number | null;
}

export interface QuotaResult {
  source: QuotaSourceId;
  status: QuotaStatus;
  /** 余额/剩余额度；unsupported 或 error 时为 null */
  balance: number | null;
  /** 币种或单位：`CNY` / `USD` / null */
  unit: string | null;
  windows: QuotaWindow[];
  fetched_at: number;
  /** 机器码（前端负责中文文案；未知码进「技术码」） */
  reason_code: string | null;
  /** 服务端给出的中文短说明（不含 token/路径） */
  detail: string | null;
}

export interface QuotaSnapshot {
  items: QuotaResult[];
  fetched_at: number;
}

export interface QuotaService {
  get(): Promise<QuotaSnapshot>;
  /** 测试用：清空缓存与退避状态 */
  reset(): void;
}

export interface QuotaServiceOptions {
  /** 注入 fetch（测试用） */
  fetchImpl?: typeof fetch;
  /** 注入当前时间（测试用） */
  now?: () => number;
  /** 缓存 TTL，默认 60s */
  ttlMs?: number;
  /** 失败退避上限，默认 10min */
  maxBackoffMs?: number;
  /** 凭据根目录，默认 os.homedir()（测试用临时目录） */
  homeDir?: string;
  /** 注入 env（测试用） */
  env?: Record<string, string | undefined>;
  /** 单来源请求超时，默认 8s */
  timeoutMs?: number;
}

const DEEPSEEK_BALANCE_URL = 'https://api.deepseek.com/user/balance';
const DEFAULT_TTL_MS = 60_000;
const DEFAULT_MAX_BACKOFF_MS = 600_000;
const DEFAULT_TIMEOUT_MS = 8_000;

interface Cached {
  result: QuotaResult;
  expiresAt: number;
  failures: number;
}

/** 从 toml 里取顶层 `key = "value"`；取不到返回 null（不解析完整 toml） */
export function readTomlString(file: string, key: string): string | null {
  try {
    const text = readFileSync(file, 'utf8');
    const match = new RegExp(`^\\s*${key}\\s*=\\s*"([^"]+)"`, 'm').exec(text);
    return match ? match[1]! : null;
  } catch {
    return null;
  }
}

/** DeepSeek API key 来源：`DEEPSEEK_API_KEY` 优先，其次 `~/.deepseek/config.toml` 的 `api_key` */
export function resolveDeepseekKey(homeDir: string, env: Record<string, string | undefined>): string | null {
  const fromEnv = env.DEEPSEEK_API_KEY?.trim();
  if (fromEnv) return fromEnv;
  const fromFile = readTomlString(join(homeDir, '.deepseek', 'config.toml'), 'api_key');
  return fromFile && fromFile.trim().length > 0 ? fromFile.trim() : null;
}

/** OpenCode Go 是否有本机 API key（`~/.local/share/opencode/auth.json` 的 `opencode-go` 条目） */
export function hasOpencodeGoKey(homeDir: string): boolean {
  try {
    const json = JSON.parse(readFileSync(join(homeDir, '.local', 'share', 'opencode', 'auth.json'), 'utf8')) as Record<string, unknown>;
    const entry = json['opencode-go'] as { key?: unknown } | undefined;
    return typeof entry?.key === 'string' && entry.key.length > 0;
  } catch {
    return false;
  }
}

/** Codex 是否有本机 ChatGPT 登录态（`~/.codex/auth.json` 且 auth_mode=chatgpt 且有 access_token） */
export function hasCodexLogin(homeDir: string): boolean {
  try {
    const json = JSON.parse(readFileSync(join(homeDir, '.codex', 'auth.json'), 'utf8')) as {
      auth_mode?: unknown;
      tokens?: { access_token?: unknown };
    };
    return json.auth_mode === 'chatgpt' && typeof json.tokens?.access_token === 'string' && json.tokens.access_token.length > 0;
  } catch {
    return false;
  }
}

const empty = (source: QuotaSourceId, status: QuotaStatus, now: number, reason_code: string | null, detail: string | null): QuotaResult => ({
  source, status, balance: null, unit: null, windows: [], fetched_at: now, reason_code, detail,
});

/** 余额响应解析（导出便于单测）：取 `is_available` + 优先 CNY 的 balance_infos[0] */
export function parseDeepseekBalance(body: unknown, fetchedAt: number): QuotaResult {
  const record = (body && typeof body === 'object' ? body : {}) as {
    is_available?: unknown;
    balance_infos?: Array<{ currency?: unknown; total_balance?: unknown }>;
  };
  const infos = Array.isArray(record.balance_infos) ? record.balance_infos : [];
  const picked = infos.find((info) => String(info.currency ?? '').toUpperCase() === 'CNY') ?? infos[0];
  const balance = picked ? Number(picked.total_balance) : Number.NaN;
  if (!picked || !Number.isFinite(balance)) {
    return empty('deepseek', 'error', fetchedAt, 'UPSTREAM_SHAPE_UNEXPECTED', 'DeepSeek 返回的余额结构不在预期内');
  }
  return {
    source: 'deepseek',
    status: 'ok',
    balance,
    unit: String(picked.currency ?? '').toUpperCase() || null,
    windows: [],
    fetched_at: fetchedAt,
    reason_code: null,
    detail: record.is_available === false ? '余额不足，API 调用会失败' : null,
  };
}

export function createQuotaService(options: QuotaServiceOptions = {}): QuotaService {
  const fetchImpl = options.fetchImpl ?? ((...args: Parameters<typeof fetch>) => fetch(...args));
  const now = options.now ?? (() => Date.now());
  const ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
  const maxBackoffMs = options.maxBackoffMs ?? DEFAULT_MAX_BACKOFF_MS;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const homeDir = options.homeDir ?? homedir();
  const env = options.env ?? process.env;

  const cache = new Map<QuotaSourceId, Cached>();
  const inFlight = new Map<QuotaSourceId, Promise<QuotaResult>>();

  async function fetchDeepseek(): Promise<QuotaResult> {
    const at = now();
    const key = resolveDeepseekKey(homeDir, env);
    if (!key) return empty('deepseek', 'unsupported', at, 'NO_CREDENTIAL', '未检测到 DeepSeek API key（~/.deepseek/config.toml 或 DEEPSEEK_API_KEY）');
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetchImpl(DEEPSEEK_BALANCE_URL, {
        headers: { Authorization: `Bearer ${key}`, Accept: 'application/json' },
        signal: controller.signal,
      });
      const fetchedAt = now();
      if (response.status === 401 || response.status === 403) {
        return empty('deepseek', 'error', fetchedAt, 'CREDENTIAL_INVALID', 'DeepSeek API key 已失效，请更新后重试');
      }
      if (response.status === 429) return empty('deepseek', 'error', fetchedAt, 'RATE_LIMITED', 'DeepSeek 限流，稍后重试');
      if (response.status >= 500) return empty('deepseek', 'error', fetchedAt, 'UPSTREAM_ERROR', 'DeepSeek 服务暂时不可用');
      if (!response.ok) return empty('deepseek', 'error', fetchedAt, 'UPSTREAM_REJECTED', `DeepSeek 拒绝了请求（HTTP ${response.status}）`);
      let body: unknown = null;
      try { body = await response.json(); } catch { body = null; }
      return parseDeepseekBalance(body, fetchedAt);
    } catch {
      return empty('deepseek', 'error', now(), 'NETWORK_ERROR', '无法连接 DeepSeek（网络或超时）');
    } finally {
      clearTimeout(timer);
    }
  }

  /** opencode-go / codex：只读本机痕迹，不请求第三方（无公开配额端点） */
  async function inspectOnly(source: 'opencode_go' | 'codex'): Promise<QuotaResult> {
    const at = now();
    if (source === 'opencode_go') {
      const hasKey = hasOpencodeGoKey(homeDir);
      return empty(
        'opencode_go',
        'unsupported',
        at,
        'NO_PUBLIC_QUOTA_ENDPOINT',
        hasKey
          ? 'OpenCode Go 没有公开的配额接口（用量只在 console 页面查看），本机已检测到 API key'
          : 'OpenCode Go 没有公开的配额接口（用量只在 console 页面查看），本机未检测到 API key',
      );
    }
    const hasLogin = hasCodexLogin(homeDir);
    return empty(
      'codex',
      'unsupported',
      at,
      'NO_PUBLIC_QUOTA_ENDPOINT',
      hasLogin
        ? 'Codex 额度窗口没有公开接口（内部接口返回 403），本机 ChatGPT 登录态可用'
        : 'Codex 额度窗口没有公开接口（内部接口返回 403），本机未检测到登录态',
    );
  }

  function loaderFor(source: QuotaSourceId): () => Promise<QuotaResult> {
    if (source === 'deepseek') return fetchDeepseek;
    return () => inspectOnly(source);
  }

  async function load(source: QuotaSourceId): Promise<QuotaResult> {
    const cached = cache.get(source);
    if (cached && cached.expiresAt > now()) return cached.result;
    const running = inFlight.get(source);
    if (running) return running;
    const promise = (async () => {
      const loader = loaderFor(source);
      const result = await loader();
      const previous = cache.get(source);
      const failures = result.status === 'error' ? (previous?.failures ?? 0) + 1 : 0;
      const backoff = result.status === 'error'
        ? Math.min(ttlMs * 2 ** Math.max(0, failures - 1), maxBackoffMs)
        : ttlMs;
      cache.set(source, { result, expiresAt: now() + backoff, failures });
      return result;
    })();
    inFlight.set(source, promise);
    try {
      return await promise;
    } finally {
      inFlight.delete(source);
    }
  }

  return {
    async get(): Promise<QuotaSnapshot> {
      const sources: QuotaSourceId[] = ['deepseek', 'opencode_go', 'codex'];
      const items = await Promise.all(sources.map((source) => load(source)));
      return { items, fetched_at: now() };
    },
    reset() {
      cache.clear();
      inFlight.clear();
    },
  };
}
