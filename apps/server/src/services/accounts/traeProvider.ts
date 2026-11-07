/**
 * ACC-KB-B3：Trae CN 离线凭据捕获 provider。
 *
 * 落点：`%APPDATA%\Trae CN\User\globalStorage\storage.json`，键 `iCubeAuthInfo://icube.cloudide`
 * （`tc` 信封，解包逻辑见 `packages/adapters/src/trae/tcEnvelope.ts`）。
 *
 * 口径：
 * - 对外只返回**脱敏**字段：`token_sha8` / `token_length` / `refresh_sha8` / `refresh_length` /
 *   `user_id_sha8` / `host`；原文只在函数内部短暂存在；
 * - 失败给可读 `reason_code`，绝不返回半条凭据：
 *   `TRAE_STORAGE_MISSING`（没装/没登录）、`TRAE_ENVELOPE_MISSING`（storage.json 里没有 iCubeAuthInfo 键）、
 *   `TRAE_PEPPER_UNAVAILABLE`（pepper 与当前客户端版本不匹配 → 需要更新常量表）、
 *   `TRAE_PAYLOAD_CORRUPT`（信封损坏）、`TRAE_TOKEN_MISSING`（解开但缺 token 字段）。
 *
 * ACC-SW-TRAE：新增桌面**登录态切换**（KB knowledge:cc06032d-59de-480a-a5af-6e627ed12ff2 Trae 段，范式 A 文件级快照）。
 * 只搬 storage.json 不够（state.vscdb 按 userId 隔离、Local Storage/Partitions 是 webview 侧登录态），
 * 切换 = 停客户端 → 目录级 15 条快照/还原（traeSnapshot.ts）→ 必清 logs/、code.lock、wal/shm/journal →
 * 重启客户端 → 按 storage.json 身份核验。流程走 switchFlow 共用七步骨架，
 * 失败回滚到 S2 快照；回滚也失败落 `recovery_ref` + `RECOVERY_REQUIRED`（restore 端点重放）。
 * 捕获侧同步 best-effort 快照当前登录态（`client_snapshot_ref`），作为后续切换的目标依据。
 */
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import type { AccountOperation, ManagedAccount } from '@agentboard/shared';
import { decryptTcEnvelope, TraeEnvelopeError } from '@agentboard/adapters';
import type { Db } from '../../db/connection.js';
import { createManagedAccount, attachClientSnapshot, findManagedAccountByAppIdentity, getManagedAccount, parseCredentialExpiry, setCredentialExpiry } from '../../db/repos/managedAccount.js';
import { attachCheckinCredential } from '../../db/repos/checkin.js';
import { getAccountOperation, updateAccountOperation } from '../../db/repos/accountOperation.js';
import { ApiError, NotFoundError, ValidationError } from '../../errors.js';
import { CLIENT_PROCESS_ERROR_CODES, createClientProcessControl, type ClientProcessControl } from './clientProcess.js';
import { runAccountOperation } from './operationRunner.js';
import { jwtExpiresAt } from './addAccountProtocol.js';
import type { SecretVault, VaultScope } from './secretVault.js';
import { validateTarget, type ValidatedTarget } from './switchStages.js';
import { runSwitchFlow } from './switchFlow.js';
import {
  cleanTraeResiduals,
  createTraeSnapshot,
  defaultTraeFs,
  parseTraeSnapshotManifest,
  restoreTraeSnapshot,
  traeAbsPath,
  traeSnapshotReady,
  type TraeFileSystem,
  type TraeSnapshotManifest,
} from './traeSnapshot.js';

export const TRAE_STORAGE_KEY = 'iCubeAuthInfo://icube.cloudide';

export const TRAE_APP_ID = 'trae' as const;

/** 快照 manifest 里承载 IDE 侧登录态的条目（validate_target 用它做身份核验） */
export const TRAE_STORAGE_RELATIVE_PATH = 'User/globalStorage/storage.json';

export interface TraeCaptureEntry {
  /** 令牌 sha256 前 8 位（脱敏） */
  token_sha8: string;
  token_length: number;
  refresh_sha8: string;
  refresh_length: number;
  user_id_sha8: string | null;
  /** 令牌声明的服务端 host（用于判断 CN/INTL 线） */
  host: string | null;
  /** 令牌过期时间（原样字符串，ISO8601） */
  expired_at: string | null;
}

export type TraeCaptureResult =
  | { ok: true; reason_code: 'CAPTURE_OK'; storage_path: string; entry: TraeCaptureEntry }
  | { ok: false; reason_code: string; message: string; storage_path: string };

const sha8 = (value: string): string => createHash('sha256').update(value).digest('hex').slice(0, 8);

/** 默认 storage.json 路径（Windows：%APPDATA%；其它平台给同构推导，找不到就报 TRAE_STORAGE_MISSING） */
export function defaultTraeStoragePath(env: NodeJS.ProcessEnv = process.env): string {
  const appData = env.APPDATA ?? '';
  return join(appData, 'Trae CN', 'User', 'globalStorage', 'storage.json');
}

/** ACC-SW-TRAE：默认 Trae CN 用户数据目录（快照/必清的根） */
export function defaultTraeDataDir(env: NodeJS.ProcessEnv = process.env): string {
  return join(env.APPDATA ?? '', 'Trae CN');
}

