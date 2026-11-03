/**
 * 账号页额度/余额卡（ACC-QUOTA-01）。
 *
 * 数据源 `GET /api/managed-account-quotas`：逐来源 `{source,status,balance,unit,windows,fetched_at,reason_code,detail}`。
 * - `ok`：显示余额/余量 + 各窗口「重置 HH:mm（还剩 Xh Ym）」；
 * - `unsupported` / `error`：显示可解释中文原因（沿用 ACC-REASON-01 口径：裸码不作主文案，未知码进可展开技术码）；
 * - 不显示 token / 本机路径；服务端 60s 缓存，界面只展示 fetched_at。
 */
import { useQuery } from '@tanstack/react-query';
import { api } from '../../api/client';
import { Badge } from '../ui/Badge';
import { reasonTechnicalCode } from './accountCapabilities';

export type QuotaSourceId = 'deepseek' | 'opencode_go' | 'codex';
export type QuotaStatus = 'ok' | 'unsupported' | 'error';

export interface QuotaWindow {
  name: string;
  remaining: number;
  reset_at: number | null;
  /** 已用百分比（0-100）；百分比类窗口（如 OpenCode Go）才有 */
  used_percent?: number | null;
}

export interface QuotaItem {
  source: QuotaSourceId;
  status: QuotaStatus;
  balance: number | null;
  unit: string | null;
  windows: QuotaWindow[];
  fetched_at: number;
  reason_code: string | null;
  detail: string | null;
}

export interface QuotaSnapshot {
  items: QuotaItem[];
  fetched_at: number;
  workspace_id: string | null;
}

export const QUOTA_SOURCE_LABEL: Record<QuotaSourceId, string> = {
  deepseek: 'DeepSeek 余额',
  opencode_go: 'OpenCode Go 套餐余量',
  codex: 'Codex 额度窗口',
};

/** 额度来源的原因码文案（服务端口径）；未收录码走中性文案 + 技术码 */
export const QUOTA_REASON_LABEL: Record<string, string> = {
  NO_CREDENTIAL: '本机未找到该来源的凭据',
  NO_PUBLIC_QUOTA_ENDPOINT: '该来源没有公开的额度接口',
  CREDENTIAL_INVALID: '凭据已失效，请更新后重试',
  RATE_LIMITED: '对方限流，稍后自动重试',
  UPSTREAM_ERROR: '对方服务暂时不可用',
  UPSTREAM_REJECTED: '对方拒绝了请求',
  UPSTREAM_SHAPE_UNEXPECTED: '对方返回的数据结构不在预期内',
  NETWORK_ERROR: '网络不可用或超时',
  // OpenCode Go（ACC-QUOTA-02，走本地 opencode 服务）
  OPENCODE_NOT_LOGGED_IN: '本机未登录 OpenCode Go',
  OPENCODE_AUTH_UNAVAILABLE: '本机缺少 opencode 本地服务口令',
  OPENCODE_SERVER_NOT_RUNNING: '未发现本地 opencode 服务（需运行 opencode 或设置 OPENCODE_SERVER_URL）',
  OPENCODE_AUTH_FAILED: '本地 opencode 服务拒绝认证',
  OPENCODE_ROUTE_UNSUPPORTED: '本地 opencode 版本过旧，没有用量路由',
};

export const QUOTA_UNKNOWN_REASON_LABEL = '暂时取不到额度';

const STATUS_LABEL: Record<QuotaStatus, string> = { ok: '正常', unsupported: '不支持', error: '取数失败' };
const STATUS_TONE: Record<QuotaStatus, 'green' | 'gray' | 'red'> = { ok: 'green', unsupported: 'gray', error: 'red' };

const WINDOW_LABEL: Record<string, string> = {
  '5h': '5 小时窗口',
  weekly: '周窗口',
  monthly: '月窗口',
};

const pad = (value: number): string => String(value).padStart(2, '0');

