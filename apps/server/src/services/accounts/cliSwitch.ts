/**
 * CLI-SWITCH：CLI 三来源（DeepSeek / OpenCode-Go / Codex）的「当前生效账号」切换。
 *
 * 状态机沿用 ACC-SWITCH 的口径，但不复用 managed_account 的 account_operation 表
 * （该表 app_id 只接受桌面来源）：
 *   预检（能力 + 账号 + vault） → 快照原文件 → 生成新内容 → 原子写入 → 读回校验
 *   → 任一步失败按快照回滚；同来源同一时刻只允许一个切换（tryWithAccountLock → ACCOUNT_BUSY）。
 *
 * 安全红线：
 * - 默认 dry-run，只有显式 apply 才写本机文件；
 * - 明文凭据只从 vault 取出并在内存中使用，绝不落日志/响应/备份文件；
 * - 「备份」是内存快照（不把含明文 key 的原文件另存一份到磁盘）；
 * - 没有可靠写入+校验路径的来源（Codex OAuth）保持 switch=false。
 */
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { CliAccountAppId } from '@agentboard/shared';
import type { Db } from '../../db/connection.js';
import { ApiError } from '../../errors.js';
import { collectDeepseekKeyCandidates } from '../quotas/quotaService.js';
import { CLI_CLIENT_INSTANCE_ID, cliIdentityHash, readOpencodeGoKey } from './cliAccounts.js';
import { tryWithAccountLock } from './locks.js';
import type { SecretVault } from './secretVault.js';

/** 切换只需要读取 vault 中的凭据（写入由 CLI-IMPORT 负责） */
export type CliSwitchVault = Pick<SecretVault, 'unprotect'>;

export interface CliSwitchCapability {
  app_id: CliAccountAppId;
  switch: boolean;
  reason_code: string;
  reason: string | null;
}

/** 能力表：只有真正具备「写入 + 读回校验」路径的来源才允许 switch=true */
export const CLI_SWITCH_CAPABILITIES: readonly CliSwitchCapability[] = [
  { app_id: 'deepseek', switch: true, reason_code: 'OK', reason: null },
  { app_id: 'opencode_go', switch: true, reason_code: 'OK', reason: null },
  {
    app_id: 'codex',
    switch: false,
    reason_code: 'CODEX_OAUTH_WRITE_UNVERIFIED',
    reason: 'Codex 登录态是 OAuth 令牌（含刷新令牌），写入与读回校验路径未验证，保持只读',
  },
  {
    // ACC-CC-3：写回 ~/.commandcode/auth.json 是否等价于有效登录态未实测（CC-1 §7），保持只读
    app_id: 'commandcode',
    switch: false,
    reason_code: 'AUTH_WRITE_UNVERIFIED',
    reason: '写回 ~/.commandcode/auth.json 是否等价于有效登录态未验证，保持只读',
  },
];

export function cliSwitchCapability(appId: CliAccountAppId): CliSwitchCapability {
  return CLI_SWITCH_CAPABILITIES.find(item => item.app_id === appId)
    ?? { app_id: appId, switch: false, reason_code: 'CLI_SWITCH_UNKNOWN_APP', reason: '未知的 CLI 来源' };
}

interface CliAccountRow {
  id: string;
  app_id: CliAccountAppId;
  identity_hash: string;
  credential_ref: string | null;
}

export interface CliSwitchResult {
  app_id: CliAccountAppId;
  account_id: string;
  /** dry_run 只描述计划；switched 表示已写入并通过读回校验 */
  status: 'dry_run' | 'switched';
  applied: boolean;
  /** 脱敏后的目标文件标签（不含绝对路径与凭据） */
  target: string;
  field: string;
  current_identity_hint: string | null;
  target_identity_hint: string;
  already_current: boolean;
  /** dry-run 预检发现的阻断原因（例如环境变量会覆盖配置文件） */
  blocked_reason_code: string | null;
}

interface CliTargetFile {
  label: string;
  path: string;
  field: string;
  /** 读取配置中保存的 key（文件缺失/解析失败返回 null） */
  readStored(): string | null;
  /** 额度链路实际生效的第一顺位 key（与 quotaService 的读取位置同源） */
  readEffective(): string | null;
  /** 生成写入后的完整文件内容（保留其余配置；解析失败抛 CLIENT_STATE_UNREADABLE） */
  build(credential: string): string;
}