/** ACC-SW-TRAE：快照备份根默认落在 DB 同目录（与 vault/attachments 同一信任域，数据根下非公开位） */
export function defaultTraeBackupRoot(dbPath: string): string {
  return resolve(dirname(dbPath), 'trae-snapshots');
}

/** ACC-SW-TRAE：Trae 桌面客户端 exe 的常见安装位（装在非默认盘时走 env 或进程表探测兜底） */
export function traeExeCandidates(env: NodeJS.ProcessEnv = process.env): string[] {
  const candidates: string[] = [];
  const localAppData = env.LOCALAPPDATA ?? '';
  if (localAppData !== '') candidates.push(join(localAppData, 'Programs', 'Trae CN', 'Trae CN.exe'));
  candidates.push(join(env.ProgramFiles ?? 'C:\\Program Files', 'Trae CN', 'Trae CN.exe'));
  candidates.push(join(env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)', 'Trae CN', 'Trae CN.exe'));
  return candidates;
}

const PS_QUOTE = (value: string): string => `'${value.replace(/'/g, "''")}'`;

/**
 * ACC-SW-TRAE：进程表探测——拿运行中 `Trae CN.exe` 的真实路径。
 * exe 装在非默认位置（本机实测 `D:\Program Files\Trae CN\Trae CN.exe`）时，静态候选探不到，
 * 运行中的进程表是唯一可靠来源；探测失败返回 null（调用方给 CLIENT_PATH_MISSING + env 提示，不猜路径）。
 */
export function createTraeExeProbe(options: { run?: (script: string) => Promise<string>; platform?: NodeJS.Platform } = {}): () => Promise<string | null> {
  const run = options.run ?? (async (script: string): Promise<string> => {
    const { execFile } = await import('node:child_process');
    const shell = process.env.AGENTBOARD_POWERSHELL ?? 'powershell.exe';
    return new Promise<string>((resolvePromise, rejectPromise) => {
      execFile(shell, ['-NoProfile', '-NonInteractive', '-Command', script], { timeout: 20_000, windowsHide: true }, (error, stdout) => {
        if (error) { rejectPromise(error); return; }
        resolvePromise(stdout.trim());
      });
    });
  });
  return async (): Promise<string | null> => {
    if ((options.platform ?? process.platform) !== 'win32') return null;
    try {
      const out = await run(`Get-CimInstance Win32_Process -Filter "Name='Trae CN.exe'" | Select-Object -First 1 -ExpandProperty ExecutablePath`);
      const exe = out.trim();
      return exe === '' ? null : exe;
    } catch {
      return null;
    }
  };
}

export interface CaptureTraeOptions {
  storagePath?: string;
  /** 测试注入：覆盖 pepper（模拟「常量表与客户端版本不匹配」） */
  pepper?: Buffer;
}

/** 内部读取结果：明文仅在本进程内存中短暂存在，不导出给路由/日志 */
interface TraePayload {
  token: string;
  refreshToken: string;
  userId: string | null;
  host: string | null;
  expiredAt: string | null;
}

type PayloadRead =
  | { ok: true; storage_path: string; payload: TraePayload }
  | { ok: false; reason_code: string; message: string; storage_path: string };

function pickEnvelope(raw: Record<string, unknown>): string | undefined {
  return typeof raw[TRAE_STORAGE_KEY] === 'string'
    ? raw[TRAE_STORAGE_KEY] as string
    // 兜底：取最长的 iCubeAuthInfo* 值（与开源实现一致）
    : Object.entries(raw)
      .filter(([key, value]) => key.startsWith('iCubeAuthInfo') && typeof value === 'string')
      .map(([, value]) => value as string)
      .sort((a, b) => b.length - a.length)[0];
}

function readTraePayload(options: CaptureTraeOptions = {}): PayloadRead {
  const storagePath = options.storagePath ?? defaultTraeStoragePath();
  if (!existsSync(storagePath)) {
    return { ok: false, reason_code: 'TRAE_STORAGE_MISSING', message: `未找到 Trae 凭据文件：${storagePath}`, storage_path: storagePath };
  }
  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(readFileSync(storagePath, 'utf8')) as Record<string, unknown>;
  } catch (error) {
    return {
      ok: false,
      reason_code: 'TRAE_STORAGE_CORRUPT',
      message: `storage.json 不是合法 JSON：${error instanceof Error ? error.message : String(error)}`,
      storage_path: storagePath,
    };
  }
  const extracted = extractEnvelopePayload(raw, options.pepper);
  return extracted.ok
    ? { ok: true, storage_path: storagePath, payload: extracted.payload }
    : { ok: false, reason_code: extracted.reason_code, message: extracted.message, storage_path: storagePath };
}

/** 信封解包共用逻辑（sync 真机读与 provider 注入 fs 读共用；明文只在返回值里短暂存在） */
type EnvelopeRead =
  | { ok: true; payload: TraePayload }
  | { ok: false; reason_code: string; message: string };

