/**
 * ACC-13：minimax 桌面客户端登录态切换（文件级）。
 *
 * 凭据落盘位置（已实测本机）：`~/.minimax/auth/<buildEnv>/<region>/mcode-public/auth.json`，
 * 结构 `{schemaVersion, records:{<clientId>:{accessToken, refreshToken, expiresAtMs, ...}}}`（纯 JSON，无 DPAPI）。
 *
 * 流程（与 workbuddyDesktopProvider 的契约对齐）：preflight → stop → snapshot → validate_target →
 * write → start → verify；任一步失败 → rollback 到快照，回滚成功抛 `SWITCH_ROLLED_BACK`，
 * 回滚也失败抛 `RECOVERY_REQUIRED`（由 `runAccountOperation` 落 `recovery_required` 状态）。
 *
 * 与签到解耦：签到只用 vault 里该账号的凭据（`checkin_credential_ref`），**不依赖**客户端当前登录态；
 * 切换失败不影响签到能力。
 *
 * trae：取证结论是登录态不在可安全改写的明文文件里（见卡评论），因此不提供文件级切换，
 * 能力表里保持 `switch: false` + `reason_code: 'LOGIN_STATE_NOT_FILE_BASED'`。
 */
import { createHash, randomUUID } from 'node:crypto';
import { promises as nodeFs } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import type { AccountOperation, ManagedAccount } from '@agentboard/shared';
import type { Db } from '../../db/connection.js';
import { ApiError, NotFoundError } from '../../errors.js';
import { getManagedAccount } from '../../db/repos/managedAccount.js';
import { runAccountOperation } from './operationRunner.js';
import type { CheckinVault } from './checkinProvider.js';

export const MINIMAX_APP_ID = 'minimax' as const;

export interface MinimaxPaths {
  /** auth.json 绝对路径 */
  authFile: string;
  /** 客户端可执行文件（preflight 存在性 + 启停用） */
  clientExe: string;
}

export interface MinimaxFileSystem {
  exists(path: string): Promise<boolean>;
  readFile(path: string): Promise<Buffer>;
  writeFile(path: string, data: Buffer, mode: number): Promise<void>;
  rename(from: string, to: string): Promise<void>;
  copyFile(from: string, to: string): Promise<void>;
  remove(path: string): Promise<void>;
}

export interface MinimaxProcessControl {
  isRunning(exePath: string): Promise<boolean>;
  stop(exePath: string): Promise<void>;
  start(exePath: string): Promise<void>;
}

export interface MinimaxProviderDeps {
  db: Db;
  vault: CheckinVault;
  paths?: MinimaxPaths;
  fs?: MinimaxFileSystem;
  process?: MinimaxProcessControl;
  now?: () => number;
}

/** 默认路径：`~/.minimax/auth/prod/cn/mcode-public/auth.json`（本机实测） */
export function defaultMinimaxPaths(home: string = homedir()): MinimaxPaths {
  return {
    authFile: join(home, '.minimax', 'auth', 'prod', 'cn', 'mcode-public', 'auth.json'),
    clientExe: join(home, 'AppData', 'Local', 'Programs', 'MiniMax', 'MiniMax.exe'),
  };
}

const defaultFs: MinimaxFileSystem = {
  exists: async path => nodeFs.access(path).then(() => true, () => false),
  readFile: path => nodeFs.readFile(path),
  writeFile: async (path, data, mode) => { await nodeFs.writeFile(path, data, { mode }); },
  rename: (from, to) => nodeFs.rename(from, to),
  copyFile: (from, to) => nodeFs.copyFile(from, to),
  remove: path => nodeFs.rm(path, { force: true }),
};

interface AuthRecord { accessToken?: string; refreshToken?: string; expiresAtMs?: number; [key: string]: unknown }
interface AuthFile { schemaVersion?: number; records?: Record<string, AuthRecord>; [key: string]: unknown }

const parseAuth = (buffer: Buffer): AuthFile => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(buffer.toString('utf8'));
  } catch {
    throw new ApiError(409, 'CLIENT_STATE_UNREADABLE', '客户端凭据文件无法解析');
  }
  if (!parsed || typeof parsed !== 'object') throw new ApiError(409, 'CLIENT_STATE_UNREADABLE', '客户端凭据文件结构不符合预期');
  return parsed as AuthFile;
};