function encodeTomlBasicString(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

function deepseekTarget(homeDir: string, env: Record<string, string | undefined>): CliTargetFile {
  const path = join(homeDir, '.deepseek', 'config.toml');
  return {
    label: '~/.deepseek/config.toml',
    path,
    field: 'api_key',
    readStored() {
      try {
        const text = readFileSync(path, 'utf8');
        const match = /^\s*api_key\s*=\s*(?:"([^"\r\n]*)"|'([^'\r\n]*)')/m.exec(text);
        return match ? (match[1] ?? match[2] ?? null) : null;
      } catch {
        return null;
      }
    },
    readEffective() {
      return collectDeepseekKeyCandidates(homeDir, env)[0]?.key ?? null;
    },
    build(credential) {
      const quoted = `"${encodeTomlBasicString(credential)}"`;
      let text = '';
      if (existsSync(path)) text = readFileSync(path, 'utf8');
      const linePattern = /^(\s*)api_key\s*=\s*(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\r\n]*)$/m;
      if (linePattern.test(text)) return text.replace(linePattern, (_line, indent: string) => `${indent}api_key = ${quoted}`);
      const separator = text.length === 0 || text.endsWith('\n') ? '' : '\n';
      return `${text}${separator}api_key = ${quoted}\n`;
    },
  };
}

function opencodeTarget(homeDir: string): CliTargetFile {
  const path = join(homeDir, '.local', 'share', 'opencode', 'auth.json');
  const unreadable = (): never => {
    throw new ApiError(409, 'CLIENT_STATE_UNREADABLE', 'OpenCode auth.json 不是可安全改写的 JSON，已中止且未写入');
  };
  const parse = (): Record<string, unknown> => {
    if (!existsSync(path)) return {};
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(path, 'utf8'));
    } catch {
      return unreadable();
    }
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return unreadable();
    return parsed as Record<string, unknown>;
  };
  return {
    label: '~/.local/share/opencode/auth.json',
    path,
    field: 'opencode-go.key',
    readStored() {
      try {
        const json = parse();
        const entry = json['opencode-go'] as { key?: unknown } | undefined;
        return typeof entry?.key === 'string' && entry.key.length > 0 ? entry.key : null;
      } catch {
        return null;
      }
    },
    readEffective() {
      return readOpencodeGoKey(homeDir);
    },
    build(credential) {
      const json = parse();
      const entry = json['opencode-go'];
      if (entry !== undefined && (typeof entry !== 'object' || entry === null || Array.isArray(entry))) {
        return unreadable();
      }
      json['opencode-go'] = { ...(entry as Record<string, unknown> | undefined), key: credential };
      return `${JSON.stringify(json, null, 2)}\n`;
    },
  };
}

function targetFor(appId: CliAccountAppId, homeDir: string, env: Record<string, string | undefined>): CliTargetFile {
  if (appId === 'deepseek') return deepseekTarget(homeDir, env);
  if (appId === 'opencode_go') return opencodeTarget(homeDir);
  throw new ApiError(409, 'CLI_SWITCH_UNSUPPORTED', `来源 ${appId} 不支持切换：${cliSwitchCapability(appId).reason ?? '无可用写入路径'}`);
}

interface FileSnapshot {
  path: string;
  existed: boolean;
  bytes: Buffer | null;
}

function captureSnapshot(path: string): FileSnapshot {
  if (!existsSync(path)) return { path, existed: false, bytes: null };
  return { path, existed: true, bytes: readFileSync(path) };
}

/** 原子写入：同目录临时文件 + rename 替换；失败时清掉临时文件，目标文件保持原状 */
function atomicWrite(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const temp = `${path}.agentboard-tmp-${randomUUID()}`;
  try {
    writeFileSync(temp, content, { encoding: 'utf8' });
    renameSync(temp, path);
  } catch (error) {
    rmSync(temp, { force: true });
    throw error;
  }
}

function restoreSnapshot(snapshot: FileSnapshot): void {
  if (snapshot.existed && snapshot.bytes) atomicWrite(snapshot.path, snapshot.bytes.toString('utf8'));
  else rmSync(snapshot.path, { force: true });
}

function snapshotRestored(snapshot: FileSnapshot): boolean {
  try {
    if (!snapshot.existed) return !existsSync(snapshot.path);
    return existsSync(snapshot.path) && readFileSync(snapshot.path).equals(snapshot.bytes ?? Buffer.alloc(0));
  } catch {
    return false;
  }
}

function hint(appId: CliAccountAppId, key: string | null): string | null {
  return key === null ? null : `sha256:${cliIdentityHash(appId, key).slice(0, 12)}`;
}

export interface SwitchCliAccountOptions {
  db: Db;
  vault?: CliSwitchVault;
  accountId: string;
  /** 默认 false = dry-run，只返回计划摘要，不触碰本机配置 */
  apply?: boolean;
  homeDir: string;
  env: Record<string, string | undefined>;
  /** 测试注入：模拟写入后的校验失败，用于覆盖回滚路径（生产不传） */
  verifyOverride?: (credential: string) => Promise<void>;
}

/**
 * 切换一个 CLI 账号为当前生效账号。
 * 失败分两类：预检失败（未写任何东西）与写入后失败（已按快照回滚，报 CLI_SWITCH_ROLLED_BACK）。
 */
