/**
 * 账号能力矩阵与文案映射（ACC-09 / ACC-14）。
 * 能力状态一律以服务端 `GET /api/managed-account-capabilities` 为准；前端只保留 reason_code / source 的展示文案。
 * 服务端返回：AccountCapability[] = { app_id, capture, switch, checkin, *_reason_code, reason_code, source }。
 *
 * ACC-14：界面只展示三个在用平台（WorkBuddy / MiniMax / Trae）；CodeBuddy Desktop 已下线，
 * 栏位从 `APP_ORDER` / `APP_LABEL` 移除，历史账号在 `AccountsPanel` 过滤掉（库内数据与接口不变）。
 */
import { useQuery } from '@tanstack/react-query';
import type { AccountCapability, AccountOperation, CliAppCapability, ManagedAppId, PublicManagedAccount } from '@agentboard/shared';
import { api } from '../../api/client';
import { isTerminalState } from './AccountOperationStatus';

/** 界面上按平台分区的 app（CodeBuddy Desktop 已下线，不在其中） */
export type AccountsAppId = 'workbuddy_desktop' | 'minimax' | 'trae';

/**
 * 平台展示元信息（ACC-KB-B1W）：**唯一**的显示名/图标/色调来源。
 * 服务端 `ManagedAppId` 已是六值（含 `qoder_cn` / `zcode`），但 B1S 的能力矩阵与路由还没落，
 * 所以这里不把它们塞进 `APP_ORDER`（版式不动，仍三栏），只保证：
 * - 已知平台 → 稳定的显示名 + 图标字形 + 中性色调；
 * - 未知/未来平台 → `platformMeta` 兜底出「未识别平台」，绝不把裸 id 抛到界面上。
 */
export interface PlatformMeta {
  app: ManagedAppId;
  label: string;
  /** 文字图标（单字符/双字符字形，走中性色，不引入新色相） */
  glyph: string;
  /** 是否已下线（下线平台不进分区，历史账号由 AccountsPanel 过滤） */
  offline: boolean;
}

const PLATFORM_META: Record<string, Omit<PlatformMeta, 'app'>> = {
  workbuddy_desktop: { label: 'Workbuddy', glyph: 'W', offline: false },
  codebuddy_desktop: { label: 'CodeBuddy Desktop', glyph: 'C', offline: true },
  minimax: { label: 'MiniMax', glyph: 'M', offline: false },
  trae: { label: 'Trae', glyph: 'T', offline: false },
  qoder_cn: { label: 'Qoder CN', glyph: 'Q', offline: false },
  zcode: { label: 'ZCode', glyph: 'Z', offline: false },
};

/** 未知平台的兜底展示名（不含裸 id） */
export const UNKNOWN_PLATFORM_LABEL = '未识别平台';

/** 平台元信息（未知 id 走兜底，永不返回裸 id 作为显示名） */
export function platformMeta(app: string): PlatformMeta {
  const known = PLATFORM_META[app];
  if (known !== undefined) return { app: app as ManagedAppId, ...known };
  return { app: app as ManagedAppId, label: UNKNOWN_PLATFORM_LABEL, glyph: '?', offline: false };
}

export const APP_ORDER: AccountsAppId[] = ['workbuddy_desktop', 'minimax', 'trae'];

export const APP_LABEL: Record<AccountsAppId, string> = {
  workbuddy_desktop: 'Workbuddy',
  minimax: 'MiniMax',
  trae: 'Trae',
};

/** 已下线平台：不出栏位；历史账号在界面过滤（接口与库内记录保持原样） */
export const OFFLINE_APP_IDS: readonly ManagedAppId[] = ['codebuddy_desktop'];

export function isOfflineApp(app: ManagedAppId): boolean {
  return OFFLINE_APP_IDS.includes(app);
}

/** 平台名（已下线平台与未知平台都走映射表，未知给「未识别平台」而不是裸 id） */
export function appLabel(app: ManagedAppId | string): string {
  return platformMeta(String(app)).label;
}

