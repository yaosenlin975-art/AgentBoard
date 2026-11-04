/**
 * 账号页额度/余额行（ACC-QUOTA-01 数据口径 + ACC-QUOTA-02 行内绘制 + ACC-PANEL-03 行组）。
 *
 * 数据源 `GET /api/managed-account-quotas`：逐来源 `{source,status,balance,unit,windows,fetched_at,reason_code,detail}`。
 * - `ok`：余额显示 `{金额} {单位}`，窗口显示迷你进度条（宽 = `used_percent`），重置时间只进 tooltip；
 * - `unsupported` / `error`：显示可解释中文原因（沿用 ACC-REASON-01 口径：裸码不作主文案，未知码进可展开技术码）；
 * - 不显示 token / 本机路径；服务端 60s 缓存，界面只展示 fetched_at。
 *
 * 三行嵌在账号管理六行总览的后三行（设计 §5），仅额度、不可展开、无账号操作。
 */
import { useQuery } from '@tanstack/react-query';
import { api } from '../../api/client';
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

/** 「已限额」芯片文案（设计 §5） */
export const QUOTA_LIMITED_LABEL = '已限额';

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

/** 窗口名 → 参考图用词（rolling/5h → 5-hour window） */
export function quotaWindowTitle(name: string): string {
  if (name === 'rolling' || name === '5h') return '5-hour window';
  if (name === 'weekly') return 'Weekly';
  if (name === 'monthly') return 'Monthly';
  return name;
}

/** 「Resets in Xd Yh / Xh Ym」：向下取整到分钟；无重置时刻或已过期 → `Resets soon` */
export function formatResets(resetAt: number | null, nowMs: number): string {
  if (resetAt === null) return 'Resets soon';
  const diff = resetAt - nowMs;
  if (diff <= 0) return 'Resets soon';
  const totalMinutes = Math.floor(diff / 60_000);
  const days = Math.floor(totalMinutes / (60 * 24));
  const hours = Math.floor((totalMinutes % (60 * 24)) / 60);
  const minutes = totalMinutes % 60;
  return days > 0 ? `Resets in ${days}d ${hours}h` : `Resets in ${hours}h ${minutes}m`;
}

/** 进度条宽度：已用百分比截断到 0–100（缺省 0） */
export function windowBarWidth(usedPercent: number | null | undefined): number {
  if (typeof usedPercent !== 'number' || !Number.isFinite(usedPercent)) return 0;
  return Math.min(100, Math.max(0, usedPercent));
}

/** 行内窗口短标签（设计 §5：5h / 周 / 月） */
export function quotaWindowShortLabel(name: string): string {
  if (name === 'rolling' || name === '5h') return '5h';
  if (name === 'weekly') return '周';
  if (name === 'monthly') return '月';
  return name;
}

/** 「已限额」判定：名为 limited 的窗口或已用满 100% */
export function isWindowLimited(window: QuotaWindow): boolean {
  return window.name === 'limited' || (window.used_percent ?? 0) >= 100;
}

/** 主文案 = 中文原因，裸码只进可展开技术码（ACC-REASON-01 口径） */
export function quotaReasonView(item: QuotaItem): { text: string | null; technical: string | null } {
  const mapped = item.reason_code !== null ? QUOTA_REASON_LABEL[item.reason_code] ?? null : null;
  return {
    text: mapped ?? (item.status === 'ok' ? null : item.detail ?? QUOTA_UNKNOWN_REASON_LABEL),
    technical: item.status !== 'ok' && mapped === null ? reasonTechnicalCode(item.reason_code) : null,
  };
}

/** Codex 只有 5-hour 与 Weekly（design-2026-11-03 D3 不变）；其它来源显示全部窗口 */
export function quotaWindowsOf(item: QuotaItem): QuotaWindow[] {
  return item.source === 'codex' ? item.windows.filter((window) => quotaWindowTitle(window.name) !== 'Monthly') : item.windows;
}

/** 行内余额文案；有符号时不再重复单位，0 读作「额度内」以免被误认为欠费 */
export function quotaRowBalance(item: QuotaItem): string | null {
  if (item.balance === null) return null;
  return item.balance === 0 ? '额度内' : quotaAmountText(item);
}

/**
 * ACC-QUOTA-02：单个额度来源的行内绘制（设计 §5），供 C3 总览面板嵌入行栏。
 * 三种分支同栏位互斥：余额 / 窗口迷你进度条 / 原因（+ 可展开技术码）。
 */