/** 本地时间 HH:mm */
export function formatResetClock(resetAt: number): string {
  const date = new Date(resetAt);
  return `${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/** 剩余时长：`1h 20m` / `45m`；已过期返回 `已重置` */
export function formatRemaining(resetAt: number, nowMs: number): string {
  const diff = resetAt - nowMs;
  if (diff <= 0) return '已重置';
  const totalMinutes = Math.floor(diff / 60_000);
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return hours > 0 ? `${hours}h ${minutes}m` : `${minutes}m`;
}

const currencySymbol = (unit: string | null): string => (unit === 'CNY' ? '¥' : unit === 'USD' ? '$' : '');

export function quotaAmountText(item: QuotaItem): string | null {
  if (item.balance === null) return null;
  const symbol = currencySymbol(item.unit);
  const amount = item.balance.toFixed(2);
  return symbol ? `${symbol}${amount}` : `${amount}${item.unit ? ` ${item.unit}` : ''}`;
}

export function QuotaCards() {
  const query = useQuery({
    queryKey: ['managed-account-quotas'],
    queryFn: () => api.get<QuotaSnapshot>('/api/managed-account-quotas'),
    staleTime: 30_000,
  });
  const now = Date.now();

  return (
    <div data-testid="quota-cards" className="mb-2 rounded-lg border border-neutral-200 p-2.5 dark:border-neutral-800">
      <div className="mb-1.5 flex flex-wrap items-baseline gap-2">
        <h4 className="text-sm font-medium text-neutral-900 dark:text-neutral-100">额度与余额</h4>
        {query.data && (
          <span data-testid="quota-updated" className="text-[11px] text-neutral-400 dark:text-neutral-500">
            更新于 {formatResetClock(query.data.fetched_at)}（服务端 60s 缓存）
          </span>
        )}
      </div>

      {query.isPending && <p className="text-xs text-neutral-500 dark:text-neutral-400">读取额度…</p>}
      {query.isError && (
        <p role="alert" data-testid="quota-load-error" className="text-xs text-red-600 dark:text-red-400">
          额度读取失败：{query.error instanceof Error ? query.error.message : '未知错误'}
        </p>
      )}

      {query.data && (
        <div className="grid gap-2 sm:grid-cols-3">
          {query.data.items.map((item) => {
            const amount = quotaAmountText(item);
            const mapped = item.reason_code !== null ? QUOTA_REASON_LABEL[item.reason_code] ?? null : null;
            const reasonText = mapped ?? (item.status === 'ok' ? null : item.detail ?? QUOTA_UNKNOWN_REASON_LABEL);
            const technical = item.status !== 'ok' && mapped === null ? reasonTechnicalCode(item.reason_code) : null;
            return (
              <div key={item.source} data-testid={`quota-card-${item.source}`} className="rounded-lg border border-neutral-200 p-2 text-xs dark:border-neutral-800">
                <div className="flex flex-wrap items-center gap-1.5">
                  <span className="text-sm font-medium text-neutral-900 dark:text-neutral-100">{QUOTA_SOURCE_LABEL[item.source]}</span>
                  <Badge tone={STATUS_TONE[item.status]}>{STATUS_LABEL[item.status]}</Badge>
                </div>

                {item.status === 'ok' && (
                  <>
                    <p data-testid={`quota-balance-${item.source}`} className="mt-1 text-neutral-800 dark:text-neutral-200">
                      {amount ?? '—'}
                      {item.unit && <span className="ml-1 text-[11px] text-neutral-400 dark:text-neutral-500">{item.unit}</span>}
                    </p>
                    {item.detail !== null && <p className="mt-0.5 text-amber-600 dark:text-amber-400">{item.detail}</p>}
                    {item.windows.length > 0 && (
                      <ul className="mt-1 space-y-0.5">
                        {item.windows.map((window, index) => (
                          <li key={`${item.source}-${window.name}-${index}`} data-testid={`quota-window-${item.source}-${index}`} className="text-neutral-600 dark:text-neutral-400">
                            {WINDOW_LABEL[window.name] ?? window.name}：剩余 {window.remaining}
                            {typeof window.used_percent === 'number' && `%（已用 ${window.used_percent}%`}
                            {typeof window.used_percent === 'number' && window.reset_at !== null && (
                              <span data-testid={`quota-reset-${item.source}-${index}`}>
                                ，重置 {formatResetClock(window.reset_at)}，还剩 {formatRemaining(window.reset_at, now)}）
                              </span>
                            )}
                            {typeof window.used_percent === 'number' && window.reset_at === null && '）'}
                            {typeof window.used_percent !== 'number' && window.reset_at !== null && (
                              <span data-testid={`quota-reset-${item.source}-${index}`} className="ml-1">
                                （重置 {formatResetClock(window.reset_at)}，还剩 {formatRemaining(window.reset_at, now)}）
                              </span>
                            )}
                          </li>
                        ))}
                      </ul>
                    )}
                  </>
                )}

                {item.status !== 'ok' && (
                  <p data-testid={`quota-reason-${item.source}`} className="mt-1 text-neutral-600 dark:text-neutral-400">
                    {reasonText}
                    {item.detail !== null && item.detail !== reasonText && <span className="ml-1 text-neutral-500 dark:text-neutral-500">{item.detail}</span>}
                  </p>
                )}

                {technical !== null && (
                  <details data-testid={`quota-code-${item.source}`} className="mt-0.5 text-[11px] text-neutral-500 dark:text-neutral-400">
                    <summary className="cursor-pointer select-none">技术码</summary>
                    <code className="font-mono">{technical}</code>
                  </details>
                )}
              </div>
            );
          })}
        </div>
      )}

      <p className="mt-1 text-[11px] text-neutral-400 dark:text-neutral-500">
        只展示可解释来源：有公开接口的显示真实余额，没有公开接口的显示原因，不编造数据
      </p>
    </div>
  );
}

