/**
 * 账号能力矩阵与文案映射（ACC-09 / ACC-14）。
 * 能力状态一律以服务端 `GET /api/managed-account-capabilities` 为准；前端只保留 reason_code / source 的展示文案。
 * 服务端返回：AccountCapability[] = { app_id, capture, switch, checkin, *_reason_code, reason_code, source }。
 *
 * ACC-14：界面只展示三个在用平台（WorkBuddy / MiniMax / Trae）；CodeBuddy Desktop 已下线，
 * 栏位从 `APP_ORDER` / `APP_LABEL` 移除，历史账号在 `AccountsPanel` 过滤掉（库内数据与接口不变）。
 */
import { useQuery } from '@tanstack/react-query';
import type { AccountCapability, ManagedAppId, PublicManagedAccount } from '@agentboard/shared';
import { api } from '../../api/client';

/** 界面上按平台分区的 app（CodeBuddy Desktop 已下线，不在其中） */
export type AccountsAppId = 'workbuddy_desktop' | 'minimax' | 'trae';

export const APP_ORDER: AccountsAppId[] = ['workbuddy_desktop', 'minimax', 'trae'];

export const APP_LABEL: Record<AccountsAppId, string> = {
  workbuddy_desktop: 'WorkBuddy Desktop',
  minimax: 'MiniMax',
  trae: 'Trae',
};

/** 已下线平台：不出栏位；历史账号在界面过滤（接口与库内记录保持原样） */
export const OFFLINE_APP_IDS: readonly ManagedAppId[] = ['codebuddy_desktop'];

export function isOfflineApp(app: ManagedAppId): boolean {
  return OFFLINE_APP_IDS.includes(app);
}

/** 平台名（已下线平台返回原 id，不抛错） */
export function appLabel(app: ManagedAppId): string {
  return APP_LABEL[app as AccountsAppId] ?? app;
}

/** 不可用原因的界面文案（按服务端 reason_code；'OK' 不参与文案） */
export const REASON_LABEL: Record<string, string> = {
  OK: '可用',
  TARGET_KIND_UNCONFIRMED: '目标未确认，不可用',
  CHECKIN_PROVIDER_UNVERIFIED: '签到能力未验证',
  CHECKIN_PROVIDER_AVAILABLE: '签到能力可用',
  CHECKIN_READY: '签到可用',
  PROVIDER_UNAVAILABLE: 'provider 未装配',
  PROVIDER_UNVERIFIED: '该能力未验证',
  VAULT_UNAVAILABLE: '凭据保护未装配',
  CHECKIN_BATCH_IN_PROGRESS: '该产品已有进行中的签到批次',
  CHECKIN_BATCH_FINISHED: '批次已结束，无法取消',
  ACCOUNT_BUSY: '账号正忙，本轮未发起',
  ACCOUNT_DISABLED: '账号已停用，本轮未发起',
  ACCOUNT_NOT_FOUND: '账号不存在',
  CHECKIN_CREDENTIAL_MISSING: '该账号没有签到凭据，未发起',
  CHECKIN_CREDENTIAL_INVALID: '凭据已失效，请重新读取本机账号',
  CHECKIN_PROVIDER_MISMATCH: '账号与签到平台不匹配',
  CHECKIN_RATE_LIMITED: '签到被限流',
  CHECKIN_FAILED: '签到失败',
  OPERATION_UNKNOWN: '结果未知，未自动重发',
  VAULT_READ_FAILED: '凭据读取失败，请重新读取本机账号',
  LOCAL_RECORD: '本地记录今日已完成',
  NETWORK: '网络错误',
  // ACC-13：桌面客户端能力未就绪的真实根因码
  CLIENT_NOT_INSTALLED: '本机未安装该客户端',
  LOGIN_STATE_NOT_FILE_BASED: '登录态不在可改写的明文文件里',
  CHECKIN_AUTH_UNSUPPORTED: '该平台走本机凭据读取，不支持授权流程',
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

/** 猫猫旅行结果文案（workbuddy 签到成功后的附加活动，落在 operation.recovery_ref） */
export const TRAVEL_LABEL: Record<string, string> = {
  claimed: '已领取',
  dispatched: '已派出',
  already_done: '今日已完成',
  failed: '失败',
};

export interface TravelView {
  status: string;
  label: string;
  /** 失败时的安全错误码（服务端口径，不含 token / stderr）；成功为 null */
  code: string | null;
}

/**
 * 解析签到 operation 的 `recovery_ref`：`travel=<status>` 或 `travel=failed:<CODE>`。
 * 无 travel 前缀返回 null（其它 operation 的 recovery_ref 与本视图无关）。
 */
export function travelFromRecoveryRef(ref: string | null | undefined): TravelView | null {
  if (!ref) return null;
  const match = /^travel=([a-z_]+)(?::(.+))?$/.exec(ref.trim());
  if (!match) return null;
  const status = match[1]!;
  return { status, label: TRAVEL_LABEL[status] ?? status, code: match[2] ?? null };
}

/**
 * 「签到当前」判定（ACC-14）：一键签到会把该账号提交进批次。
 * 可判定条件 = 该平台签到能力可用 + 账号启用 + 账号签到能力非 unsupported。
 * 服务端不暴露 `checkin_credential_ref`，是否真有凭据以批次逐账号结果（CHECKIN_CREDENTIAL_MISSING）为准。
 */
export function checkinParticipation(
  account: Pick<PublicManagedAccount, 'enabled' | 'checkin_capability'>,
  capability: CapabilityView | null,
): { participates: boolean; reason: string | null } {
  if (account.enabled === false) return { participates: false, reason: '账号已停用' };
  if (account.checkin_capability === 'unsupported') return { participates: false, reason: '该账号不支持签到' };
  if (capability === null) return { participates: false, reason: '能力未知' };
  if (!capability.checkin) {
    return { participates: false, reason: unavailableLabel(capability, 'checkin') ?? '签到能力未验证' };
  }
  return { participates: true, reason: null };
}

/** 「读取本机账号」失败原因文案：只给可解释结论，不回显脚本 stdout/stderr 原文 */
export const IMPORT_ERROR_LABEL: Record<string, string> = {
  PYTHON_UNAVAILABLE: '本机未找到 python，无法读取本机账号',
  EXPORT_TIMEOUT: '读取超时：凭据脚本未在限定时间内返回',
  EXPORT_FAILED: '读取失败：凭据脚本异常退出',
  EXPORT_OUTPUT_INVALID: '脚本输出无法解析，已丢弃，未采信其中任何凭据',
  VAULT_UNAVAILABLE: '凭据保险库不可用，未写入任何凭据',
};

export function importErrorLabel(code: string | null | undefined): string | null {
  if (!code) return null;
  return IMPORT_ERROR_LABEL[code] ?? `读取失败（${code}）`;
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
