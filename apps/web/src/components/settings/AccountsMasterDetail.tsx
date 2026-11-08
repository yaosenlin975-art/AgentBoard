/**
 * ACC-B1：账号面板主从布局骨架。
 *
 * 左栏 = 平台索引（accounts-redesign 方向 B：每平台一行 = 名称 + 指标 + 迷你条 + 异常色；
 * `metric` 未传时回落旧单行形态：名称 + 账号数 + 今日签到健康态），
 * 右栏 = **只渲染选中平台**的容器（从结构上消除六平台同屏堆叠）。
 *
 * 选中态用**组件内 useState**（与既有 `openApps` 同层），不新增第二套导航 store；
 * `navStore` 只管视图级导航，账号面板内部的平台选择留在面板内。
 *
 * 响应式（阈值取卡面 920px）：
 * - ≥920px：`flex-row`，左栏固定 244px（accounts-redesign 方向 B 规格，原 200px）、右栏 flex-1；
 * - <920px：`flex-col`，左栏变**可横滑 rail**（`overflow-x-auto` + 不换行），避免竖排多行吃掉首屏；
 * - <560px：仍是单列 + 横滑，375px 下页面 `scrollWidth == clientWidth`（rail 自己滚，不撑破页面）。
 *
 * 键盘：左栏项是 `role="tab"` 的 `<button>`，`aria-selected` 表达选中；
 * ↑/↓/←/→ 在项间移动焦点并切换，Home/End 跳首尾，Tab 正常离开索引。
 *
 * ADD-FLOW-2（口径 A）：`items` 由调用方过滤成「有账号」的平台/来源，可能为空；
 * 空态在左栏给一行提示（`accounts-index-empty`，放 tablist 之外）、右栏指向顶部「添加账号」
 * （`accounts-detail-empty`），不再显示「没有可显示的平台」这种死胡同文案。
 */
import { useCallback, useRef, useState } from 'react';
import type { AccountView } from './AccountCard';
import type { CheckinTodaySummary } from './accountCapabilities';

/**
 * 左栏指标行（accounts-redesign 方向 B：指标 + 迷你条 + 异常色）。
 * 文本不带裸码：异常一律中文短句，技术细节留给右栏。
 */
export interface PlatformIndexMetric {
  /** 指标文本，如 `2/3`（今日签到）、`¥12.34`（余额）、`5h · 34%`（首个窗口）、`1 个账号` */
  text: string;
  /** 异常色：ok=已完成/正常（accent）；warn=部分完成（琥珀提醒）；idle=中性灰；danger=已限额（红） */
  tone: 'ok' | 'warn' | 'idle' | 'danger';
  /** 迷你条百分比（0-100，方向 B 仅额度窗口行有）；缺省不渲染条 */
  barPercent?: number;
  /** tooltip 补充（如「今日签到 2/5」）；缺省无 */
  title?: string;
}

export interface PlatformIndexItem {
  app: string;
  label: string;
  /** 来源行（DeepSeek / OpenCode-Go / Codex）：不可签到，右栏只读详情 */
  kind?: 'platform' | 'source';
  accountCount: number;
  /** 今日签到：已完成/可参与（CheckinTodaySummary 的 done/total） */
  done: number;
  total: number;
  /**
   * 左栏指标（方向 B 规格）。传入时该行渲染「名称 + 指标（+ 迷你条）」，不再渲染账号数/健康角标；
   * 缺省回落旧单行形态（accountCount + done/total），兼容直接渲染本组件的调用方与测试夹具。
   */
  metric?: PlatformIndexMetric | null;
  /** 右栏渲染：选中平台的内容 */
  render: () => React.ReactNode;
}

/** 指标异常色（与设计 rail-check 的 ok/warn/idle 三态 + 已限额 danger 对齐） */
const METRIC_TONE_CLASS: Record<PlatformIndexMetric['tone'], string> = {
  ok: 'text-accent',
  warn: 'text-amber-600 dark:text-amber-400',
  idle: 'text-ink-3',
  danger: 'text-red-600 dark:text-red-400',
};

