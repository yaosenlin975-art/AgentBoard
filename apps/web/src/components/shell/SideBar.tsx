/**
 * 左栏（S2a，设计稿 `Docs/design-2026-11-04-nav-sidebar-chat-view.md` §3/§7）。
 *
 * 本卡只落「壳」：工作区展示 + 五视图纵向入口 + 底部状态行。
 * 账号/设置入口与 drawer（§6）、工作区切换浮层、窄屏 56px 图标栏归 S2c。
 *
 * 状态权威是 `useNavStore.view`（S1 已落地）：点入口只调 `setView`，不做本地 state，
 * 也不与 TopBar/工具条里的 ViewSwitcher 抢状态（S2c 会把工具条入口移除）。
 */
import type { Workspace } from '@agentboard/shared';
import { useNavStore, type NavView } from '../../state/navStore';
import { usePanelStore } from '../../state/panelStore';

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

export function SideBar({ workspace }: { workspace: Workspace | null }) {
  const view = useNavStore((state) => state.view);
  const setView = useNavStore((state) => state.setView);
  // 聊天入口徽标 = 全部会话未读合计（设计 §5；与左会话列表的单项徽标同一份 panelStore.unread）
  const unread = usePanelStore((state) => state.unread);
  const chatUnread = Object.values(unread).reduce((sum, n) => sum + (n > 0 ? n : 0), 0);

  return (
    <nav
      data-testid="sidebar"
      aria-label="主导航"
      className="flex w-[176px] shrink-0 flex-col border-r border-hairline bg-surface-card"
    >
      <div data-testid="sidebar-workspace" className="border-b border-hairline px-3 py-3">
        <p className="truncate text-xl font-semibold text-ink" title={workspace?.name ?? '未选择工作区'}>
          {workspace?.name ?? '未选择工作区'}
        </p>
        <p data-testid="sidebar-workspace-path" className="truncate text-xs leading-none text-ink-3" title={workspace?.path ?? '未选择工作区'}>
          {workspace?.path ?? '未选择工作区'}
        </p>
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

      <div className="mt-auto border-t border-hairline px-3 py-2 text-[11px] text-ink-3" data-testid="sidebar-status">
        左栏导航
      </div>
    </nav>
  );
}