function extractEnvelopePayload(raw: Record<string, unknown>, pepper?: Buffer): EnvelopeRead {
  const b64 = pickEnvelope(raw);
  if (b64 === undefined) {
    return { ok: false, reason_code: 'TRAE_ENVELOPE_MISSING', message: `storage.json 里没有 ${TRAE_STORAGE_KEY} 条目` };
  }
  let payload: Record<string, unknown>;
  try {
    payload = decryptTcEnvelope(b64, pepper);
  } catch (error) {
    const code = error instanceof TraeEnvelopeError ? error.code : 'TRAE_PAYLOAD_CORRUPT';
    return { ok: false, reason_code: code, message: error instanceof Error ? error.message : String(error) };
  }
  const token = typeof payload.token === 'string' ? payload.token : '';
  if (token === '') {
    return { ok: false, reason_code: 'TRAE_TOKEN_MISSING', message: '信封解开了但缺少 token 字段' };
  }
  return {
    ok: true,
    payload: {
      token,
      refreshToken: typeof payload.refreshToken === 'string' ? payload.refreshToken : '',
      userId: typeof payload.userId === 'string' ? payload.userId : null,
      host: typeof payload.host === 'string' ? payload.host : null,
      expiredAt: typeof payload.expiredAt === 'string' ? payload.expiredAt : null,
    },
  };
}

export function captureTraeCredential(options: CaptureTraeOptions = {}): TraeCaptureResult {
  const read = readTraePayload(options);
  if (!read.ok) {
    return { ok: false, reason_code: read.reason_code, message: read.message, storage_path: read.storage_path };
  }
  const { token, refreshToken, userId, host, expiredAt } = read.payload;
  return {
    ok: true,
    reason_code: 'CAPTURE_OK',
    storage_path: read.storage_path,
    entry: {
      token_sha8: sha8(token),
      token_length: token.length,
      refresh_sha8: refreshToken === '' ? '' : sha8(refreshToken),
      refresh_length: refreshToken.length,
      user_id_sha8: userId === null ? null : sha8(userId),
      host,
      expired_at: expiredAt,
    },
  };
}

/** registry 用：当前机器上是否存在可解的信封（不抛错，只看文件） */
export function traeStorageAvailable(storagePath: string = defaultTraeStoragePath()): boolean {
  return existsSync(storagePath);
}

/** ACC-GET：Trae 捕获固定客户端实例标识（同一身份重复捕获不新增账号） */
export const TRAE_CLIENT_INSTANCE = 'trae-desktop';

/** 取 JWT payload 的 sub（base64url；不是 JWT 或解不开 → null） */
function jwtSubject(token: string): string | null {
  const parts = token.split('.');
  if (parts.length < 2) return null;
  try {
    const json = JSON.parse(Buffer.from(parts[1]!, 'base64url').toString('utf8')) as { sub?: unknown };
    return typeof json.sub === 'string' && json.sub.trim() !== '' ? json.sub : null;
  } catch {
    return null;
  }
}

/** ACC-SW-TRAE：Trae 账号的 vault 最小面（SecretVault 与测试假体都满足） */
export type TraeVault = Pick<SecretVault, 'protect' | 'unprotect' | 'delete'>;

/**
 * ACC-SW-TRAE：从 storage.json 字节里解出登录身份哈希（与 captureCurrent 同一口径 sha256('trae' + NUL + sub)）。
 * 目标账号快照的 storage.json 用它核验「快照身份 == 账号身份」；解不开/缺身份 → null。
 */
export function identityHashOfStorageBytes(bytes: Buffer, pepper?: Buffer): string | null {
  let raw: Record<string, unknown>;
  try { raw = JSON.parse(bytes.toString('utf8')) as Record<string, unknown>; } catch { return null; }
  const envelope = pickEnvelope(raw);
  if (envelope === undefined) return null;
  try {
    const payload = decryptTcEnvelope(envelope, pepper);
    const token = typeof payload.token === 'string' ? payload.token : '';
    const subject = token === '' ? null : jwtSubject(token);
    const identity = subject ?? (typeof payload.userId === 'string' && payload.userId.trim() !== '' ? payload.userId : null);
    return identity === null ? null : sha256(`trae\0${identity}`);
  } catch {
    return null;
  }
}

/** verify 轮询用真实时钟（与 minimaxDesktopProvider 同口径：测试冻结时钟时避免死等） */
const sleepVerify = (ms: number): Promise<void> => new Promise(resolvePromise => setTimeout(resolvePromise, ms));

