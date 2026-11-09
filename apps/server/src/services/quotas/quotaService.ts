/**
 * ACC-QUOTA-01：账号页额度/余额来源聚合。
 *
 * 取证结论（2026-11-03，详见卡评论 bff272c2）：
 * - deepseek：`GET https://api.deepseek.com/user/balance`（Bearer），响应
 *   `{ is_available, balance_infos[{currency,total_balance,granted_balance,topped_up_balance}] }`
 *   → 余额来源；凭据取 `DEEPSEEK_API_KEY` 或 `~/.deepseek/config.toml` 的 `api_key`。
 * - opencode_go：Windows 从 OpenCode v2 的只读 credential SQLite 记录取得当前 active Console 凭据，直接读取官方 Go usage；
 *   其他平台保留本机 `/api/experimental/usage/limits` 路径。
 * - codex：只有 ChatGPT OAuth 登录态（`~/.codex/auth.json`），`/backend-api/codex/usage` 与 `/rate_limits` 均 403，
 *   本地 sqlite/global-state 也没有额度窗口 → unsupported `NO_PUBLIC_QUOTA_ENDPOINT`，不请求任何第三方。
 *
 * 设计约束：
 * - 逐来源独立结果（单来源失败不影响其它来源）；
 * - 60s 缓存 + 失败指数退避（60s → 2× → … 上限 10min），同来源并发只发一次请求；
 * - 响应与日志不含 token / identity_hash / 文件路径（detail 里只写「已检测到/未检测到」）。
 */
