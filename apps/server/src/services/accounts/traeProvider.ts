/**
 * ACC-KB-B3：Trae CN 离线凭据捕获 provider。
 *
 * 落点：`%APPDATA%\Trae CN\User\globalStorage\storage.json`，键 `iCubeAuthInfo://icube.cloudide`
 * （`tc` 信封，解包逻辑见 `packages/adapters/src/trae/tcEnvelope.ts`）。
 *
 * 口径：
 * - **只读**客户端文件：不启停 Trae、不写其目录、不落盘 token、不进日志；
 * - 对外只返回**脱敏**字段：`token_sha8` / `token_length` / `refresh_sha8` / `refresh_length` /
 *   `user_id_sha8` / `host`；原文只在函数内部短暂存在；
 * - 失败给可读 `reason_code`，绝不返回半条凭据：
 *   `TRAE_STORAGE_MISSING`（没装/没登录）、`TRAE_ENVELOPE_MISSING`（storage.json 里没有 iCubeAuthInfo 键）、
 *   `TRAE_PEPPER_UNAVAILABLE`（pepper 与当前客户端版本不匹配 → 需要更新常量表）、
 *   `TRAE_PAYLOAD_CORRUPT`（信封损坏）、`TRAE_TOKEN_MISSING`（解开但缺 token 字段）。
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ManagedAccount } from '@agentboard/shared';
import { decryptTcEnvelope, TraeEnvelopeError } from '@agentboard/adapters';
import type { Db } from '../../db/connection.js';
import { createManagedAccount, findManagedAccountByAppIdentity } from '../../db/repos/managedAccount.js';
import { attachCheckinCredential } from '../../db/repos/checkin.js';
import { ApiError, ValidationError } from '../../errors.js';
import { runAccountOperation } from './operationRunner.js';
import type { SecretVault } from './secretVault.js';

export const TRAE_STORAGE_KEY = 'iCubeAuthInfo://icube.cloudide';

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
  const envelope = raw[TRAE_STORAGE_KEY];
  const b64 = typeof envelope === 'string'
    ? envelope
    // 兜底：取最长的 iCubeAuthInfo* 值（与开源实现一致）
    : Object.entries(raw)
      .filter(([key, value]) => key.startsWith('iCubeAuthInfo') && typeof value === 'string')
      .map(([, value]) => value as string)
      .sort((a, b) => b.length - a.length)[0];
  if (b64 === undefined) {
    return { ok: false, reason_code: 'TRAE_ENVELOPE_MISSING', message: `storage.json 里没有 ${TRAE_STORAGE_KEY} 条目`, storage_path: storagePath };
  }
  let payload: Record<string, unknown>;
  try {
    payload = decryptTcEnvelope(b64, options.pepper);
  } catch (error) {
    const code = error instanceof TraeEnvelopeError ? error.code : 'TRAE_PAYLOAD_CORRUPT';
    return {
      ok: false,
      reason_code: code,
      message: error instanceof Error ? error.message : String(error),
      storage_path: storagePath,
    };
  }
  const token = typeof payload.token === 'string' ? payload.token : '';
  if (token === '') {
    return { ok: false, reason_code: 'TRAE_TOKEN_MISSING', message: '信封解开了但缺少 token 字段', storage_path: storagePath };
  }
  return {
    ok: true,
    storage_path: storagePath,
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

export interface TraeDesktopProviderDeps {
  db: Db;
  vault: SecretVault;
  /** 测试注入；生产默认 `%APPDATA%\Trae CN\...\storage.json` */
  storagePath?: string;
  pepper?: Buffer;
}

/**
 * ACC-GET：Trae 桌面「捕获当前账号」。
 *
 * 与 `captureTraeCredential` 的区别：这里会**落库**（managed_account + checkin 凭据），
 * 供签到链路直接使用；对外仍只返回脱敏的 `ManagedAccount`，token 只进 vault（DPAPI）。
 * 身份口径与 ACC-11 导入一致：`identity_hash = sha256('trae' + NUL + JWT sub)`。
 */
export class TraeDesktopProvider {
  private readonly db: Db;
  private readonly vault: SecretVault;
  private readonly storagePath: string | undefined;
  private readonly pepper: Buffer | undefined;

  constructor(deps: TraeDesktopProviderDeps) {
    this.db = deps.db;
    this.vault = deps.vault;
    this.storagePath = deps.storagePath;
    this.pepper = deps.pepper;
  }

  async captureCurrent(options: { display_name?: string } = {}): Promise<ManagedAccount> {
    if (options.display_name !== undefined && (options.display_name.trim().length < 1 || options.display_name.trim().length > 100)) {
      throw new ValidationError('display_name 不合法');
    }
    const read = readTraePayload({ ...(this.storagePath !== undefined ? { storagePath: this.storagePath } : {}), ...(this.pepper !== undefined ? { pepper: this.pepper } : {}) });
    if (!read.ok) throw new ApiError(409, read.reason_code, read.message);
    const subject = jwtSubject(read.payload.token) ?? read.payload.userId;
    if (subject === null) throw new ApiError(409, 'TRAE_IDENTITY_UNAVAILABLE', 'Trae 凭据缺少稳定用户标识，无法建立账号');
    const identityHash = sha256(`trae\0${subject}`);
    let captured: ManagedAccount | null = null;
    const operation = await runAccountOperation(this.db, {
      app_id: 'trae', client_instance_id: TRAE_CLIENT_INSTANCE, operation: 'capture',
    }, async () => {
      const existing = findManagedAccountByAppIdentity(this.db, 'trae', identityHash);
      const clientInstance = existing?.client_instance_id ?? TRAE_CLIENT_INSTANCE;
      const ref = await this.vault.protect(Buffer.from(read.payload.token, 'utf8'), {
        app_id: 'trae', client_instance_id: clientInstance, identity_hash: identityHash, purpose: 'checkin',
      });
      try {
        const displayName = (options.display_name ?? existing?.display_name ?? `Trae-${identityHash.slice(0, 8)}`).trim();
        if (existing) {
          if (displayName !== existing.display_name) this.db.prepare('UPDATE managed_account SET display_name=?,updated_at=? WHERE id=?').run(displayName, Date.now(), existing.id);
          captured = attachCheckinCredential(this.db, existing.id, ref);
          if (existing.checkin_credential_ref && existing.checkin_credential_ref !== ref) await this.vault.delete(existing.checkin_credential_ref).catch(() => {});
        } else {
          captured = createManagedAccount(this.db, {
            app_id: 'trae', client_instance_id: clientInstance, service_region: regionOf(read.payload.host),
            identity_hash: identityHash, display_name: displayName, checkin_credential_ref: ref,
          });
          captured = attachCheckinCredential(this.db, captured.id, ref);
        }
      } catch (error) {
        await this.vault.delete(ref).catch(() => {});
        throw error;
      }
      return 'succeeded';
    });
    if (operation.state !== 'succeeded' || !captured) throw new ApiError(409, operation.safe_error_code ?? 'CAPTURE_FAILED', '捕获当前 Trae 账号失败');
    return captured;
  }
}

function regionOf(host: string | null): 'cn' | 'global' | 'unknown' {
  if (host === null) return 'unknown';
  if (host.includes('trae.cn')) return 'cn';
  if (host.includes('trae.ai') || host.includes('trae.com')) return 'global';
  return 'unknown';
}

const sha256 = (value: string): string => createHash('sha256').update(value).digest('hex');