export async function switchCliAccount(options: SwitchCliAccountOptions): Promise<CliSwitchResult> {
  const row = options.db
    .prepare('SELECT id,app_id,identity_hash,credential_ref FROM cli_account WHERE id=?')
    .get(options.accountId) as CliAccountRow | undefined;
  if (!row) throw new ApiError(404, 'ACCOUNT_NOT_FOUND', '账号不存在');
  const capability = cliSwitchCapability(row.app_id);
  if (!capability.switch) {
    throw new ApiError(409, 'CLI_SWITCH_UNSUPPORTED', `来源 ${row.app_id} 不支持切换：${capability.reason ?? '无可用写入路径'}`);
  }

  const target = targetFor(row.app_id, options.homeDir, options.env);
  const currentKey = target.readEffective();
  const targetHint = `sha256:${row.identity_hash.slice(0, 12)}`;
  const alreadyCurrent = hint(row.app_id, currentKey) === targetHint;

  // DeepSeek 的环境变量优先级高于 config.toml：写入也不会成为生效凭据，预检直接拒绝
  const blocked = row.app_id === 'deepseek' && (options.env.DEEPSEEK_API_KEY ?? '').trim().length > 0 && !alreadyCurrent
    ? 'DEEPSEEK_ENV_SHADOWS'
    : null;

  if (options.apply !== true) {
    return {
      app_id: row.app_id,
      account_id: row.id,
      status: 'dry_run',
      applied: false,
      target: target.label,
      field: target.field,
      current_identity_hint: hint(row.app_id, currentKey),
      target_identity_hint: targetHint,
      already_current: alreadyCurrent,
      blocked_reason_code: blocked,
    };
  }

  if (blocked) {
    throw new ApiError(409, blocked, '环境变量 DEEPSEEK_API_KEY 的优先级高于配置文件，写入配置文件不会生效；请先移除该环境变量');
  }
  if (!options.vault) throw new ApiError(503, 'VAULT_UNAVAILABLE', '凭据保险库不可用，无法切换');
  if (!row.credential_ref) {
    throw new ApiError(409, 'CLI_CREDENTIAL_MISSING', '该账号没有可用凭据（登记时保险库不可用），请重新导入后再切换');
  }

  const credentialRef = row.credential_ref;
  const locked = await tryWithAccountLock('cli', row.app_id, async () => {
    let credential: string;
    try {
      credential = Buffer.from(await options.vault!.unprotect(credentialRef, {
        app_id: row.app_id,
        client_instance_id: CLI_CLIENT_INSTANCE_ID,
        identity_hash: row.identity_hash,
        purpose: 'cli_credential',
      })).toString('utf8');
    } catch {
      throw new ApiError(503, 'VAULT_READ_FAILED', '无法从保险库读取该账号凭据，请重新导入');
    }
    if (credential.trim().length === 0) throw new ApiError(409, 'CLI_CREDENTIAL_MISSING', '保险库中的凭据为空，请重新导入');

    // 「已是当前账号」必须在锁内复核：外部并发写入可能刚把目标改成同一凭据
    if (target.readStored() === credential && target.readEffective() === credential) {
      return {
        app_id: row.app_id,
        account_id: row.id,
        status: 'switched' as const,
        applied: true,
        target: target.label,
        field: target.field,
        current_identity_hint: hint(row.app_id, credential),
        target_identity_hint: targetHint,
        already_current: true,
        blocked_reason_code: null,
      };
    }

    // 解析/生成失败属于预检失败：此时还没有写任何文件，按原错误码直接返回
    const content = target.build(credential);
    const snapshot = captureSnapshot(target.path);
    try {
      atomicWrite(target.path, content);
      if (options.verifyOverride) await options.verifyOverride(credential);
      const stored = target.readStored();
      const effective = target.readEffective();
      if (stored !== credential || effective !== credential) {
        throw new ApiError(409, 'CLI_SWITCH_VERIFY_FAILED', '写入后读回校验失败：配置文件内容与实际生效凭据不一致');
      }
    } catch (error) {
      restoreSnapshot(snapshot);
      if (!snapshotRestored(snapshot)) {
        throw new ApiError(503, 'CLI_SWITCH_ROLLBACK_FAILED', '切换失败且回滚未能确认，请手工恢复原凭据文件');
      }
      if (error instanceof ApiError && error.code !== 'CLI_SWITCH_VERIFY_FAILED') {
        throw new ApiError(409, 'CLI_SWITCH_ROLLED_BACK', `切换中止，已回滚到写入前内容（${error.code}）`);
      }
      throw new ApiError(409, 'CLI_SWITCH_ROLLED_BACK', '切换失败，已回滚到写入前内容（校验未通过）');
    }

    return {
      app_id: row.app_id,
      account_id: row.id,
      status: 'switched' as const,
      applied: true,
      target: target.label,
      field: target.field,
      current_identity_hint: hint(row.app_id, credential),
      target_identity_hint: targetHint,
      already_current: false,
      blocked_reason_code: null,
    };
  });

  if (locked === null) throw new ApiError(409, 'ACCOUNT_BUSY', '该来源已有切换操作在进行，请稍后重试');
  return locked;
}
