/**
 * ACC-CLI-MULTI（口径 A）：CLI 三来源（DeepSeek / OpenCode-Go / Codex）的本机凭据登记。
 *
 * 只做三件事：只读发现本机凭据 → 按来源内身份去重并持久化 → 提供给界面真实计数。
 * **不做**写入/切换（见 CLI-IMPORT / CLI-SWITCH），也不改额度计算口径：额度仍走 quotaService。
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
import { collectDeepseekKeyCandidates } from '../quotas/quotaService.js';
import type { SecretVault } from './secretVault.js';

export const CLI_ACCOUNT_APP_IDS = ['deepseek', 'opencode_go', 'codex'] as const;
/** 本机只读发现能产出账号的两类来源；Codex 无凭据可枚举，不产账号 */
type DiscoveredAppId = Exclude<CliAccountAppId, 'codex'>;
/** CLI 凭据的 vault 只有写入能力需求（读取/删除随 CLI-IMPORT / CLI-SWITCH 再扩） */
export type CliCredentialVault = Pick<SecretVault, 'protect'>;
const CLI_CLIENT_INSTANCE_ID = 'cli-local';

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
export function listCliAccounts(db: Db): PublicCliAccount[] {
  const rows = db
    .prepare('SELECT id,app_id,identity_hash,created_at,last_seen_at FROM cli_account ORDER BY app_id,created_at,id')
    .all() as CliAccountRow[];
  return rows.map(row => ({
    id: row.id,
    app_id: row.app_id,
    identity_hint: `sha256:${row.identity_hash.slice(0, 12)}`,
    created_at: row.created_at,
    last_seen_at: row.last_seen_at,
  }));
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
