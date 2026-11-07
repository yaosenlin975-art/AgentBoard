/**
 * ACC-KB-B2W：协议级「添加账号」的协议 → 界面文案映射。
 *
 * **唯一来源是服务端**：`GET /api/add-account-protocols` 返回每个平台实际装配的协议
 * （`app_id` / `protocol` / `provider_version` / `requires_browser` / `regions`）。
 * 前端不维护平台副本，也**不臆造服务端没有的协议**：服务端没装配的平台不给「添加账号」入口，
 * 只给一句原因文案（不出现「点了必然失败」的按钮）。
 *
 * 五平台链路（服务端实现见 `apps/server/src/services/accounts/addAccountProvider.ts` 与
 * `traeAddAccountProvider.ts`）：
 * - `minimax_device`：RFC 8628 device grant + PKCE，**有设备码**（`user_code`）需手工输入；
 * - `qoder_device`：自研设备授权页（challenge S256 + nonce），无设备码，浏览器选账号；
 * - `zcode_cli`：CLI 轮询流（init → poll），浏览器登录后由服务端轮询收口；
 * - `workbuddy_oneid`：OneID 插件式 state，浏览器登录后换 token；
 * - `trae_oauth`：OAuth 授权码 + 固定本地回调（`127.0.0.1:17388`），**必须同一台机器的浏览器**。
 *
 * 知识页 `89c72721` §2 提到 Qoder 还有一条 PAT 直填路线，但**服务端没有装配该协议**
 * （协议枚举只有上面五个，见 `packages/shared/src/types.ts` 的 `AddAccountProtocol`），
 * 因此界面**不提供 PAT 输入框**——那会变成「可点但必然失败」的入口，与卡面验收相悖。
 */
import type { AddAccountProtocol } from '@agentboard/shared';
import { hasReasonLabel, reasonLabel } from './accountCapabilities';

/** 协议链路种类（决定步骤文案与设备码展示） */
export type AddAccountFlowKind = 'device_code' | 'device_auth' | 'cli' | 'browser_login' | 'local_callback';

export interface AddAccountFlowCopy {
  /** 一句话引导 */
  instruction: string;
  /** 是否要展示设备码（`user_code`） */
  showsUserCode: boolean;
  /** 设备码的中文名 */
  userCodeLabel: string | null;
  /** 有序步骤（浏览器里做什么 → 回到面板做什么） */
  steps: readonly string[];
  /** 是否强调「必须是同一台机器的浏览器」 */
  sameMachine: boolean;
}

/** 五平台各自的文案（逐条对照服务端实现与知识页 `89c72721` §2 写，不猜） */
const PROTOCOL_COPY: Record<AddAccountProtocol, AddAccountFlowCopy> = {
  minimax_device: {
    instruction: '在浏览器打开授权页，输入设备码并确认登录。',
    showsUserCode: true,
    userCodeLabel: '设备码',
    steps: ['打开授权页', '输入设备码并确认登录', '回到本页检查授权结果'],
    sameMachine: false,
  },
  qoder_device: {
    instruction: '在浏览器打开授权页，选择要添加的账号并确认。',
    showsUserCode: false,
    userCodeLabel: null,
    steps: ['打开授权页', '选择账号并确认授权', '回到本页检查授权结果'],
    sameMachine: false,
  },
  zcode_cli: {
    instruction: '在浏览器打开授权页完成登录，命令行轮询会自动收口。',
    showsUserCode: false,
    userCodeLabel: null,
    steps: ['打开授权页并完成登录', '回到本页检查授权结果'],
    sameMachine: false,
  },
  workbuddy_oneid: {
    instruction: '在浏览器打开授权页完成登录，授权后由服务端换取账号凭据。',
    showsUserCode: false,
    userCodeLabel: null,
    steps: ['打开授权页并完成登录', '回到本页检查授权结果'],
    sameMachine: false,
  },
  trae_oauth: {
    instruction: '在同一台机器的浏览器打开授权页完成登录；授权后回调会打到本机 127.0.0.1:17388。',
    showsUserCode: false,
    userCodeLabel: null,
    steps: ['在同一台机器的浏览器打开授权页并完成登录', '授权后浏览器会跳回本机回调地址', '回到本页检查授权结果'],
    sameMachine: true,
  },
};

/** 未知协议（服务端新增但前端还没跟进）时的中性文案：不猜流程，只说「在浏览器完成登录」 */
const FALLBACK_COPY: AddAccountFlowCopy = {
  instruction: '在浏览器打开授权页完成登录。',
  showsUserCode: false,
  userCodeLabel: null,
  steps: ['打开授权页并完成登录', '回到本页检查授权结果'],
  sameMachine: false,
};

/** 协议 → 文案（未知协议走兜底，不崩、不臆造） */
export function addAccountFlowCopy(protocol: AddAccountProtocol | string): AddAccountFlowCopy {
  return PROTOCOL_COPY[protocol as AddAccountProtocol] ?? FALLBACK_COPY;
}

/** 区域标签（服务端 `regions` 字段只给 'cn' / 'global'） */
export function addAccountRegionLabel(region: 'cn' | 'global'): string {
  return region === 'global' ? '国际区' : '中国区';
}

/**
 * 添加账号失败原因文案：
 * - 服务端已收录的码 → 走 `reasonLabel`（中文主文案，裸码只进技术码区）；
 * - `*_HTTP_<status>` 这类动态码 → 「平台接口返回异常（HTTP xxx）」，仍是中文主文案；
 * - 其余未收录码 → 中性文案（裸码由调用方放进可展开技术码）。
 */
export function addAccountFailureLabel(code: string | null | undefined): string {
  if (!code) return '添加账号失败';
  if (hasReasonLabel(code)) return reasonLabel(code);
  const http = /_HTTP_(\d{3})$/.exec(code);
  if (http) return `平台接口返回异常（HTTP ${http[1]}）`;
  return reasonLabel(code);
}