export function AccountsMasterDetail({
  items,
  selected: selectedProp,
  onSelect,
}: {
  items: PlatformIndexItem[];
  /**
   * 受控选中（ACC-UI-TOPBAR：顶栏「添加」作用于右栏当前平台，选中态上提到面板）。
   * 不传时保持组件内 useState（既有独立渲染口径不变）。
   */
  selected?: string;
  onSelect?: (app: string) => void;
}) {
  const [internalSelected, setInternalSelected] = useState<string>(items[0]?.app ?? '');
  const selected = selectedProp ?? internalSelected;
  const containerRef = useRef<HTMLDivElement | null>(null);
  const active = items.find((item) => item.app === selected) ?? items[0] ?? null;

  const choose = useCallback((app: string) => {
    setInternalSelected(app);
    onSelect?.(app);
  }, [onSelect]);

  const focusIndex = useCallback((delta: number | 'home' | 'end') => {
    const buttons = containerRef.current?.querySelectorAll<HTMLButtonElement>('[data-testid^="accounts-index-item-"]');
    if (buttons === undefined || buttons.length === 0) return;
    const list = [...buttons];
    const currentId = list.findIndex((button) => button.getAttribute('aria-selected') === 'true');
    const from = currentId === -1 ? 0 : currentId;
    const nextIndex = delta === 'home'
      ? 0
      : delta === 'end'
        ? list.length - 1
        : (from + delta + list.length) % list.length;
    const next = list[nextIndex];
    if (next === undefined) return;
    choose(next.dataset.app ?? '');
    next.focus();
  }, [choose]);

  return (
    <div
      data-testid="accounts-master-detail"
      className="flex min-h-0 flex-col gap-2 min-[920px]:flex-row min-[920px]:gap-3"
    >
      {/* 左栏：平台索引（窄屏变横滑 rail）。空态提示放 tablist 之外，避免 tablist 里混入非 tab 子节点 */}
      <div className="shrink-0 min-[920px]:w-[244px]">
        <div
          ref={containerRef}
          data-testid="accounts-index"
          role="tablist"
          aria-label="平台索引"
          aria-orientation="vertical"
          className="flex gap-1 overflow-x-auto pb-1 min-[920px]:flex-col min-[920px]:overflow-visible min-[920px]:pb-0"
        >
          {items.map((item) => {
            const isActive = active !== null && item.app === active.app;
            return (
              <button
                key={item.app}
                type="button"
                role="tab"
                data-testid={`accounts-index-item-${item.app}`}
                data-app={item.app}
                aria-selected={isActive}
                aria-controls={`accounts-panel-${item.app}`}
                id={`accounts-tab-${item.app}`}
                tabIndex={isActive ? 0 : -1}
                onClick={() => choose(item.app)}
                onKeyDown={(event) => {
                  if (event.key === 'ArrowDown' || event.key === 'ArrowRight') {
                    event.preventDefault();
                    focusIndex(1);
                  } else if (event.key === 'ArrowUp' || event.key === 'ArrowLeft') {
                    event.preventDefault();
                    focusIndex(-1);
                  } else if (event.key === 'Home') {
                    event.preventDefault();
                    focusIndex('home');
                  } else if (event.key === 'End') {
                    event.preventDefault();
                    focusIndex('end');
                  }
                }}
                className={`flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-md px-2 py-1 text-left text-xs ab-transition ${
                  isActive
                    ? 'bg-accent-soft font-medium text-accent'
                    : 'text-ink-2 hover:bg-surface-raised'
                }`}
              >
                {item.metric != null ? (
                  /* 方向 B 规格：名称 + 指标（+ 迷你条），账号数/健康角标不再占行 */
                  <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                    <span className="truncate">{item.label}</span>
                    <span
                      data-testid={`accounts-index-metric-${item.app}`}
                      data-tone={item.metric.tone}
                      title={item.metric.title}
                      className={`tabular-nums text-[11px] font-normal ${METRIC_TONE_CLASS[item.metric.tone]}`}
                    >
                      {item.metric.text}
                    </span>
                    {item.metric.barPercent !== undefined && (
                      <span aria-hidden="true" className="block h-[3px] w-full overflow-hidden rounded bg-surface-raised">
                        <span
                          data-testid={`accounts-index-bar-${item.app}`}
                          data-width={item.metric.barPercent}
                          style={{ width: `${item.metric.barPercent}%` }}
                          className={`block h-full rounded ${item.metric.tone === 'danger' ? 'bg-red-600 dark:bg-red-400' : 'bg-ink-2'}`}
                        />
                      </span>
                    )}
                  </span>
                ) : (
                  <>
                    <span className="truncate">{item.label}</span>
                    <span data-testid={`accounts-index-count-${item.app}`} className="tabular-nums text-[11px] text-ink-3">
                      {item.accountCount}
                    </span>
                    {item.total > 0 && (
                      <span
                        data-testid={`accounts-index-health-${item.app}`}
                        title={`今日签到 ${item.done}/${item.total}`}
                        className={`tabular-nums text-[11px] ${item.done === item.total ? 'text-accent' : 'text-ink-3'}`}
                      >
                        {item.done}/{item.total}
                      </span>
                    )}
                  </>
                )}
              </button>
            );
          })}
        </div>
        {items.length === 0 && (
          <p data-testid="accounts-index-empty" className="px-2 text-[11px] leading-snug text-ink-3">
            还没有账号
          </p>
        )}
      </div>

      {/* 右栏：只渲染选中平台 */}
      <div
        data-testid="accounts-detail"
        className="min-w-0 flex-1"
        role="tabpanel"
        {...(active === null ? {} : { id: `accounts-panel-${active.app}`, 'aria-labelledby': `accounts-tab-${active.app}` })}
      >
        {active === null ? (
          <p data-testid="accounts-detail-empty" className="text-xs text-ink-3">
            还没有账号。点顶部「添加账号」选择供应商：授权登录，或读取本机已登录的凭据。
          </p>
        ) : (
          active.render()
        )}
      </div>
    </div>
  );
}

export type { AccountView, CheckinTodaySummary };
