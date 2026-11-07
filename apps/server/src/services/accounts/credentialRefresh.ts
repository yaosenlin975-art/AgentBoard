/**
 * ACC-TOKEN-2：`POST /api/managed-accounts/:id/refresh-credential` 的三分派执行体（设计页 §4）。
 *
 * - `refresh_token`（minimax）：解密单份凭据 → parseMinimaxCredential → 复用既有 refresh grant
 *   实现（attemptMinimaxRefresh，行为与签到侧 refreshMinimaxCredential 同源）→ 新载荷写回 vault +
 *   更新到期列 → 删旧 ref。invalid_grant（refresh token 被官方客户端轮换作废）→ 记失效 → 409
 *   CREDENTIAL_RELOGIN_REQUIRED；网络/非 2xx/缺字段 → 409 CREDENTIAL_REFRESH_FAILED。
 * - `recapture`（workbuddy/trae/minimax 旧裸串降级）：转发该平台 capture-current 既有逻辑
 *   （workbuddy 客户端未跑先走 backfillCheckinCredentialFromPlugin，与 capture-current 端点分支一致）。
 *   捕获 provider 自身就是到期列写入点，成功后行已带新到期时间。
 * - `relogin` 或 null：不发任何平台请求，直接 409 CREDENTIAL_RELOGIN_REQUIRED（body 附 app_id，
 *   前端拿它开添加账号向导并预选平台）。
 *
 * 并发与幂等：runAccountOperation(operation='capture', tryLock=true)——不新建 operation 类型，
 * 同账号刷新与签到/捕获/切换互斥，抢不到锁 409 ACCOUNT_BUSY；幂等键由路由层处理。
 */
import type { CredentialRefreshMethod, ManagedAccount, PublicManagedAccount } from '@agentboard/shared';
import type { Db } from '../../db/connection.js';
import {
  getManagedAccount,
  markCredentialInvalid,
  markCredentialRefreshed,
  publicManagedAccount,
} from '../../db/repos/managedAccount.js';
import { ApiError } from '../../errors.js';
import { runAccountOperation } from './operationRunner.js';
import type { CheckinVault } from './checkinProvider.js';
import { attemptMinimaxRefresh, parseMinimaxCredential } from './httpCheckinProviders.js';

/** 捕获转发目标（结构化最小接口；生产由 routes 的 requireProvider 提供，测试注入 fake） */
export interface CredentialCaptureProvider {
  captureCurrent(options?: { display_name?: string }): Promise<ManagedAccount>;
  /** WorkBuddy 专属：客户端未跑时用插件线 JWT 回填（与 capture-current 端点分支一致） */
  backfillCheckinCredentialFromPlugin?(): Promise<ManagedAccount | null>;
}

export interface CredentialRefreshDeps {
  db: Db;
  /** 缺失时 refresh_token 分派 503 VAULT_UNAVAILABLE（recapture/relogin 不需要 vault） */
  vault?: CheckinVault;
  resolveCapture: () => Promise<CredentialCaptureProvider>;
  /** minimax refresh grant 的 fetch（测试注入 fake；生产走全局 fetch） */
  fetchImpl?: typeof fetch;
  now?: () => number;
}

export interface CredentialRefreshResult {
  account: PublicManagedAccount;
  refreshed: true;
  method: CredentialRefreshMethod;
}

function reloginRequired(appId: ManagedAccount['app_id'], reasonCode: string, message: string): ApiError {
  return new ApiError(409, 'CREDENTIAL_RELOGIN_REQUIRED', message, { reason_code: reasonCode, app_id: appId });
}