const recordEntries = (file: AuthFile): Array<[string, AuthRecord]> => Object.entries(file.records ?? {});

const tokenOf = (record: AuthRecord): string => String(record.accessToken ?? '').trim();

/** 从 auth.json 里挑有效期最晚的可用记录，返回 clientId + token */
export function readMinimaxIdentity(file: AuthFile): { clientId: string; token: string } | null {
  let best: { clientId: string; token: string; expires: number } | null = null;
  for (const [clientId, record] of recordEntries(file)) {
    const token = tokenOf(record);
    if (!token) continue;
    const expires = Number(record.expiresAtMs ?? 0);
    if (!best || expires > best.expires) best = { clientId, token, expires };
  }
  return best ? { clientId: best.clientId, token: best.token } : null;
}

export class MinimaxDesktopProvider {
  private readonly db: Db;
  private readonly vault: CheckinVault;
  private readonly paths: MinimaxPaths;
  private readonly fs: MinimaxFileSystem;
  private readonly process: MinimaxProcessControl;
  private readonly now: () => number;

  constructor(deps: MinimaxProviderDeps) {
    this.db = deps.db;
    this.vault = deps.vault;
    this.paths = deps.paths ?? defaultMinimaxPaths();
    this.fs = deps.fs ?? defaultFs;
    this.process = deps.process ?? {
      isRunning: async () => false,
      stop: async () => { throw new ApiError(409, 'CLIENT_STOP_UNAVAILABLE', '未装配客户端停止能力'); },
      start: async () => { throw new ApiError(409, 'CLIENT_START_UNAVAILABLE', '未装配客户端启动能力'); },
    };
    this.now = deps.now ?? (() => Date.now());
  }

  private scope(account: { identity_hash: string; client_instance_id: string }) {
    return { app_id: MINIMAX_APP_ID, client_instance_id: account.client_instance_id, identity_hash: account.identity_hash, purpose: 'checkin' as const };
  }

  /** cell: preflight —— 客户端路径存在且凭据文件可读 */
  async preflight(): Promise<{ authFile: string; bytes: Buffer }> {
    if (!(await this.fs.exists(this.paths.authFile))) throw new ApiError(409, 'CLIENT_PATH_MISSING', '未找到 MiniMax 客户端凭据文件');
    if (!(await this.fs.exists(this.paths.clientExe))) throw new ApiError(409, 'CLIENT_PATH_MISSING', '未找到 MiniMax 客户端可执行文件');
    return { authFile: this.paths.authFile, bytes: await this.fs.readFile(this.paths.authFile) };
  }