/**
 * 不可用原因的界面文案（中文主文案）。
 *
 * 码的来源以服务端代码为准（逐条核对，不猜码）：
 * - 能力矩阵：`apps/server/src/services/accounts/registry.ts` 的静态表（`OK` / `CHECKIN_READY` /
 *   `TARGET_KIND_UNCONFIRMED` / `CLIENT_NOT_INSTALLED` / `LOGIN_STATE_NOT_FILE_BASED`），
 *   以及 `apps/server/src/api/accountRoutes.ts` 的 `mergeAccountCapabilities` 分维度推导
 *   （`CHECKIN_PROVIDER_AVAILABLE` / `CHECKIN_PROVIDER_UNVERIFIED`，可用维度恒为 `OK`）。
 * - 捕获/切换/签到/导入接口抛出的 `ApiError.code`：`api/accountRoutes.ts`、
 *   `services/accounts/{workbuddyDesktopProvider,minimaxDesktopProvider,checkinRunner,checkinAuthorization,
 *   operationRunner,credentialImport,secretVault}.ts`、`errors.ts` 的默认码。
 * - 落库码：`operationRunner.ts` 的 `SAFE_ERROR_CODES` 与它的 `ACCOUNT_OPERATION_FAILED` 兜底、
 *   `checkinRunner.ts` 的逐项码（`ACCOUNT_DISABLED` / `CHECKIN_CREDENTIAL_MISSING` / `LOCAL_RECORD` …）。
 *
 * 未收录的码**不会**当主文案：`reasonLabel` 回中性文案，原始码只走 `reasonTechnicalCode`（可展开技术码）。
 */
