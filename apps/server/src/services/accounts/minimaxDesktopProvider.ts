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
import { updateAccountOperation } from '../../db/repos/accountOperation.js';
import { ApiError, NotFoundError } from '../../errors.js';
import { CLIENT_PROCESS_ERROR_CODES, createClientProcessControl, type ClientProcessControl } from './clientProcess.js';
import { getManagedAccount } from '../../db/repos/managedAccount.js';
import { runAccountOperation } from './operationRunner.js';
import type { CheckinVault } from './checkinProvider.js';
import { parseMinimaxCredential } from './httpCheckinProviders.js';
import { createMinimaxClientProbe, type MinimaxClientProbe } from './minimaxClientProbe.js';
import { runSwitchFlow } from './switchFlow.js';
import { credentialUid, validateTarget, verifyByServerUid, type ServerIdentityProbe, type ValidatedTarget } from './switchStages.js';

export const MINIMAX_APP_ID = 'minimax' as const;

/** 进程级探测缓存：provider 默认使用（与能力矩阵同一套候选与原因码） */
const cachedMinimaxClientProbe = createMinimaxClientProbe();

/** agent 云端 API（与签到 provider 同一套服务端） */
const MINIMAX_AGENT_BASE = 'https://agent.minimaxi.com/minimax-cloud/api/v1';

const asRecord = (value: unknown): Record<string, unknown> =>
  (value && typeof value === 'object' ? value as Record<string, unknown> : {});
const str = (value: unknown): string | null =>
  (typeof value === 'string' && value.trim() !== '' ? value : null);

/**
 * B4S-3：MiniMax 的服务端身份探针。
 *
 * 用客户端此刻持有的凭据调一次**需鉴权**的 agent 云端接口：服务端认这份凭据才算数
 * （200 = 认；401/403 = 不认 → `SERVER_CREDENTIAL_REJECTED`）。
 * 服务端若在响应里带出身份标识就用它比对；没带时退到凭据里 **服务端签名** 的 JWT `sub`
 * （仍是服务端签发的身份，不是本地文件里的自说自话）。
 */
export function createMinimaxServerIdentityProbe(options: { fetchImpl?: typeof fetch; timeoutMs?: number } = {}): ServerIdentityProbe {
  const fetchImpl = options.fetchImpl ?? fetch;
  return {
    async probe(token: string): Promise<{ uid: string | null }> {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? 15_000);
      try {
        const response = await fetchImpl(`${MINIMAX_AGENT_BASE}/signin/status`, {
          method: 'GET',
          headers: { authorization: `Bearer ${token}`, accept: 'application/json' },
          signal: controller.signal,
        });
        if (response.status === 401 || response.status === 403) {
          throw new ApiError(409, 'SERVER_CREDENTIAL_REJECTED', '服务端不认这份凭据');
        }
        if (!response.ok) {
          throw new ApiError(409, 'SERVER_CREDENTIAL_REJECTED', `服务端身份校验请求失败（HTTP ${response.status}）`);
        }
        let body: unknown = null;
        try { body = await response.json(); } catch { body = null; }
        const data = asRecord(asRecord(body).data);
        const uid = str(data.user_id) ?? str(data.uid) ?? str(data.account_id) ?? str(asRecord(body).user_id) ?? null;
        return { uid: uid ?? credentialUid(token) };
      } finally {
        clearTimeout(timer);
      }
    },
  };
}

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
  /** MINIMAX-PATH：客户端 exe 探测（默认用 60s 缓存的内置探测；测试可注入） */
  clientProbe?: Pick<MinimaxClientProbe, 'get'>;
  /**
   * B4S-3：S5 服务端身份校验探针。
   *
   * **默认不装配**（= 该 provider 没有服务端校验能力 → S5 如实报 `PROVIDER_NOT_IMPLEMENTED`）；
   * 生产由装配根（`index.ts`）显式注入 `createMinimaxServerIdentityProbe()`。
   * 这样「能力是否具备」由装配决定，测试也不会意外发起真实网络请求。
   */
  serverIdentityProbe?: ServerIdentityProbe | null;
}