  /** capture：把当前登录态落成账号行（token 与整份快照都进 vault） */
  async captureCurrent(options: { display_name?: string } = {}): Promise<ManagedAccount> {
    const { bytes } = await this.preflight();
    const identity = readMinimaxIdentity(parseAuth(bytes));
    if (!identity) throw new ApiError(409, 'CLIENT_NOT_LOGGED_IN', 'MiniMax 客户端当前没有可用登录态');
    const clientInstanceId = 'minimax-desktop';
    const identityHash = createHash('sha256').update(`${MINIMAX_APP_ID}\u0000${identity.clientId}`).digest('hex');
    const scope = { app_id: MINIMAX_APP_ID, client_instance_id: clientInstanceId, identity_hash: identityHash, purpose: 'checkin' as const };
    const credentialRef = await this.vault.protect(Buffer.from(identity.token, 'utf8'), scope);
    const snapshotRef = await this.vault.protect(bytes, scope);
    const existing = this.db.prepare('SELECT id FROM managed_account WHERE app_id=? AND client_instance_id=? AND identity_hash=?')
      .get(MINIMAX_APP_ID, clientInstanceId, identityHash) as { id: string } | undefined;
    const timestamp = this.now();
    if (existing) {
      this.db.prepare('UPDATE managed_account SET display_name=?, checkin_credential_ref=?, client_snapshot_ref=?, client_snapshot_version=client_snapshot_version+1, updated_at=? WHERE id=?')
        .run(options.display_name ?? identity.clientId.slice(0, 100), credentialRef, snapshotRef, timestamp, existing.id);
      return getManagedAccount(this.db, existing.id)!;
    }
    const id = randomUUID();
    this.db.prepare(`INSERT INTO managed_account
      (id,app_id,client_instance_id,service_region,identity_hash,display_name,identity_hint,client_snapshot_ref,checkin_credential_ref,client_snapshot_version,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(id, MINIMAX_APP_ID, clientInstanceId, 'cn', identityHash, (options.display_name ?? identity.clientId).slice(0, 100), null, snapshotRef, credentialRef, 1, timestamp, timestamp);
    return getManagedAccount(this.db, id)!;
  }

  /** switch：停客户端 → 快照 → 写目标 token → 启动 → 校验；失败回滚 */
  async switchAccount(accountId: string, hooks: { onOperationCreated?: (id: string) => void } = {}): Promise<AccountOperation> {
    const account = getManagedAccount(this.db, accountId);
    if (!account) throw new NotFoundError('账号不存在');
    if (account.app_id !== MINIMAX_APP_ID) throw new ApiError(409, 'ACCOUNT_APP_MISMATCH', '账号不属于 MiniMax');
    return runAccountOperation(
      this.db,
      { account_id: account.id, app_id: MINIMAX_APP_ID, client_instance_id: account.client_instance_id, operation: 'switch' },
      async () => {
        const preflight = await this.preflight();
        const original = preflight.bytes;
        if (await this.process.isRunning(this.paths.clientExe)) await this.process.stop(this.paths.clientExe);
        const snapshotRef = await this.vault.protect(original, this.scope(account));
        this.db.prepare('UPDATE managed_account SET client_snapshot_ref=?, client_snapshot_version=client_snapshot_version+1, updated_at=? WHERE id=?')
          .run(snapshotRef, this.now(), account.id);
        if (!account.checkin_credential_ref) throw new ApiError(409, 'TARGET_CREDENTIAL_MISSING', '目标账号没有可用凭据');
        const targetToken = (await this.vault.unprotect(account.checkin_credential_ref, this.scope(account))).toString('utf8').trim();
        if (!targetToken) throw new ApiError(409, 'TARGET_CREDENTIAL_MISSING', '目标账号凭据为空');
        const file = parseAuth(original);
        const entries = recordEntries(file);
        if (entries.length === 0) throw new ApiError(409, 'CLIENT_STATE_UNREADABLE', '客户端凭据文件没有记录');
        const rewritten: AuthFile = {
          ...file,
          records: Object.fromEntries(entries.map(([key, record]) => [key, { ...record, accessToken: targetToken }])),
        };
        const temp = `${this.paths.authFile}.agentboard-${randomUUID()}.tmp`;
        try {
          await this.fs.writeFile(temp, Buffer.from(JSON.stringify(rewritten), 'utf8'), 0o600);
          await this.fs.rename(temp, this.paths.authFile);
        } catch {
          await this.fs.remove(temp);
          throw new ApiError(409, 'SWITCH_WRITE_FAILED', '写入客户端凭据失败');
        }
        await this.process.start(this.paths.clientExe);
        const verified = readMinimaxIdentity(parseAuth(await this.fs.readFile(this.paths.authFile)));
        if (!verified || verified.token !== targetToken) {
          const restored = await this.restoreSnapshot(snapshotRef, account);
          if (!restored) throw new ApiError(409, 'RECOVERY_REQUIRED', '切换校验失败且回滚未成功');
          throw new ApiError(409, 'SWITCH_ROLLED_BACK', '切换后校验失败，已回滚到原账号');
        }
        return 'succeeded';
      },
      hooks,
      { tryLock: true },
    );
  }

  /** 把快照写回磁盘；返回是否成功 */
  private async restoreSnapshot(snapshotRef: string, account: ManagedAccount): Promise<boolean> {
    try {
      const bytes = await this.vault.unprotect(snapshotRef, this.scope(account));
      const temp = `${this.paths.authFile}.agentboard-restore-${randomUUID()}.tmp`;
      await this.fs.writeFile(temp, bytes, 0o600);
      await this.fs.rename(temp, this.paths.authFile);
      return true;
    } catch {
      return false;
    }
  }
}

/** 计算 minimax 账号的稳定实例目录（导出用，便于文档与测试引用） */
export const minimaxInstanceDir = (authFile: string): string => resolve(dirname(authFile));
