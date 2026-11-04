import { useRef, useState } from 'react';
import type { Workspace } from '@agentboard/shared';
import { useAppStore, type WsStatus } from '../../state/appStore';
import { usePanelStore } from '../../state/panelStore';
import { useNavStore } from '../../state/navStore';
import { THEME_LABEL, useTheme } from '../../theme';
import { Modal } from '../ui/Modal';
import { SettingsDialog } from './SettingsDialog';
import { AccountsPanel } from '../settings/AccountsPanel';
import { WorkspaceSidebarOverlay, LEFT_PANEL_ID, LEFT_TRIGGER_ID } from '../overlay/WorkspaceSidebarOverlay';
import { useOverlayStore } from '../../state/overlayStore';
import { IconChevronDown } from '../ui/Icon';

const WS_DOT: Record<WsStatus, string> = {
  connecting: 'bg-yellow-500',
  open: 'bg-green-500',
  closed: 'bg-red-500',
};

/** 连接状态只用于圆点颜色与 data 属性（PANEL-VIEW-BUG：顶栏不再展示「已连接」等文案） */

export function TopBar({ workspace }: { workspace: Workspace | null }) {
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [accountsOpen, setAccountsOpen] = useState(false);
  // 左浮窗（工作空间列表）：PANEL-FLOAT，浮窗在触发按钮正下方展开
  const leftOpen = useOverlayStore((s) => s.left);
  const toggleLeft = useOverlayStore((s) => s.toggleLeft);
  const workspaceTriggerRef = useRef<HTMLButtonElement>(null);
  const wsStatus = useAppStore((s) => s.wsStatus);
  const [theme, cycleTheme] = useTheme();
  // 未读徽标：各会话未读计数总和（Record<sessionId, number>）
  const openChat = usePanelStore((s) => s.openChat);
  // 聊天是否已打开（PANEL-ENTRY2：顶栏按钮的 aria-expanded）
  // S2b：聊天已整屏化 —— 读 navStore（主区第五视图），不再看右侧面板视图（PanelView 已无 'chat'）
  const navView = useNavStore((s) => s.view);
  const chatOpen = navView === 'chat';
  const unreadTotal = usePanelStore((s) =>
    Object.values(s.unread).reduce<number>((sum, n) => sum + n, 0),
  );

  return (
    <header className="flex min-h-14 shrink-0 flex-wrap items-center gap-2 border-b border-hairline bg-surface-card px-4 py-2">
      <div className="min-w-0">
        <div className="flex min-w-0 items-center gap-1.5">
          {/* 左浮窗触发按钮（PANEL-FLOAT）：按钮即当前工作空间名，浮窗在其正下方展开 */}
          <div className="relative">
            <button
              type="button"
              id={LEFT_TRIGGER_ID}
              ref={workspaceTriggerRef}
              data-testid="topbar-workspace"
              aria-expanded={leftOpen}
              aria-controls={LEFT_PANEL_ID}
              aria-label="工作空间"
              title="切换工作空间"
              onClick={() => {
                if (!leftOpen) usePanelStore.getState().closeRight();
                toggleLeft();
              }}
              className="truncate rounded px-1 -mx-1 text-left text-xl font-semibold hover:bg-neutral-100 focus-visible:outline-2 focus-visible:outline-blue-500 dark:hover:bg-neutral-800"
            >
              <span aria-hidden="true" className="mr-1 inline-flex text-ink-3"><IconChevronDown size={12} /></span>
              {workspace ? workspace.name : '未选择工作空间'}
            </button>
            <WorkspaceSidebarOverlay triggerRef={workspaceTriggerRef} />
          </div>
          {/* TOPBAR-WSPATH：路径顶到原版本号的位置（字号/颜色沿用版本号），版本号不再显示；
              超长时 truncate + title 给完整路径，未选工作区时给占位文案。 */}
          <span
            data-testid="topbar-workspace-path"
            title={workspace ? workspace.path : '未选择工作区'}
            className="min-w-0 max-w-[38vw] truncate text-xs leading-none text-neutral-400 dark:text-neutral-500"
          >
            {workspace ? workspace.path : '未选择工作区'}
          </span>
        </div>
      </div>

      <div className="ml-auto flex flex-wrap items-center gap-2">


        {/* PANEL-VIEW-BUG：只保留状态圆点（颜色编码），不再展示「已连接/连接中/已断开」文案 */}
        <div
          className="flex items-center gap-1.5 text-xs text-neutral-500 dark:text-neutral-400"
          data-testid="topbar-ws-status"
          data-status={wsStatus}
          title="服务连接状态"
          aria-label="服务连接状态"
        >
          <span className={`inline-block h-2 w-2 rounded-full ${WS_DOT[wsStatus]}`} aria-hidden="true" />
        </div>

        <button
          type="button"
          onClick={cycleTheme}
          aria-label="切换主题"
          className="rounded px-2 py-1 text-xs text-neutral-600 hover:bg-neutral-100 dark:text-neutral-300 dark:hover:bg-neutral-800"
        >
          {THEME_LABEL[theme]}
        </button>

        <button
          type="button"
          data-testid="topbar-chat"
          aria-label="聊天"
          aria-expanded={chatOpen}
          aria-controls="right-panel-content"
          title="打开聊天浮窗"
          onClick={() => openChat()}
          className="relative rounded px-2 py-1 text-xs text-neutral-600 hover:bg-neutral-100 dark:text-neutral-300 dark:hover:bg-neutral-800"
        >
          聊天
          {unreadTotal > 0 && (
            <span
              data-testid="topbar-chat-unread"
              className="absolute -right-1 -top-1 rounded-full bg-accent px-1 text-[10px] leading-4 font-medium text-accent-ink"
            >
              {unreadTotal}
            </span>
          )}
        </button>

        <button
          type="button"
          data-testid="topbar-accounts"
          aria-label="账号管理"
          title="管理 WorkBuddy / CodeBuddy 账号"
          onClick={() => setAccountsOpen(true)}
          className="rounded px-2 py-1 text-xs text-neutral-600 hover:bg-neutral-100 dark:text-neutral-300 dark:hover:bg-neutral-800"
        >
          账号
        </button>

        <button
          type="button"
          aria-label="设置"
          onClick={() => setSettingsOpen(true)}
          className="rounded px-2 py-1 text-xs text-neutral-600 hover:bg-neutral-100 dark:text-neutral-300 dark:hover:bg-neutral-800"
        >
          设置
        </button>
      </div>

      <SettingsDialog open={settingsOpen} onClose={() => setSettingsOpen(false)} />
      {/* 账号管理独立入口：与设置弹窗内区块共用同一个 AccountsPanel，账号与 workspace 无关故不依赖 workspace */}
      <Modal open={accountsOpen} title="账号管理" onClose={() => setAccountsOpen(false)} size="lg" scrollable>
        <AccountsPanel />
      </Modal>
    </header>
  );
}









