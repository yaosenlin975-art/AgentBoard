import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, open, readFile, rm, lstat } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';
import { z } from 'zod';
import { ApiError, ValidationError } from '../../errors.js';

/** 支持的后台应用；ACC-10 起含 minimax / trae（vault scope 随 ManagedAppId 一起扩展） */
export const managedAppSchema = z.enum(['workbuddy_desktop', 'codebuddy_desktop', 'minimax', 'trae', 'qoder_cn', 'zcode']);
/** ACC-CLI-MULTI：CLI 额度来源（只登记本机凭据，不参与桌面客户端的快照/签到语义） */
export const cliAppSchema = z.enum(['deepseek', 'opencode_go', 'codex', 'commandcode']);
/** vault 的 app_id 维度 = 桌面平台 ∪ CLI 来源 */
const vaultAppSchema = z.union([managedAppSchema, cliAppSchema]);
/**
 * 凭据 scope。
 *
 * purpose 四值：
 * - `client_snapshot`：客户端登录态快照（切号写回用）；
 * - `checkin`：已激活的签到凭据（绑在已建成的 managed_account 上）；
 * - `pending_credential`（ACC-KB-B2S）：**待激活凭据**——协议级加号在授权完成前握着的中间态
 *   （device_code / PKCE verifier / poll token 等）。此时账号身份还没拿到，identity_hash 用
 *   会话 id 的 sha256 占位；授权成功即转存为 `checkin`，失败/放弃/超时就删掉，不留孤儿文件。
 * - `cli_credential`（ACC-CLI-MULTI）：CLI 三来源的本机 API key。**独立 purpose**，不与签到凭据混用；
 *   只登记、不写回客户端配置（写入/切换见 CLI-SWITCH）。
 */
const scopeSchema = z.object({ app_id: vaultAppSchema, client_instance_id: z.string().min(1).max(300), identity_hash: z.string().regex(/^[a-f0-9]{64}$/), purpose: z.enum(['client_snapshot', 'checkin', 'pending_credential', 'cli_credential']) }).strict();
export type VaultScope = z.infer<typeof scopeSchema>;
const reference = z.string().uuid();
const script = `$ErrorActionPreference='Stop'; try {
  Add-Type -AssemblyName System.Security
  $j=[Console]::In.ReadToEnd() | ConvertFrom-Json
  $bytes=[Convert]::FromBase64String($j.data)
  $entropy=[Convert]::FromBase64String($j.entropy)
  if($j.mode -eq 'protect') { $out=[Security.Cryptography.ProtectedData]::Protect($bytes,$entropy,[Security.Cryptography.DataProtectionScope]::CurrentUser) }
  else { $out=[Security.Cryptography.ProtectedData]::Unprotect($bytes,$entropy,[Security.Cryptography.DataProtectionScope]::CurrentUser) }
  [Console]::Out.Write([Convert]::ToBase64String($out))
} catch { [Console]::Error.Write('DPAPI_FAILED'); exit 1 }`;

async function dpapi(data: Buffer, scope: VaultScope, mode: 'protect' | 'unprotect'): Promise<Buffer> {
  if (process.platform !== 'win32') throw new ApiError(503, 'VAULT_UNAVAILABLE', '当前平台不支持 Windows DPAPI');
  const validated = scopeSchema.safeParse(scope);
  if (!validated.success) throw new ValidationError('凭据 scope 不合法');
  const entropy = createHash('sha256').update('AgentBoard/SecretVault/v1\0' + JSON.stringify(validated.data)).digest('base64');
  const executable = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  return new Promise((accept, reject) => {
    const error = () => new ApiError(503, mode === 'protect' ? 'VAULT_UNAVAILABLE' : 'VAULT_READ_FAILED', '凭据保护不可用或 scope 不匹配');
    const child = execFile(executable, ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true, timeout: 10000, maxBuffer: 16 * 1024 * 1024, encoding: 'utf8' }, (err, stdout) => {
      if (err || !/^[A-Za-z0-9+/]+={0,2}$/.test(stdout.trim())) { reject(error()); return; }
      accept(Buffer.from(stdout.trim(), 'base64'));
    });
    child.stdin?.on('error', () => reject(error()));
    child.stdin?.end(JSON.stringify({ mode, entropy, data: data.toString('base64') }));
  });
}
export class SecretVault {
  readonly root: string;
  constructor(root: string) { if (!isAbsolute(root)) throw new ValidationError('Vault 路径必须为绝对路径'); this.root = resolve(root); }
  private file(ref: string): string { if (!reference.safeParse(ref).success) throw new ValidationError('凭据 reference 不合法'); return join(this.root, `${ref}.dpapi`); }
  async protect(data: Buffer, scope: VaultScope): Promise<string> {
    if (!Buffer.isBuffer(data) || !data.length || data.length > 5 * 1024 * 1024) throw new ValidationError('凭据大小不合法');
    const cipher = await dpapi(data, scope, 'protect');
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    const ref = randomUUID(); const file = this.file(ref);
    try { const handle = await open(file, 'wx', 0o600); try { await handle.writeFile(cipher); await handle.sync(); } finally { await handle.close(); } }
    catch { await rm(file, { force: true }).catch(() => {}); throw new ApiError(503, 'VAULT_UNAVAILABLE', '凭据保存失败'); }
    return ref;
  }
  async unprotect(ref: string, scope: VaultScope): Promise<Buffer> {
    const file = this.file(ref);
    try { const stat = await lstat(file); if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 10 * 1024 * 1024) throw Error('invalid'); return await dpapi(await readFile(file), scope, 'unprotect'); }
    catch { throw new ApiError(503, 'VAULT_READ_FAILED', '凭据不可读取或 scope 不匹配'); }
  }
  async delete(ref: string): Promise<void> { await rm(this.file(ref), { force: true }); }
}
