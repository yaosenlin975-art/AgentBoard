/**
 * 左栏（S2a，设计稿 `Docs/design-2026-11-04-nav-sidebar-chat-view.md` §3/§7）。
 *
 * FIX-1（导航重构纠偏，父卡 3c8d0a34）：结构回归设计稿顺序
 *   工作空间 → 五入口 → 账号/设置（纵向两项）→ 状态行
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
import { useRef } from 'react';
import type { Workspace } from '@agentboard/shared';
import { useNavStore, type NavView } from '../../state/navStore';
import { usePanelStore } from '../../state/panelStore';
import { useAppStore, type WsStatus } from '../../state/appStore';
import { useOverlayStore } from '../../state/overlayStore';
import { THEME_LABEL, useTheme } from '../../theme';
import { WorkspaceSidebarOverlay, LEFT_PANEL_ID, LEFT_TRIGGER_ID } from '../overlay/WorkspaceSidebarOverlay';

const ENTRY_ICON: Record<NavView, string> = {
  board: 'M3 3h7v7H3zM14 3h7v7h-7zM3 14h7v7H3zM14 14h7v7h-7z',
  tree: 'M4 4h6v4H4zM14 10h6v4h-6zM14 16h6v4h-6zM7 8v10h7M7 10h7',
  knowledge: 'M4 4h16v16H4zM8 8h8M8 12h8M8 16h5',
  log: 'M4 6h16M4 12h16M4 18h10',
  chat: 'M4 5h16v10H9l-5 4z',
};

const ENTRIES: Array<{ view: NavView; label: string }> = [
  { view: 'board', label: '平铺看板' },
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

export function SideBar({ workspace }: { workspace: Workspace | null }) {
  const view = useNavStore((state) => state.view);
  const setView = useNavStore((state) => state.setView);
  const drawer = useNavStore((state) => state.drawer);
  const toggleDrawer = useNavStore((state) => state.toggleDrawer);
  // 未读徽标 = 全部会话未读合计（设计 §5；只挂在五入口的聊天项上）
  const unread = usePanelStore((state) => state.unread);
  const chatUnread = Object.values(unread).reduce((sum, n) => sum + (n > 0 ? n : 0), 0);
  const leftOpen = useOverlayStore((state) => state.left);
  const toggleLeft = useOverlayStore((state) => state.toggleLeft);
  const wsStatus = useAppStore((state) => state.wsStatus);
  const [theme, cycleTheme] = useTheme();
  const workspaceTriggerRef = useRef<HTMLButtonElement>(null);

  return (
    <nav
      data-testid="sidebar"
      aria-label="主导航"
      className="flex w-[176px] shrink-0 flex-col border-r border-hairline bg-surface-card"
    >
      {/* ① 工作空间（FIX-1：容器 relative，浮窗锚定在触发按钮正下方） */}
      <div data-testid="sidebar-workspace" className="relative border-b border-hairline px-3 py-3">
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
          className="flex w-full min-w-0 items-center gap-1 text-left text-xl font-semibold text-ink focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent"
        >
          <span aria-hidden="true" className="shrink-0 text-ink-3">▾</span>
          <span className="truncate">{workspace?.name ?? '未选择工作区'}</span>
        </button>
        <p
          data-testid="sidebar-workspace-path"
          className="mt-0.5 truncate text-xs leading-none text-ink-3"
          title={workspace?.path ?? '未选择工作区'}
        >
          {workspace?.path ?? '未选择工作区'}
        </p>
        <WorkspaceSidebarOverlay triggerRef={workspaceTriggerRef} />
      </div>

      {/* ② 五入口（聊天只在这里出现一次，未读徽标挂本项） */}
      <ul className="flex flex-col gap-0.5 p-2" role="list">
        {ENTRIES.map((entry) => {
          const active = view === entry.view;
          return (
            <li key={entry.view}>
              <button
                type="button"
                data-testid={`sidebar-entry-${entry.view}`}
                aria-current={active ? 'page' : undefined}
                aria-label={entry.label}
                aria-expanded={entry.view === 'chat' ? view === 'chat' : undefined}
                onClick={() => setView(entry.view)}
                className={`flex h-9 w-full items-center gap-2 rounded-md px-2 text-sm transition-colors focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent ${
                  active ? 'bg-accent-soft font-medium text-accent' : 'text-ink-2 hover:bg-surface-raised'
                }`}
              >
                <svg aria-hidden="true" viewBox="0 0 24 24" className="size-4 shrink-0" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
                  <path d={ENTRY_ICON[entry.view]} />
                </svg>
                <span className="truncate">{entry.label}</span>
                {entry.view === 'chat' && chatUnread > 0 && (
                  <span
                    data-testid="sidebar-chat-unread"
                    title={`${chatUnread} 条未读消息`}
                    className="ml-auto shrink-0 rounded-full bg-red-600 px-1.5 text-[10px] font-medium leading-4 text-white"
                  >
                    {chatUnread > 99 ? '99+' : chatUnread}
                  </span>
                )}
              </button>
            </li>
          );
        })}
      </ul>

      {/* ③ 账号 / 设置（FIX-1：从四宫格下沉到底部，纵向两项） */}
      <div data-testid="sidebar-account-settings" className="mt-auto flex flex-col gap-1 px-2 pb-1">
        <button
          type="button"
          data-testid="topbar-accounts"
          aria-label="账号管理"
          aria-expanded={drawer === 'accounts'}
          title="管理 WorkBuddy / CodeBuddy 账号"
          onClick={() => toggleDrawer('accounts')}
          className={BOTTOM_BTN}
        >
          <svg aria-hidden="true" viewBox="0 0 24 24" className="size-4 shrink-0" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
            <path d="M4 16c0-2.2 3.6-4 8-4s8 1.8 8 4v2H4zM12 10a3 3 0 100-6 3 3 0 000 6" />
          </svg>
          <span className="truncate">账号</span>
        </button>
        <button
          type="button"
          data-testid="topbar-settings"
          aria-label="设置"
          aria-expanded={drawer === 'settings'}
          onClick={() => toggleDrawer('settings')}
          className={BOTTOM_BTN}
        >
          <svg aria-hidden="true" viewBox="0 0 24 24" className="size-4 shrink-0" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
            <path d="M12 15a3 3 0 100-6 3 3 0 000 6M4 12h2M18 12h2M12 4v2M12 18v2M6.5 6.5l1.4 1.4M16.1 16.1l1.4 1.4M17.5 6.5l-1.4 1.4M7.9 16.1l-1.4 1.4" />
          </svg>
          <span className="truncate">设置</span>
        </button>
      </div>

      {/* ④ 状态行：服务状态圆点 + 主题小字（点字切主题） */}
      <div
        className="flex items-center gap-1 border-t border-hairline px-2 py-2 text-[11px] text-ink-3"
        data-testid="sidebar-status"
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
        <span className="truncate">{WS_LABEL[wsStatus]}</span>
        <span aria-hidden="true" className="shrink-0 text-ink-3">·</span>
        <button
          type="button"
          data-testid="topbar-theme"
          onClick={cycleTheme}
          aria-label="切换主题"
          title={`主题：${THEME_LABEL[theme]}（点击切换）`}
          className="shrink-0 rounded px-0.5 text-[11px] text-ink-2 underline-offset-2 hover:underline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent"
        >
          {THEME_SHORT[theme] ?? THEME_LABEL[theme]}
        </button>
      </div>
    </nav>
  );
}