export const REASON_LABEL: Record<string, string> = {
  // 能力矩阵与通用能力态
  OK: '可用',
  CHECKIN_READY: '签到可用',
  CHECKIN_PROVIDER_AVAILABLE: '签到能力可用',
  CHECKIN_PROVIDER_UNVERIFIED: '签到能力未验证',
  TARGET_KIND_UNCONFIRMED: '目标未确认，不可用',
  CLIENT_NOT_INSTALLED: '本机未安装该客户端',
  LOGIN_STATE_NOT_FILE_BASED: '登录态不在可改写的明文文件里',
  PROVIDER_UNAVAILABLE: '客户端 provider 未装配',
  PROVIDER_UNVERIFIED: '该能力未验证',
  // ACC-KB-B1W：新增平台（qoder_cn / zcode）只有 id、provider 还没实现，如实展示「尚未接入」
  PROVIDER_NOT_IMPLEMENTED: '该平台尚未接入（provider 未实现）',
  VAULT_UNAVAILABLE: '凭据保护未装配',
  VAULT_READ_FAILED: '凭据读取失败，请重新读取本机账号',
  // 桌面客户端捕获 / 切换
  CLIENT_NOT_RUNNING: '客户端未在运行',
  CLIENT_NOT_LOGGED_IN: '客户端未登录',
  CLIENT_INSTANCE_NOT_FOUND: '未找到该客户端安装实例',
  CLIENT_VERSION_UNSUPPORTED: '客户端版本不在支持范围',
  CLIENT_SCHEMA_UNSUPPORTED: '客户端登录文件格式不在支持范围',
  CLIENT_PATH_MISSING: '客户端路径不存在',
  CLIENT_STATE_UNREADABLE: '客户端登录态不可读取',
  CLIENT_STOP_UNAVAILABLE: '客户端无法安全退出',
  CLIENT_START_UNAVAILABLE: '客户端无法重新启动',
  EXIT_NOT_CONFIRMED: '客户端未按要求退出',
  // ACC-KB-B4S：进程控制（B4S-1 clientProcess.ts）——「客户端在跑」被拦住时的原因
  CLIENT_PROCESS_PROBE_FAILED: '无法查询客户端进程状态，已中止操作',
  CLIENT_PROCESS_CONTROL_UNAVAILABLE: '当前平台无法控制客户端进程，已中止操作',
  CLIENT_STOP_TIMEOUT: '客户端未在超时内退出，已中止操作',
  IDENTITY_UNAVAILABLE: '读不到当前登录身份',
  IDENTITY_CHANGED: '操作期间登录身份变化，已放弃保存',
  IDENTITY_VERIFY_FAILED: '切换后身份核验失败',
  WORKBUDDY_PATHS_UNAVAILABLE: '无法解析本机客户端契约路径',
  OPERATION_NOT_FOUND: '操作记录不存在',
  OPERATION_START_TIMEOUT: '操作未能启动',
  RECOVERY_REQUIRED: '上次操作需要恢复',
  RECOVERY_NOT_REQUIRED: '没有需要恢复的操作',
  RESTORED: '已恢复到操作前的状态',
  SWITCH_ROLLED_BACK: '切换失败，已回滚到原账号',
  SWITCH_WRITE_FAILED: '写入目标账号失败',
  SWITCH_STAGE_FAILED: '切换步骤失败',
  STARTUP_TIMEOUT: '客户端启动未就绪',
  TARGET_ACCOUNT_NOT_FOUND: '目标账号不存在',
  TARGET_CREDENTIAL_MISSING: '目标账号缺少可用凭据',
  TARGET_IDENTITY_UNKNOWN: '目标账号身份无法确定',
  TARGET_IDENTITY_MISMATCH: '目标账号身份不匹配',
  TARGET_INSTANCE_MISMATCH: '目标账号实例不匹配',
  TARGET_SNAPSHOT_INVALID: '目标账号快照无效',
  SNAPSHOT_MISSING: '缺少账号快照',
  SNAPSHOT_FILE_MISSING: '快照文件缺失',
  SNAPSHOT_VERSION_MISMATCH: '快照版本不匹配',
  SNAPSHOT_WRITE_FAILED: '快照写入失败',
  // ACC-KB-B4S：S5 服务端身份校验（B4S-3 switchStages.ts）
  SERVER_CREDENTIAL_REJECTED: '服务端不认当前客户端的登录凭据',
  SERVER_IDENTITY_UNAVAILABLE: '服务端未返回可校验的身份标识',
  SERVER_IDENTITY_MISMATCH: '服务端返回的身份与目标账号不一致',
  // Trae / 协议级添加账号
  TRAE_STORAGE_MISSING: '未找到该客户端的本地凭据文件',
  ADD_ACCOUNT_PROTOCOL_UNSUPPORTED: '该平台不支持协议级添加账号',
  ADD_ACCOUNT_SESSION_EXISTS: '已有进行中的添加账号会话',
  // ACC-KB-B2W：协议级加号的授权会话与平台侧原因码
  AUTHORIZATION_EXPIRED: '授权会话已过期，请重新发起',
  AUTHORIZATION_NOT_PENDING: '该授权会话已不在进行中',
  AUTHORIZATION_CANCELLED: '已取消添加账号',
  MINIMAX_ACCESS_DENIED: '授权被拒绝，未添加账号',
  MINIMAX_DEVICE_CODE_INVALID: '平台返回的设备码信息不完整，无法发起授权',
  MINIMAX_TOKEN_RESPONSE_INVALID: '平台返回的授权结果不完整，未添加账号',
  MINIMAX_IDENTITY_MISSING: '平台未返回账号标识，未添加账号',
  ZCODE_INIT_INVALID: '平台授权初始化失败',
  ZCODE_FLOW_FAILED: '平台授权流程失败，未添加账号',
  ZCODE_TOKEN_INVALID: '平台返回的令牌无效，未添加账号',
  QODER_IDENTITY_MISSING: '平台未返回账号标识，未添加账号',
  WORKBUDDY_STATE_INVALID: '平台授权状态无效，无法发起授权',
  WORKBUDDY_IDENTITY_MISSING: '平台未返回账号标识，未添加账号',
  TRAE_DEVICE_IDENTITY_UNAVAILABLE: '读不到本机客户端设备身份，无法添加账号',
  TRAE_CALLBACK_PORT_UNAVAILABLE: '本机回调端口被占用，无法添加账号',
  TRAE_CALLBACK_HOST_REJECTED: '回调来源不在允许范围内，未添加账号',
  TRAE_TOKEN_INVALID: '平台返回的令牌无效，未添加账号',
  TRAE_IDENTITY_MISSING: '平台未返回账号标识，未添加账号',
  ACCOUNT_EXISTS: '该账号已存在',
  ACCOUNT_NOT_FOUND: '账号不存在',
  ACCOUNT_DISABLED: '账号已停用，本轮未发起',
  ACCOUNT_BUSY: '账号正忙，本轮未发起',
  ACCOUNT_APP_MISMATCH: '账号与操作平台不匹配',
  ACCOUNT_OPERATION_FAILED: '操作执行失败（未归类错误）',
  // 签到
  CHECKIN_FAILED: '签到失败',
  CHECKIN_RATE_LIMITED: '签到被限流',
  CHECKIN_CREDENTIAL_MISSING: '该账号没有签到凭据，未发起',
  CHECKIN_CREDENTIAL_INVALID: '凭据已失效，请重新读取本机账号',
  CHECKIN_PROVIDER_MISMATCH: '账号与签到平台不匹配',
  CHECKIN_IDENTITY_MISMATCH: '签到凭据身份与账号不匹配',
  CHECKIN_AUTH_UNSUPPORTED: '该平台走本机凭据读取，不支持授权流程',
  CHECKIN_AUTHORIZATION_EXISTS: '该账号已有进行中的签到授权',
  CHECKIN_BATCH_IN_PROGRESS: '该产品已有进行中的签到批次',
  CHECKIN_BATCH_FINISHED: '批次已结束，无法取消',
  OPERATION_UNKNOWN: '结果未知，未自动重发',
  LOCAL_RECORD: '本地记录今日已完成',
  // ACC-CC-2：Command Code（CLI 来源）能力原因码（依据 CC-1 调研文档 §4）
  CLI_NOT_INSTALLED: '本机未安装该 CLI',
  AUTH_FILE_MISSING: '本机没有该来源的凭据文件',
  AUTH_SCHEMA_UNSUPPORTED: '凭据文件格式不在支持范围',
  AUTH_WRITE_UNVERIFIED: '写回路径未验证，暂不可切换',
  CHECKIN_NOT_APPLICABLE: '该来源没有签到功能',
  CAPABILITY_UNKNOWN: '能力状态未取到',
  // 通用错误（errors.ts 默认码 + 前端网络错误）
  VALIDATION_ERROR: '参数不合法',
  NOT_FOUND: '对象不存在',
  CONFLICT: '状态冲突',
  INTERNAL: '服务端内部错误',
  NETWORK: '网络错误',
};

