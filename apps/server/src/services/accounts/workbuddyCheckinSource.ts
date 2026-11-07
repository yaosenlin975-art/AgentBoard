/**
 * ACC-GET：WorkBuddy 捕获时的签到凭据来源。
 *
 * 背景：桌面线 `workbuddy-desktop.info` 的 token 是 `$wbEncrypted` 信封（保护器密钥由客户端原生模块供给，
 * 离线不可解）；可用来源有两条，且**都已在既有链路中验证过读取方式**：
 * 1. 插件线 `Tencent-Cloud.coding-copilot.info` 的 `auth.accessToken`（明文 JWT，`sub` == 桌面 `account.uid`）；
 * 2. `scripts/accounts/export_credentials.py` 扫描 WorkBuddy 进程内存按 JWT `sub` 导出（ACC-11 导入通道）。
 *
 * 安全边界：token 只在内存中短暂存在；不写日志、不进响应、不落明文文件；只返回给调用方做 vault.protect。
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { ExportRunner } from './credentialImport.js';
import { createDefaultExportRunner, parseExportOutput } from './credentialImport.js';
import { jwtExpiresAt } from './addAccountProtocol.js';
import { parseCredentialExpiry } from '../../db/repos/managedAccount.js';
import type { ClientIdentity } from './workbuddyDesktopProvider.js';

const sha256 = (value: string): string => createHash('sha256').update(value).digest('hex');

/** 默认插件线凭据文件（与知识页 `platform-credential-storage` §3 一致） */
export function defaultWorkbuddyPluginInfoPath(env: NodeJS.ProcessEnv = process.env): string {
  return join(env.LOCALAPPDATA ?? '', 'CodeBuddyExtension', 'Data', 'Public', 'auth', 'Tencent-Cloud.coding-copilot.info');
}

/** 取 JWT payload 的 sub（base64url；不是 JWT 或解不开 → null） */
export function jwtSubject(token: string): string | null {
  const parts = token.split('.');
  if (parts.length < 2) return null;
  try {
    const json = JSON.parse(Buffer.from(parts[1]!, 'base64url').toString('utf8')) as { sub?: unknown };
    return typeof json.sub === 'string' && json.sub.trim() !== '' ? json.sub : null;
  } catch {
    return null;
  }
}

/**
 * ACC-TOKEN-2：桌面线 info 文件 `auth.expiresAt` 是明文毫秒（本机实测，G2；信封字段不读），
 * 文件缺失/损坏/字段缺失 → null。到期列写入点用，无需解密 token。
 */
export async function readWorkbuddyAuthExpiresAt(authInfoPath: string): Promise<number | null> {
  if (!existsSync(authInfoPath)) return null;
  let info: unknown;
  try { info = JSON.parse((await readFile(authInfoPath)).toString('utf8')); } catch { return null; }
  return parseCredentialExpiry((info as { auth?: { expiresAt?: unknown } } | null)?.auth?.expiresAt);
}

export interface WorkbuddyCheckinTokenSource {
  /** 返回与给定身份匹配的签到 token；取不到返回 null（不抛错、不打日志） */
  find(identity: ClientIdentity): Promise<string | null>;
}

export interface WorkbuddyCheckinSourceOptions {
  pluginInfoPath?: string;
  /** 测试注入：替换真实 python 子进程 */
  runExport?: ExportRunner;
}

function readPluginToken(pluginInfoPath: string, identity: ClientIdentity): string | null {
  if (!existsSync(pluginInfoPath)) return null;
  let info: unknown;
  try { info = JSON.parse(readFileSync(pluginInfoPath, 'utf8')); } catch { return null; }
  const token = (info as { auth?: { accessToken?: unknown } } | null)?.auth?.accessToken;
  if (typeof token !== 'string' || token.trim() === '') return null;
  const subject = jwtSubject(token);
  return subject !== null && sha256(subject) === identity.identity_hash ? token : null;
}

export function createWorkbuddyCheckinTokenSource(options: WorkbuddyCheckinSourceOptions = {}): WorkbuddyCheckinTokenSource {
  const pluginInfoPath = options.pluginInfoPath ?? defaultWorkbuddyPluginInfoPath();
  const runExport = options.runExport ?? createDefaultExportRunner();
  return {
    async find(identity) {
      const fromPlugin = readPluginToken(pluginInfoPath, identity);
      if (fromPlugin !== null) return fromPlugin;
      try {
        const run = await runExport('workbuddy');
        const { entries } = parseExportOutput(run.stdout, 'workbuddy');
        const matched = entries.find(entry => sha256(entry.account_key) === identity.identity_hash);
        return matched ? matched.token : null;
      } catch {
        return null;
      }
    },
  };
}
