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
import { execFile } from 'node:child_process';
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
  /** 已用百分比（0-100）；百分比类窗口才有，其余为 null */
  used_percent?: number | null;
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
  /** 注入命令执行（测试用；默认 execFile 包装，用于发现本地 opencode 服务端口） */
  execFileImpl?: (file: string, args: string[]) => Promise<string>;
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

/**
 * DeepSeek key 候选（ACC-QUOTA-03），按优先级：
 * 1. `DEEPSEEK_API_KEY`（env，用户显式配置，最高优先级）
 * 2. `~/.deepseek/config.toml` 的 `api_key`（DeepSeek CLI 的官方配置位）
 * 3. `~/.dsh/.credentials.yaml` 的 `refs.DEEPSEEK_API_KEY`（**最低优先级的兼容来源**：
 *    本机 DSH 把新 key 放在这里，而 `~/.deepseek/config.toml` 可能残留旧 key；
 *    该文件是别的工具的私有格式，不是官方约定，解析失败一律静默跳过）
 */
export type DeepseekKeySource = 'env' | 'deepseek_config' | 'dsh_credentials';

export interface DeepseekKeyCandidate {
  source: DeepseekKeySource;
  key: string;
}

/** 只读解析 `~/.dsh/.credentials.yaml` 的 `refs.DEEPSEEK_API_KEY`（不做完整 YAML 解析，失败返回 null） */
export function readDshCredentialsDeepseekKey(file: string): string | null {
  try {
    const text = readFileSync(file, 'utf8');
    const refsStart = /^refs:\s*$/m.exec(text);
    if (!refsStart) return null;
    const afterRefs = text.slice(refsStart.index + refsStart[0].length);
    const sectionMatch = /^\s{2}DEEPSEEK_API_KEY\s*:\s*["']?([^"'\r\n]+)["']?\s*$/m.exec(afterRefs);
    if (!sectionMatch) return null;
    // 只取 `refs:` 之后、下一个顶级键之前的部分，避免命中 `records:` 里的同名字段
    const nextTopLevel = /^[A-Za-z_][A-Za-z0-9_]*\s*:/m.exec(afterRefs);
    if (nextTopLevel && sectionMatch.index > nextTopLevel.index) return null;
    const value = sectionMatch[1]!.trim();
    return value.length > 0 ? value : null;
  } catch {
    return null;
  }
}

/** 收集 DeepSeek key 候选（不去重时按优先级去重） */
export function collectDeepseekKeyCandidates(homeDir: string, env: Record<string, string | undefined>): DeepseekKeyCandidate[] {
  const candidates: DeepseekKeyCandidate[] = [];
  const push = (source: DeepseekKeySource, value: string | null | undefined): void => {
    const key = typeof value === 'string' ? value.trim() : '';
    if (key.length === 0) return;
    if (candidates.some((item) => item.key === key)) return;
    candidates.push({ source, key });
  };
  push('env', env.DEEPSEEK_API_KEY);
  push('deepseek_config', readTomlString(join(homeDir, '.deepseek', 'config.toml'), 'api_key'));
  push('dsh_credentials', readDshCredentialsDeepseekKey(join(homeDir, '.dsh', '.credentials.yaml')));
  return candidates;
}