/** 未知码的中性主文案：裸码不出现在主文案位置 */
export const UNKNOWN_REASON_LABEL = '该操作暂不可用';

/** 能力来源文案：derived = 由注入的已验证 provider 推导，static = registry 静态表 */
export const SOURCE_LABEL: Record<AccountCapability['source'], string> = {
  derived: '由已验证 provider 推导',
  static: '静态能力表',
};

/** 该码是否有中文文案（未知码返回 false，界面据此展示可展开技术码） */
export function hasReasonLabel(code: string | null | undefined): boolean {
  if (!code) return false;
  return Object.prototype.hasOwnProperty.call(REASON_LABEL, code);
}

export function reasonLabel(code: string | null | undefined): string {
  if (!code) return '能力未验证';
  return REASON_LABEL[code] ?? UNKNOWN_REASON_LABEL;
}

/**
 * 技术码（排障用）：只在「技术码」可展开区展示，主文案永远不用裸码。
 * 已知码也返回原码，便于对照服务端日志；无码返回 null。
 */
export function reasonTechnicalCode(code: string | null | undefined): string | null {
  return typeof code === 'string' && code.length > 0 ? code : null;
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
 * 可判定条件 = 该平台签到能力可用 + 账号启用 + 账号签到能力非 unsupported + 已有签到凭据。
 * 服务端只暴露布尔 `has_checkin_credential`（不暴露 ref）；缺凭据的账号不再提交进批次。
 */
export function checkinParticipation(
  account: Pick<PublicManagedAccount, 'enabled' | 'checkin_capability' | 'has_checkin_credential'>,
  capability: CapabilityView | null,
): { participates: boolean; reason: string | null } {
  if (account.enabled === false) return { participates: false, reason: '账号已停用' };
  if (account.checkin_capability === 'unsupported') return { participates: false, reason: '该账号不支持签到' };
  if (account.has_checkin_credential === false) return { participates: false, reason: '缺少签到凭据，请先刷新或重新获取' };
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

/** 「今日已完成」计入分子的状态（设计 §5 拍板口径） */
const CHECKIN_DONE_STATUSES: readonly string[] = ['succeeded', 'already_done'];

/** 本地日期键（YYYY-MM-DD，按浏览器时区），与批次 `profile_local_day` 同口径 */
export function localDayKey(ms: number): string {
  const date = new Date(ms);
  const pad = (value: number): string => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

export type CheckinChipTone = 'done' | 'partial' | 'unavailable';

export interface CheckinTodaySummary {
  /** 分母 = 可参与签到账号数（checkinParticipation 口径） */
  total: number;
  /** 分子 = 今日已完成（last_checkin_day=今天 且 status ∈ {succeeded, already_done}） */
  done: number;
  /** 今日结果未知：不计入分子，芯片加 ? 角标 */
  unknown: number;
  chip: { tone: CheckinChipTone; text: string; title: string };
}

/**
 * 平台签到芯片（ACC-PANEL-03，设计 §5/§6）：
 * 全完成→绿 `✓ n/n`；部分→琥珀 `n/m`；平台签到能力不可用→灰「签到不可用」。
 * `m = 0`（能力可用但没有可参与账号）归灰档显示「未纳入签到」，不虚报完成。
 */
export function summarizeCheckinToday(
  accounts: Array<Pick<PublicManagedAccount, 'enabled' | 'checkin_capability' | 'has_checkin_credential' | 'last_checkin_day' | 'last_checkin_status'>>,
  capability: CapabilityView | null,
  today: string,
): CheckinTodaySummary {
  const participating = accounts.filter((account) => checkinParticipation(account, capability).participates);
  const total = participating.length;
  const done = participating.filter((account) =>
    account.last_checkin_day === today && (CHECKIN_DONE_STATUSES.includes(account.last_checkin_status ?? ''))).length;
  const unknown = participating.filter((account) => account.last_checkin_day === today && account.last_checkin_status === 'unknown').length;

  if (capability === null) {
    return { total, done, unknown, chip: { tone: 'unavailable', text: '签到能力未知', title: '能力矩阵尚未取到该平台签到能力' } };
  }
  if (!capability.checkin) {
    const label = unavailableLabel(capability, 'checkin') ?? '该平台签到能力不可用';
    const code = capabilityReasonCode(capability, 'checkin');
    return { total, done, unknown, chip: { tone: 'unavailable', text: '签到不可用', title: `${label}（${code ?? '原因未知'}）` } };
  }
  if (total === 0) {
    return { total, done, unknown, chip: { tone: 'unavailable', text: '未纳入签到', title: '该平台没有启用且支持签到的账号' } };
  }
  const badge = unknown > 0 ? ' ?' : '';
  if (done === total) {
    return { total, done, unknown, chip: { tone: 'done', text: `✓ ${done}/${total}${badge}`, title: todayLabelTitle(unknown) } };
  }
  return { total, done, unknown, chip: { tone: 'partial', text: `${done}/${total}${badge}`, title: todayLabelTitle(unknown) } };
}

function todayLabelTitle(unknown: number): string {
  const base = '今日已完成/可参与（本地记录，非平台官方状态）';
  return unknown > 0 ? `${base}；? = 结果未知，未自动重发` : base;
}

export interface AccountCapabilitiesState {
  capabilities: Partial<Record<ManagedAppId, CapabilityView>>;
  isPending: boolean;
  isError: boolean;
  errorMessage: string | null;
}

/* ────────────────────────────── ACC-KB-A2W ────────────────────────────── */

/** 能力徽标三态（互斥口径的唯一来源） */
export type CapabilityBadgeState = 'supported' | 'unknown' | 'unsupported';

export interface CapabilityBadgeModel {
  state: CapabilityBadgeState;
  /** 蓝标（能力可用）/ 灰标（未知或不可用）——二者互斥，永远只有一个为 true */
  tone: 'blue' | 'gray';
  showBlue: boolean;
  showGray: boolean;
  label: string;
  /** 可读说明：hover title / aria-label 用，含逐维度原因码，不把裸码放到主文案 */
  title: string;
}

const DIMENSION_ORDER: CapabilityAction[] = ['capture', 'switch', 'checkin'];
const DIMENSION_NAME: Record<CapabilityAction, string> = { capture: '捕获', switch: '切换', checkin: '签到' };

function dimensionSummary(capability: CapabilityView): string {
  return DIMENSION_ORDER.map((action) => {
    if (capability[action] === true) return `${DIMENSION_NAME[action]}可用`;
    const code = capabilityReasonCode(capability, action);
    const label = unavailableLabel(capability, action) ?? '原因未知';
    return `${DIMENSION_NAME[action]}不可用（${label}${code !== null && code !== 'OK' ? ` / ${code}` : ''}）`;
  }).join(' · ');
}

/**
 * 能力徽标模型（ACC-KB-A2W）：**蓝标与灰标互斥**。
 * - 能力未取到（`capability === null`）→ 只有灰标「能力未知」；
 * - 任一维度可用 → 只有蓝标「能力可用」；
 * - 全部维度不可用 → 只有灰标「能力不可用」。
 * 任何输入下 `showBlue && showGray` 永远为 false（单测钉死）。
 */
export function capabilityBadge(capability: CapabilityView | null): CapabilityBadgeModel {
  if (capability === null) {
    return {
      state: 'unknown',
      tone: 'gray',
      showBlue: false,
      showGray: true,
      label: '能力未知',
      title: '能力矩阵未取到该平台：捕获/切换/签到均未确认',
    };
  }
  const anyAvailable = DIMENSION_ORDER.some((action) => capability[action] === true);
  const summary = dimensionSummary(capability);
  if (anyAvailable) {
    return { state: 'supported', tone: 'blue', showBlue: true, showGray: false, label: '能力可用', title: summary };
  }
  return { state: 'unsupported', tone: 'gray', showBlue: false, showGray: true, label: '能力不可用', title: summary };
}

export interface ToggleEnabledVerdict {
  /** 现在能否点「启用/停用」 */
  allowed: boolean;
  /** 不能点时与服务端 409 同口径的错误码 */
  code: 'ACCOUNT_BUSY' | null;
  /** 不能点时的可读原因（与服务端 message 同口径） */
  reason: string | null;
  /** 点下去之后的目标状态（按钮文案用） */
  nextEnabled: boolean;
}

/** 与服务端 409 ACCOUNT_BUSY 一致的文案（`apps/server/src/api/accountRoutes.ts`） */
export const ACCOUNT_BUSY_REASON = '账号有排队或进行中的操作，稍后再改启用状态';

/**
 * 启用/停用是否可点（ACC-KB-A2W）：该账号存在非终态操作（排队/进行中）时不可点，
 * 与服务端 `PATCH /api/managed-accounts/:id` 的 409 `ACCOUNT_BUSY` 完全同口径，避免「点了才报错」。
 */
export function canToggleEnabled(
  account: Pick<PublicManagedAccount, 'id' | 'enabled'>,
  operations: readonly Pick<AccountOperation, 'account_id' | 'state'>[],
): ToggleEnabledVerdict {
  const nextEnabled = account.enabled === false;
  const busy = operations.some((operation) => operation.account_id === account.id && !isTerminalState(operation.state));
  if (busy) return { allowed: false, code: 'ACCOUNT_BUSY', reason: ACCOUNT_BUSY_REASON, nextEnabled };
  return { allowed: true, code: null, reason: null, nextEnabled };
}

/* ────────────────────────────── ACC-CC-2 / ACC-CC-3 ────────────────────────────── */

/** Command Code 的界面显示名（CLI 来源区，不引入新色相） */
export const COMMANDCODE_SOURCE_LABEL = 'Command Code';

/**
 * ACC-CC-3：Command Code 的真实能力来自服务端 `GET /api/cli-accounts/commandcode/capability`。
 * 前端不再持有「写死不可用」的本地副本：拿不到就显示「能力未知」，绝不硬编码成可用。
 */
export interface CommandCodeCapabilityState {
  capability: CliAppCapability | null;
  isPending: boolean;
  isError: boolean;
  errorMessage: string | null;
}

export function useCommandCodeCapability(): CommandCodeCapabilityState {
  const query = useQuery({
    queryKey: ['cli-accounts-commandcode-capability'],
    queryFn: () => api.get<{ capability: CliAppCapability }>('/api/cli-accounts/commandcode/capability'),
    staleTime: 30_000,
  });
  return {
    capability: query.data?.capability ?? null,
    isPending: query.isPending,
    isError: query.isError,
    errorMessage: query.error instanceof Error ? query.error.message : null,
  };
}

/**
 * 空态文案必须与能力状态一致（未安装 ≠ 没登录 ≠ 格式不认识），不拿「0 个账号」笼统带过。
 */
export function commandCodeEmptyHint(capability: CliAppCapability | null): string {
  if (capability === null) return '能力状态未取到，暂不展示账号。';
  if (capability.auth_file_state === 'readable') return '本机已识别凭据，但尚未登记账号（可点「导入凭据」补登记）。';
  if (capability.auth_file_state === 'unrecognized') return '本机存在 auth.json，但格式未识别，未登记任何账号。';
  if (capability.installed) return '本机已安装 Command Code，但未找到凭据文件。';
  return '本机未安装 Command Code CLI，也未发现凭据。';
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
