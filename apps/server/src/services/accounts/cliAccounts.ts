/**
 * ACC-CLI-MULTI（口径 A）：CLI 来源的本机账号登记。
 *
 * 只做三件事：只读发现本机凭据 → 按来源内身份去重并持久化 → 提供给界面真实计数。
 * CLI-IMPORT 起的「手动导入一份凭据」也在这里（`importCliCredential`）；
 * **不做**写回客户端配置/切换（见 CLI-SWITCH），也不改额度计算口径：额度仍走 quotaService。
 *
 * 各来源的账号上限（不是设计选择，是本机事实）：
 * - DeepSeek：三个候选位置（env / `~/.deepseek/config.toml` / `~/.dsh/.credentials.yaml`），
 *   同一 key 出现在多个位置只算 1 个账号（key 哈希 = 身份），不同 key 才是不同账号 → 0..N；
 * - OpenCode Go：`~/.local/share/opencode/auth.json` 只有一条 `opencode-go.key` → 最多 1；
 * - Codex：仅在 ChatGPT OAuth 模式下读取 auth.json 的 account ID；API key 不冒充 ChatGPT 账号。
 *
 * API 凭据只进 secretVault（purpose `cli_credential`，与签到 purpose 分开）；Codex 只保存 account ID 哈希。
 * 响应与日志不含 key、token 或原始 account ID。
 */
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, join, resolve } from 'node:path';
import type { CliAccountAppId, CliAppCapability, PublicCliAccount } from '@agentboard/shared';
import type { Db } from '../../db/connection.js';
import { ApiError } from '../../errors.js';
import { collectDeepseekKeyCandidates } from '../quotas/quotaService.js';
import type { SecretVault } from './secretVault.js';

export const CLI_ACCOUNT_APP_IDS = ['deepseek', 'opencode_go', 'codex', 'commandcode'] as const;
/** 本机只读发现可产出账号的来源；Codex 用 ChatGPT account ID 作身份，不把令牌当凭据。 */
type DiscoveredAppId = CliAccountAppId;
/**
 * CLI 凭据的 vault：写入恒需要；删除是 ACC-CC-5 的增量需求，
 * 旧测试替身只实现 protect 也能编译（缺删除能力时删除接口会明确拒绝，而非留孤儿密文）。
 */
export type CliCredentialVault = Pick<SecretVault, 'protect'> & Partial<Pick<SecretVault, 'delete'>>;
export const CLI_CLIENT_INSTANCE_ID = 'cli-local';

export interface CliCredentialCandidate {
  app_id: DiscoveredAppId;
  /** 身份输入：其它来源为凭据；Codex 为 ChatGPT account ID。 */
  key: string;
}

interface CliAccountRow {
  id: string;
  app_id: CliAccountAppId;
  identity_hash: string;
  created_at: number;
  last_seen_at: number;
}

/** 来源内身份 = sha256(app_id + NUL + key)；同一 key 在任何位置都得到同一个哈希 */
export function cliIdentityHash(appId: CliAccountAppId, key: string): string {
  return createHash('sha256').update(`${appId}\u0000${key}`).digest('hex');
}

/** 只读解析 `~/.local/share/opencode/auth.json` 的 `opencode-go.key`（与额度链路的读取位置一致） */
export function readOpencodeGoKey(homeDir: string): string | null {
  try {
    const json = JSON.parse(readFileSync(join(homeDir, '.local', 'share', 'opencode', 'auth.json'), 'utf8')) as Record<string, unknown>;
    const entry = json['opencode-go'] as { key?: unknown } | undefined;
    return typeof entry?.key === 'string' && entry.key.length > 0 ? entry.key : null;
  } catch {
    return null;
  }
}

/** 解析本机 ID token 缓存中的 ChatGPT account ID；不做远端认证校验、不存储或回显 token。 */
function codexAccountIdFromIdToken(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const parts = value.split('.');
  if (parts.length !== 3 || parts.some((part) => part.length === 0)) return null;
  try {
    const claims = JSON.parse(Buffer.from(parts[1]!, 'base64url').toString('utf8')) as Record<string, unknown>;
    const auth = claims['https://api.openai.com/auth'];
    if (typeof auth !== 'object' || auth === null || Array.isArray(auth)) return null;
    const accountId = (auth as Record<string, unknown>).chatgpt_account_id;
    return typeof accountId === 'string' && accountId.trim().length > 0 ? accountId.trim() : null;
  } catch {
    return null;
  }
}

