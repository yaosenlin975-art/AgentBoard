/**
 * 账号能力矩阵与文案映射（ACC-09）。
 * 能力状态一律以服务端 `GET /api/managed-account-capabilities` 为准；前端只保留 reason_code / source 的展示文案。
 * 服务端返回：AccountCapability[] = { app_id, capture, switch, checkin, reason_code, source: 'static'|'derived' }。
 */
import { useQuery } from '@tanstack/react-query';
import type { AccountCapability, ManagedAppId } from '@agentboard/shared';
import { api } from '../../api/client';

export const APP_LABEL: Record<ManagedAppId, string> = {
  workbuddy_desktop: 'WorkBuddy Desktop',
  codebuddy_desktop: 'CodeBuddy Desktop',
  minimax: 'MiniMax 桌面',
  trae: 'Trae 桌面',
};

export const APP_ORDER: ManagedAppId[] = ['workbuddy_desktop', 'codebuddy_desktop'];

/** 不可用原因的界面文案（按服务端 reason_code；'OK' 不参与文案） */
export const REASON_LABEL: Record<string, string> = {
  OK: '可用',
  TARGET_KIND_UNCONFIRMED: '目标未确认，不可用',
  CHECKIN_PROVIDER_UNVERIFIED: '签到能力未验证',
  CHECKIN_PROVIDER_AVAILABLE: '签到能力可用',
  PROVIDER_UNAVAILABLE: 'provider 未装配',
  PROVIDER_UNVERIFIED: '该能力未验证',
  VAULT_UNAVAILABLE: '凭据保护未装配',
  CHECKIN_BATCH_IN_PROGRESS: '该产品已有进行中的签到批次',
  CHECKIN_BATCH_FINISHED: '批次已结束，无法取消',
  ACCOUNT_BUSY: '账号正忙，本轮未发起',
};

/** 能力来源文案：derived = 由注入的已验证 provider 推导，static = registry 静态表 */
export const SOURCE_LABEL: Record<AccountCapability['source'], string> = {
  derived: '由已验证 provider 推导',
  static: '静态能力表',
};

export function reasonLabel(code: string | null | undefined): string {
  if (!code) return '能力未验证';
  return REASON_LABEL[code] ?? code;
}

/** 服务端错误码（web ApiError 只带 code/status） */
export function reasonCodeOf(error: unknown): string | null {
  if (typeof error !== 'object' || error === null) return null;
  const code = (error as { code?: unknown }).code;
  return typeof code === 'string' ? code : null;
}

/**
 * UI 视图类型：服务端恒填三个分维度原因码，但 shared 里声明为可选（避免既有测试构造器 tsc 报错）。
 * 前端在这里收窄为必填，由 `normalizeCapability` 在拿到响应后补齐（缺失时回退顶层 reason_code）。
 */
export type CapabilityView = AccountCapability & Required<Pick<AccountCapability, 'capture_reason_code' | 'switch_reason_code' | 'checkin_reason_code'>>;

export function normalizeCapability(row: AccountCapability): CapabilityView {
  return {
    ...row,
    capture_reason_code: row.capture_reason_code ?? (row.capture ? 'OK' : row.reason_code),
    switch_reason_code: row.switch_reason_code ?? (row.switch ? 'OK' : row.reason_code),
    checkin_reason_code: row.checkin_reason_code ?? row.reason_code,
  };
}

/** 能力维度 */
export type CapabilityAction = 'capture' | 'switch' | 'checkin';

const DIMENSION_FIELD: Record<CapabilityAction, 'capture_reason_code' | 'switch_reason_code' | 'checkin_reason_code'> = {
  capture: 'capture_reason_code',
  switch: 'switch_reason_code',
  checkin: 'checkin_reason_code',
};

/**
 * 按维度取原因码：优先取分维度字段（capture/switch/checkin_reason_code）。
 * 返回 'OK' 表示可用，调用方不要当错误文案。
 */
export function capabilityReasonCode(capability: CapabilityView | null, action: CapabilityAction): string | null {
  if (!capability) return null;
  return capability[DIMENSION_FIELD[action]];
}

/** 该维度不可用时的原因码（可用返回 null，便于直接渲染「不可用（原因）」） */
export function unavailableReason(capability: CapabilityView | null, action: CapabilityAction): string | null {
  if (!capability) return null;
  if (capability[action]) return null;
  const code = capabilityReasonCode(capability, action);
  return code === 'OK' ? null : code;
}

/** 该维度不可用时的界面文案 */
export function unavailableLabel(capability: CapabilityView | null, action: CapabilityAction): string | null {
  const code = unavailableReason(capability, action);
  if (code === null) return null;
  return reasonLabel(code);
}

export interface AccountCapabilitiesState {
  capabilities: Partial<Record<ManagedAppId, CapabilityView>>;
  isPending: boolean;
  isError: boolean;
  errorMessage: string | null;
}

/** 能力矩阵查询：失败时不回退到本地副本，界面据此禁用全部写操作 */
export function useAccountCapabilities(): AccountCapabilitiesState {
  const query = useQuery({
    queryKey: ['managed-account-capabilities'],
    queryFn: () => api.get<AccountCapability[]>('/api/managed-account-capabilities'),
    staleTime: 30_000,
  });
  const capabilities: Partial<Record<ManagedAppId, CapabilityView>> = {};
  for (const row of query.data ?? []) capabilities[row.app_id] = normalizeCapability(row);
  return {
    capabilities,
    isPending: query.isPending,
    isError: query.isError,
    errorMessage: query.error instanceof Error ? query.error.message : null,
  };
}

