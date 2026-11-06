/**
 * 左栏（S2a，设计稿 `Docs/designs/chat/2026-11-04-nav-sidebar-chat-view.md` §3/§7）。
 *
 * FIX-1（导航重构纠偏，父卡 3c8d0a34）：结构回归设计稿顺序
 *   工作空间 → 入口（DEC-6 后为六入口）→ 账号/设置（纵向两项）→ 状态行
 * - 删掉 NAV-TOPBAR-01 迁入的 `sidebar-controls` 四宫格：聊天不再有重复入口（只作五入口之一，
 *   未读徽标挂在 `sidebar-entry-chat`）；账号/设置下沉到底部；主题并入状态行小字（点字切主题）。
 * - 品牌位容器加 `relative`：`WorkspaceSidebarOverlay` 的 `absolute top-full` 才能真正锚定在触发按钮正下方
 *   （此前无定位祖先，浮窗按视口飞到屏幕外）。
 * testid 映射（兼容旧锚点，测试同步更新）：
 *   `topbar-workspace`（品牌按钮）· `sidebar-workspace-path`（路径）· `sidebar-entry-chat`（唯一聊天入口）
 *   `sidebar-chat-unread`（未读徽标）· `topbar-accounts` / `topbar-settings`（底部两项）
 *   `topbar-theme`（状态行里的主题小字）· `topbar-ws-status`（状态圆点）
 *   已删除：`sidebar-controls`、`topbar-chat`、`topbar-chat-unread`（聊天入口与徽标合并到五入口）。
 */
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import type { Workspace } from '@agentboard/shared';
import { useNavStore, type NavView } from '../../state/navStore';
import { usePanelStore } from '../../state/panelStore';
import { useAppStore, type WsStatus } from '../../state/appStore';
import { useOverlayStore } from '../../state/overlayStore';
import { THEME_LABEL, useTheme } from '../../theme';
import { WorkspaceSidebarOverlay, LEFT_PANEL_ID, LEFT_TRIGGER_ID } from '../overlay/WorkspaceSidebarOverlay';
import { useDecisionLayerCounts } from '../decisions/useDecisions';
import { useDecisionsScope } from '../../state/useDecisionsScope';
import { useSidebarShortcut } from './useSidebarShortcut';
import { DRAWER_ANCHOR_MIN_VIEWPORT } from '../../lib/drawerAnchor';

const ENTRY_ICON: Record<NavView, string> = {
  board: 'M3 3h7v7H3zM14 3h7v7h-7zM3 14h7v7H3zM14 14h7v7h-7z',
  decisions: 'M12 3l7 4v10l-7 4-7-4V7zM5 7l7 4 7-4M12 11v10',
  tree: 'M4 4h6v4H4zM14 10h6v4h-6zM14 16h6v4h-6zM7 8v10h7M7 10h7',
  knowledge: 'M4 4h16v16H4zM8 8h8M8 12h8M8 16h5',
  log: 'M4 6h16M4 12h16M4 18h10',
  chat: 'M4 5h16v10H9l-5 4z',
};

const ENTRIES: Array<{ view: NavView; label: string }> = [
  { view: 'board', label: '任务看板' },
  { view: 'decisions', label: '待决策' },
  { view: 'tree', label: '任务树' },
  { view: 'knowledge', label: '知识库' },
  { view: 'log', label: '日志' },
  { view: 'chat', label: '聊天' },
];

const WS_DOT: Record<WsStatus, string> = {
  connecting: 'bg-yellow-500',
  open: 'bg-green-500',
  closed: 'bg-red-500',
};

/** 状态行里的服务状态：只给短词（顶部状态圆点同步用 WS_DOT） */
const WS_LABEL: Record<WsStatus, string> = {
  connecting: '连接中',
  open: '服务运行中',
  closed: '服务已断开',
};

/** 主题短标签：点状态行的字切主题，全称进 title / aria-label */
const THEME_SHORT: Record<string, string> = {
  system: '跟随系统',
  light: '浅色',
  dark: '深色',
};