/**
 * 只读 Codex ChatGPT OAuth 身份：CODEX_HOME/auth.json 或默认 ~/.codex/auth.json。
 * API key 模式不是 ChatGPT 账号；account_id 只用于哈希，令牌不进入账号存储。
 */
function readCodexAccountId(homeDir: string, env: Record<string, string | undefined>): string | null {
  const configuredHome = env.CODEX_HOME?.trim();
  const authPath = resolve(configuredHome && configuredHome.length > 0 ? configuredHome : join(homeDir, '.codex'), 'auth.json');
  try {
    const auth = JSON.parse(readFileSync(authPath, 'utf8')) as Record<string, unknown>;
    if (auth.auth_mode !== 'chatgpt') return null;
    const tokens = typeof auth.tokens === 'object' && auth.tokens !== null && !Array.isArray(auth.tokens)
      ? auth.tokens as Record<string, unknown>
      : {};
    const accountId = typeof tokens.account_id === 'string' && tokens.account_id.trim().length > 0
      ? tokens.account_id.trim()
      : null;
    const claimAccountId = codexAccountIdFromIdToken(tokens.id_token);
    if (claimAccountId === null) return null;
    if (accountId !== null && claimAccountId !== null && accountId !== claimAccountId) return null;
    return accountId ?? claimAccountId;
  } catch {
    return null;
  }
}

/** Command Code 的凭据文件（home 相对，官方口径） */
export function commandCodeAuthPath(homeDir: string): string {
  return join(homeDir, '.commandcode', 'auth.json');
}

/**
 * Command Code CLI 是否在 PATH 里。
 * Windows 原生别名是 `cmdc`（`cmd` 被系统 shell 占用），npm 全局命令是 `command-code`；
 * 这里只做文件存在性探测（不 spawn 子进程），覆盖 .cmd/.exe/.ps1 三种入口。
 */
export function isCommandCodeCliInstalled(env: Record<string, string | undefined> = process.env): boolean {
  const pathValue = env.PATH ?? env.Path ?? '';
  if (pathValue.trim().length === 0) return false;
  const names = process.platform === 'win32'
    ? ['cmdc.cmd', 'cmdc.exe', 'cmdc.ps1', 'command-code.cmd', 'command-code.exe', 'command-code.ps1']
    : ['cmdc', 'command-code'];
  return pathValue
    .split(delimiter)
    .map((dir) => dir.trim().replace(/^"|"$/g, ''))
    .filter((dir) => dir.length > 0)
    .some((dir) => names.some((name) => existsSync(join(dir, name))));
}

/** auth.json 里可能承载凭据的字段名（官方 schema 未公开，只读探测真实键，不猜值） */
const COMMAND_CODE_TOKEN_FIELDS = ['accessToken', 'access_token', 'apiKey', 'api_key', 'key', 'token'] as const;

/**
 * 从 auth.json 中取「唯一」凭据：只看顶层与一层嵌套对象的已知字段名。
 * 命中多个不同值 → 视为未识别（不替用户挑一个）；一个都没有 → 未识别。
 */
function extractCommandCodeToken(parsed: unknown): string | null {
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null;
  const values = new Set<string>();
  const collect = (value: Record<string, unknown>): void => {
    for (const field of COMMAND_CODE_TOKEN_FIELDS) {
      const candidate = value[field];
      if (typeof candidate === 'string' && candidate.trim().length > 0) values.add(candidate.trim());
    }
  };
  const root = parsed as Record<string, unknown>;
  collect(root);
  for (const value of Object.values(root)) {
    if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
      collect(value as Record<string, unknown>);
    }
  }
  return values.size === 1 ? [...values][0]! : null;
}

export interface CommandCodeAuthProbe {
  state: 'readable' | 'missing' | 'unrecognized';
  key: string | null;
}

/** 只读探测 `~/.commandcode/auth.json`；不读凭据以外的字段，不打印/不回显文件内容 */
export function readCommandCodeAuth(homeDir: string): CommandCodeAuthProbe {
  const path = commandCodeAuthPath(homeDir);
  if (!existsSync(path)) return { state: 'missing', key: null };
  try {
    const key = extractCommandCodeToken(JSON.parse(readFileSync(path, 'utf8')) as unknown);
    return key === null ? { state: 'unrecognized', key: null } : { state: 'readable', key };
  } catch {
    return { state: 'unrecognized', key: null };
  }
}