import { closeSync, existsSync, openSync, readFileSync, readSync, readdirSync, statSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import Database from 'better-sqlite3';
import { QUOTA_SOURCE_IDS } from '@agentboard/shared';
import { parseMinimaxCredits, parseQoderQuota, parseTraeUsage, parseWorkbuddyCredits, parseZcodeQuota } from './platformQuotaParsers.js';
import { traeQuotaUrl, workbuddyQuotaUrl } from '../accounts/platformHosts.js';
import type { AccountQuotaSourceId, PlatformQuotaCredential } from './platformQuotaCredentials.js';

// ACC-KB-A4：额度类型收敛到 packages/shared（此前 server 与 web 各抄一份字面量 union）。
// 这里 re-export 保持既有 import 路径可用（`accountQuotas.test.ts` 等仍从本模块取类型）。
import type { QuotaResult, QuotaSnapshot, QuotaSourceId, QuotaStatus, QuotaWindow } from '@agentboard/shared';
export type { QuotaResult, QuotaSnapshot, QuotaSourceId, QuotaStatus, QuotaWindow };

type ExecFileRunnerOptions = { input?: string; timeoutMs?: number };

export interface QuotaService {
  get(account?: { accountId: string; source: AccountQuotaSourceId | 'commandcode' }): Promise<QuotaSnapshot>;
  /** 测试用：清空缓存与退避状态 */
  reset(): void;
}

export interface QuotaServiceOptions {
  /** 注入 fetch（测试用） */
  fetchImpl?: typeof fetch;
  /** 注入当前时间（测试用） */
  now?: () => number;
  /** 运行平台（测试用；默认 process.platform） */
  platform?: NodeJS.Platform;
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
  /** 注入命令执行（测试用；默认 execFile 包装，用于服务发现及 Windows 只读额度请求） */
  execFileImpl?: (file: string, args: string[], options?: ExecFileRunnerOptions) => Promise<string>;
  /** ACC-CODEX-QUOTA-IMPL：注入 Codex 扫描（测试用；默认读 ~/.codex/sessions 最新 rollout） */
  codexScan?: () => Promise<QuotaResult>;
  /**
   * ACC-KB-B5S：平台账号侧五个来源（workbuddy / minimax / trae / qoder_cn / zcode）的凭据。
   * 缺省或值为 null → 该来源如实返回 `unsupported` + `NO_CREDENTIAL`，绝不编造额度。
   */
  platformTokens?: Partial<Record<QuotaSourceId, string | null>>;
  /**
   * ACC-QUOTA-ALL：平台凭据解析器（fetch 时调用，可感知凭据导入/轮换；优先于 `platformTokens`）。
   * 实现：`platformQuotaCredentials.resolvePlatformQuotaCredential`（中心库签到凭据 / zcode 本机文件）。
   * 解析器自身不抛错；这里对意外抛错兜底成 `CREDENTIAL_UNAVAILABLE`。
   */
  platformCredential?: (source: QuotaSourceId, accountId?: string) => Promise<PlatformQuotaCredential>;
  /** Command Code CLI 凭据按 cli_account id 精确读取；不参与平台凭据选择。 */
  commandCodeCredential?: (accountId: string) => Promise<PlatformQuotaCredential>;
}

const DEEPSEEK_BALANCE_URL = 'https://api.deepseek.com/user/balance';
/** ACC-QUOTA-ALL：平台额度端点（知识 `3c21b76c` §1 矩阵；trae/workbuddy 走 platformHosts 单一事实源） */
const MINIMAX_QUOTA_URL = 'https://agent.minimaxi.com/matrix/api/v1/commerce/get_membership_info';
const QODER_QUOTA_URL = 'https://openapi.qoder.com.cn/api/v2/quota/usage';
const ZCODE_QUOTA_URL = 'https://bigmodel.cn/api/monitor/usage/quota/limit';
const COMMAND_CODE_API_BASE = 'https://api.commandcode.ai';
/** 平台请求超时：对齐 httpCheckinProviders 的 15s 口径（平台网络质量差于本地 CLI） */
const PLATFORM_TIMEOUT_MS = 15_000;
const PLATFORM_LABEL: Partial<Record<QuotaSourceId, string>> = {
  workbuddy: 'WorkBuddy', minimax: 'MiniMax', trae: 'Trae', qoder_cn: 'Qoder', zcode: 'ZCode',
};
const DEFAULT_TTL_MS = 60_000;
const DEFAULT_MAX_BACKOFF_MS = 600_000;
const DEFAULT_TIMEOUT_MS = 8_000;
const OPENCODE_GO_TIMEOUT_MS = 12_000;
const OPENCODE_GO_USAGE_URL = 'https://opencode.ai/zen/go/v1/usage';
const PLATFORM_GET_POWERSHELL_SCRIPT = String.raw`$ErrorActionPreference = 'Stop'
[void][Reflection.Assembly]::LoadWithPartialName('System.Net.Http')
$inputData = [Console]::In.ReadToEnd() | ConvertFrom-Json
$handler = [System.Net.Http.HttpClientHandler]::new()
$handler.UseProxy = $true
$handler.AllowAutoRedirect = $false
$client = [System.Net.Http.HttpClient]::new($handler)
$client.Timeout = [TimeSpan]::FromMilliseconds([double]$inputData.timeoutMs)
$request = [System.Net.Http.HttpRequestMessage]::new([System.Net.Http.HttpMethod]::Get, [string]$inputData.url)
$request.Headers.Authorization = [System.Net.Http.Headers.AuthenticationHeaderValue]::new('Bearer', [string]$inputData.token)
if (![string]::IsNullOrWhiteSpace([string]$inputData.orgHeaderName) -and ![string]::IsNullOrWhiteSpace([string]$inputData.orgHeaderValue)) {
  $request.Headers.Add([string]$inputData.orgHeaderName, [string]$inputData.orgHeaderValue)
}
$request.Headers.Accept.Add([System.Net.Http.Headers.MediaTypeWithQualityHeaderValue]::new('application/json'))
$response = $null
try {
  $response = $client.SendAsync($request).GetAwaiter().GetResult()
  $result = @{ status = [int]$response.StatusCode }
  if ([int]$response.StatusCode -eq 200) { $result.body = $response.Content.ReadAsStringAsync().GetAwaiter().GetResult() }
  $result | ConvertTo-Json -Compress -Depth 4
} catch {
  $exception = $_.Exception
  $cause = $exception.GetType().Name
  while ($null -ne $exception.InnerException) {
    $exception = $exception.InnerException
    if ($exception -is [System.Net.Sockets.SocketException]) { $cause = [string]$exception.SocketErrorCode; break }
  }
  @{ status = $null; error = $cause } | ConvertTo-Json -Compress
} finally {
  if ($null -ne $response) { $response.Dispose() }
  $request.Dispose()
  $client.Dispose()
}`;

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

type OpenCodeCredentialLookup =
  | { kind: 'ok'; token: string; orgId: string; workspaceName: string | null }
  | { kind: 'missing' }
  | { kind: 'workspace_missing' }
  | { kind: 'unavailable' };

function opencodeDatabasePath(homeDir: string, env: Record<string, string | undefined>): string {
  const dataDir = join(env.XDG_DATA_HOME || join(homeDir, '.local', 'share'), 'opencode');
  const configured = env.OPENCODE_DB?.trim();
  if (!configured) return join(dataDir, 'opencode.db');
  return isAbsolute(configured) ? configured : join(dataDir, configured);
}

/** 只读当前 OpenCode integration 的 active credential；顺序与 v2.2.5 active connection 一致。 */
function readOpencodeGoCredential(
  homeDir: string,
  env: Record<string, string | undefined>,
): OpenCodeCredentialLookup {
  const filename = opencodeDatabasePath(homeDir, env);
  if (!existsSync(filename)) return { kind: 'missing' };
  let db: Database.Database | undefined;
  try {
    db = new Database(filename, { readonly: true, fileMustExist: true, timeout: 1_000 });
    const row = db.prepare(
      'SELECT value FROM credential WHERE integration_id = ? ORDER BY active DESC, time_created DESC, id DESC LIMIT 1',
    ).get('opencode') as { value?: unknown } | undefined;
    if (!row || typeof row.value !== 'string') return { kind: 'missing' };
    const value = JSON.parse(row.value) as {
      type?: unknown;
      key?: unknown;
      access?: unknown;
      metadata?: { orgID?: unknown; orgName?: unknown; server?: unknown };
    };
    if (value.type !== 'key' && value.type !== 'oauth') return { kind: 'unavailable' };
    const token = value.type === 'oauth' ? value.access : value.key;
    if (typeof token !== 'string' || token.length === 0) return { kind: 'unavailable' };
    const metadata = value.metadata;
    if (typeof metadata?.orgID !== 'string' || metadata.orgID.length === 0) return { kind: 'workspace_missing' };
    let server = typeof metadata.server === 'string' ? metadata.server : 'https://opencode.ai/console';
    server = server.replace(/^https:\/\/console\.opencode\.ai(?=\/|$)/, 'https://opencode.ai/console');
    const parsedServer = new URL(server);
    if (parsedServer.protocol !== 'https:' || parsedServer.port !== '' || parsedServer.username || parsedServer.password ||
      (parsedServer.hostname !== 'opencode.ai' && parsedServer.hostname !== 'console.opencode.ai')) {
      return { kind: 'unavailable' };
    }
    return {
      kind: 'ok',
      token,
      orgId: metadata.orgID,
      workspaceName: typeof metadata.orgName === 'string' ? metadata.orgName : null,
    };
  } catch {
    return { kind: 'unavailable' };
  } finally {
    db?.close();
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

/** 解析官方 Go usage 响应；resetsAt 是 ISO 字符串，转换规则与 OpenCode DateFromString.getTime() 一致。 */
function parseOpencodeGoUsage(body: unknown, fetchedAt: number, workspaceName?: string): QuotaResult {
  const root = (body && typeof body === 'object' ? body : {}) as { usage?: Record<string, unknown> };
  const usage = root.usage;
  if (!usage || typeof usage !== 'object') {
    return empty('opencode_go', 'error', fetchedAt, 'UPSTREAM_SHAPE_UNEXPECTED', 'OpenCode Go 没有返回额度窗口');
  }
  const go: Record<string, { percent: number; limited: boolean; resetsAt: number }> = {};
  for (const [key] of OPENCODE_WINDOW_NAMES) {
    const meter = usage[key] as { status?: unknown; percent?: unknown; resetsAt?: unknown } | undefined;
    if (!meter || typeof meter !== 'object' || (meter.status !== 'ok' && meter.status !== 'rate-limited') ||
      typeof meter.percent !== 'number' || !Number.isFinite(meter.percent) || typeof meter.resetsAt !== 'string') {
      return empty('opencode_go', 'error', fetchedAt, 'UPSTREAM_SHAPE_UNEXPECTED', 'OpenCode Go 的额度窗口结构异常');
    }
    const resetsAt = Date.parse(meter.resetsAt);
    if (!Number.isFinite(resetsAt)) {
      return empty('opencode_go', 'error', fetchedAt, 'UPSTREAM_SHAPE_UNEXPECTED', 'OpenCode Go 的额度重置时间无效');
    }
    go[key] = { percent: meter.percent, limited: meter.status === 'rate-limited', resetsAt };
  }
  return parseOpencodeUsage({ data: { go, workspace: { name: workspaceName } } }, fetchedAt);
}

/** Codex 窗口分钟数 → 我们的窗口名（用户要求只展示 5h 与 weekly，不显示 Monthly） */
export const CODEX_WINDOW_MINUTES: Record<number, '5h' | 'weekly'> = { 300: '5h', 10080: 'weekly' };

/**
 * 解析 rollout 里的一条 `payload.rate_limits`（导出便于单测）：
 * `primary{used_percent, window_minutes, resets_at}`、`secondary{…}`、`credits.balance`、`plan_type`。
 * - 只保留 `window_minutes` ∈ {300, 10080} 的窗口（300 → 5h，10080 → weekly）；
 * - `resets_at` 是**秒**级 epoch → ×1000 转毫秒；
 * - `credits.balance` 为字符串金额，0 时 `detail` 给「额度内」（避免被误读成欠费）。
 */
export function parseCodexRateLimits(raw: unknown, fetchedAt: number): QuotaResult {
  const limits = (raw && typeof raw === 'object' ? raw : null) as {
    primary?: { used_percent?: unknown; window_minutes?: unknown; resets_at?: unknown };
    secondary?: { used_percent?: unknown; window_minutes?: unknown; resets_at?: unknown };
    credits?: { balance?: unknown; has_credits?: unknown; unlimited?: unknown };
    plan_type?: unknown;
  } | null;
  if (!limits) return empty('codex', 'unsupported', fetchedAt, 'NO_CODEX_RATE_LIMITS', '本机 Codex 会话里没有额度快照（rate_limits）');
  const windows: QuotaWindow[] = [];
  for (const slot of [limits.primary, limits.secondary]) {
    if (!slot || typeof slot !== 'object') continue;
    const minutes = Number(slot.window_minutes);
    const name = CODEX_WINDOW_MINUTES[minutes];
    if (!name) continue;
    const used = Number(slot.used_percent);
    if (!Number.isFinite(used)) continue;
    const resetsAt = Number(slot.resets_at);
    windows.push({
      name,
      remaining: Math.max(0, Math.round((100 - used) * 10) / 10),
      used_percent: Math.min(100, Math.max(0, Math.round(used * 10) / 10)),
      reset_at: Number.isFinite(resetsAt) ? resetsAt * 1000 : null,
    });
  }
  if (windows.length === 0) {
    return empty('codex', 'unsupported', fetchedAt, 'NO_CODEX_RATE_LIMITS', '本机 Codex 会话里没有可用的 5 小时/周窗口');
  }
  // 展示顺序固定 5h → weekly
  windows.sort((a, b) => (a.name === '5h' ? -1 : 1) - (b.name === '5h' ? -1 : 1));
  const balanceRaw = limits.credits?.balance;
  const balance = typeof balanceRaw === 'string' && balanceRaw.trim() !== '' && Number.isFinite(Number(balanceRaw)) ? Number(balanceRaw) : null;
  const plan = typeof limits.plan_type === 'string' && limits.plan_type.length > 0 ? limits.plan_type : null;
  const zeroBalance = balance !== null && balance === 0;
  return {
    source: 'codex',
    status: 'ok',
    balance,
    unit: balance === null ? null : 'USD',
    windows,
    fetched_at: fetchedAt,
    reason_code: null,
    detail: zeroBalance ? '额度内' : plan ? `套餐：${plan}` : null,
  };
}

/** 找 `~/.codex/sessions` 下 mtime 最新的 rollout 文件（按年月日目录倒序 + 目录内按 mtime 倒序，命中第一条即返回） */
export function findLatestCodexRollout(sessionsRoot: string): { file: string; mtime: number } | null {
  const listDirs = (dir: string): string[] => {
    try {
      return readdirSync(dir, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort().reverse();
    } catch {
      return [];
    }
  };
  const listRollouts = (dir: string): Array<{ file: string; mtime: number }> => {
    try {
      return readdirSync(dir, { withFileTypes: true })
        .filter((entry) => entry.isFile() && entry.name.endsWith('.jsonl'))
        .map((entry) => {
          const file = join(dir, entry.name);
          try { return { file, mtime: statSync(file).mtimeMs }; } catch { return null; }
        })
        .filter((item): item is { file: string; mtime: number } => item !== null)
        .sort((a, b) => b.mtime - a.mtime);
    } catch {
      return [];
    }
  };
  let best: { file: string; mtime: number } | null = null;
  // 目录层级：sessions/YYYY/MM/DD/*.jsonl（也兼容直接放文件的扁平结构）
  const direct = listRollouts(sessionsRoot);
  if (direct.length > 0) best = direct[0]!;
  for (const year of listDirs(sessionsRoot)) {
    for (const month of listDirs(join(sessionsRoot, year))) {
      for (const day of listDirs(join(sessionsRoot, year, month))) {
        const files = listRollouts(join(sessionsRoot, year, month, day));
        if (files.length > 0 && (best === null || files[0]!.mtime > best.mtime)) best = files[0]!;
      }
    }
  }
  return best;
}

/** 从 rollout 文件尾部找最后一条含 `rate_limits` 的行并返回该对象（只读，不解析其它内容） */
export function readLatestRateLimits(file: string, maxTailBytes = 512 * 1024): unknown | null {
  let fd: number | null = null;
  try {
    const size = statSync(file).size;
    const start = Math.max(0, size - maxTailBytes);
    fd = openSync(file, 'r');
    const buffer = Buffer.alloc(Math.min(size, maxTailBytes));
    readSync(fd, buffer, 0, buffer.length, start);
    const lines = buffer.toString('utf8').split('\n');
    for (let index = lines.length - 1; index >= 0; index -= 1) {
      const line = lines[index]!.trim();
      if (!line.includes('"rate_limits"')) continue;
      try {
        const parsed = JSON.parse(line) as { payload?: { rate_limits?: unknown } };
        const limits = parsed.payload?.rate_limits ?? null;
        if (limits) return limits;
      } catch {
        continue;
      }
    }
    return null;
  } catch {
    return null;
  } finally {
    if (fd !== null) { try { closeSync(fd); } catch { /* noop */ } }
  }
}

/** 扫描本机 Codex 会话并产出额度结果（文件/字段缺失都给可解释的 unsupported） */
export function scanCodexRollout(homeDir: string, nowFn: () => number): Promise<QuotaResult> {
  const fetchedAt = nowFn();
  const sessionsRoot = join(homeDir, '.codex', 'sessions');
  if (!existsSync(sessionsRoot)) {
    return Promise.resolve(empty('codex', 'unsupported', fetchedAt, 'NO_CODEX_SESSIONS', '未发现本机 Codex 会话记录（~/.codex/sessions 不存在）'));
  }
  const latest = findLatestCodexRollout(sessionsRoot);
  if (latest === null) {
    return Promise.resolve(empty('codex', 'unsupported', fetchedAt, 'NO_CODEX_SESSIONS', '未发现本机 Codex 会话记录（sessions 目录下没有 rollout 文件）'));
  }
  const limits = readLatestRateLimits(latest.file);
  if (limits === null) {
    return Promise.resolve(empty('codex', 'unsupported', fetchedAt, 'NO_CODEX_RATE_LIMITS', '本机 Codex 会话里没有额度快照（该会话未返回 rate_limits）'));
  }
  return Promise.resolve(parseCodexRateLimits(limits, fetchedAt));
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

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function commandCodeWindows(value: unknown): QuotaWindow[] | null {
  if (!isPlainRecord(value)) return null;
  const definitions = [
    { key: 'fiveHour', name: '5h', kind: 'rolling' as const },
    { key: 'weekly', name: 'weekly', kind: 'weekly' as const },
  ];
  const result: QuotaWindow[] = [];
  for (const definition of definitions) {
    const window = value[definition.key];
    if (!isPlainRecord(window)) return null;
    const { used, cap, resetAt } = window;
    if (typeof used !== 'number' || !Number.isFinite(used) || used < 0
      || typeof cap !== 'number' || !Number.isFinite(cap) || cap < 0
      || typeof resetAt !== 'number' || !Number.isFinite(resetAt) || resetAt < 0) return null;
    result.push({
      name: definition.name,
      kind: definition.kind,
      used,
      total: cap,
      remaining: Math.max(0, cap - used),
      used_percent: cap > 0 ? Math.min(100, used / cap * 100) : null,
      reset_at: resetAt === 0 ? null : resetAt,
    });
  }
  return result;
}

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
  const injectedFetch = options.fetchImpl;
  const fetchImpl = options.fetchImpl ?? ((...args: Parameters<typeof fetch>) => fetch(...args));
  const execFileImpl = options.execFileImpl ?? ((file: string, args: string[], runnerOptions?: ExecFileRunnerOptions) =>
    new Promise<string>((resolve, reject) => {
      const child = execFile(file, args, {
        windowsHide: true,
        timeout: runnerOptions?.timeoutMs ?? 5_000,
        maxBuffer: 4 * 1024 * 1024,
        encoding: 'utf8',
      }, (error, stdout) => {
        if (error) reject(error); else resolve(String(stdout));
      });
      child.stdin?.on('error', () => {});
      child.stdin?.end(runnerOptions?.input);
    }));
  const now = options.now ?? (() => Date.now());
  const ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
  const maxBackoffMs = options.maxBackoffMs ?? DEFAULT_MAX_BACKOFF_MS;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const homeDir = options.homeDir ?? homedir();
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;

  type ReadOnlyGetResult =
    | { kind: 'ok'; body: unknown }
    | { kind: 'status'; status: number }
    | { kind: 'shape' }
    | { kind: 'network' };

  /** 只读 Bearer GET：测试走注入 fetch；Windows 生产走系统代理 .NET，并仅经 stdin 传凭据。 */
  async function readOnlyGetJson(
    url: string,
    token: string,
    requestTimeoutMs: number,
    orgHeader?: { name: string; value: string },
  ): Promise<ReadOnlyGetResult> {
    if (injectedFetch || platform !== 'win32') {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), requestTimeoutMs);
      try {
        const response = await fetchImpl(url, {
          method: 'GET',
          headers: {
            authorization: `Bearer ${token}`,
            accept: 'application/json',
            ...(orgHeader ? { [orgHeader.name]: orgHeader.value } : {}),
          },
          redirect: 'error',
          signal: controller.signal,
        });
        if (!response.ok) return { kind: 'status', status: response.status };
        try {
          return { kind: 'ok', body: await response.json() };
        } catch {
          return { kind: 'shape' };
        }
      } catch {
        return { kind: 'network' };
      } finally {
        clearTimeout(timer);
      }
    }

    try {
      const output = await execFileImpl('powershell.exe', [
        '-NoLogo', '-NoProfile', '-NonInteractive', '-Command', PLATFORM_GET_POWERSHELL_SCRIPT,
      ], {
        input: JSON.stringify({
          url,
          token,
          orgHeaderName: orgHeader?.name,
          orgHeaderValue: orgHeader?.value,
          timeoutMs: requestTimeoutMs,
        }),
        timeoutMs: requestTimeoutMs,
      });
      let response: { status?: unknown; body?: unknown };
      try {
        response = JSON.parse(output) as typeof response;
      } catch {
        return { kind: 'shape' };
      }
      if (typeof response.status !== 'number') return { kind: 'network' };
      if (response.status !== 200) return { kind: 'status', status: response.status };
      if (typeof response.body !== 'string') return { kind: 'shape' };
      try {
        return { kind: 'ok', body: JSON.parse(response.body) as unknown };
      } catch {
        return { kind: 'shape' };
      }
    } catch {
      return { kind: 'network' };
    }
  }

  const cache = new Map<string, Cached>();
  const inFlight = new Map<string, Promise<QuotaResult>>();
  let cacheGeneration = 0;

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

  /** Windows 显式本机服务配置优先；否则优先官方 Console credential，读取不可用时保留本机路径。 */
  async function fetchOpencodeGo(): Promise<QuotaResult> {
    const at = now();
    if (platform === 'win32' && !env.OPENCODE_SERVER_URL?.trim()) {
      const credential = readOpencodeGoCredential(homeDir, env);
      if (credential.kind === 'ok') return fetchOpencodeGoDirect(credential);
    }
    return fetchOpencodeGoLocal(at);
  }

  async function fetchOpencodeGoLocal(at: number): Promise<QuotaResult> {
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

  async function fetchOpencodeGoDirect(credential: Extract<OpenCodeCredentialLookup, { kind: 'ok' }>): Promise<QuotaResult> {
    const result = await readOnlyGetJson(OPENCODE_GO_USAGE_URL, credential.token, OPENCODE_GO_TIMEOUT_MS, {
      name: 'x-opencode-org-id',
      value: credential.orgId,
    });
    const at = now();
    if (result.kind === 'network') return empty('opencode_go', 'error', at, 'NETWORK_ERROR', '无法连接 OpenCode Go 额度服务（网络或超时）');
    if (result.kind === 'shape') return empty('opencode_go', 'error', at, 'UPSTREAM_SHAPE_UNEXPECTED', 'OpenCode Go 请求结果结构异常');
    if (result.kind === 'status') {
      if (result.status === 401) return empty('opencode_go', 'error', at, 'OPENCODE_AUTH_FAILED', 'OpenCode Console 凭据已失效，请在客户端恢复登录后重试');
      if (result.status === 403) return empty('opencode_go', 'unsupported', at, 'OPENCODE_NO_ALLOWANCE', '当前 OpenCode 工作区没有 Go 额度');
      if (result.status === 429) return empty('opencode_go', 'error', at, 'RATE_LIMITED', 'OpenCode Go 额度服务限流，稍后重试');
      if (result.status >= 500) return empty('opencode_go', 'error', at, 'UPSTREAM_ERROR', 'OpenCode Go 额度服务暂时不可用');
      return empty('opencode_go', 'error', at, 'UPSTREAM_REJECTED', `OpenCode Go 额度服务拒绝了请求（HTTP ${result.status}）`);
    }
    return parseOpencodeGoUsage(result.body, at, credential.workspaceName ?? undefined);
  }

  /**
   * ACC-CODEX-QUOTA-IMPL：Codex 额度走**本地 rollout 快照**（零网络、零凭据）。
   * 读 `~/.codex/sessions/<YYYY>/<MM>/<DD>/rollout-*.jsonl` 里 mtime 最新的一份，取 `event_msg -> payload.rate_limits`：
   * `primary{used_percent, window_minutes, resets_at}` / `secondary{…}` / `credits.balance` / `plan_type`。
   * 只映射 `window_minutes=300 → 5h`、`10080 → weekly`（用户要求不显示 Monthly）；不读 token 原文。
   */
  async function fetchCodexFromRollout(): Promise<QuotaResult> {
    const scan = options.codexScan ?? (() => scanCodexRollout(homeDir, now));
    return scan();
  }

  /** Command Code /usage 的最小只读路径：whoami 取 org.id，再取余额和窗口。 */
  async function fetchCommandCode(accountId?: string): Promise<QuotaResult> {
    if (!accountId) return empty('commandcode', 'unsupported', now(), 'ACCOUNT_ID_REQUIRED', 'Command Code 额度需要指定账号');
    let credential: PlatformQuotaCredential;
    try {
      credential = options.commandCodeCredential
        ? await options.commandCodeCredential(accountId)
        : { kind: 'missing', reasonCode: 'CREDENTIAL_MISSING', detail: '未检测到该账号的额度凭据，请重新导入 API Key' };
    } catch {
      return empty('commandcode', 'error', now(), 'CREDENTIAL_UNAVAILABLE', '额度凭据解析失败，请稍后重试');
    }
    if (credential.kind === 'missing') {
      const status: QuotaStatus = credential.reasonCode === 'CREDENTIAL_MISSING' ? 'unsupported' : 'error';
      return empty('commandcode', status, now(), credential.reasonCode, credential.detail);
    }

    const requestJson = async (url: string): Promise<{ body: Record<string, unknown> | null; failure: QuotaResult | null }> => {
      const result = await readOnlyGetJson(url, credential.token, PLATFORM_TIMEOUT_MS);
      if (result.kind === 'network') {
        return { body: null, failure: empty('commandcode', 'error', now(), 'NETWORK_ERROR', 'Command Code 额度接口网络不可用或超时') };
      }
      if (result.kind === 'shape' || (result.kind === 'ok' && !isPlainRecord(result.body))) {
        return { body: null, failure: empty('commandcode', 'error', now(), 'UPSTREAM_SHAPE_UNEXPECTED', 'Command Code 额度接口返回的数据结构不符合预期') };
      }
      if (result.kind === 'status') {
        const code = result.status === 401 ? 'CREDENTIAL_INVALID'
          : result.status === 403 ? 'NO_ALLOWANCE'
            : result.status === 429 ? 'RATE_LIMITED' : 'UPSTREAM_ERROR';
        const detail = result.status === 403 ? 'Command Code 账号没有可读取的额度权限'
          : result.status === 401 ? 'Command Code API Key 已失效，请重新导入'
            : `Command Code 额度接口返回 ${result.status}`;
        return { body: null, failure: empty('commandcode', 'error', now(), code, detail) };
      }
      return { body: result.body as Record<string, unknown>, failure: null };
    };

    const whoami = await requestJson(`${COMMAND_CODE_API_BASE}/alpha/whoami?limits=1`);
    if (whoami.failure) return whoami.failure;
    const org = isPlainRecord(whoami.body?.org) ? whoami.body.org : null;
    const orgId = typeof org?.id === 'string' || typeof org?.id === 'number' ? String(org.id) : null;
    const creditsUrl = new URL('/alpha/billing/credits', COMMAND_CODE_API_BASE);
    if (orgId) creditsUrl.searchParams.set('orgId', orgId);
    const creditsResponse = await requestJson(creditsUrl.toString());
    if (creditsResponse.failure) return creditsResponse.failure;
    const creditEnvelope = isPlainRecord(creditsResponse.body?.credits) ? creditsResponse.body.credits : null;
    const credits = isPlainRecord(creditEnvelope?.credits) ? creditEnvelope.credits : null;
    const monthly = credits?.monthlyCredits;
    const purchased = credits?.purchasedCredits;
    const free = credits?.freeCredits;
    if (typeof monthly !== 'number' || !Number.isFinite(monthly)
      || typeof purchased !== 'number' || !Number.isFinite(purchased)
      || typeof free !== 'number' || !Number.isFinite(free)) {
      return empty('commandcode', 'error', now(), 'UPSTREAM_SHAPE_UNEXPECTED', 'Command Code credits 字段缺失或无效');
    }
    const windows = commandCodeWindows(creditEnvelope?.windowLimits)
      ?? commandCodeWindows(whoami.body?.windowLimits);
    if (!windows) return empty('commandcode', 'error', now(), 'UPSTREAM_SHAPE_UNEXPECTED', 'Command Code 5h/weekly 窗口字段缺失或无效');
    const balance = Math.max(0, monthly) + Math.max(0, purchased) + Math.max(0, free);
    if (!Number.isFinite(balance)) return empty('commandcode', 'error', now(), 'UPSTREAM_SHAPE_UNEXPECTED', 'Command Code 余额字段超出有效范围');
    return {
      source: 'commandcode',
      status: 'ok',
      balance,
      unit: 'USD',
      windows,
      fetched_at: now(),
      reason_code: null,
      detail: null,
    };
  }

  /**
   * ACC-KB-B5S S2 + ACC-QUOTA-ALL：平台账号侧五个来源。
   * - 凭据：`platformCredential` 解析器（中心库签到凭据 / zcode 本机文件）优先，兼容旧 `platformTokens` 静态注入；
   *   取不到凭据 → 如实 `unsupported` + 精确 reason_code + 可行动指引，绝不编造额度；
   * - 端点与鉴权按公共知识 `3c21b76c` §1 矩阵（2026-11-07 真机复核）：trae 必须 v2 且
   *   `Authorization: Cloud-IDE-JWT` 前缀（Bearer 一律 401）、body 带 require_usage（v2 才有 usage_summary）；
   *   minimax 的 `get_membership_info` 仅 Bearer 即成功（签名头实测非必需，真积分在 op_credit_summary）；
   * - 平台请求统一 15s AbortSignal（对齐 httpCheckinProviders 的超时口径）；
   * - 单来源失败不影响其它来源（沿用 load() 的逐来源缓存与退避）。
   */
  async function fetchPlatform(source: QuotaSourceId, accountId?: string): Promise<QuotaResult> {
    let credential: PlatformQuotaCredential;
    if (options.platformCredential) {
      try {
        credential = await options.platformCredential(source, accountId);
      } catch {
        return empty(source, 'error', now(), 'CREDENTIAL_UNAVAILABLE', '额度凭据解析失败（vault 暂不可用），稍后重试');
      }
    } else {
      const token = accountId === undefined ? options.platformTokens?.[source] ?? null : null;
      credential = token === null
        ? { kind: 'missing', reasonCode: 'NO_CREDENTIAL', detail: `本机未找到 ${source} 的额度凭据` }
        : { kind: 'ok', token, accountName: null };
    }
    if (credential.kind === 'missing') {
      return empty(source, 'unsupported', now(), credential.reasonCode, credential.detail);
    }
    const token = credential.token;
    const endpoints: Partial<Record<QuotaSourceId, { url: string; init: RequestInit }>> = {
      // KB §1：Trae 必须 v2 + `Cloud-IDE-JWT` 前缀（不是独立头名、更不是 Bearer），body 需 require_usage:true
      trae: {
        url: traeQuotaUrl(),
        init: {
          method: 'POST',
          headers: { authorization: `Cloud-IDE-JWT ${token}`, 'content-type': 'application/json', accept: 'application/json' },
          body: JSON.stringify({ require_usage: true, req_source: 1 }),
        },
      },
      // KB §1：WorkBuddy 计费域只认 Bearer（Cookie 一律 APISIX 401），body 空对象
      workbuddy: {
        url: workbuddyQuotaUrl(),
        init: { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', accept: 'application/json' }, body: '{}' },
      },
      // KB §2（2026-11-07 复核）：真积分端点仅 Bearer 即 status_code=0；签名头 yy/x-timestamp/x-signature 非必需
      minimax: {
        url: MINIMAX_QUOTA_URL,
        init: { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', accept: 'application/json' }, body: '{}' },
      },
      // KB §1：Qoder 开放平台只认 Bearer（dt- 桌面令牌）；big_model_credits 明细通道才要 Cookie（本来源不消费）
      qoder_cn: { url: QODER_QUOTA_URL, init: { method: 'GET', headers: { authorization: `Bearer ${token}`, accept: 'application/json' } } },
      // KB §2：必须 oauth:bigmodel:access_token（zcodejwttoken 会 401），凭据选择在凭据解析层完成
      zcode: { url: ZCODE_QUOTA_URL, init: { method: 'GET', headers: { authorization: `Bearer ${token}`, accept: 'application/json' } } },
    };
    const target = endpoints[source];
    if (!target) return empty(source, 'unsupported', now(), 'NO_PUBLIC_QUOTA_ENDPOINT', `${source} 暂无余额端点`);
    const doFetch = options.fetchImpl ?? fetch;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), PLATFORM_TIMEOUT_MS);
    try {
      const response = await doFetch(target.url, { ...target.init, signal: controller.signal });
      if (!response.ok) {
        const invalid = response.status === 401 || response.status === 403;
        const code = response.status === 429 ? 'RATE_LIMITED'
          : invalid ? 'CREDENTIAL_INVALID' : 'UPSTREAM_ERROR';
        const detail = invalid
          ? `${PLATFORM_LABEL[source] ?? source} 凭据已失效（对方返回 ${response.status}），请重新导入凭据`
          : `对方返回 ${response.status}`;
        return empty(source, 'error', now(), code, detail);
      }
      const body: unknown = await response.json();
      const parsed = source === 'trae' ? parseTraeUsage(body)
        : source === 'workbuddy' ? parseWorkbuddyCredits(body)
          : source === 'minimax' ? parseMinimaxCredits(body)
            : source === 'qoder_cn' ? parseQoderQuota(body)
              : parseZcodeQuota(body);
      const parsedOk = parsed.balance !== null || parsed.windows.length > 0;
      const accountHint = credential.accountName === null ? null : `账号：${credential.accountName}`;
      return {
        source,
        status: parsedOk ? 'ok' : 'unsupported',
        balance: parsed.balance,
        unit: parsed.unit,
        windows: parsed.windows,
        fetched_at: now(),
        reason_code: parsedOk ? null : 'UPSTREAM_SHAPE_UNEXPECTED',
        detail: parsedOk ? accountHint : '对方返回的数据结构不在预期内',
      };
    } catch {
      return empty(source, 'error', now(), 'NETWORK_ERROR', '网络不可用或超时');
    } finally {
      clearTimeout(timer);
    }
  }

  function loaderFor(source: QuotaSourceId, accountId?: string): () => Promise<QuotaResult> {
    if (source === 'deepseek') return fetchDeepseek;
    if (source === 'opencode_go') return fetchOpencodeGo;
    if (source === 'codex') return fetchCodexFromRollout;
    if (source === 'commandcode') return () => fetchCommandCode(accountId);
    return () => fetchPlatform(source, accountId);
  }

  async function load(source: QuotaSourceId, accountId?: string): Promise<QuotaResult> {
    const key = accountId === undefined ? source : `${source}:${accountId}`;
    const cached = cache.get(key);
    if (cached && cached.expiresAt > now()) return cached.result;
    const running = inFlight.get(key);
    if (running) return running;
    const generation = cacheGeneration;
    const promise = (async () => {
      const loader = loaderFor(source, accountId);
      const result = await loader();
      if (generation === cacheGeneration) {
        const previous = cache.get(key);
        const failures = result.status === 'error' ? (previous?.failures ?? 0) + 1 : 0;
        const backoff = result.status === 'error'
          ? Math.min(ttlMs * 2 ** Math.max(0, failures - 1), maxBackoffMs)
          : ttlMs;
        cache.set(key, { result, expiresAt: now() + backoff, failures });
      }
      return result;
    })();
    inFlight.set(key, promise);
    try {
      return await promise;
    } finally {
      if (inFlight.get(key) === promise) inFlight.delete(key);
    }
  }

  return {
    async get(account?: { accountId: string; source: AccountQuotaSourceId | 'commandcode' }): Promise<QuotaSnapshot> {
      const sources: QuotaSourceId[] = account ? [account.source] : [...QUOTA_SOURCE_IDS];
      const items = await Promise.all(sources.map((source) => load(source, account?.accountId)));
      return { items, fetched_at: now() };
    },
    reset() {
      cacheGeneration += 1;
      cache.clear();
      inFlight.clear();
    },
  };
}
