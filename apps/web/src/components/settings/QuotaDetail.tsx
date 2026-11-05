/**
 * ACC-B6：额度平台在右栏的详情（余额 / 时间窗口 / 积分占位）。
 *
 * 数据与刷新复用 `QuotaCards.tsx` 的同一个查询（`useQuotaSnapshot`，queryKey `managed-account-quotas`），
 * 不新造服务端端点，也不改 shared 类型；前端只做呈现。
 *
 * 三种形态（`quotaDetailKind`）：
 * - `balance`：余额大数字 + 抓取时间，不画进度条（DeepSeek）；
 * - `windows`：每条窗口一行——名称 + 2px 进度条 + 已用/上限 + 重置时间（opencode-go / Codex）；
 * - `credit`：虚线占位块「积分暂未接入」，不用灰块冒充数值；
 * - 取不到数据（`unsupported` / `error` / 服务端未返回）一律给明确空态，不静默显示 0。
 */
import { useQueryClient } from '@tanstack/react-query';
import type { QuotaSourceId } from '@agentboard/shared';
import {
  QUOTA_LIMITED_LABEL,
  QUOTA_SOURCE_LABEL,
  QUOTA_UNKNOWN_REASON_LABEL,
  formatRemaining,
  formatResetClock,
  isWindowLimited,
  quotaAmountText,
  quotaReasonView,
  quotaWindowKindLabel,
  quotaWindowsOf,
  useQuotaSnapshot,
  windowBarWidth,
  type QuotaItem,
} from './QuotaCards';

export type QuotaDetailKind = 'balance' | 'windows' | 'credit' | 'reason';

/** 详情形态判定：状态非 ok 先落原因态；有积分窗口走占位；有窗口走窗口；其余按余额 */
export function quotaDetailKind(item: QuotaItem): QuotaDetailKind {
  if (item.status !== 'ok') return 'reason';
  const windows = quotaWindowsOf(item);
  if (windows.some((window) => window.kind === 'credit')) return 'credit';
  if (windows.length > 0) return 'windows';
  return 'balance';
}

/** 窗口「已用 / 上限」；老数据没有 total/used 时回落百分比（不编造上限） */
export function quotaDetailWindowAmount(window: QuotaItem['windows'][number]): string {
  if (window.total !== undefined && window.total !== null && window.used !== undefined && window.used !== null) {
    return `${Math.round(window.used)} / ${Math.round(window.total)}`;
  }
  return `${windowBarWidth(window.used_percent)}%`;
}

/** 重置时间文本：有时刻就写本地钟点，缺时刻明确说未知 */
export function quotaDetailResetText(resetAt: number | null): string {
  return resetAt === null ? '重置时刻未知' : `重置 ${formatResetClock(resetAt)}`;
}

const EYEBROW = 'text-[11px] font-semibold uppercase tracking-[0.14em] text-ink-3';

/**
 * 单个额度来源的右栏详情。`source` 只决定展示哪一条，数据整块取自共享快照，切换平台不会串数据。
 */
export function QuotaDetail({ source }: { source: QuotaSourceId }) {
  const queryClient = useQueryClient();
  const query = useQuotaSnapshot();
  const item = (query.data?.items ?? []).find((entry) => entry.source === source);
  const now = Date.now();
  const refreshing = query.isFetching;

  const refresh = () => {
    void queryClient.refetchQueries({ queryKey: ['managed-account-quotas'] });
  };

  return (
    <section
      data-testid={`quota-detail-${source}`}
      data-source={source}
      data-status={item?.status ?? 'missing'}
      className="space-y-2 rounded-lg border border-hairline bg-surface-card p-3"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h4 data-testid={`quota-detail-title-${source}`} className={EYEBROW}>
          {QUOTA_SOURCE_LABEL[source]}
        </h4>
        <button
          type="button"
          data-testid={`quota-detail-refresh-${source}`}
          className="ab-transition rounded-md bg-surface-raised px-2 py-0.5 text-[11px] text-ink-2 hover:text-ink disabled:opacity-60"
          disabled={refreshing}
          onClick={refresh}
        >
          {refreshing ? '刷新中…' : '刷新额度'}
        </button>
      </div>

      {query.isPending && (
        <p data-testid={`quota-detail-loading-${source}`} className="text-xs text-ink-3">读取额度…</p>
      )}

      {query.isError && (
        <p role="alert" data-testid={`quota-detail-error-${source}`} className="text-xs text-red-600 dark:text-red-400">
          额度读取失败：{query.error instanceof Error ? query.error.message : '未知错误'}
        </p>
      )}

      {query.data && item === undefined && (
        <p data-testid={`quota-detail-empty-${source}`} className="rounded-md border border-dashed border-hairline px-3 py-4 text-center text-xs text-ink-3">
          服务端暂未返回{QUOTA_SOURCE_LABEL[source]}的额度数据
        </p>
      )}

      {item !== undefined && (
        <QuotaDetailBody item={item} now={now} />
      )}

      {query.data !== undefined && (
        <p data-testid={`quota-detail-fetched-${source}`} className="text-[11px] text-ink-3">
          更新于 {formatResetClock(item?.fetched_at ?? query.data.fetched_at)} · 服务端 60s 缓存
        </p>
      )}
    </section>
  );
}

