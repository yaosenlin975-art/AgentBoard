/**
 * 协议级「添加账号」的前端调用层（ACC-KB-B2W）。
 *
 * 契约见 `Docs/api.md` §14c（服务端实现 `apps/server/src/api/accountRoutes.ts` 的
 * `/api/add-account-*` 路由族 + `services/accounts/addAccountAuthorization.ts`）。
 *
 * 四段语义（与签到授权同构，但方向相反：先授权、再建账号）：
 * 1. `GET  /api/add-account-protocols` —— 该平台**实际装配了哪个协议**（界面按它分支，不维护平台副本）；
 * 2. `POST /api/add-account-sessions` —— 发起授权，拿 `authorization_url`（+ MiniMax 的设备码）；
 * 3. `POST /api/add-account-sessions/:id/poll` —— 轮询结果；`pending` 不产生任何落库副作用，
 *    `authorized` 时凭据落 vault 并建/更新 `managed_account`（同一 app + 同一 uid 不产生重复账号）；
 * 4. `DELETE /api/add-account-sessions/:id` —— 放弃授权：会话置 cancelled，不建账号。
 *
 * 响应只含脱敏元数据：待激活凭据（device_code / PKCE verifier / poll token）**永不出现在响应里**。
 */
import type { AddAccountProtocolInfo, AddAccountSession, ManagedAppId, PublicManagedAccount } from '@agentboard/shared';
import { api } from '../../api/client';

export interface AddAccountProtocolsResult {
  items: AddAccountProtocolInfo[];
}

/** 轮询结果：`pending` 时 `account` 为 null；`authorized` 时带新建/更新的账号 */
export interface AddAccountPollResult {
  session: AddAccountSession;
  account: PublicManagedAccount | null;
}

/** 该工作区支持的「协议级添加账号」平台与协议（未装配的平台不在列表里） */
export const fetchAddAccountProtocols = (): Promise<AddAccountProtocolsResult> =>
  api.get<AddAccountProtocolsResult>('/api/add-account-protocols');

/** 发起授权：拿到授权地址（+ 设备码）。同平台已有进行中的会话时服务端返回 409 ADD_ACCOUNT_SESSION_EXISTS */
export const startAddAccountSession = (
  appId: ManagedAppId,
  region?: 'cn' | 'global',
): Promise<{ session: AddAccountSession }> =>
  api.post<{ session: AddAccountSession }>('/api/add-account-sessions', region ? { app_id: appId, region } : { app_id: appId });

/** 轮询授权结果 */
export const pollAddAccountSession = (sessionId: string): Promise<AddAccountPollResult> =>
  api.post<AddAccountPollResult>(`/api/add-account-sessions/${encodeURIComponent(sessionId)}/poll`, {});

/** 放弃授权：会话置 cancelled，待激活凭据删除，不建账号 */
export const cancelAddAccountSession = (sessionId: string): Promise<{ session: AddAccountSession }> =>
  api.del<{ session: AddAccountSession }>(`/api/add-account-sessions/${encodeURIComponent(sessionId)}`);