/**
 * ACC-CC-3：Command Code 的真实能力（不猜）：
 * - capture：auth.json 可识别出唯一凭据或存在 COMMAND_CODE_API_KEY → 可用；
 *   否则按「未安装 / 无凭据文件 / 格式未识别」分别给原因码；
 * - switch：写回 auth.json 是否等价有效登录态未实测 → 恒不可用（AUTH_WRITE_UNVERIFIED）；
 * - checkin：产品无签到语义 → CHECKIN_NOT_APPLICABLE。
 */
export function commandCodeCapability(
  homeDir: string,
  env: Record<string, string | undefined> = process.env,
): CliAppCapability {
  const auth = readCommandCodeAuth(homeDir);
  const envKey = (env.COMMAND_CODE_API_KEY ?? '').trim();
  const installed = isCommandCodeCliInstalled(env);
  let capture: boolean;
  let captureReasonCode: string;
  let captureReason: string | null;
  if (auth.state === 'readable' || envKey.length > 0) {
    capture = true;
    captureReasonCode = 'OK';
    captureReason = null;
  } else if (auth.state === 'unrecognized') {
    // 文件真实存在但格式不认识：比「未安装」更精确，不猜字段
    capture = false;
    captureReasonCode = 'AUTH_SCHEMA_UNSUPPORTED';
    captureReason = 'auth.json 存在但格式未识别（未找到唯一凭据字段）';
  } else if (!installed) {
    capture = false;
    captureReasonCode = 'CLI_NOT_INSTALLED';
    captureReason = '本机未安装 Command Code CLI（PATH 中找不到 cmdc / command-code）';
  } else {
    capture = false;
    captureReasonCode = 'AUTH_FILE_MISSING';
    captureReason = '本机没有 ~/.commandcode/auth.json，请先登录或将 Studio API key 导入';
  }
  return {
    app_id: 'commandcode',
    installed,
    capture,
    capture_reason_code: captureReasonCode,
    capture_reason: captureReason,
    switch: false,
    switch_reason_code: 'AUTH_WRITE_UNVERIFIED',
    switch_reason: '写回 auth.json 是否等价于有效登录态未验证，暂不支持切换',
    checkin: false,
    checkin_reason_code: 'CHECKIN_NOT_APPLICABLE',
    checkin_reason: 'Command Code 没有签到功能',
    auth_file_state: auth.state,
  };
}

/**
 * 收集本机可发现的凭据（已按来源内身份去重）。
 * DeepSeek 复用额度链路的候选收集（含跨位置去重口径），保证「计数」与「实际生效凭据」同源。
 */
export function discoverCliCredentials(
  homeDir: string,
  env: Record<string, string | undefined>,
): CliCredentialCandidate[] {
  const candidates: CliCredentialCandidate[] = [];
  const seen = new Set<string>();
  const push = (appId: DiscoveredAppId, value: string | null | undefined): void => {
    const key = typeof value === 'string' ? value.trim() : '';
    if (key.length === 0) return;
    const digest = cliIdentityHash(appId, key);
    if (seen.has(digest)) return;
    seen.add(digest);
    candidates.push({ app_id: appId, key });
  };
  for (const candidate of collectDeepseekKeyCandidates(homeDir, env)) push('deepseek', candidate.key);
  push('opencode_go', readOpencodeGoKey(homeDir));
  push('codex', readCodexAccountId(homeDir, env));
  // ACC-CC-3：Command Code 只登记真实读到的凭据（auth.json 唯一字段或环境变量），格式未识别不产账号
  push('commandcode', (env.COMMAND_CODE_API_KEY ?? '').trim());
  push('commandcode', readCommandCodeAuth(homeDir).key);
  return candidates;
}

/** 对外投影：不含 credential_ref / identity_hash 全量 / key */
function publicCliAccount(row: CliAccountRow, local?: Set<string>): PublicCliAccount {
  const key = `${row.app_id}\u0000${row.identity_hash}`;
  return {
    id: row.id,
    app_id: row.app_id,
    identity_hint: `sha256:${row.identity_hash.slice(0, 12)}`,
    // ACC-CC-5：不新增数据库列，按「本次发现集合」判定来源
    ...(local === undefined ? {} : { source: local.has(key) ? ('local' as const) : ('manual' as const) }),
    created_at: row.created_at,
    last_seen_at: row.last_seen_at,
  };
}