function QuotaDetailBody({ item, now }: { item: QuotaItem; now: number }) {
  const kind = quotaDetailKind(item);
  const source = item.source;

  if (kind === 'reason') {
    const { text, technical } = quotaReasonView(item);
    return (
      <div className="space-y-1" data-testid={`quota-detail-reason-block-${source}`}>
        <p data-testid={`quota-detail-reason-${source}`} className="text-xs text-ink-2">
          {text ?? QUOTA_UNKNOWN_REASON_LABEL}
        </p>
        {technical !== null && (
          <details data-testid={`quota-detail-code-${source}`} className="text-[11px] text-ink-3">
            <summary className="cursor-pointer select-none">技术码</summary>
            <code className="font-mono">{technical}</code>
          </details>
        )}
      </div>
    );
  }

  if (kind === 'credit') {
    return (
      <div className="space-y-1" data-testid={`quota-detail-credit-${source}`}>
        <p className={EYEBROW}>积分</p>
        <div
          data-testid={`quota-detail-credit-placeholder-${source}`}
          className="grid place-items-center rounded-lg border border-dashed border-hairline px-4 py-6 text-xs text-ink-3"
        >
          积分暂未接入
        </div>
      </div>
    );
  }

  if (kind === 'windows') {
    const windows = quotaWindowsOf(item);
    return (
      <div className="space-y-1.5" data-testid={`quota-detail-windows-${source}`}>
        <p className={EYEBROW}>时间窗口限额</p>
        <div className="space-y-1.5">
          {windows.map((window, index) => {
            const limited = isWindowLimited(window);
            const width = windowBarWidth(window.used_percent);
            return (
              <div
                key={`${source}-${window.name}-${index}`}
                data-testid={`quota-detail-window-${source}-${index}`}
                data-kind={window.kind ?? 'legacy'}
                className="grid grid-cols-[auto_1fr_auto] items-center gap-x-2 gap-y-0.5 text-[11px]"
              >
                <span className="text-ink-2">{quotaWindowKindLabel(window)}</span>
                <span aria-hidden="true" className="h-0.5 overflow-hidden rounded-full bg-surface-raised">
                  <span
                    data-testid={`quota-detail-bar-${source}-${index}`}
                    data-width={width}
                    style={{ width: `${width}%` }}
                    className={`block h-full rounded-full transition-[width] duration-[160ms] ease-[cubic-bezier(0.2,0,0,1)] motion-reduce:transition-none ${limited ? 'bg-accent' : 'bg-ink-2'}`}
                  />
                </span>
                {limited ? (
                  <span
                    data-testid={`quota-detail-limited-${source}-${index}`}
                    className="rounded-full bg-accent-soft px-1.5 py-0.5 text-[11px] font-medium text-accent"
                  >
                    {QUOTA_LIMITED_LABEL}
                  </span>
                ) : (
                  <span data-testid={`quota-detail-amount-${source}-${index}`} className="tabular-nums text-ink">
                    {quotaDetailWindowAmount(window)}
                  </span>
                )}
                <span
                  data-testid={`quota-detail-reset-${source}-${index}`}
                  title={window.reset_at === null ? '重置时刻未知' : formatRemaining(window.reset_at, now)}
                  className="col-start-2 text-ink-3"
                >
                  {quotaDetailResetText(window.reset_at)}
                </span>
              </div>
            );
          })}
        </div>
      </div>
    );
  }

  const amount = quotaAmountText(item);
  return (
    <div className="space-y-1" data-testid={`quota-detail-balance-${source}`}>
      <p className={EYEBROW}>账户余额</p>
      {amount === null ? (
        <p data-testid={`quota-detail-balance-empty-${source}`} className="rounded-md border border-dashed border-hairline px-3 py-4 text-center text-xs text-ink-3">
          余额暂不可用
        </p>
      ) : (
        <p data-testid={`quota-detail-balance-value-${source}`} className="tabular-nums text-3xl font-semibold leading-none tracking-tight text-ink">
          {amount}
        </p>
      )}
    </div>
  );
}
