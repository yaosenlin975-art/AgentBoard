/**
 * ACC-KB-B2S：协议级「添加账号」的 provider 契约与公共助手。
 *
 * 目标：不再只能从**正在运行的客户端进程**里捞已有登录态 —— 改成走平台自己的授权协议：
 *   发起（startAuthorization）→ 用户在浏览器确认一次 → 轮询/回调（pollAuthorization）→ 拿到凭据。
 *
 * 三条硬约束（贯穿全部平台实现）：
 * 1. **凭据只在授权成功后落库**：pending 阶段的中间态只进 vault（purpose=`pending_credential`），
 *    绝不进响应、绝不进库、绝不进日志；
 * 2. **失败不留痕**：放弃/超时/被拒都必须把待激活凭据从 vault 删掉，不留孤儿文件、不留半条账号；
 * 3. **证据优先**：每个平台的请求形状都来自本机产品源码或线上实测（见各实现的注释），
 *    与共享知识页冲突时以源码/实测为准，并在卡评论里记录差异。
 */
import type { AddAccountProtocol, ManagedAppId } from '@agentboard/shared';
import { ApiError } from '../../errors.js';

export type { AddAccountProtocol };

/** 加号支持的区域（协议端点按区分家） */
export type AddAccountRegion = 'cn' | 'global';

export interface AddAccountStart {
  /** 用户要打开的授权地址 */
  authorization_url: string;
  /** 需要用户手工输入的码（MiniMax device code）；没有则 null */
  user_code: string | null;
  /** 会话过期时间（epoch ms） */
  expires_at: number;
  /** 待激活凭据：授权成功前还不能用的中间态（device_code / PKCE verifier / poll token…） */
  pending_secret: Buffer;
}

export type AddAccountPoll =
  | { status: 'pending' }
  | { status: 'authorized'; uid: string; display_name: string | null; credential: Buffer }
  | { status: 'failed'; safe_error_code: string }
  | { status: 'expired' };

export interface AddAccountProviderSpec {
  readonly app_id: ManagedAppId;
  readonly protocol: AddAccountProtocol;
  readonly provider_version: string;
  /** 该平台协议端点支持的区域（没有对应线路的平台只列一个） */
  readonly regions: readonly AddAccountRegion[];
  /** 发起授权：产出授权地址 + 待激活凭据 */
  startAuthorization(input: { region: AddAccountRegion }): Promise<AddAccountStart>;
  /** 轮询授权结果：pending 时不得产生任何落库副作用 */
  pollAuthorization(pendingSecret: Buffer): Promise<AddAccountPoll>;
  /** 会话结束（取消/过期/失败）时释放 provider 侧资源（如 Trae 的本地回调监听） */
  dispose?(pendingSecret: Buffer): Promise<void>;
}

/** vault 侧只认这三个 purpose；pending_credential 的 identity_hash 用会话 id 的 sha256 占位 */
export type AddAccountVaultPurpose = 'client_snapshot' | 'checkin' | 'pending_credential';

export interface AddAccountVault {
  protect(data: Buffer, scope: { app_id: ManagedAppId; client_instance_id: string; identity_hash: string; purpose: AddAccountVaultPurpose }): Promise<string>;
  unprotect(ref: string, scope: { app_id: ManagedAppId; client_instance_id: string; identity_hash: string; purpose: AddAccountVaultPurpose }): Promise<Buffer>;
  delete?(ref: string): Promise<void>;
}

// ---------- 公共助手 ----------

export const asRecord = (value: unknown): Record<string, unknown> =>
  (value && typeof value === 'object' ? value as Record<string, unknown> : {});

export const str = (value: unknown): string | null =>
  (typeof value === 'string' && value.trim() !== '' ? value : null);

export const num = (value: unknown): number | null =>
  (typeof value === 'number' && Number.isFinite(value) ? value : null);

export interface HttpOutcome { status: number; ok: boolean; body: unknown }

/** 所有平台 HTTP 都走可注入的 fetchImpl（测试用 fake fetch，不打真实接口） */
export async function requestJson(
  fetchImpl: typeof fetch,
  url: string,
  init: RequestInit,
  timeoutMs: number,
): Promise<HttpOutcome> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(url, { ...init, signal: controller.signal });
    let body: unknown = null;
    try { body = await response.json(); } catch { body = null; }
    return { status: response.status, ok: response.ok, body };
  } finally {
    clearTimeout(timer);
  }
}

/** 待激活凭据统一用 JSON 编码（各平台自己定义形状） */
export function encodePending(value: unknown): Buffer {
  return Buffer.from(JSON.stringify(value), 'utf8');
}

export function decodePending<T>(secret: Buffer): T {
  try {
    const parsed = JSON.parse(secret.toString('utf8')) as unknown;
    if (!parsed || typeof parsed !== 'object') throw new Error('not an object');
    return parsed as T;
  } catch {
    throw new ApiError(500, 'ADD_ACCOUNT_PENDING_CORRUPT', '授权会话的待激活凭据已损坏，请重新发起');
  }
}

/** JWT payload 解出 `sub`（MiniMax 用它当账号 uid）；不是合法 JWT 时返回 null */
export function jwtSubject(token: string): string | null {
  const parts = token.split('.');
  const payload = parts[1];
  if (parts.length !== 3 || !payload) return null;
  try {
    const json = Buffer.from(payload, 'base64url').toString('utf8');
    const sub = str(asRecord(JSON.parse(json)).sub);
    return sub;
  } catch {
    return null;
  }
}
