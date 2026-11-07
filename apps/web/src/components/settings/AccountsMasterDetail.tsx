/**
 * ACC-B1：账号面板主从布局骨架。
 *
 * 左栏 = 平台索引（每个平台一行：图标 + 名称 + 当前账号 + 账号数 + 今日签到健康态），
 * 右栏 = **只渲染选中平台**的容器（从结构上消除六平台同屏堆叠）。
 *
 * 选中态用**组件内 useState**（与既有 `openApps` 同层），不新增第二套导航 store；
 * `navStore` 只管视图级导航，账号面板内部的平台选择留在面板内。
 *
 * 响应式（阈值取卡面 920px）：
 * - ≥920px：`flex-row`，左栏固定 200px、右栏 flex-1；
 * - <920px：`flex-col`，左栏变**可横滑 rail**（`overflow-x-auto` + 不换行），避免竖排六行吃掉首屏；
 * - <560px：仍是单列 + 横滑，375px 下页面 `scrollWidth == clientWidth`（rail 自己滚，不撑破页面）。
 *
 * 键盘：左栏项是 `role="tab"` 的 `<button>`，`aria-selected` 表达选中；
 * ↑/↓/←/→ 在项间移动焦点并切换，Home/End 跳首尾，Tab 正常离开索引。
 */
import { useCallback, useRef, useState } from 'react';
import type { AccountView } from './AccountCard';
import type { CheckinTodaySummary } from './accountCapabilities';

export interface PlatformIndexItem {
  app: string;
  label: string;
  /** 来源行（DeepSeek / OpenCode-Go / Codex）：不可签到，右栏只读详情 */
  kind?: 'platform' | 'source';
  accountCount: number;
  /** 今日签到：已完成/可参与（CheckinTodaySummary 的 done/total） */
  done: number;
  total: number;
  /** 右栏渲染：选中平台的内容 */
  render: () => React.ReactNode;
}

export function AccountsMasterDetail({ items }: { items: PlatformIndexItem[] }) {
  const [selected, setSelected] = useState<string>(items[0]?.app ?? '');
  const containerRef = useRef<HTMLDivElement | null>(null);
  const active = items.find((item) => item.app === selected) ?? items[0] ?? null;

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
    setSelected(next.dataset.app ?? '');
    next.focus();
  }, []);

  return (
    <div
      data-testid="accounts-master-detail"
      className="flex min-h-0 flex-col gap-2 min-[920px]:flex-row min-[920px]:gap-3"
    >
      {/* 左栏：平台索引（窄屏变横滑 rail） */}
      <div
        ref={containerRef}
        data-testid="accounts-index"
        role="tablist"
        aria-label="平台索引"
        aria-orientation="vertical"
        className="flex shrink-0 gap-1 overflow-x-auto pb-1 min-[920px]:w-[200px] min-[920px]:flex-col min-[920px]:overflow-visible min-[920px]:pb-0"
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
              onClick={() => setSelected(item.app)}
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
            </button>
          );
        })}
      </div>

      {/* 右栏：只渲染选中平台 */}
      <div
        data-testid="accounts-detail"
        className="min-w-0 flex-1"
        role="tabpanel"
        {...(active === null ? {} : { id: `accounts-panel-${active.app}`, 'aria-labelledby': `accounts-tab-${active.app}` })}
      >
        {active === null ? (
          <p data-testid="accounts-detail-empty" className="text-xs text-ink-3">没有可显示的平台</p>
        ) : (
          active.render()
        )}
      </div>
    </div>
  );
}

export type { AccountView, CheckinTodaySummary };