export interface TraeDesktopProviderDeps {
  db: Db;
  vault: TraeVault;
  /** 测试注入；生产默认 `%APPDATA%\Trae CN\...\storage.json` */
  storagePath?: string;
  pepper?: Buffer;
  /** ACC-SW-TRAE：Trae CN 用户数据目录；缺省从 storagePath 上溯三级（storage.json 在 <dataDir>/User/globalStorage/ 下） */
  dataDir?: string;
  /** ACC-SW-TRAE：快照备份根；缺省 `<db 所在目录>/trae-snapshots` */
  backupRoot?: string;
  /** ACC-SW-TRAE：客户端可执行文件显式指定；缺省 env `AGENTBOARD_TRAE_EXE` → 常见安装位 → 进程表探测 */
  clientExe?: string;
  /** ACC-SW-TRAE：文件系统（测试注入内存实现） */
  fs?: TraeFileSystem;
  /** ACC-SW-TRAE：进程探测/停止/启动（clientProcess.ts 共用实现；测试注入假体） */
  process?: ClientProcessControl;
  now?: () => number;
  /** ACC-SW-TRAE：运行中客户端 exe 探测（测试注入；缺省查进程表） */
  probeExePath?: () => Promise<string | null>;
  /** ACC-SW-TRAE：verify 等客户端落定窗口（ms，默认 20s；测试注入缩短） */
  verifySettleTimeoutMs?: number;
  /** ACC-SW-TRAE：verify 轮询间隔（ms，默认 400） */
  verifyPollMs?: number;
  /** ACC-SW-TRAE：stop 成功后等文件句柄释放（ms，默认 500；测试可置 0） */
  stopSettleMs?: number;
}

/** 切换流程里 S2 产出的回滚依据（备份目录 + manifest + vault ref） */
interface TraeRollbackSnapshot {
  ref: string;
  dir: string;
  manifest: TraeSnapshotManifest;
}

/** S3 产出、S4 消费：目标快照的还原依据 */
interface TraeTargetWrite {
  credential: Buffer;
  manifest: TraeSnapshotManifest;
  backupDir: string;
}

/**
 * ACC-GET / ACC-SW-TRAE：Trae 桌面「捕获当前账号」+「登录态切换」。
 *
 * 与 `captureTraeCredential` 的区别：这里会**落库**（managed_account + checkin 凭据），
 * 供签到链路直接使用；对外仍只返回脱敏的 `ManagedAccount`，token 只进 vault（DPAPI）。
 * 身份口径与 ACC-11 导入一致：`identity_hash = sha256('trae' + NUL + JWT sub)`。
 */
export class TraeDesktopProvider {
  private readonly db: Db;
  private readonly vault: TraeVault;
  private readonly storagePath: string | undefined;
  private readonly pepper: Buffer | undefined;
  private readonly dataDir: string;
  private readonly backupRoot: string;
  private readonly clientExe: string | undefined;
  private readonly fs: TraeFileSystem;
  private readonly process: ClientProcessControl;
  private readonly now: () => number;
  private readonly probeExePath: () => Promise<string | null>;
  private readonly verifySettleTimeoutMs: number;
  private readonly verifyPollMs: number;
  private readonly stopSettleMs: number;
  /** exe 探测一次后在本实例内复用 */
  private resolvedClientExe: string | null = null;

  constructor(deps: TraeDesktopProviderDeps) {
    this.db = deps.db;
    this.vault = deps.vault;
    this.storagePath = deps.storagePath;
    this.pepper = deps.pepper;
    this.dataDir = deps.dataDir
      ?? (deps.storagePath !== undefined ? resolve(dirname(dirname(dirname(deps.storagePath)))) : defaultTraeDataDir());
    this.backupRoot = deps.backupRoot ?? defaultTraeBackupRoot(deps.db.name);
    this.clientExe = deps.clientExe;
    this.fs = deps.fs ?? defaultTraeFs;
    this.process = deps.process ?? createClientProcessControl();
    this.now = deps.now ?? (() => Date.now());
    this.probeExePath = deps.probeExePath ?? createTraeExeProbe();
    this.verifySettleTimeoutMs = deps.verifySettleTimeoutMs ?? 20_000;
    this.verifyPollMs = deps.verifyPollMs ?? 400;
    this.stopSettleMs = deps.stopSettleMs ?? 500;
  }

  private scopeFor(account: { identity_hash: string; client_instance_id: string }, purpose: 'checkin' | 'client_snapshot'): VaultScope {
    return { app_id: TRAE_APP_ID, client_instance_id: account.client_instance_id, identity_hash: account.identity_hash, purpose };
  }

  private get liveStoragePath(): string {
    return this.storagePath ?? traeAbsPath(this.dataDir, TRAE_STORAGE_RELATIVE_PATH);
  }

  private snapshotDir(ref: string): string {
    return join(this.backupRoot, ref);
  }

  /** ACC-SW-TRAE：provider 内部读 live storage.json（走注入 fs，测试可用内存实现）；失败码与 readTraePayload 一致 */
  private async readPayloadLive(): Promise<PayloadRead> {
    const storagePath = this.liveStoragePath;
    if (!(await this.fs.exists(storagePath))) {
      return { ok: false, reason_code: 'TRAE_STORAGE_MISSING', message: `未找到 Trae 凭据文件：${storagePath}`, storage_path: storagePath };
    }
    let raw: Record<string, unknown>;
    try {
      raw = JSON.parse((await this.fs.readFile(storagePath)).toString('utf8')) as Record<string, unknown>;
    } catch (error) {
      return { ok: false, reason_code: 'TRAE_STORAGE_CORRUPT', message: `storage.json 不是合法 JSON：${error instanceof Error ? error.message : String(error)}`, storage_path: storagePath };
    }
    const extracted = extractEnvelopePayload(raw, this.pepper);
    return extracted.ok
      ? { ok: true, storage_path: storagePath, payload: extracted.payload }
      : { ok: false, reason_code: extracted.reason_code, message: extracted.message, storage_path: storagePath };
  }

