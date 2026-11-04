/**
 * B4S-3：切换骨架里 **S3（validate_target）** 与 **S5（verify）** 的共用实现。
 *
 * 为什么要抽出来：两个 provider 之前各写各的——
 * - WorkBuddy 的 S3 是「解密目标快照 + 校验三元组 + 校验 sha256」，S5 是「读回本地 uid 比对」；
 * - MiniMax 的 S3 只做了「目标凭据非空」，S5 只做了「本地文件里 token 相等」。
 * 结果是 MiniMax 的 S5 **从不做服务端身份校验**：客户端被写成了别人的凭据、服务端根本不认，
 * 本地比对却照样「通过」。本模块把两步的语义与失败码固定下来，两个 provider 共用。
 *
 * S5 的判定口径（**服务端为准，本地比对只作辅助信号**）：
 * 1. 必须用**客户端此刻实际持有的凭据**触发一次需鉴权的服务端调用；
 * 2. 服务端不认这份凭据 → `SERVER_CREDENTIAL_REJECTED`；
 * 3. 服务端认了但没给出可校验的身份标识 → `SERVER_IDENTITY_UNAVAILABLE`；
 * 4. 服务端给出的身份与目标账号的身份不一致 → `SERVER_IDENTITY_MISMATCH`。
 *
 * 平台没有可用的服务端身份校验能力（如尚未实现切换的 Trae / Qoder / ZCode）时如实报
 * `PROVIDER_NOT_IMPLEMENTED`，不拿本地比对冒充服务端校验。
 *
 * **S3 与 S5 的分工**：S3 只回答「目标能不能用」（账号在 / 属于本产品 / 凭据可解非空），
 * 一律发生在写盘之前；S5 回答「切换结果对不对」（客户端此刻是不是目标，且服务端认不认）。
 * 目标身份标识取不到属于 S5 的前置条件（`TARGET_IDENTITY_UNKNOWN`），**不在 S3 就拦下**——
 * 否则会退化成「没做服务端校验也先失败」，与 S3/S5 分离的初衷相反。
 */
import type { ManagedAccount, ManagedAppId } from '@agentboard/shared';
import { ApiError } from '../../errors.js';

/**
 * S3 / S5 的固定失败码（不含凭据与原始异常文本）。
 *
 * - S3（目标校验）：`TARGET_ACCOUNT_NOT_FOUND` `ACCOUNT_APP_MISMATCH` `TARGET_CREDENTIAL_MISSING`
 *   `TARGET_INSTANCE_MISMATCH` `SNAPSHOT_MISSING`
 * - S5（服务端校验）：`TARGET_IDENTITY_UNKNOWN`（目标身份取不到，服务端比对做不了）
 *   `TARGET_IDENTITY_MISMATCH`（客户端当前凭据与目标不一致）/ `PROVIDER_NOT_IMPLEMENTED`
 *   `SERVER_CREDENTIAL_REJECTED` `SERVER_IDENTITY_UNAVAILABLE` `SERVER_IDENTITY_MISMATCH`
 */
export const SWITCH_STAGE_ERROR_CODES = [
  'TARGET_ACCOUNT_NOT_FOUND', 'ACCOUNT_APP_MISMATCH', 'TARGET_CREDENTIAL_MISSING', 'TARGET_IDENTITY_UNKNOWN',
  'TARGET_INSTANCE_MISMATCH', 'SNAPSHOT_MISSING', 'TARGET_IDENTITY_MISMATCH',
  'PROVIDER_NOT_IMPLEMENTED', 'SERVER_CREDENTIAL_REJECTED', 'SERVER_IDENTITY_UNAVAILABLE', 'SERVER_IDENTITY_MISMATCH',
] as const;

export type SwitchStageErrorCode = typeof SWITCH_STAGE_ERROR_CODES[number];

/** 平台的服务端身份探针：用凭据触发一次需鉴权的服务端调用，回传服务端认可的身份标识 */
export interface ServerIdentityProbe {
  /** 触发一次需鉴权的服务端调用；服务端拒认时抛 `SERVER_CREDENTIAL_REJECTED` */
  probe(token: string): Promise<{ uid: string | null }>;
}