const BOTTOM_BTN =
  'flex h-8 w-full items-center gap-2 rounded-md border border-hairline bg-surface-card px-2 text-xs text-ink-2 transition-colors hover:bg-surface-raised focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent';

/**
 * SIDEBAR-5：窄屏口径（<920px，断点与抽屉锚定共用 DRAWER_ANCHOR_MIN_VIEWPORT）。
 * 窄屏展开是瞬时浮层，不写 navStore 持久化；JS 与 CSS 用同一个查询串，避免判定漂移。
 */
const NARROW_QUERY = `(max-width: ${DRAWER_ANCHOR_MIN_VIEWPORT - 0.02}px)`;

function subscribeNarrow(callback: () => void): () => void {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return () => {};
  const media = window.matchMedia(NARROW_QUERY);
  media.addEventListener('change', callback);
  return () => media.removeEventListener('change', callback);
}

function readNarrow(): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false;
  return window.matchMedia(NARROW_QUERY).matches;
}

export function SideBar({ workspace }: { workspace: Workspace | null }) {
  const view = useNavStore((state) => state.view);
  const setView = useNavStore((state) => state.setView);
  const drawer = useNavStore((state) => state.drawer);
  const toggleDrawer = useNavStore((state) => state.toggleDrawer);
  // SIDEBAR-1：两形态骨架（宽度与标签过渡见 index.css 的 .ab-sidebar）
  const sidebarMode = useNavStore((state) => state.sidebarMode);
  const toggleSidebar = useNavStore((state) => state.toggleSidebar);
  // 未读徽标 = 全部会话未读合计（设计 §5；只挂在五入口的聊天项上）
  const unread = usePanelStore((state) => state.unread);
  const chatUnread = Object.values(unread).reduce((sum, n) => sum + (n > 0 ? n : 0), 0);
  const leftOpen = useOverlayStore((state) => state.left);
  const toggleLeft = useOverlayStore((state) => state.toggleLeft);
  const wsStatus = useAppStore((state) => state.wsStatus);
  const [theme, cycleTheme] = useTheme();
  const workspaceTriggerRef = useRef<HTMLButtonElement>(null);
  const sidebarRef = useRef<HTMLElement>(null);
  const collapseToggleRef = useRef<HTMLButtonElement>(null);
  // DEC-BADGE：待决策徽标拆成「宽限中 / 已落锁」两项；范围跟随待决策区，数据与列表同源
  const decisionsScope = useDecisionsScope();
  const decision = useDecisionLayerCounts(workspace?.id ?? null, decisionsScope);
  const decisionTotal = decision.grace + decision.locked;
  /** 徽标数字：任一 >99 折成 99+（与聊天未读同一规则） */
  const badgeText = (count: number): string => (count > 99 ? '99+' : String(count));

  /** SIDEBAR-1/4：形态切换的唯一动作（顶部按钮与 Ctrl/Cmd+B 共用）；收起时把侧栏内焦点交给仍可见的切换按钮，避免掉回 body */
  const applySidebarToggle = useCallback((): void => {
    const wasExpanded = useNavStore.getState().sidebarMode === 'expanded';
    toggleSidebar();
    if (!wasExpanded) return;
    const active = document.activeElement;
    if (
      active instanceof HTMLElement &&
      sidebarRef.current?.contains(active) &&
      active !== collapseToggleRef.current
    ) {
      collapseToggleRef.current?.focus({ preventScroll: true });
    }
  }, [toggleSidebar]);

  // SIDEBAR-5：窄屏（<920px）展开是 208px 浮层 + 遮罩的瞬时态，不写持久化
  const narrow = useSyncExternalStore(subscribeNarrow, readNarrow, () => false);
  const [narrowExpanded, setNarrowExpanded] = useState(false);
  const effectiveMode = narrow && narrowExpanded ? 'expanded' : narrow ? 'collapsed' : sidebarMode;
  const collapsed = effectiveMode === 'collapsed';

  const closeNarrowOverlay = useCallback((): void => {
    setNarrowExpanded(false);
    collapseToggleRef.current?.focus({ preventScroll: true });
  }, []);

  // 回到宽屏清掉瞬时态，避免下次变窄时浮层莫名打开
  useEffect(() => {
    if (!narrow) setNarrowExpanded(false);
  }, [narrow]);

  // 浮层打开时 Esc 收起并把焦点交还切换按钮；有弹窗时让弹窗先处理
  useEffect(() => {
    if (!narrow || !narrowExpanded) return undefined;
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return;
      if (document.querySelector('[role="dialog"]') !== null) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      closeNarrowOverlay();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [narrow, narrowExpanded, closeNarrowOverlay]);

  /** 按钮与快捷键共用：宽屏走 store（持久化）；窄屏只开合瞬时浮层 */
  const toggleEffectiveMode = useCallback((): void => {
    if (!narrow) {
      applySidebarToggle();
      return;
    }
    if (narrowExpanded) closeNarrowOverlay();
    else setNarrowExpanded(true);
  }, [narrow, narrowExpanded, applySidebarToggle, closeNarrowOverlay]);

  // SIDEBAR-4：非输入区 Ctrl/Cmd+B 切换；窄屏同样开合浮层
  useSidebarShortcut(toggleEffectiveMode);

  return (
    <>
      {/* 窄屏浮层：56px 占位保持主区宽度，遮罩在浮层之下、主区之上 */}
      {narrow && narrowExpanded && <div aria-hidden="true" className="ab-sidebar-rail-slot" />}
      {narrow && narrowExpanded && (
        <div
          data-testid="sidebar-backdrop"
          aria-hidden="true"
          className="ab-sidebar-backdrop"
          onClick={closeNarrowOverlay}
        />
      )}
      <nav
        ref={sidebarRef}
        id="app-sidebar"
        data-testid="sidebar"
        data-mode={effectiveMode}
        data-overlay={narrow && narrowExpanded ? 'true' : undefined}
        aria-label="主导航"
        className="ab-sidebar flex shrink-0 flex-col border-r border-hairline bg-surface-card"
      >
      {/* ① 工作空间（FIX-1：容器 relative，浮窗锚定在触发按钮正下方） */}
      <div data-testid="sidebar-workspace" className="ab-sidebar-head relative border-b border-hairline px-3 py-3">
        <div className="ab-sidebar-head-row flex items-start gap-1.5">
          <button
            type="button"
            id={LEFT_TRIGGER_ID}
            ref={workspaceTriggerRef}
            data-testid="topbar-workspace"
            aria-expanded={leftOpen}
            aria-controls={LEFT_PANEL_ID}
            aria-label="工作空间"
            title="切换工作空间"
            onClick={toggleLeft}
            className="ab-sidebar-ws flex w-full min-w-0 items-center gap-1 text-left text-xl font-semibold text-ink focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent"
          >
            <span aria-hidden="true" className="ab-sidebar-caret shrink-0 text-ink-3">▾</span>
            <span className="ab-sidebar-label truncate">{workspace?.name ?? '未选择工作区'}</span>
            {/* 收起态的工作空间方块（首字）；展开态由 .ab-sidebar-label 显示全名 */}
            <span aria-hidden="true" className="ab-sidebar-ws-initial">
              {(workspace?.name ?? '未选择工作区').slice(0, 1)}
            </span>
          </button>
          {/* SIDEBAR-1：顶部切换按钮（展开 24×24 幽灵按钮 / 收起 28×22，仍在头部） */}
          <button
            type="button"
            ref={collapseToggleRef}
            data-testid="sidebar-collapse-toggle"
            aria-expanded={!collapsed}
            aria-controls="app-sidebar"
            aria-label={collapsed ? '展开侧栏' : '收起侧栏'}
            title={collapsed ? '展开侧栏' : '收起侧栏'}
            onClick={toggleEffectiveMode}
            className="ab-sidebar-toggle inline-flex shrink-0 items-center justify-center rounded-md text-ink-3 transition-colors hover:bg-surface-raised hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent"
          >
            <svg aria-hidden="true" viewBox="0 0 24 24" className="ab-sidebar-ico-collapse" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
              <path d="M14 6l-6 6 6 6" />
              <path d="M19 4v16" />
            </svg>
            <svg aria-hidden="true" viewBox="0 0 24 24" className="ab-sidebar-ico-expand" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
              <path d="M10 6l6 6-6 6" />
              <path d="M19 4v16" />
            </svg>
          </button>
        </div>
        <p
          data-testid="sidebar-workspace-path"
          className="ab-sidebar-label mt-0.5 truncate text-xs leading-none text-ink-3"
          title={workspace?.path ?? '未选择工作区'}
        >
          {workspace?.path ?? '未选择工作区'}
        </p>
        <WorkspaceSidebarOverlay triggerRef={workspaceTriggerRef} />
      </div>

      {/* ② 六入口（聊天只在这里出现一次，未读徽标挂本项；待决策分项徽标见 DEC-BADGE） */}
      <ul className="ab-sidebar-nav flex flex-col gap-0.5 p-2" role="list">
        {ENTRIES.map((entry) => {
          const active = view === entry.view;
          // SIDEBAR-3：角标数字同时进 tooltip 与 aria-label（收起态图标旁看不到文字时也读得到）
          const isDecisions = entry.view === 'decisions';
          const count = entry.view === 'chat' ? chatUnread : isDecisions ? decisionTotal : 0;
          // DEC-BADGE：待决策播报分项数量，其余入口沿用总量
          const tip = isDecisions
            ? decisionTotal > 0
              ? `${entry.label} · 宽限中 ${badgeText(decision.grace)} · 已超时 ${badgeText(decision.locked)}`
              : entry.label
            : count > 0
              ? `${entry.label} · ${badgeText(count)}`
              : entry.label;
          const entryLabel = isDecisions
            ? decisionTotal > 0
              ? `待决策，宽限中 ${decision.grace} 条，已超时 ${decision.locked} 条`
              : entry.label
            : count > 0
              ? `聊天，${count} 条未读`
              : entry.label;
          return (
            <li key={entry.view} className="ab-sidebar-tip" data-tip={tip}>
              <button
                type="button"
                data-testid={`sidebar-entry-${entry.view}`}
                aria-current={active ? 'page' : undefined}
                aria-label={entryLabel}
                aria-expanded={entry.view === 'chat' ? view === 'chat' : undefined}
                data-active={active ? 'true' : 'false'}
                onClick={() => {
                  setView(entry.view);
                  // SIDEBAR-5：窄屏浮层选中入口即收起
                  if (narrow && narrowExpanded) closeNarrowOverlay();
                }}
                // A2：入口点击反馈只走颜色过渡（≤150ms）+ data-active 供断言；reduced-motion 下即时
                className={`ab-sidebar-entry flex h-9 w-full items-center gap-2 rounded-md px-2 text-sm transition-colors duration-150 motion-reduce:transition-none focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent ${
                  active
                    ? 'bg-accent-soft font-medium text-accent active:bg-accent-soft'
                    : 'text-ink-2 hover:bg-surface-raised active:bg-surface-raised'
                }`}
              >
                <svg aria-hidden="true" viewBox="0 0 24 24" className="size-4 shrink-0" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
                  <path d={ENTRY_ICON[entry.view]} />
                </svg>
                <span className="ab-sidebar-label truncate">{entry.label}</span>
                {entry.view === 'chat' && chatUnread > 0 && (
                  <span
                    data-testid="sidebar-chat-unread"
                    className="ab-sidebar-badge ml-auto shrink-0 rounded-full bg-red-600 px-1.5 text-[10px] font-medium leading-4 text-white"
                  >
                    {chatUnread > 99 ? '99+' : chatUnread}
                  </span>
                )}
                {entry.view === 'decisions' && decisionTotal > 0 && (
                  // DEC-BADGE：琥珀=宽限中，红=已超时/落锁；数字由 aria-label 播报，视觉徽标对读屏隐藏
                  <span
                    data-testid="sidebar-decisions-badge"
                    className="ab-sidebar-badge ab-decision-badge-group ml-auto shrink-0"
                    aria-hidden="true"
                  >
                    {decision.grace > 0 && (
                      <span data-testid="sidebar-decisions-grace" className="ab-decision-badge ab-decision-badge-grace">
                        {badgeText(decision.grace)}
                      </span>
                    )}
                    {decision.locked > 0 && (
                      <span data-testid="sidebar-decisions-locked" className="ab-decision-badge ab-decision-badge-locked">
                        {badgeText(decision.locked)}
                      </span>
                    )}
                  </span>
                )}
              </button>
            </li>
          );
        })}
      </ul>

      {/* ③ 账号 / 设置（FIX-1：从四宫格下沉到底部，纵向两项） */}
      <div data-testid="sidebar-account-settings" className="ab-sidebar-bottom mt-auto flex flex-col gap-1 px-2 pb-1">
        <button
          type="button"
          data-testid="topbar-accounts"
          aria-label="账号管理"
          aria-expanded={drawer === 'accounts'}
          title="管理 WorkBuddy / CodeBuddy 账号"
          onClick={() => toggleDrawer('accounts')}
          data-tip="账号管理"
          className={`ab-sidebar-tip ab-sidebar-bottom-btn ${BOTTOM_BTN}`}
        >
          <svg aria-hidden="true" viewBox="0 0 24 24" className="size-4 shrink-0" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
            <path d="M4 16c0-2.2 3.6-4 8-4s8 1.8 8 4v2H4zM12 10a3 3 0 100-6 3 3 0 000 6" />
          </svg>
          <span className="ab-sidebar-label truncate">账号</span>
        </button>
        <button
          type="button"
          data-testid="topbar-settings"
          aria-label="设置"
          aria-expanded={drawer === 'settings'}
          onClick={() => toggleDrawer('settings')}
          data-tip="设置"
          className={`ab-sidebar-tip ab-sidebar-bottom-btn ${BOTTOM_BTN}`}
        >
          <svg aria-hidden="true" viewBox="0 0 24 24" className="size-4 shrink-0" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
            <path d="M12 15a3 3 0 100-6 3 3 0 000 6M4 12h2M18 12h2M12 4v2M12 18v2M6.5 6.5l1.4 1.4M16.1 16.1l1.4 1.4M17.5 6.5l-1.4 1.4M7.9 16.1l-1.4 1.4" />
          </svg>
          <span className="ab-sidebar-label truncate">设置</span>
        </button>
      </div>

      {/* ④ 状态行：服务状态圆点 + 主题小字（点字切主题） */}
      <div
        className="ab-sidebar-tip ab-sidebar-status flex items-center gap-1 border-t border-hairline px-2 py-2 text-[11px] text-ink-3"
        data-testid="sidebar-status"
        data-tip={`${WS_LABEL[wsStatus]} · ${THEME_LABEL[theme]}`}
      >
        {/* PANEL-VIEW-BUG 口径：只保留状态圆点（颜色编码），文案用短词跟在后面 */}
        <span
          data-testid="topbar-ws-status"
          data-status={wsStatus}
          title="服务连接状态"
          aria-label="服务连接状态"
          className="inline-flex shrink-0 items-center"
        >
          <span className={`inline-block h-2 w-2 rounded-full ${WS_DOT[wsStatus]}`} aria-hidden="true" />
        </span>
        <span className="ab-sidebar-label truncate">{WS_LABEL[wsStatus]}</span>
        <span aria-hidden="true" className="ab-sidebar-status-sep shrink-0 text-ink-3">·</span>
        {/* AUDIT-SETTINGS（F-13）：主题的唯一权威入口是「设置 → 主题」三选一；这里只**只读显示**当前主题，不再可点（两处可点 = 多入口） */}
        <span
          data-testid="topbar-theme"
          data-readonly="true"
          aria-label={`当前${THEME_LABEL[theme]}（在设置里切换）`}
          title={`主题：${THEME_LABEL[theme]}（在「设置 → 主题」里切换）`}
          className="ab-sidebar-label shrink-0 text-[11px] text-ink-3"
        >
          {THEME_SHORT[theme] ?? THEME_LABEL[theme]}
        </span>
      </div>
      </nav>
    </>
  );
}


