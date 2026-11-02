/**
 * ACC-11：从本机读取三平台凭据并写入加密 vault。
 *
 * 安全边界（卡上的硬约束）：
 * - **只在显式调用导入端点时运行**，没有任何启动/定时扫描；
 * - 脚本 stdout 视为**不可信输入**（长度上限、JSON 解析失败给出固定错误码，绝不把原始 stdout 拼进响应）；
 * - token 只经 `vault.protect` 落密文引用；本模块不打日志、不回响应、不落明文文件；
 * - `identity_hash` 由 `account_key`（sub/uid/clientId）派生，不用 token 原文；
 * - `execFile('python', [...])` 不走 shell 拼接。
 */
import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import type { Db } from '../../db/connection.js';
import { findManagedAccountByIdentity, getManagedAccount } from '../../db/repos/managedAccount.js';
import type { CheckinVault } from './checkinProvider.js';

export type ExportPlatform = 'workbuddy' | 'trae' | 'minimax';
export type ImportedAppId = 'workbuddy_desktop' | 'trae' | 'minimax';

export const EXPORT_PLATFORMS: ExportPlatform[] = ['workbuddy', 'trae', 'minimax'];

const APP_ID_BY_PLATFORM: Record<ExportPlatform, ImportedAppId> = {
  workbuddy: 'workbuddy_desktop',
  trae: 'trae',
  minimax: 'minimax',
};

/** 导入时用的稳定 client_instance_id：让 UNIQUE(app_id, client_instance_id, identity_hash) 在重复导入时命中同一行 */
const IMPORT_CLIENT_INSTANCE = 'imported';
const DEFAULT_TIMEOUT_MS = 20_000;
const MAX_STDOUT_BYTES = 2 * 1024 * 1024;
const MAX_STDERR_CHARS = 2000;

const entrySchema = z.object({
  platform: z.enum(['workbuddy', 'trae', 'minimax']),
  account_key: z.string().trim().min(1).max(200),
  display_hint: z.string().max(120).optional(),
  token: z.string().min(8),
  expires_at: z.number().finite().nullish(),
}).strict();

export interface ExportRun { stdout: string; stderr: string; durationMs: number }
export type ExportRunner = (platform: ExportPlatform) => Promise<ExportRun>;

export interface PlatformImportSummary {
  platform: ExportPlatform;
  app_id: ImportedAppId;
  found: number;
  created: number;
  updated: number;
  skipped: number;
  /** 固定错误码，绝不含 stdout/stderr 原文 */
  error: string | null;
}

export interface ImportedAccountSummary {
  account_id: string;
  app_id: ImportedAppId;
  display_name: string;
  action: 'created' | 'updated';
  expires_at: number | null;
}

export interface CredentialImportResult {
  batch_id: string;
  actor: string;
  duration_ms: number;
  platforms: PlatformImportSummary[];
  accounts: ImportedAccountSummary[];
  /** 本机 python 不可用等需要前端提示的整批级错误码 */
  error: string | null;
}

export interface CredentialImportDeps {
  db: Db;
  vault: CheckinVault;
  /** 测试注入：替换真实 python 子进程 */
  runExport?: ExportRunner;
  pythonCommand?: string;
  scriptPath?: string;
  timeoutMs?: number;
  now?: () => number;
  onAudit?: (line: Record<string, unknown>) => void;
}

const defaultScriptPath = (): string =>
  join(fileURLToPath(new URL('.', import.meta.url)), '..', '..', '..', 'scripts', 'accounts', 'export_credentials.py');

const sha256 = (value: string): string => createHash('sha256').update(value).digest('hex');

/** 默认 runner：execFile（无 shell），超时与输出上限在此收口 */
function defaultRunner(options: { pythonCommand: string; scriptPath: string; timeoutMs: number }): ExportRunner {
  return (platform) => new Promise((resolve, reject) => {
    const started = Date.now();
    execFile(
      options.pythonCommand,
      [options.scriptPath, '--platform', platform, '--json'],
      { timeout: options.timeoutMs, maxBuffer: MAX_STDOUT_BYTES, windowsHide: true, encoding: 'utf8' },
      (error, stdout, stderr) => {
        if (error) {
          const code = (error as { code?: string }).code;
          if (code === 'ENOENT') { reject(Object.assign(new Error('python missing'), { reason: 'PYTHON_UNAVAILABLE' })); return; }
          if (code === 'ETIMEDOUT' || /timed? ?out/i.test(error.message)) { reject(Object.assign(new Error('timeout'), { reason: 'EXPORT_TIMEOUT' })); return; }
          reject(Object.assign(new Error('export failed'), { reason: 'EXPORT_FAILED' }));
          return;
        }
        resolve({ stdout, stderr: String(stderr ?? '').slice(0, MAX_STDERR_CHARS), durationMs: Date.now() - started });
      },
    );
  });
}

/** stdout → 账号条目；任何异常都收敛成固定错误码，不回传原文 */
export function parseExportOutput(stdout: string, platform: ExportPlatform): { entries: z.infer<typeof entrySchema>[]; error: string | null } {
  if (stdout.length > MAX_STDOUT_BYTES) return { entries: [], error: 'EXPORT_OUTPUT_INVALID' };
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout.trim());
  } catch {
    return { entries: [], error: 'EXPORT_OUTPUT_INVALID' };
  }
  if (!Array.isArray(parsed)) return { entries: [], error: 'EXPORT_OUTPUT_INVALID' };
  const entries: z.infer<typeof entrySchema>[] = [];
  for (const item of parsed) {
    const checked = entrySchema.safeParse(item);
    if (!checked.success) continue;
    if (checked.data.platform !== platform) continue;
    entries.push(checked.data);
  }
  return { entries, error: null };
}