  /**
   * ACC-SW-TRAE：把当前登录态（15 条清单）快照进 vault，返回回滚依据。
   * 暂存目录先拷贝、manifest 保护后再定名（vault ref 生成后 rename 到最终目录）。
   */
  private async snapshotLiveIntoVault(scope: VaultScope): Promise<TraeRollbackSnapshot> {
    const staging = join(this.backupRoot, randomUUID());
    await this.fs.mkdir(staging);
    let manifest: TraeSnapshotManifest;
    try {
      manifest = await createTraeSnapshot({ dataDir: this.dataDir, backupDir: staging, now: this.now, fs: this.fs });
      const ref = await this.vault.protect(Buffer.from(JSON.stringify(manifest), 'utf8'), scope);
      const finalDir = this.snapshotDir(ref);
      await this.fs.mkdir(this.backupRoot);
      await this.fs.rename(staging, finalDir);
      return { ref, dir: finalDir, manifest };
    } catch (error) {
      await this.fs.remove(staging).catch(() => {});
      throw error;
    }
  }

  /** 删除一份快照（vault manifest + 备份目录）；失败可重试（rm force / delete 幂等） */
  private async deleteSnapshotRef(ref: string): Promise<void> {
    await this.vault.delete(ref);
    await this.fs.remove(this.snapshotDir(ref));
  }

  /**
   * ACC-SW-TRAE：捕获用的登录态快照（含冷快照升级）。
   *
   * 客户端在跑时 Chromium 会以独占方式持有 `Local Storage/leveldb`、`Session Storage`、`Network`、
   * `Partitions/*` 里的部分文件（真机实证：这几个目录条目整段 failed）——按 KB cc06032d 范式 A 的 S0
   * （必须关客户端才能拿一致登录态），快照有 failed 条目就**停机重拍**，拍完把客户端拉回来。
   * 停不了/重拍也失败 → 保留第一份（部分快照总比没有好，切换侧 validate 如实按缺条目拒绝）。
   */
  private async snapshotAccountState(clientInstanceId: string, identityHash: string): Promise<string> {
    const scope = this.scopeFor({ identity_hash: identityHash, client_instance_id: clientInstanceId }, 'client_snapshot');
    let snapshot = await this.snapshotLiveIntoVault(scope);
    if (!snapshot.manifest.entries.some(entry => entry.status === 'failed')) return snapshot.ref;
    const clientExe = await this.resolveClientExe().catch(() => '');
    let stopped = false;
    if (clientExe !== '') {
      try {
        if (await this.process.isRunning(clientExe)) {
          await this.process.stop(clientExe);
          stopped = true;
          if (this.stopSettleMs > 0) await sleepVerify(this.stopSettleMs);
        }
      } catch { stopped = false; }
    }
    try {
      const cold = await this.snapshotLiveIntoVault(scope);
      await this.deleteSnapshotRef(snapshot.ref).catch(() => {});
      snapshot = cold;
    } catch { /* 冷快照失败：保留第一份 */ }
    finally {
      if (stopped && clientExe !== '') {
        try { await this.process.start(clientExe); } catch (error) {
          // 重启失败不阻断捕获，客户端可手动拉起；失败码可见（不含路径/token 原文）
          console.error(`[agentboard] trae 捕获冷快照后重启客户端失败：${error instanceof ApiError ? error.code : 'CLIENT_START_FAILED'}`);
        }
      }
    }
    return snapshot.ref;
  }

  /** ACC-SWITCH：读 storage.json 判定客户端当前登录身份（身份口径与 captureCurrent 一致）；读不到 → null */
  async getCurrentIdentityHash(): Promise<string | null> {
    const read = await this.readPayloadLive();
    if (!read.ok) return null;
    const subject = jwtSubject(read.payload.token) ?? read.payload.userId;
    return subject === null ? null : sha256(`trae\0${subject}`);
  }