export function QuotaRow({ item, now = Date.now() }: { item: QuotaItem; now?: number }) {
  const windows = quotaWindowsOf(item);
  const balance = item.status === 'ok' ? quotaRowBalance(item) : null;
  const { text, technical } = quotaReasonView(item);
  return (
    <div data-testid={`quota-row-${item.source}`} data-source={item.source} data-status={item.status} className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs">
      <span className="font-medium text-neutral-900 dark:text-neutral-100">{QUOTA_SOURCE_LABEL[item.source]}</span>

      {balance !== null && (
        <span data-testid={`quota-row-balance-${item.source}`} className="tabular-nums text-neutral-800 dark:text-neutral-200">
          {balance}
          {/* 「额度内」本身已是完整读法，再加「余额」注会读成「额度内余额」 */}
          {balance !== '额度内' && <span className="ml-1 text-[11px] text-neutral-400 dark:text-neutral-500">余额</span>}
        </span>
      )}

      {item.status === 'ok' && windows.length > 0 && (
        <span data-testid={`quota-row-windows-${item.source}`} className="inline-flex flex-wrap items-center gap-x-3 gap-y-1">
          {windows.map((window, index) => {
            const limited = isWindowLimited(window);
            const pct = windowBarWidth(window.used_percent);
            return (
              <span
                key={`${item.source}-${window.name}-${index}`}
                data-testid={`quota-row-window-${item.source}-${index}`}
                title={`${quotaWindowShortLabel(window.name)} · ${formatResets(window.reset_at, now)}`}
                className="inline-flex items-center gap-1.5"
              >
                <span className="text-[11px] text-neutral-500 dark:text-neutral-400">{quotaWindowShortLabel(window.name)}</span>
                <span aria-hidden="true" className="h-1.5 w-14 overflow-hidden rounded-full bg-surface-raised">
                  <span
                    data-testid={`quota-row-bar-${item.source}-${index}`}
                    data-width={pct}
                    style={{ width: `${pct}%` }}
                    className={`block h-full rounded-full transition-[width] duration-200 motion-reduce:transition-none ${limited ? 'bg-accent' : 'bg-ink-2'}`}
                  />
                </span>
                {limited ? (
                  <span data-testid={`quota-row-limited-${item.source}-${index}`} className="rounded-full bg-accent-soft px-1.5 py-0.5 text-[11px] font-medium text-accent">
                    {QUOTA_LIMITED_LABEL}
                  </span>
                ) : (
                  <span data-testid={`quota-row-used-${item.source}-${index}`} className="tabular-nums text-[11px] text-neutral-700 dark:text-neutral-300">{pct}%</span>
                )}
              </span>
            );
          })}
        </span>
      )}

      {item.status !== 'ok' && (
        <span data-testid={`quota-row-reason-${item.source}`} className="text-neutral-600 dark:text-neutral-400">{text}</span>
      )}

      {technical !== null && (
        <details data-testid={`quota-row-code-${item.source}`} className="text-[11px] text-neutral-500 dark:text-neutral-400">
          <summary className="cursor-pointer select-none">技术码</summary>
          <code className="font-mono">{technical}</code>
        </details>
      )}
    </div>
  );
}

/** 积分占位芯片（设计 §5）：与余额/进度条同栏位，WorkBuddy / MiniMax / Trae 行复用；未来接入只换绘制分支 */
export function QuotaCreditChip({ label = '积分 未接入', testId = 'quota-credit-chip' }: { label?: string; testId?: string } = {}) {
  return (
    <span data-testid={testId} title="积分体系未接入，暂无数据" className="inline-flex items-center rounded-full bg-surface-raised px-2 py-0.5 text-[11px] font-medium text-ink-3">
      {label}
    </span>
  );
}
/** 额度行在总览里的顺序（设计 §5：仅额度平台在后，组内维持来源顺序） */
export const QUOTA_ROW_ORDER: QuotaSourceId[] = ['deepseek', 'opencode_go', 'codex'];

/**
 * 额度来源行组（ACC-PANEL-03 嵌入六行总览的后三行）：逐来源一行，不可展开、无账号操作。
 * 加载中/失败各占一行提示；来源缺失（服务端未返回）按 ORDER 补成同栏位的 `quota-row-<source>` 行，
 * 因此「每个来源恰有一行」在总览里恒成立。
 */
export function QuotaRows() {
  const query = useQuery({
    queryKey: ['managed-account-quotas'],
    queryFn: () => api.get<QuotaSnapshot>('/api/managed-account-quotas'),
    staleTime: 30_000,
  });
  const now = Date.now();
  const bySource = new Map((query.data?.items ?? []).map((item) => [item.source, item]));
  const items = QUOTA_ROW_ORDER.map((source) => bySource.get(source));

  return (
    <div data-testid="quota-rows" className="divide-y divide-neutral-100 dark:divide-neutral-800">
      {query.isPending && <p data-testid="quota-loading" className="py-2 text-xs text-neutral-500 dark:text-neutral-400">读取额度…</p>}
      {query.isError && (
        <p role="alert" data-testid="quota-load-error" className="py-2 text-xs text-red-600 dark:text-red-400">
          额度读取失败：{query.error instanceof Error ? query.error.message : '未知错误'}
        </p>
      )}
      {query.data && items.map((item, index) => (
        item !== undefined
          ? <div key={item.source} className="py-2"><QuotaRow item={item} now={now} /></div>
          : (
            <div
              key={`quota-missing-${QUOTA_ROW_ORDER[index]}`}
              data-testid={`quota-row-${QUOTA_ROW_ORDER[index]}`}
              data-source={QUOTA_ROW_ORDER[index]}
              data-status="missing"
              className="flex flex-wrap items-center gap-x-2 py-2 text-xs"
            >
              <span className="font-medium text-neutral-900 dark:text-neutral-100">{QUOTA_SOURCE_LABEL[QUOTA_ROW_ORDER[index]!]}</span>
              <span data-testid={`quota-row-reason-${QUOTA_ROW_ORDER[index]}`} className="text-neutral-500 dark:text-neutral-400">{QUOTA_UNKNOWN_REASON_LABEL}</span>
            </div>
          )
      ))}
      {query.data && (
        <p data-testid="quota-updated" className="py-1.5 text-[11px] text-neutral-400 dark:text-neutral-500">
          服务端 60s 缓存 · 更新于 {formatResetClock(query.data.fetched_at)}
        </p>
      )}
    </div>
  );
}
