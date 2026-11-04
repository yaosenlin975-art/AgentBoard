/**
 * 左栏（S2a，设计稿 `Docs/design-2026-11-04-nav-sidebar-chat-view.md` §3/§7）。
 *
 * NAV-TOPBAR-01：顶栏不再承载工作区名/路径与右侧控件 —— 全部并入本栏顶部品牌位：
 * - 品牌位 = 工作区切换按钮（`LEFT_TRIGGER_ID` + 名称 + 路径；路径 truncate 且 title 给全路径）；
 * - 品牌位下方 = 主题 / 聊天 / 账号 / 设置 四宫格（行为与顶栏时期一致：`cycleTheme`、
 *   `openChat()`、`toggleDrawer('accounts'|'settings')`），可 Tab 聚焦、保留 aria-label；
 * - 底部状态行 = WS 状态圆点 + 导航说明（顶栏删除后状态圆点落在这里，不留空条）。
 *
 * 状态权威是 `useNavStore.view`（S1 已落地）：点入口只调 `setView`，不做本地 state。
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

/** 176px 栏内放不下「主题：跟随系统」，按钮只显示短词，全称进 title / aria-label */
const THEME_SHORT: Record<string, string> = {
  system: '跟随系统',
  light: '亮色',
  dark: '暗色',
};

const CONTROL_BTN =
  'flex h-8 min-w-0 items-center justify-center gap-1 rounded-md border border-hairline bg-surface-card px-1.5 text-xs text-ink-2 transition-colors hover:bg-surface-raised focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent';

export function SideBar({ workspace }: { workspace: Workspace | null }) {
  const view = useNavStore((state) => state.view);
  const setView = useNavStore((state) => state.setView);
  const drawer = useNavStore((state) => state.drawer);
  const toggleDrawer = useNavStore((state) => state.toggleDrawer);
  // 聊天入口徽标 = 全部会话未读合计（设计 §5；与左会话列表的单项徽标同一份 panelStore.unread）
  const unread = usePanelStore((state) => state.unread);
  const chatUnread = Object.values(unread).reduce((sum, n) => sum + (n > 0 ? n : 0), 0);
  const openChat = usePanelStore((state) => state.openChat);
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
      {/* 品牌位（NAV-TOPBAR-01）：工作区名 + 路径 + 切换浮层触发 */}
      <div data-testid="sidebar-workspace" className="border-b border-hairline px-3 py-3">
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

      {/* 顶栏迁入的四组控件（NAV-TOPBAR-01）：两列网格，176px 栏内不溢出 */}
      <div data-testid="sidebar-controls" className="grid grid-cols-2 gap-1.5 border-b border-hairline p-2">
        <button
          type="button"
          data-testid="topbar-theme"
          onClick={cycleTheme}
          aria-label="切换主题"
          title={`主题：${THEME_LABEL[theme]}（点击切换）`}
          className={CONTROL_BTN}
        >
          <span className="truncate">{THEME_SHORT[theme] ?? THEME_LABEL[theme]}</span>
        </button>

        <button
          type="button"
          data-testid="topbar-chat"
          aria-label="聊天"
          aria-expanded={view === 'chat'}
          aria-controls="right-panel-content"
          title="打开聊天（主区整屏）"
          onClick={() => openChat()}
          className={`relative ${CONTROL_BTN}`}
        >
          聊天
          {chatUnread > 0 && (
            <span
              data-testid="topbar-chat-unread"
              className="absolute -right-1 -top-1 rounded-full bg-accent px-1 text-[10px] font-medium leading-4 text-accent-ink"
            >
              {chatUnread > 99 ? '99+' : chatUnread}
            </span>
          )}
        </button>

        <button
          type="button"
          data-testid="topbar-accounts"
          aria-label="账号管理"
          aria-expanded={drawer === 'accounts'}
          title="管理 WorkBuddy / CodeBuddy 账号"
          onClick={() => toggleDrawer('accounts')}
          className={CONTROL_BTN}
        >
          账号
        </button>

        <button
          type="button"
          data-testid="topbar-settings"
          aria-label="设置"
          aria-expanded={drawer === 'settings'}
          onClick={() => toggleDrawer('settings')}
          className={CONTROL_BTN}
        >
          设置
        </button>
      </div>

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

      <div className="mt-auto flex items-center gap-1.5 border-t border-hairline px-3 py-2 text-[11px] text-ink-3" data-testid="sidebar-status">
        {/* PANEL-VIEW-BUG 口径：只保留状态圆点（颜色编码），不展示「已连接/已断开」文案 */}
        <span
          data-testid="topbar-ws-status"
          data-status={wsStatus}
          title="服务连接状态"
          aria-label="服务连接状态"
          className="inline-flex items-center"
        >
          <span className={`inline-block h-2 w-2 rounded-full ${WS_DOT[wsStatus]}`} aria-hidden="true" />
        </span>
        <span>左栏导航</span>
      </div>
    </nav>
  );
}
