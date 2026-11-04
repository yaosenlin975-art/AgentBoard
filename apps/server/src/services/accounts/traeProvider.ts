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
import { decryptTcEnvelope, TraeEnvelopeError } from '@agentboard/adapters';

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

export function captureTraeCredential(options: CaptureTraeOptions = {}): TraeCaptureResult {
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
  const refresh = typeof payload.refreshToken === 'string' ? payload.refreshToken : '';
  const userId = typeof payload.userId === 'string' ? payload.userId : null;
  const host = typeof payload.host === 'string' ? payload.host : null;
  const expiredAt = typeof payload.expiredAt === 'string' ? payload.expiredAt : null;
  return {
    ok: true,
    reason_code: 'CAPTURE_OK',
    storage_path: storagePath,
    entry: {
      token_sha8: sha8(token),
      token_length: token.length,
      refresh_sha8: refresh === '' ? '' : sha8(refresh),
      refresh_length: refresh.length,
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