/** 默认路径：`~/.minimax/auth/prod/cn/mcode-public/auth.json`（本机实测） */
export function defaultMinimaxPaths(home: string = homedir()): MinimaxPaths {
  return {
    authFile: join(home, '.minimax', 'auth', 'prod', 'cn', 'mcode-public', 'auth.json'),
    // MINIMAX-PATH：exe 不再写死单一路径，未显式指定时由探测结果决定（见 resolveClientExe）
    clientExe: '',
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

export interface MinimaxIdentity {
  clientId: string;
  token: string;
  /** ACC-FIX-5：auth.json 里的 refreshToken（旧文件可能没有 → null） */
  refreshToken: string | null;
  expiresAt: number | null;
}

/** 从 auth.json 里挑有效期最晚的可用记录，返回 clientId + token + refreshToken */
export function readMinimaxIdentity(file: AuthFile): MinimaxIdentity | null {
  let best: { clientId: string; token: string; expires: number; refreshToken: string | null } | null = null;
  for (const [clientId, record] of recordEntries(file)) {
    const token = tokenOf(record);
    if (!token) continue;
    const expires = Number(record.expiresAtMs ?? 0);
    if (!best || expires > best.expires) best = { clientId, token, expires, refreshToken: str(record.refreshToken) };
  }
  if (!best) return null;
  return {
    clientId: best.clientId,
    token: best.token,
    refreshToken: best.refreshToken,
    expiresAt: Number.isFinite(best.expires) && best.expires > 0 ? best.expires : null,
  };
}

export class MinimaxDesktopProvider {
  private readonly db: Db;
  private readonly vault: CheckinVault;
  private readonly paths: MinimaxPaths;
  private readonly fs: MinimaxFileSystem;
  private readonly process: MinimaxProcessControl;
  private readonly now: () => number;
  private readonly clientProbe: Pick<MinimaxClientProbe, 'get'>;
  private readonly serverIdentityProbe: ServerIdentityProbe | null;
  /** 探测一次后在本实例内复用（探测本身有 TTL 缓存） */
  private resolvedClientExe: string | null = null;

  constructor(deps: MinimaxProviderDeps) {
    this.db = deps.db;
    this.vault = deps.vault;
    this.paths = deps.paths ?? defaultMinimaxPaths();
    this.fs = deps.fs ?? defaultFs;
    // B4S-1：默认接真实进程探测/停止（之前 isRunning 恒 false，等于在跑时也会覆盖 auth.json）
    const realProcess = createClientProcessControl();
    this.process = deps.process ?? {
      isRunning: (exePath: string) => realProcess.isRunning(exePath),
      stop: (exePath: string) => realProcess.stop(exePath),
      start: async () => { throw new ApiError(409, 'CLIENT_START_UNAVAILABLE', '未装配客户端启动能力'); },
    };
    this.now = deps.now ?? (() => Date.now());
    this.clientProbe = deps.clientProbe ?? cachedMinimaxClientProbe;
    this.serverIdentityProbe = deps.serverIdentityProbe ?? null;
  }

  private scope(account: { identity_hash: string; client_instance_id: string }) {
    return { app_id: MINIMAX_APP_ID, client_instance_id: account.client_instance_id, identity_hash: account.identity_hash, purpose: 'checkin' as const };
  }

  /**
   * 解析客户端 exe：显式 `paths.clientExe` 优先（调用方指定/测试注入），否则用探测结果。
   * 探测不到时按原因码报错：真未装 → `CLIENT_NOT_INSTALLED`；装在非默认位置但定位不到 → `CLIENT_PATH_UNRESOLVED`（文案指向 AGENTBOARD_MINIMAX_EXE）。
   */
  private async resolveClientExe(): Promise<string> {
    if (this.paths.clientExe !== '') return this.paths.clientExe;
    if (this.resolvedClientExe !== null) return this.resolvedClientExe;
    const status = await this.clientProbe.get();
    if (!status.exe) throw new ApiError(409, status.reason_code, status.message);
    this.resolvedClientExe = status.exe;
    return status.exe;
  }

  /** cell: preflight —— 客户端路径存在且凭据文件可读 */
  async preflight(): Promise<{ authFile: string; bytes: Buffer }> {
    if (!(await this.fs.exists(this.paths.authFile))) throw new ApiError(409, 'CLIENT_PATH_MISSING', '未找到 MiniMax 客户端凭据文件');
    const clientExe = await this.resolveClientExe();
    if (!(await this.fs.exists(clientExe))) throw new ApiError(409, 'CLIENT_PATH_MISSING', `未找到 MiniMax 客户端可执行文件：${clientExe}`);
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
    /**
     * ACC-FIX-5：auth.json 带 refreshToken 时按 JSON 载荷落库，与导入线同形态（ACC-FIX-3），
     * 签到 401 后能走 refresh 自愈；旧文件没有 refreshToken 时保留裸串，不伪造续期能力。
     */
    const credentialPayload = identity.refreshToken
      ? JSON.stringify({ access_token: identity.token, refresh_token: identity.refreshToken, expires_at: identity.expiresAt })
      : identity.token;
    const credentialRef = await this.vault.protect(Buffer.from(credentialPayload, 'utf8'), scope);
    const snapshotRef = await this.vault.protect(bytes, scope);
    const existing = this.db.prepare('SELECT id FROM managed_account WHERE app_id=? AND client_instance_id=? AND identity_hash=?')
      .get(MINIMAX_APP_ID, clientInstanceId, identityHash) as { id: string } | undefined;
    const timestamp = this.now();
    if (existing) {
      this.db.prepare("UPDATE managed_account SET display_name=?, checkin_credential_ref=?, checkin_capability='supported', client_snapshot_ref=?, client_snapshot_version=client_snapshot_version+1, updated_at=? WHERE id=?")
        .run(options.display_name ?? identity.clientId.slice(0, 100), credentialRef, snapshotRef, timestamp, existing.id);
      return getManagedAccount(this.db, existing.id)!;
    }
    const id = randomUUID();
    this.db.prepare(`INSERT INTO managed_account
      (id,app_id,client_instance_id,service_region,identity_hash,display_name,identity_hint,client_snapshot_ref,checkin_credential_ref,client_snapshot_version,checkin_capability,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(id, MINIMAX_APP_ID, clientInstanceId, 'cn', identityHash, (options.display_name ?? identity.clientId).slice(0, 100), null, snapshotRef, credentialRef, 1, 'supported', timestamp, timestamp);
    return getManagedAccount(this.db, id)!;
  }

  /**
   * ACC-SWITCH：读 auth.json 判定「客户端当前登录身份」的哈希（身份口径与 captureCurrent 一致）。
   * 只读凭据文件、不要求 exe 存在、不抛错：读不到/解不开 → null（列表显示「当前未知」）。
   */
  async getCurrentIdentityHash(): Promise<string | null> {
    try {
      if (!(await this.fs.exists(this.paths.authFile))) return null;
      const identity = readMinimaxIdentity(parseAuth(await this.fs.readFile(this.paths.authFile)));
      if (!identity) return null;
      return createHash('sha256').update(`${MINIMAX_APP_ID}\u0000${identity.clientId}`).digest('hex');
    } catch {
      return null;
    }
  }

  /**
   * switch：走**共用骨架**（B4S-4），本类只提供各步回调。
   * 步序：preflight（含「客户端在跑则阻断」）→ stop → snapshot → validate_target → write → start → verify →（失败）rollback。
   */
  async switchAccount(accountId: string, hooks: { onOperationCreated?: (id: string) => void } = {}): Promise<AccountOperation> {
    const account = getManagedAccount(this.db, accountId);
    if (!account) throw new NotFoundError('账号不存在');
    if (account.app_id !== MINIMAX_APP_ID) throw new ApiError(409, 'ACCOUNT_APP_MISMATCH', '账号不属于 MiniMax');
    return runAccountOperation(
      this.db,
      { account_id: account.id, app_id: MINIMAX_APP_ID, client_instance_id: account.client_instance_id, operation: 'switch' },
      async op => {
        if (hooks.onOperationCreated) hooks.onOperationCreated(op.id);
        // 骨架回调之间要传递的中间产物
        let original: Buffer | null = null;
        let clientExe = '';
        let target: ValidatedTarget | null = null;

        await runSwitchFlow({
          setStage: stage => this.setStage(op, stage),
          callbacks: {
            // S0：读客户端凭据文件 + 定位客户端 exe
            preflight: async () => {
              const pre = await this.preflight();
              clientExe = await this.resolveClientExe();
              original = pre.bytes;
            },
            // S1：客户端在跑必须先停掉并确认退出；探测/停止失败一律中止（绝不在客户端运行时覆盖 auth.json）
            stop: async () => {
              let running: boolean;
              try {
                running = await this.process.isRunning(clientExe);
              } catch (error) {
                // B4S-1：阻断点在 preflight 语义内（未改动 auth.json），stage 留在 preflight
                this.setStage(op, 'preflight');
                if (error instanceof ApiError) throw error;
                throw new ApiError(409, CLIENT_PROCESS_ERROR_CODES.probeFailed, '无法确认 MiniMax 客户端是否在运行，已中止切换');
              }
              if (!running) return;
              try {
                await this.process.stop(clientExe);
              } catch (error) {
                this.setStage(op, 'preflight');
                throw error;
              }
              if (await this.process.isRunning(clientExe)) {
                this.setStage(op, 'preflight');
                throw new ApiError(409, CLIENT_PROCESS_ERROR_CODES.stopTimeout, 'MiniMax 客户端仍在运行，已中止切换（未改动 auth.json）');
              }
            },
            // S2：快照当前凭据进 vault（回滚依据）
            snapshot: async () => {
              const snapshotRef = await this.vault.protect(original!, this.scope(account));
              this.db.prepare('UPDATE managed_account SET client_snapshot_ref=?, client_snapshot_version=client_snapshot_version+1, updated_at=? WHERE id=?')
                .run(snapshotRef, this.now(), account.id);
              return snapshotRef;
            },
            // S3：共用目标校验（账号在 / 属于本产品 / 凭据可解 / 身份可确定）
            validateTarget: async () => {
              if (!account.checkin_credential_ref) throw new ApiError(409, 'TARGET_CREDENTIAL_MISSING', '目标账号没有可用凭据');
              const storedCredential = await this.vault.unprotect(account.checkin_credential_ref, this.scope(account));
              // ACC-FIX-5：vault 里可能是 {access_token,refresh_token} JSON（捕获/导入线同形态），
              // 写客户端只认裸 accessToken，身份也只从裸串取。
              const targetCredential = Buffer.from(parseMinimaxCredential(storedCredential).access_token, 'utf8');
              target = validateTarget({
                app_id: MINIMAX_APP_ID,
                account,
                credential: targetCredential,
                uid: credentialUid(targetCredential),
              });
              return target;
            },
            // S4：临时文件 + rename 原子替换
            write: async (value) => {
              const file = parseAuth(original!);
              const entries = recordEntries(file);
              if (entries.length === 0) throw new ApiError(409, 'CLIENT_STATE_UNREADABLE', '客户端凭据文件没有记录');
              const targetToken = value.credential.toString('utf8').trim();
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
                // 写盘失败 = 客户端文件**未被改动**（临时文件已删，rename 是原子的）：
                // stage 退回 write 之前，避免 operationRunner 按「可能已写客户端」把实例误冻成 recovery_required。
                this.setStage(op, 'validate_target');
                throw new ApiError(409, 'SWITCH_WRITE_FAILED', '写入客户端凭据失败');
              }
            },
            // S5：启动客户端
            start: async () => { await this.process.start(clientExe); },
            // S5：服务端身份校验——本地 token 比对只作辅助信号，最终以服务端认可的身份为准
            verify: async () => {
              const liveToken = readMinimaxIdentity(parseAuth(await this.fs.readFile(this.paths.authFile)))?.token ?? '';
              if (liveToken !== target!.credential.toString('utf8').trim()) {
                throw new ApiError(409, 'TARGET_IDENTITY_MISMATCH', '客户端当前凭据与目标不一致');
              }
              await verifyByServerUid({
                app_id: MINIMAX_APP_ID,
                token: liveToken,
                expectedUid: target!.uid,
                probe: this.serverIdentityProbe,
              });
            },
            // 回滚：写回快照（失败 → recovery_ref → 由 A3 restore 通道重放）
            rollback: async (snapshotRef, cause) => { await this.rollbackToSnapshot(op, snapshotRef, account, cause); },
          },
        });
        return 'succeeded';
      },
      hooks,
      { tryLock: true },
    );
  }

  private setStage(op: AccountOperation, stage: AccountOperation['stage']): void {
    updateAccountOperation(this.db, op.id, { stage });
  }

  /**
   * 回滚：把快照写回客户端。
   * - 回滚成功 → 抛 `SWITCH_ROLLED_BACK`（原账号已恢复，实例不冻结）；
   * - 回滚失败 → 落 `recovery_ref`（快照 = 恢复依据）并抛 `RECOVERY_REQUIRED`，实例冻结，
   *   由 A3 的 restore 端点重放回滚（不再另造一条恢复通道）。
   */
  private async rollbackToSnapshot(op: AccountOperation, snapshotRef: string, account: ManagedAccount, cause: string): Promise<never> {
    const restored = await this.restoreSnapshot(snapshotRef, account);
    if (!restored) {
      updateAccountOperation(this.db, op.id, { recovery_ref: snapshotRef });
      throw new ApiError(409, 'RECOVERY_REQUIRED', '切换校验失败且回滚未成功，该实例已冻结，需经 restore 端点解冻');
    }
    throw new ApiError(409, 'SWITCH_ROLLED_BACK', `切换失败已回滚并核验原账号（失败原因: ${cause}）`);
  }

  /** A3 restore 通道：把快照写回客户端（回滚重放）；失败抛错，实例保持冻结，可再次触发 */
  async restoreFromSnapshot(input: { account: ManagedAccount; snapshotRef: string }): Promise<void> {
    const restored = await this.restoreSnapshot(input.snapshotRef, input.account);
    if (!restored) throw new ApiError(409, 'SNAPSHOT_WRITE_FAILED', '恢复快照失败');
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