export async function refreshAccountCredential(deps: CredentialRefreshDeps, account: ManagedAccount): Promise<CredentialRefreshResult> {
  const now = deps.now?.() ?? Date.now();
  // 以库内最新行为准（调用方传来的对象可能已过期；method/凭据引用按当前行分派）
  const current = getManagedAccount(deps.db, account.id) ?? account;
  const storedMethod = current.credential_refresh_method ?? null;
  // relogin / 未登记：不发任何平台请求，直接给可行动错误码
  if (storedMethod === null || storedMethod === 'relogin') {
    throw reloginRequired(current.app_id, 'CREDENTIAL_RELOGIN_REQUIRED', '该账号的凭据无法自动刷新，请重新登录');
  }
  let httpError: ApiError | null = null;
  let usedMethod: CredentialRefreshMethod = storedMethod;
  const operation = await runAccountOperation(
    deps.db,
    { account_id: current.id, app_id: current.app_id, client_instance_id: current.client_instance_id, operation: 'capture' },
    async () => {
      if (storedMethod === 'refresh_token') {
        if (!deps.vault || current.checkin_credential_ref === null) {
          // 无 vault / 无凭据引用 → 无法走 grant，按平台能力降级 recapture
          usedMethod = 'recapture';
        } else {
          const scope = { app_id: current.app_id, client_instance_id: current.client_instance_id, identity_hash: current.identity_hash, purpose: 'checkin' as const };
          let credential: Buffer;
          try {
            credential = await deps.vault.unprotect(current.checkin_credential_ref, scope);
          } catch {
            throw new ApiError(503, 'VAULT_UNAVAILABLE', '凭据保护不可用');
          }
          const parsed = parseMinimaxCredential(credential);
          if (parsed.refresh_token !== undefined) {
            const outcome = await attemptMinimaxRefresh(parsed, current.service_region === 'global' ? 'global' : 'cn', {
              ...(deps.fetchImpl !== undefined ? { fetchImpl: deps.fetchImpl } : {}),
            }).catch(() => ({ ok: false as const, reason: 'failed' as const }));
            if (outcome.ok) {
              const payload = Buffer.from(JSON.stringify({
                access_token: outcome.payload.access_token,
                refresh_token: outcome.payload.refresh_token,
                expires_at: outcome.payload.expires_at,
              }), 'utf8');
              const newRef = await deps.vault.protect(payload, scope);
              deps.db.prepare('UPDATE managed_account SET checkin_credential_ref=?, updated_at=? WHERE id=?')
                .run(newRef, now, current.id);
              markCredentialRefreshed(deps.db, current.id, outcome.payload.expires_at, now);
              if (deps.vault.delete !== undefined) {
                try { await deps.vault.delete(current.checkin_credential_ref); } catch { /* 旧凭据清理失败不影响刷新结果 */ }
              }
              return 'succeeded';
            }
            if (outcome.reason === 'invalid_grant') {
              markCredentialInvalid(deps.db, current.id, now);
              httpError = reloginRequired(current.app_id, 'CREDENTIAL_INVALID_GRANT', '该账号的刷新令牌已被平台作废，请重新登录');
              throw httpError;
            }
            httpError = new ApiError(409, 'CREDENTIAL_REFRESH_FAILED', '刷新凭据失败，请稍后重试或重新登录');
            throw httpError;
          }
          // minimax 旧裸串载荷（无 refresh_token）→ 降级 recapture（设计页 §2 矩阵）
          usedMethod = 'recapture';
        }
      }
      // recapture：转发该平台 capture-current 既有逻辑（provider 自身落新凭据与到期列）
      const provider = await deps.resolveCapture();
      try {
        await provider.captureCurrent({});
        return 'succeeded';
      } catch (error) {
        if (error instanceof ApiError && error.code === 'CLIENT_NOT_RUNNING'
          && current.app_id === 'workbuddy_desktop'
          && typeof provider.backfillCheckinCredentialFromPlugin === 'function') {
          const backfilled = await provider.backfillCheckinCredentialFromPlugin().catch(() => null);
          if (backfilled !== null) return 'succeeded';
        }
        httpError = error instanceof ApiError
          ? error
          : new ApiError(409, 'CREDENTIAL_REFRESH_FAILED', '刷新凭据失败，请稍后重试或重新登录');
        throw httpError;
      }
    },
    {},
    { tryLock: true },
  );
  if (operation.state !== 'succeeded') {
    // runAccountOperation 吞掉原始异常只留 safe_error_code；透传原码（如 TRAE_STORAGE_MISSING / CLIENT_NOT_RUNNING）
    if (httpError !== null) throw httpError;
    throw new ApiError(409, operation.safe_error_code ?? 'CREDENTIAL_REFRESH_FAILED', '刷新凭据失败，请稍后重试或重新登录');
  }
  const updated = getManagedAccount(deps.db, current.id);
  if (!updated) throw new ApiError(409, 'CREDENTIAL_REFRESH_FAILED', '刷新凭据失败：账号行已不存在');
  return { account: publicManagedAccount(updated, now), refreshed: true, method: usedMethod };
}