/** 本机发现集合的身份键（app_id + identity_hash） */
function localIdentityKeys(homeDir: string, env: Record<string, string | undefined>): Set<string> {
  return new Set(
    discoverCliCredentials(homeDir, env).map(
      (candidate) => `${candidate.app_id}\u0000${cliIdentityHash(candidate.app_id, candidate.key)}`,
    ),
  );
}

/**
 * CLI 账号列表（脱敏）。
 * 传入 `homeDir/env` 时附带 `source`（local = 当前仍能在本机发现；manual = 仅存在于 AgentBoard）。
 */
export function listCliAccounts(
  db: Db,
  discovery?: { homeDir: string; env: Record<string, string | undefined> },
): PublicCliAccount[] {
  const local = discovery === undefined ? undefined : localIdentityKeys(discovery.homeDir, discovery.env);
  const rows = db
    .prepare('SELECT id,app_id,identity_hash,created_at,last_seen_at FROM cli_account ORDER BY app_id,created_at,id')
    .all() as CliAccountRow[];
  // Codex 不支持手动导入；认证身份变化或退出后隐藏旧身份，避免把历史记录误当当前登录账号。
  return rows
    .filter((row) => discovery === undefined || row.app_id !== 'codex' || local?.has(`${row.app_id}\u0000${row.identity_hash}`) === true)
    .map((row) => publicCliAccount(row, local));
}

export interface CaptureCliAccountsOptions {
  db: Db;
  /** 生产为 SecretVault；缺省/加密失败时仍登记账号（ref 留空），绝不落明文 */
  vault?: CliCredentialVault;
  /** 凭据根目录，默认 os.homedir()（测试用临时目录） */
  homeDir?: string;
  /** 注入 env（测试用） */
  env?: Record<string, string | undefined>;
  /** 注入当前时间（测试用） */
  now?: () => number;
}

/**
 * 幂等登记：同一 (app_id, identity_hash) 只建一条，已存在只更新 `last_seen_at`。
 * 已消失的凭据不删除（保留「曾经发现过」的记录，last_seen_at 表达新鲜度）。
 */
export async function captureCliAccounts(options: CaptureCliAccountsOptions): Promise<PublicCliAccount[]> {
  const { db } = options;
  const now = (options.now ?? Date.now)();
  const homeDir = options.homeDir ?? homedir();
  const env = options.env ?? process.env;
  const candidates = discoverCliCredentials(homeDir, env);
  const local = new Set<string>();
  for (const candidate of candidates) {
    local.add(`${candidate.app_id}\u0000${cliIdentityHash(candidate.app_id, candidate.key)}`);
  }
  const find = db.prepare('SELECT id FROM cli_account WHERE app_id=? AND identity_hash=?');
  const insert = db.prepare(
    'INSERT INTO cli_account (id,app_id,identity_hash,credential_ref,created_at,last_seen_at) VALUES (?,?,?,?,?,?)',
  );
  const touch = db.prepare('UPDATE cli_account SET last_seen_at=? WHERE app_id=? AND identity_hash=?');
  for (const candidate of candidates) {
    const identityHash = cliIdentityHash(candidate.app_id, candidate.key);
    if (find.get(candidate.app_id, identityHash) !== undefined) {
      touch.run(now, candidate.app_id, identityHash);
      continue;
    }
    let credentialRef: string | null = null;
    if (options.vault && candidate.app_id !== 'codex') {
      try {
        credentialRef = await options.vault.protect(Buffer.from(candidate.key, 'utf8'), {
          app_id: candidate.app_id,
          client_instance_id: CLI_CLIENT_INSTANCE_ID,
          identity_hash: identityHash,
          purpose: 'cli_credential',
        });
      } catch {
        // 加密不可用时仍允许登记（身份是哈希），但不把明文写任何地方
        credentialRef = null;
      }
    }
    insert.run(randomUUID(), candidate.app_id, identityHash, credentialRef, now, now);
  }
  return listCliAccounts(db, { homeDir, env });
}