export function createCredentialImporter(deps: CredentialImportDeps) {
  const now = deps.now ?? (() => Date.now());
  const runExport = deps.runExport ?? defaultRunner({
    pythonCommand: deps.pythonCommand ?? 'python',
    scriptPath: deps.scriptPath ?? defaultScriptPath(),
    timeoutMs: deps.timeoutMs ?? DEFAULT_TIMEOUT_MS,
  });
  const audit = deps.onAudit ?? ((line: Record<string, unknown>) => console.log('[credential-import]', JSON.stringify(line)));

  return {
    async importCredentials(input: { platforms?: ExportPlatform[]; actor: string; batchId?: string }): Promise<CredentialImportResult> {
      const startedAt = now();
      const batchId = input.batchId ?? randomUUID();
      const platforms = input.platforms?.length ? [...new Set(input.platforms)] : EXPORT_PLATFORMS;
      const summaries: PlatformImportSummary[] = [];
      const accounts: ImportedAccountSummary[] = [];
      let fatalError: string | null = null;

      for (const platform of platforms) {
        const appId = APP_ID_BY_PLATFORM[platform];
        const summary: PlatformImportSummary = { platform, app_id: appId, found: 0, created: 0, updated: 0, skipped: 0, error: null };
        let entries: z.infer<typeof entrySchema>[] = [];
        try {
          const run = await runExport(platform);
          const parsed = parseExportOutput(run.stdout, platform);
          entries = parsed.entries;
          summary.error = parsed.error;
        } catch (error) {
          const reason = (error as { reason?: string }).reason ?? 'EXPORT_FAILED';
          summary.error = reason === 'PYTHON_UNAVAILABLE' ? 'PYTHON_UNAVAILABLE' : reason;
          if (reason === 'PYTHON_UNAVAILABLE') fatalError = 'PYTHON_UNAVAILABLE';
        }
        summary.found = entries.length;

        for (const entry of entries) {
          const identityHash = sha256(`${appId}\u0000${entry.account_key}`);
          const displayName = (entry.display_hint?.trim() || entry.account_key).slice(0, 100);
          const existing = findManagedAccountByIdentity(deps.db, appId, IMPORT_CLIENT_INSTANCE, identityHash);
          const scope = { app_id: appId, client_instance_id: IMPORT_CLIENT_INSTANCE, identity_hash: identityHash, purpose: 'checkin' as const };
          let credentialRef: string;
          try {
            credentialRef = await deps.vault.protect(Buffer.from(entry.token, 'utf8'), scope);
          } catch {
            summary.skipped += 1;
            continue;
          }
          const timestamp = now();
          if (existing) {
            deps.db.prepare('UPDATE managed_account SET display_name=?, checkin_credential_ref=?, updated_at=? WHERE id=?')
              .run(displayName, credentialRef, timestamp, existing.id);
            // 旧密文引用作废即删，避免重复导入让 vault 里堆孤儿文件（失败不影响导入结果）
            const previousRef = existing.checkin_credential_ref;
            if (previousRef && previousRef !== credentialRef) {
              const deletable = deps.vault as { delete?: (ref: string) => Promise<void> };
              if (typeof deletable.delete === 'function') await deletable.delete(previousRef).catch(() => undefined);
            }
            summary.updated += 1;
            accounts.push({ account_id: existing.id, app_id: appId, display_name: displayName, action: 'updated', expires_at: entry.expires_at ?? null });
          } else {
            const id = randomUUID();
            deps.db.prepare(`INSERT INTO managed_account
              (id, app_id, client_instance_id, service_region, identity_hash, display_name, identity_hint, client_snapshot_ref, checkin_credential_ref, client_snapshot_version, created_at, updated_at)
              VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`)
              .run(id, appId, IMPORT_CLIENT_INSTANCE, 'unknown', identityHash, displayName, null, null, credentialRef, 1, timestamp, timestamp);
            summary.created += 1;
            accounts.push({ account_id: getManagedAccount(deps.db, id)!.id, app_id: appId, display_name: displayName, action: 'created', expires_at: entry.expires_at ?? null });
          }
        }

        summaries.push(summary);
        // 审计：每次导入每个平台一条 operation 行（不含 token / stdout），用 batch_id 归组
        const state = summary.error ? 'failed' : 'succeeded';
        const auditedAt = now();
        deps.db.prepare(`INSERT INTO account_operation
          (id, batch_id, account_id, app_id, client_instance_id, operation, state, stage, safe_error_code, recovery_ref, recovers_operation_id, created_at, started_at, finished_at)
          VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
          .run(randomUUID(), batchId, null, appId, IMPORT_CLIENT_INSTANCE, 'capture', state, 'verify',
            summary.error ?? null, `accounts=${summary.found}`, null, auditedAt, auditedAt, auditedAt);
      }

      const durationMs = Math.max(0, now() - startedAt);
      audit({
        batch_id: batchId,
        actor: input.actor,
        platforms: summaries.map(item => ({ platform: item.platform, found: item.found, created: item.created, updated: item.updated, error: item.error })),
        duration_ms: durationMs,
      });
      return { batch_id: batchId, actor: input.actor, duration_ms: durationMs, platforms: summaries, accounts, error: fatalError };
    },
  };
}