  async captureCurrent(options: { display_name?: string } = {}): Promise<ManagedAccount> {
    if (options.display_name !== undefined && (options.display_name.trim().length < 1 || options.display_name.trim().length > 100)) {
      throw new ValidationError('display_name 不合法');
    }
    const read = await this.readPayloadLive();
    if (!read.ok) throw new ApiError(409, read.reason_code, read.message);
    const subject = jwtSubject(read.payload.token) ?? read.payload.userId;
    if (subject === null) throw new ApiError(409, 'TRAE_IDENTITY_UNAVAILABLE', 'Trae 凭据缺少稳定用户标识，无法建立账号');
    const identityHash = sha256(`trae\0${subject}`);
    // ACC-TOKEN-2：信封 payload 的 expiredAt == JWT exp（秒级字符串/数值），兜底再解一次 JWT exp
    const expiresAt = parseCredentialExpiry(read.payload.expiredAt) ?? jwtExpiresAt(read.payload.token);
    let captured: ManagedAccount | null = null;
    const operation = await runAccountOperation(this.db, {
      app_id: 'trae', client_instance_id: TRAE_CLIENT_INSTANCE, operation: 'capture',
    }, async () => {
      const existing = findManagedAccountByAppIdentity(this.db, 'trae', identityHash);
      const clientInstance = existing?.client_instance_id ?? TRAE_CLIENT_INSTANCE;
      // ACC-TOKEN-2：落 JSON 载荷 {token, refresh_token, expires_at}（旧实现只落裸 token，refreshToken/expiredAt
      // 被丢弃——设计页 §2 trae 行的缺口）；签到/导入侧 parseTraeCredential 兼容旧裸串。
      const credentialPayload = JSON.stringify({
        token: read.payload.token,
        ...(read.payload.refreshToken !== '' ? { refresh_token: read.payload.refreshToken } : {}),
        expires_at: expiresAt,
      });
      const ref = await this.vault.protect(Buffer.from(credentialPayload, 'utf8'), {
        app_id: 'trae', client_instance_id: clientInstance, identity_hash: identityHash, purpose: 'checkin',
      });
      // ACC-SW-TRAE：凭据落库的同时 best-effort 快照登录态（切换的目标依据）；
      // 客户端在跑导致条目失败时自动升级为停机冷快照（拍完拉回客户端）。
      // 快照整体失败不阻断捕获——切换会在 validate_target 如实报 SNAPSHOT_MISSING 并提示重新捕获。
      let snapshotRef: string | null = null;
      try {
        snapshotRef = await this.snapshotAccountState(clientInstance, identityHash);
      } catch { snapshotRef = null; }
      try {
        const displayName = (options.display_name ?? existing?.display_name ?? `Trae-${identityHash.slice(0, 8)}`).trim();
        if (existing) {
          if (displayName !== existing.display_name) this.db.prepare('UPDATE managed_account SET display_name=?,updated_at=? WHERE id=?').run(displayName, Date.now(), existing.id);
          captured = attachCheckinCredential(this.db, existing.id, ref);
          if (existing.checkin_credential_ref && existing.checkin_credential_ref !== ref) await this.vault.delete(existing.checkin_credential_ref).catch(() => {});
          if (snapshotRef !== null) {
            captured = attachClientSnapshot(this.db, existing.id, { client_snapshot_ref: snapshotRef, client_snapshot_version: (existing.client_snapshot_version ?? 0) + 1 });
            if (existing.client_snapshot_ref && existing.client_snapshot_ref !== snapshotRef) await this.deleteSnapshotRef(existing.client_snapshot_ref).catch(() => {});
          }
        } else {
          captured = createManagedAccount(this.db, {
            app_id: 'trae', client_instance_id: clientInstance, service_region: regionOf(read.payload.host),
            identity_hash: identityHash, display_name: displayName, checkin_credential_ref: ref,
            ...(snapshotRef !== null ? { client_snapshot_ref: snapshotRef, client_snapshot_version: 1 } : {}),
          });
          captured = attachCheckinCredential(this.db, captured.id, ref);
        }
        // ACC-TOKEN-2：捕获写入点——落到期列（trae refresh_method 固定 recapture）
        setCredentialExpiry(this.db, captured.id, { expiresAt, refreshMethod: 'recapture' });
      } catch (error) {
        await this.vault.delete(ref).catch(() => {});
        if (snapshotRef !== null) await this.deleteSnapshotRef(snapshotRef).catch(() => {});
        throw error;
      }
      return 'succeeded';
    });
    if (operation.state !== 'succeeded' || !captured) throw new ApiError(409, operation.safe_error_code ?? 'CAPTURE_FAILED', '捕获当前 Trae 账号失败');
    return captured;
  }

  /**
   * ACC-SW-TRAE：解析客户端 exe——显式 deps.clientExe 优先，其次 env `AGENTBOARD_TRAE_EXE`、
   * 常见安装位，最后查运行中进程表；都落空 → `CLIENT_PATH_MISSING`（文案带 env 提示，不猜路径）。
   */
  private async resolveClientExe(): Promise<string> {
    if (this.clientExe !== undefined && this.clientExe !== '') return this.clientExe;
    if (this.resolvedClientExe !== null) return this.resolvedClientExe;
    const fromEnv = process.env.AGENTBOARD_TRAE_EXE?.trim() ?? '';
    if (fromEnv !== '') {
      this.resolvedClientExe = fromEnv;
      return fromEnv;
    }
    for (const candidate of traeExeCandidates()) {
      if (await this.fs.exists(candidate)) {
        this.resolvedClientExe = candidate;
        return candidate;
      }
    }
    const probed = await this.probeExePath().catch(() => null);
    if (probed !== null && probed !== '') {
      this.resolvedClientExe = probed;
      return probed;
    }
    throw new ApiError(409, 'CLIENT_PATH_MISSING', '未找到 Trae CN 客户端可执行文件（可用环境变量 AGENTBOARD_TRAE_EXE 指定）');
  }