/** 兼容旧调用：返回最高优先级候选（不探测有效性；探测见 fetchDeepseek 的逐个试） */
export function resolveDeepseekKey(homeDir: string, env: Record<string, string | undefined>): string | null {
  return collectDeepseekKeyCandidates(homeDir, env)[0]?.key ?? null;
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

/** opencode 本地服务口令：`~/.config/opencode/service.json` 的 `password`（只读，不落日志） */
export function readOpencodeServicePassword(homeDir: string): string | null {
  try {
    const json = JSON.parse(readFileSync(join(homeDir, '.config', 'opencode', 'service.json'), 'utf8')) as { password?: unknown };
    return typeof json.password === 'string' && json.password.length > 0 ? json.password : null;
  } catch {
    return null;
  }
}

/** 从 `netstat -ano` 输出里取 LISTENING 的本地端口与 PID（导出于便于单测） */
export function parseNetstatListeners(output: string): Array<{ port: number; pid: number }> {
  const rows: Array<{ port: number; pid: number }> = [];
  for (const line of output.split(/\r?\n/)) {
    const match = /^\s*TCP\s+\S+:(\d+)\s+\S+\s+LISTENING\s+(\d+)\s*$/i.exec(line);
    if (match) rows.push({ port: Number(match[1]), pid: Number(match[2]) });
  }
  return rows;
}

/** 从 `tasklist /FO CSV` 输出里取 PID→进程名（导出于便于单测） */
export function parseTasklistPids(output: string): Map<number, string> {
  const map = new Map<number, string>();
  for (const line of output.split(/\r?\n/)) {
    const cells = line.split('","').map((cell) => cell.replace(/^"|"$/g, ''));
    if (cells.length < 2) continue;
    const pid = Number(cells[1]);
    if (Number.isFinite(pid)) map.set(pid, (cells[0] ?? '').toLowerCase());
  }
  return map;
}

/**
 * 发现本地 opencode 服务 URL：netstat LISTENING 端口 ∩ tasklist 里名字含 opencode 的 PID。
 * Windows 专用（本机部署环境）；其它平台或命令失败返回 null（调用方给 OPENCODE_SERVER_NOT_RUNNING）。
 */
export async function discoverOpencodeUrl(
  exec: (file: string, args: string[]) => Promise<string>,
): Promise<string | null> {
  try {
    const [netstat, tasklist] = await Promise.all([exec('netstat', ['-ano', '-p', 'tcp']), exec('tasklist', ['/FO', 'CSV', '/NH'])]);
    const pidNames = parseTasklistPids(tasklist);
    const candidates = parseNetstatListeners(netstat)
      .filter((row) => (pidNames.get(row.pid) ?? '').includes('opencode'))
      .map((row) => row.port);
    return candidates.length > 0 ? `http://127.0.0.1:${candidates[0]}` : null;
  } catch {
    return null;
  }
}

const OPENCODE_WINDOW_NAMES: Array<[key: 'rolling' | 'weekly' | 'monthly', label: string]> = [
  ['rolling', '5h'],
  ['weekly', 'weekly'],
  ['monthly', 'monthly'],
];

/**
 * 解析 `usage/limits` 响应（导出便于单测）：
 * `data.go.{rolling,weekly,monthly} = {percent, limited, resetsAt}` → 三窗口；`percent` 是已用百分比。
 */
export function parseOpencodeUsage(body: unknown, fetchedAt: number): QuotaResult {
  const record = (body && typeof body === 'object' ? body : {}) as { data?: { go?: Record<string, unknown>; workspace?: { name?: unknown } } };
  const go = record.data?.go;
  if (!go || typeof go !== 'object') {
    return empty('opencode_go', 'error', fetchedAt, 'UPSTREAM_SHAPE_UNEXPECTED', '本地 opencode 服务没有返回 OpenCode Go 用量');
  }
  const windows: QuotaWindow[] = [];
  let limited = false;
  for (const [key, label] of OPENCODE_WINDOW_NAMES) {
    const raw = (go as Record<string, unknown>)[key] as { percent?: unknown; limited?: unknown; resetsAt?: unknown } | undefined;
    if (!raw || typeof raw !== 'object') continue;
    const used = Number(raw.percent);
    if (!Number.isFinite(used)) continue;
    if (raw.limited === true) limited = true;
    windows.push({
      name: label,
      remaining: Math.max(0, Math.round((100 - used) * 10) / 10),
      used_percent: Math.min(100, Math.max(0, Math.round(used * 10) / 10)),
      reset_at: typeof raw.resetsAt === 'number' && Number.isFinite(raw.resetsAt) ? raw.resetsAt : null,
    });
  }
  if (windows.length === 0) {
    return empty('opencode_go', 'error', fetchedAt, 'UPSTREAM_SHAPE_UNEXPECTED', '本地 opencode 服务的用量结构不在预期内');
  }
  const workspaceName = typeof record.data?.workspace?.name === 'string' ? record.data.workspace.name : null;
  return {
    source: 'opencode_go',
    status: 'ok',
    balance: null,
    unit: '%',
    windows,
    fetched_at: fetchedAt,
    reason_code: null,
    detail: limited ? '已触发 OpenCode Go 限额，请求可能被降级到免费模型' : workspaceName ? `工作区：${workspaceName}` : null,
  };
}

/** Codex 是否有本机 ChatGPT 登录态（`~/.codex/auth.json` 且 auth_mode=chatgpt 且有 access_token） */export function hasCodexLogin(homeDir: string): boolean {
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
  const execFileImpl = options.execFileImpl ?? ((file: string, args: string[]) => new Promise<string>((resolve, reject) => {
    execFile(file, args, { windowsHide: true, timeout: 5_000, maxBuffer: 4 * 1024 * 1024, encoding: 'utf8' }, (error, stdout) => {
      if (error) reject(error); else resolve(String(stdout));
    });
  }));
  const now = options.now ?? (() => Date.now());
  const ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
  const maxBackoffMs = options.maxBackoffMs ?? DEFAULT_MAX_BACKOFF_MS;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const homeDir = options.homeDir ?? homedir();
  const env = options.env ?? process.env;

  const cache = new Map<QuotaSourceId, Cached>();
  const inFlight = new Map<QuotaSourceId, Promise<QuotaResult>>();

  /** 上次命中的 DeepSeek key 来源：命中后在同一缓存生命周期内复用，避免每次把 N 个候选全试一遍 */
  let deepseekSuccessSource: DeepseekKeySource | null = null;

  async function queryDeepseekBalance(key: string): Promise<{ kind: 'ok'; body: unknown } | { kind: 'status'; status: number } | { kind: 'network' }> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetchImpl(DEEPSEEK_BALANCE_URL, {
        headers: { Authorization: `Bearer ${key}`, Accept: 'application/json' },
        signal: controller.signal,
      });
      if (!response.ok) return { kind: 'status', status: response.status };
      let body: unknown = null;
      try { body = await response.json(); } catch { body = null; }
      return { kind: 'ok', body };
    } catch {
      return { kind: 'network' };
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * ACC-QUOTA-03：多候选 + 逐个试。
   * 优先级 env → `~/.deepseek/config.toml` → `~/.dsh/.credentials.yaml`；依次打余额端点，用第一个 200 的。
   * 已知成功来源优先排在前面（同一缓存生命周期内不再逐个试）。
   */
  async function fetchDeepseek(): Promise<QuotaResult> {
    const at = now();
    const candidates = collectDeepseekKeyCandidates(homeDir, env);
    if (candidates.length === 0) {
      return empty('deepseek', 'unsupported', at, 'CREDENTIAL_MISSING', '未检测到 DeepSeek API key（DEEPSEEK_API_KEY / ~/.deepseek/config.toml / ~/.dsh/.credentials.yaml）');
    }
    const ordered = deepseekSuccessSource === null
      ? candidates
      : [...candidates.filter((item) => item.source === deepseekSuccessSource), ...candidates.filter((item) => item.source !== deepseekSuccessSource)];

    let lastStatus: number | null = null;
    let networkFailure = false;
    for (const candidate of ordered) {
      const outcome = await queryDeepseekBalance(candidate.key);
      if (outcome.kind === 'ok') {
        deepseekSuccessSource = candidate.source;
        return parseDeepseekBalance(outcome.body, now());
      }
      if (outcome.kind === 'network') { networkFailure = true; continue; }
      lastStatus = outcome.status;
    }
    const fetchedAt = now();
    const tried = `（尝试过 ${ordered.length} 个凭据来源）`;
    if (networkFailure && lastStatus === null) {
      return empty('deepseek', 'error', fetchedAt, 'NETWORK_ERROR', `无法连接 DeepSeek（网络或超时）${tried}`);
    }
    if (lastStatus === 429) return empty('deepseek', 'error', fetchedAt, 'RATE_LIMITED', `DeepSeek 限流，稍后重试${tried}`);
    if (lastStatus !== null && lastStatus >= 500) {
      return empty('deepseek', 'error', fetchedAt, 'UPSTREAM_ERROR', `DeepSeek 服务暂时不可用${tried}`);
    }
    if (lastStatus === 401 || lastStatus === 403) {
      return empty('deepseek', 'error', fetchedAt, 'CREDENTIAL_INVALID', `DeepSeek API key 已失效，请更新后重试${tried}`);
    }
    if (networkFailure) return empty('deepseek', 'error', fetchedAt, 'NETWORK_ERROR', `无法连接 DeepSeek（网络或超时）${tried}`);
    return empty('deepseek', 'error', fetchedAt, 'UPSTREAM_REJECTED', `DeepSeek 拒绝了请求（HTTP ${lastStatus ?? 'unknown'}）${tried}`);
  }

  /**
   * ACC-QUOTA-02：OpenCode Go 额度窗口走**本地 opencode 服务**
   * `GET {url}/api/experimental/usage/limits`（Basic `opencode:<service.json password>`）。
   * 真实响应（2026-11-03 本机实测）：
   * `{location:{directory}, data:{workspace:{id,name,usageURL}, go:{rolling:{percent,limited,resetsAt},
   *   weekly:{...}, monthly:{...}}, budgets:[]}}`；`percent` = 已用百分比，`resetsAt` = 重置时刻。
   * 不新增凭据：复用本机 `~/.local/share/opencode/auth.json` 与 `~/.config/opencode/service.json`。
   */
  async function fetchOpencodeGo(): Promise<QuotaResult> {
    const at = now();
    if (!hasOpencodeGoKey(homeDir)) {
      return empty('opencode_go', 'unsupported', at, 'OPENCODE_NOT_LOGGED_IN', '本机未检测到 OpenCode Go 登录态（~/.local/share/opencode/auth.json）');
    }
    const password = readOpencodeServicePassword(homeDir);
    if (!password) {
      return empty('opencode_go', 'unsupported', at, 'OPENCODE_AUTH_UNAVAILABLE', '本机缺少 opencode 本地服务口令（~/.config/opencode/service.json）');
    }
    let serverUrl = env.OPENCODE_SERVER_URL?.trim() ?? '';
    if (serverUrl === '') {
      const discovered = await discoverOpencodeUrl(execFileImpl);
      if (!discovered) {
        return empty('opencode_go', 'unsupported', at, 'OPENCODE_SERVER_NOT_RUNNING', '未发现本地 opencode 服务（需在本机运行 opencode / opencode serve，或设置 OPENCODE_SERVER_URL）');
      }
      serverUrl = discovered;
    }
    const base = serverUrl.replace(/\/$/, '');
    const auth = `Basic ${Buffer.from(`opencode:${password}`).toString('base64')}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetchImpl(`${base}/api/experimental/usage/limits`, {
        headers: { Authorization: auth, Accept: 'application/json' },
        signal: controller.signal,
      });
      const fetchedAt = now();
      if (response.status === 401 || response.status === 403) {
        return empty('opencode_go', 'error', fetchedAt, 'OPENCODE_AUTH_FAILED', '本地 opencode 服务拒绝认证（service.json 口令可能已轮换）');
      }
      if (response.status === 404) {
        return empty('opencode_go', 'error', fetchedAt, 'OPENCODE_ROUTE_UNSUPPORTED', '本地 opencode 服务没有 usage 路由（版本过旧）');
      }
      if (response.status === 429) return empty('opencode_go', 'error', fetchedAt, 'RATE_LIMITED', '本地 opencode 服务限流，稍后重试');
      if (response.status >= 500) return empty('opencode_go', 'error', fetchedAt, 'UPSTREAM_ERROR', '本地 opencode 服务暂时不可用');
      if (!response.ok) return empty('opencode_go', 'error', fetchedAt, 'UPSTREAM_REJECTED', `本地 opencode 服务拒绝了请求（HTTP ${response.status}）`);
      let body: unknown = null;
      try { body = await response.json(); } catch { body = null; }
      return parseOpencodeUsage(body, fetchedAt);
    } catch {
      return empty('opencode_go', 'error', now(), 'NETWORK_ERROR', '无法连接本地 opencode 服务（网络或超时）');
    } finally {
      clearTimeout(timer);
    }
  }

  /** codex：只读本机痕迹，不请求第三方（无公开窗口端点） */
  async function inspectOnly(source: 'codex'): Promise<QuotaResult> {
    const at = now();
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
    if (source === 'opencode_go') return fetchOpencodeGo;
    return () => inspectOnly('codex');
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