export interface ValidatedTarget {
  /** 目标凭据原文（调用方自己负责用完即丢，不入库不回响应） */
  credential: Buffer;
  /** 目标身份标识（无法确定时为 null） */
  uid: string | null;
}

/**
 * S3：目标校验（平台无关）。
 *
 * 三件事：目标账号在、属于本产品、凭据可解且非空。
 * 身份标识交给调用方按平台取；**取不到不拦在这里**（那是 S5 的前置条件，报 `TARGET_IDENTITY_UNKNOWN`）。
 */
export function validateTarget(input: {
  app_id: ManagedAppId;
  account: ManagedAccount | null;
  credential: Buffer | null;
  /** 目标身份标识（由调用方从目标凭据/快照里取）；取不到时为 null */
  uid?: string | null;
}): ValidatedTarget {
  if (!input.account) throw new ApiError(404, 'TARGET_ACCOUNT_NOT_FOUND', '目标账号不存在');
  if (input.account.app_id !== input.app_id) throw new ApiError(409, 'ACCOUNT_APP_MISMATCH', '目标账号不属于该产品');
  if (!input.credential || input.credential.length === 0) throw new ApiError(409, 'TARGET_CREDENTIAL_MISSING', '目标账号没有可用凭据');
  return { credential: input.credential, uid: input.uid ?? null };
}

/**
 * S5：服务端身份校验（平台无关）。
 *
 * `expectedUid` 为目标账号的身份标识；探针回传的身份必须与之一致。
 * 探针缺失 → `PROVIDER_NOT_IMPLEMENTED`（该平台没有服务端校验能力，不拿本地比对顶替）。
 * 目标身份取不到 → `TARGET_IDENTITY_UNKNOWN`（没有比对基准，比不了）。
 */
export async function verifyByServerUid(input: {
  app_id: ManagedAppId;
  /** 客户端此刻实际持有的凭据 */
  token: string;
  /** 目标账号的身份标识；取不到时为 null */
  expectedUid: string | null;
  probe?: ServerIdentityProbe | null;
}): Promise<void> {
  if (!input.probe) {
    throw new ApiError(409, 'PROVIDER_NOT_IMPLEMENTED', '该产品暂不支持服务端身份校验');
  }
  const expectedUid = input.expectedUid?.trim() ?? '';
  if (!expectedUid) {
    throw new ApiError(409, 'TARGET_IDENTITY_UNKNOWN', '目标账号的身份标识无法确定，无法做服务端身份校验');
  }
  const token = input.token.trim();
  if (!token) throw new ApiError(409, 'TARGET_CREDENTIAL_MISSING', '客户端当前没有可用凭据');
  let result: { uid: string | null };
  try {
    result = await input.probe.probe(token);
  } catch (error) {
    // 探针失败 = 服务端没认这份凭据（或网络不通）——一律归到固定码，不把原始异常带进响应
    if (error instanceof ApiError) throw error;
    throw new ApiError(409, 'SERVER_CREDENTIAL_REJECTED', '服务端身份校验未通过');
  }
  const uid = result.uid?.trim() ?? '';
  if (!uid) throw new ApiError(409, 'SERVER_IDENTITY_UNAVAILABLE', '服务端未返回可校验的身份标识');
  if (uid !== expectedUid) {
    throw new ApiError(409, 'SERVER_IDENTITY_MISMATCH', '服务端返回的身份与目标账号不一致');
  }
}

/**
 * 从凭据里取服务端签发的身份标识。
 *
 * 优先取 JWT 的 `sub`（服务端签名，调用方无需信任本地文件）；不是 JWT 时返回 null。
 */
export function credentialUid(credential: Buffer | string): string | null {
  const token = typeof credential === 'string' ? credential : credential.toString('utf8');
  const parts = token.trim().split('.');
  const payload = parts[1];
  if (parts.length !== 3 || !payload) return null;
  try {
    const json = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as Record<string, unknown>;
    const sub = typeof json.sub === 'string' ? json.sub.trim() : '';
    if (sub) return sub;
    const accountId = typeof json.account_id === 'string' ? json.account_id.trim() : '';
    return accountId === '' ? null : accountId;
  } catch {
    return null;
  }
}