  /**
   * ACC-SW-TRAE：切换登录态——走**共用骨架**（switchFlow 七步）：
   * preflight（storage.json + exe）→ stop（绝不在客户端运行时改文件）→ snapshot（15 条停机快照，回滚依据）→
   * validate_target（目标快照三件套齐 + 快照身份==账号身份）→ write（必清 logs/、code.lock、live wal/shm/journal，
   * 还原目标快照并逐文件哈希校验）→ start（detached 拉起）→ verify（20s 轮询 storage.json 身份==目标 + 进程在跑）→
   * 失败 rollback（还原 S2 快照；还原失败落 recovery_ref + RECOVERY_REQUIRED）。
   */
  async switchAccount(accountId: string, hooks: { onOperationCreated?: (id: string) => void } = {}): Promise<AccountOperation> {
    const account = getManagedAccount(this.db, accountId);
    if (!account) throw new NotFoundError('账号不存在');
    if (account.app_id !== TRAE_APP_ID) throw new ApiError(409, 'ACCOUNT_APP_MISMATCH', '账号不属于 Trae');
    return runAccountOperation(
      this.db,
      { account_id: account.id, app_id: TRAE_APP_ID, client_instance_id: account.client_instance_id, operation: 'switch' },
      async op => {
        if (hooks.onOperationCreated) hooks.onOperationCreated(op.id);
        let clientExe = '';
        let snapshot: TraeRollbackSnapshot | null = null;
        let targetWrite: TraeTargetWrite | null = null;

        try {
          await runSwitchFlow({
          setStage: stage => this.setStage(op, stage),
          callbacks: {
            // S0：storage.json 在 + 客户端 exe 可定位
            preflight: async () => {
              if (!(await this.fs.exists(this.liveStoragePath))) {
                throw new ApiError(409, 'TRAE_STORAGE_MISSING', `未找到 Trae 凭据文件：${this.liveStoragePath}`);
              }
              clientExe = await this.resolveClientExe();
            },
            // S1：客户端在跑必须先停掉并确认退出（KB S0：绝不在运行时改登录态文件）
            stop: async () => {
              let running: boolean;
              try {
                running = await this.process.isRunning(clientExe);
              } catch (error) {
                // 阻断点在 preflight 语义内（未改动文件），stage 退回 preflight
                this.setStage(op, 'preflight');
                if (error instanceof ApiError) throw error;
                throw new ApiError(409, CLIENT_PROCESS_ERROR_CODES.probeFailed, '无法确认 Trae 客户端是否在运行，已中止切换');
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
                throw new ApiError(409, CLIENT_PROCESS_ERROR_CODES.stopTimeout, 'Trae 客户端仍在运行，已中止切换（未改动登录态文件）');
              }
              if (this.stopSettleMs > 0) await sleepVerify(this.stopSettleMs);
            },
            // S2：停机后全量快照（客户端已退出，SQLite 对是一致的）；失败 → 中止切换，未写任何文件
            snapshot: async () => {
              snapshot = await this.snapshotLiveIntoVault(this.scopeFor(account, 'client_snapshot'));
              return snapshot;
            },
            // S3：目标账号快照必须存在、三件套齐、且快照身份与账号身份一致
            validateTarget: async () => {
              if (!account.client_snapshot_ref) {
                throw new ApiError(409, 'SNAPSHOT_MISSING', '目标账号没有客户端登录态快照（请在该账号登录状态下重新捕获）');
              }
              const manifestBytes = await this.vault.unprotect(account.client_snapshot_ref, this.scopeFor(account, 'client_snapshot'));
              const manifest = parseTraeSnapshotManifest(manifestBytes);
              const ready = traeSnapshotReady(manifest);
              if (!ready.ok) throw new ApiError(409, 'TARGET_SNAPSHOT_INVALID', `目标快照缺少必搬条目：${ready.missing.join('、')}`);
              const backupDir = this.snapshotDir(account.client_snapshot_ref);
              if (!(await this.fs.exists(backupDir))) {
                throw new ApiError(409, 'SNAPSHOT_MISSING', '目标账号的快照备份目录不存在（可能已被清理，请重新捕获）');
              }
              const storageBytes = await this.fs.readFile(traeAbsPath(backupDir, TRAE_STORAGE_RELATIVE_PATH));
              const snapshotIdentity = identityHashOfStorageBytes(storageBytes, this.pepper);
              if (snapshotIdentity === null || snapshotIdentity !== account.identity_hash) {
                throw new ApiError(409, 'TARGET_SNAPSHOT_INVALID', '目标快照的登录身份与账号不一致');
              }
              targetWrite = {
                credential: validateTarget({ app_id: TRAE_APP_ID, account, credential: storageBytes, uid: snapshotIdentity }).credential,
                manifest,
                backupDir,
              };
              return targetWrite;
            },
            // S4：必清（logs/、code.lock、live wal/shm/journal）→ 还原目标快照 → 逐文件哈希校验。
            // 目录级还原非原子：失败即用 S2 快照自恢复；自恢复也失败才落 RECOVERY_REQUIRED（快照还在，restore 端点可重放）。
            write: async value => {
              try {
                await cleanTraeResiduals({ dataDir: this.dataDir, fs: this.fs });
                await restoreTraeSnapshot({ dataDir: this.dataDir, backupDir: value.backupDir, manifest: value.manifest, fs: this.fs });
              } catch {
                try {
                  await cleanTraeResiduals({ dataDir: this.dataDir, fs: this.fs });
                  await restoreTraeSnapshot({ dataDir: this.dataDir, backupDir: snapshot!.dir, manifest: snapshot!.manifest, fs: this.fs });
                } catch {
                  this.setStage(op, 'write');
                  updateAccountOperation(this.db, op.id, { recovery_ref: snapshot!.ref });
                  throw new ApiError(409, 'RECOVERY_REQUIRED', '写入 Trae 登录态失败且自恢复失败，该实例已冻结，需经 restore 端点解冻');
                }
                // 自恢复成功 = 客户端目录已回到切换前状态：stage 退回 write 之前，不触发骨架回滚、不冻结实例
                this.setStage(op, 'validate_target');
                throw new ApiError(409, 'SWITCH_WRITE_FAILED', '写入 Trae 登录态快照失败（已恢复切换前状态）');
              }
            },
            // S5：detached 拉起客户端（'无感'=不重登但必须重启客户端）
            start: async () => { await this.process.start(clientExe); },
            // S5：storage.json 身份==目标（20s 窗口轮询，等客户端启动落定）+ 进程在跑
            verify: async () => {
              const deadline = Date.now() + this.verifySettleTimeoutMs;
              let matched = false;
              while (true) {
                matched = (await this.getCurrentIdentityHash()) === account.identity_hash;
                if (matched || Date.now() >= deadline) break;
                await sleepVerify(this.verifyPollMs);
              }
              if (!matched) throw new ApiError(409, 'TARGET_IDENTITY_MISMATCH', '客户端当前登录态与目标账号不一致');
              if (!(await this.process.isRunning(clientExe))) {
                throw new ApiError(409, 'CLIENT_NOT_RUNNING', '切换后 Trae 客户端未在运行');
              }
            },
            // 回滚：先停客户端再还原 S2 快照（哈希校验内建）；回滚失败 → recovery_ref → A3 restore 重放
            rollback: async (_rollbackSnapshotRef, cause) => {
              try { await this.process.stop(clientExe); } catch { /* 停不下来按恢复失败路径处理 */ }
              try {
                await cleanTraeResiduals({ dataDir: this.dataDir, fs: this.fs });
                await restoreTraeSnapshot({ dataDir: this.dataDir, backupDir: snapshot!.dir, manifest: snapshot!.manifest, fs: this.fs });
              } catch {
                updateAccountOperation(this.db, op.id, { recovery_ref: snapshot!.ref });
                throw new ApiError(409, 'RECOVERY_REQUIRED', '切换失败且回滚未成功，该实例已冻结，需经 restore 端点解冻');
              }
              await this.deleteSnapshotRef(snapshot!.ref).catch(() => {});
              throw new ApiError(409, 'SWITCH_ROLLED_BACK', `切换失败已按哈希校验回滚原登录态（失败原因: ${cause}）`);
            },
          },
        });
        } catch (error) {
          // 写盘前失败（preflight/stop/snapshot/validate_target）或回滚成功收尾后：S2 备份已无用，清掉不留孤儿目录；
          // 回滚失败落了 recovery_ref 的快照是恢复依据，必须保留（restore 端点重放用）
          // （snapshot 在骨架回调里赋值，TS 流程分析看不到——这里显式放宽回联合类型）
          const maybeSnapshot = snapshot as TraeRollbackSnapshot | null;
          const recoveryRef = getAccountOperation(this.db, op.id)?.recovery_ref ?? null;
          if (maybeSnapshot !== null && recoveryRef !== maybeSnapshot.ref) await this.deleteSnapshotRef(maybeSnapshot.ref).catch(() => {});
          throw error;
        }
        // 成功收尾：删 S2 回滚备份（切换成功后不留副本）；目标账号自己的快照不动
        await this.deleteSnapshotRef(snapshot!.ref).catch(() => {});
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
   * A3 restore 通道：把 recovery_ref 指向的快照写回客户端（回滚重放；只还原文件，不代启客户端）。
   * 失败抛错，实例保持冻结，可再次触发。
   */
  async restoreFromSnapshot(input: { account: ManagedAccount; snapshotRef: string | null }): Promise<void> {
    if (!input.snapshotRef) throw new ApiError(409, 'SNAPSHOT_MISSING', '缺少恢复依据快照，无法回滚');
    const manifestBytes = await this.vault.unprotect(input.snapshotRef, this.scopeFor(input.account, 'client_snapshot'));
    const manifest = parseTraeSnapshotManifest(manifestBytes);
    const backupDir = this.snapshotDir(input.snapshotRef);
    if (!(await this.fs.exists(backupDir))) throw new ApiError(409, 'SNAPSHOT_MISSING', '快照备份目录不存在，无法回滚');
    await cleanTraeResiduals({ dataDir: this.dataDir, fs: this.fs });
    await restoreTraeSnapshot({ dataDir: this.dataDir, backupDir, manifest, fs: this.fs });
  }
}

function regionOf(host: string | null): 'cn' | 'global' | 'unknown' {
  if (host === null) return 'unknown';
  if (host.includes('trae.cn')) return 'cn';
  if (host.includes('trae.ai') || host.includes('trae.com')) return 'global';
  return 'unknown';
}

const sha256 = (value: string): string => createHash('sha256').update(value).digest('hex');