/** 手动导入时接受的 token 形状（API key / OAuth 短令牌都是无空白的可打印串） */
const CREDENTIAL_TOKEN = /^[A-Za-z0-9._~+/=-]{8,512}$/;
/** 允许从配置文件/JSON 片段里取值的字段名；解析失败不猜、直接给可读原因 */
const CREDENTIAL_FIELD = /\b(?:api_key|apikey|DEEPSEEK_API_KEY|COMMAND_CODE_API_KEY|key)\b["']?\s*[:=]\s*["']?([^"'\r\n,}]{1,512})/gi;

/**
 * 解析粘贴文本/文件内容里的单份凭据：裸 token 优先，其次识别 `api_key = "…"` /
 * `"api_key": "…"` / `DEEPSEEK_API_KEY=…`。多份凭据一律拒绝（本卡口径：一次一份）。
 * 返回的 error 文案不含入参原文，避免把误粘贴的密钥回显到界面或日志。
 */
export function parseCliCredentialText(raw: string): { token: string } | { error: string } {
  const text = raw.replace(/^\uFEFF/, '').trim();
  if (text.length === 0) return { error: '凭据为空：请粘贴 API key 或选择凭据文件' };
  // `DEEPSEEK_API_KEY=sk-…` 这种赋值串整体也满足 token 字符集，必须先按字段名识别再说，
  // 否则会把整行（含变量名与等号）当成 key。
  const looksLikeAssignment = /^\s*["']?(?:api_key|apikey|DEEPSEEK_API_KEY|COMMAND_CODE_API_KEY|key)["']?\s*[:=]/i.test(text);
  if (!looksLikeAssignment && CREDENTIAL_TOKEN.test(text)) return { token: text };
  const lines = text.split(/\r?\n/).map(line => line.trim()).filter(line => line.length > 0);
  if (lines.length > 1 && lines.every(line => CREDENTIAL_TOKEN.test(line))) {
    return { error: '一次只能导入一份凭据：输入里检测到多份 key' };
  }
  const found = new Set<string>();
  for (const match of text.matchAll(CREDENTIAL_FIELD)) {
    const value = match[1]!.trim();
    if (value.length > 0) found.add(value);
  }
  if (found.size === 1) {
    const token = [...found][0]!;
    return CREDENTIAL_TOKEN.test(token) ? { token } : { error: '凭据格式不合法：应是不含空白的 8–512 位 key' };
  }
  if (found.size > 1) return { error: '一次只能导入一份凭据：输入里检测到多份 key' };
  return { error: '无法从输入中解析出凭据：请粘贴单个 API key，不要包含多余文字' };
}

export interface ImportCliCredentialOptions {
  db: Db;
  /** 手动导入必须能落 vault；缺省或加密失败直接失败，不登记无凭据的账号 */
  vault?: CliCredentialVault;
  appId: CliAccountAppId;
  /** 粘贴文本或文件内容（只在内存里解析，不落盘、不回显） */
  credential: string;
  now?: () => number;
}

export interface CliCredentialImportResult {
  app_id: CliAccountAppId;
  /** created = 新登记；updated = 同身份已存在，只刷新 last_seen_at */
  action: 'created' | 'updated';
  account: PublicCliAccount;
}

/**
 * CLI-IMPORT：手动导入一份凭据。
 * - 校验：app 取值、token 形状、DeepSeek 的 `sk-` 前缀；Codex 导入对象未定 → 拒绝（不产生可切换记录）。
 * - 去重：`(app_id, identity_hash)` 已存在时只刷新 last_seen_at，不新增行、不重复写 vault。
 * - 安全：明文只进 vault（purpose `cli_credential`），响应只回脱敏哈希前缀。
 */
export async function importCliCredential(options: ImportCliCredentialOptions): Promise<CliCredentialImportResult> {
  const { db, appId } = options;
  if (appId === 'codex') {
    throw new ApiError(409, 'CLI_IMPORT_UNSUPPORTED', 'Codex 导入对象尚未确定（OAuth 令牌 / API key 均未验证），暂不支持手动导入');
  }
  const parsed = parseCliCredentialText(options.credential);
  if ('error' in parsed) throw new ApiError(400, 'INVALID_CREDENTIAL', parsed.error);
  if (appId === 'deepseek' && !parsed.token.startsWith('sk-')) {
    throw new ApiError(400, 'INVALID_CREDENTIAL', 'DeepSeek key 应以 sk- 开头，请核对导入的凭据');
  }
  if (!options.vault) throw new ApiError(503, 'VAULT_UNAVAILABLE', '凭据保护未装配，无法安全保存导入的凭据');
  const now = (options.now ?? Date.now)();
  const identityHash = cliIdentityHash(appId, parsed.token);
  const existing = db
    .prepare('SELECT id,credential_ref FROM cli_account WHERE app_id=? AND identity_hash=?')
    .get(appId, identityHash) as { id: string; credential_ref: string | null } | undefined;
  const readRow = (id: string): CliAccountRow =>
    db.prepare('SELECT id,app_id,identity_hash,created_at,last_seen_at FROM cli_account WHERE id=?').get(id) as CliAccountRow;

  // 同身份已带 vault 引用：同 key 再导入不重复加密（避免孤儿密文），只刷新发现时间
  if (existing?.credential_ref) {
    db.prepare('UPDATE cli_account SET last_seen_at=? WHERE id=?').run(now, existing.id);
    return { app_id: appId, action: 'updated', account: publicCliAccount(readRow(existing.id)) };
  }
  let credentialRef: string;
  try {
    credentialRef = await options.vault.protect(Buffer.from(parsed.token, 'utf8'), {
      app_id: appId,
      client_instance_id: CLI_CLIENT_INSTANCE_ID,
      identity_hash: identityHash,
      purpose: 'cli_credential',
    });
  } catch {
    throw new ApiError(503, 'VAULT_UNAVAILABLE', '凭据保护不可用，导入失败（未写入任何明文）');
  }
  if (existing) {
    // 历史行是在 vault 不可用时登记的（ref 为空）：补写引用，不新增账号
    db.prepare('UPDATE cli_account SET credential_ref=?, last_seen_at=? WHERE id=?').run(credentialRef, now, existing.id);
    return { app_id: appId, action: 'updated', account: publicCliAccount(readRow(existing.id)) };
  }
  const id = randomUUID();
  db.prepare(
    'INSERT INTO cli_account (id,app_id,identity_hash,credential_ref,created_at,last_seen_at) VALUES (?,?,?,?,?,?)',
  ).run(id, appId, identityHash, credentialRef, now, now);
  return { app_id: appId, action: 'created', account: publicCliAccount(readRow(id)) };
}

export interface DeleteCliAccountOptions {
  db: Db;
  accountId: string;
  /**
   * 回收该账号在 vault 里的密文（purpose `cli_credential`）。
   * 行内带 credential_ref 时必需：宁可拒绝删除并报错，也不留下无主密文。
   */
  deleteCredential?: (ref: string) => Promise<void>;
}

export interface DeletedCliAccount {
  deleted: true;
  id: string;
  app_id: CliAccountAppId;
}

/**
 * ACC-CC-5：删除一条 CLI 账号记录，并回收它的 vault 密文。
 * - 不存在 → 404 ACCOUNT_NOT_FOUND；
 * - 有 credential_ref 但没有回收能力 / 回收失败 → 503，且**不删库行**（可重试）；
 * - 本机发现的账号删掉后，下次 `GET /api/cli-accounts` 会重新登记（凭据仍在原文件），界面需提示。
 */
export async function deleteCliAccount(options: DeleteCliAccountOptions): Promise<DeletedCliAccount> {
  const { db, accountId } = options;
  const row = db
    .prepare('SELECT id,app_id,credential_ref FROM cli_account WHERE id=?')
    .get(accountId) as { id: string; app_id: CliAccountAppId; credential_ref: string | null } | undefined;
  if (row === undefined) throw new ApiError(404, 'ACCOUNT_NOT_FOUND', '账号不存在');
  if (row.credential_ref !== null) {
    if (options.deleteCredential === undefined) {
      throw new ApiError(503, 'VAULT_UNAVAILABLE', '凭据保护未装配，无法回收该账号的凭据（未删除账号记录）');
    }
    try {
      await options.deleteCredential(row.credential_ref);
    } catch {
      throw new ApiError(503, 'VAULT_DELETE_FAILED', '凭据回收失败，未删除账号记录');
    }
  }
  db.prepare('DELETE FROM cli_account WHERE id=?').run(accountId);
  return { deleted: true, id: row.id, app_id: row.app_id };
}
