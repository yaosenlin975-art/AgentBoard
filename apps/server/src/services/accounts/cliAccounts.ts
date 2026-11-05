/**
 * ACC-CLI-MULTI（口径 A）：CLI 三来源（DeepSeek / OpenCode-Go / Codex）的本机凭据登记。
 *
 * 只做三件事：只读发现本机凭据 → 按来源内身份去重并持久化 → 提供给界面真实计数。
 * CLI-IMPORT 起的「手动导入一份凭据」也在这里（`importCliCredential`）；
 * **不做**写回客户端配置/切换（见 CLI-SWITCH），也不改额度计算口径：额度仍走 quotaService。
 *
 * 各来源的账号上限（不是设计选择，是本机事实）：
 * - DeepSeek：三个候选位置（env / `~/.deepseek/config.toml` / `~/.dsh/.credentials.yaml`），
 *   同一 key 出现在多个位置只算 1 个账号（key 哈希 = 身份），不同 key 才是不同账号 → 0..N；
 * - OpenCode Go：`~/.local/share/opencode/auth.json` 只有一条 `opencode-go.key` → 最多 1；
 * - Codex：没有可枚举的凭据（额度来自 `~/.codex/sessions` 最新 rollout，登录态在 auth.json）→ 恒 0，
 *   不编造记录。
 *
 * 凭据只进 secretVault（purpose `cli_credential`，与签到 purpose 分开）；响应与日志不含 key 明文。
 */
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { CliAccountAppId, PublicCliAccount } from '@agentboard/shared';
import type { Db } from '../../db/connection.js';
import { ApiError } from '../../errors.js';
import { collectDeepseekKeyCandidates } from '../quotas/quotaService.js';
import type { SecretVault } from './secretVault.js';

export const CLI_ACCOUNT_APP_IDS = ['deepseek', 'opencode_go', 'codex'] as const;
/** 本机只读发现能产出账号的两类来源；Codex 无凭据可枚举，不产账号 */
type DiscoveredAppId = Exclude<CliAccountAppId, 'codex'>;
/** CLI 凭据的 vault 只有写入能力需求（读取/删除随 CLI-IMPORT / CLI-SWITCH 再扩） */
export type CliCredentialVault = Pick<SecretVault, 'protect'>;
export const CLI_CLIENT_INSTANCE_ID = 'cli-local';

export interface CliCredentialCandidate {
  app_id: DiscoveredAppId;
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
  return candidates;
}

/** 对外投影：不含 credential_ref / identity_hash 全量 / key */
function publicCliAccount(row: CliAccountRow): PublicCliAccount {
  return {
    id: row.id,
    app_id: row.app_id,
    identity_hint: `sha256:${row.identity_hash.slice(0, 12)}`,
    created_at: row.created_at,
    last_seen_at: row.last_seen_at,
  };
}

export function listCliAccounts(db: Db): PublicCliAccount[] {
  const rows = db
    .prepare('SELECT id,app_id,identity_hash,created_at,last_seen_at FROM cli_account ORDER BY app_id,created_at,id')
    .all() as CliAccountRow[];
  return rows.map(publicCliAccount);
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
  const candidates = discoverCliCredentials(options.homeDir ?? homedir(), options.env ?? process.env);
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
    if (options.vault) {
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
  return listCliAccounts(db);
}

/** 手动导入时接受的 token 形状（API key / OAuth 短令牌都是无空白的可打印串） */
const CREDENTIAL_TOKEN = /^[A-Za-z0-9._~+/=-]{8,512}$/;
/** 允许从配置文件/JSON 片段里取值的字段名；解析失败不猜、直接给可读原因 */
const CREDENTIAL_FIELD = /\b(?:api_key|apikey|DEEPSEEK_API_KEY|key)\b["']?\s*[:=]\s*["']?([^"'\r\n,}]{1,512})/gi;

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
  const looksLikeAssignment = /^\s*["']?(?:api_key|apikey|DEEPSEEK_API_KEY|key)["']?\s*[:=]/i.test(text);
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
