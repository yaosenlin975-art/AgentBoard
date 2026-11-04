/**
 * 导航状态（S1，设计稿 `Docs/design-2026-11-04-nav-sidebar-chat-view.md` §4）。
 *
 * 单一视图枚举替代 App 的 `layout + knowledgeOpen + logOpen` 三态组合：
 *   view ∈ { board, tree, knowledge, log, chat }  —— 五入口互斥（单值即互斥）
 *   drawer ∈ { accounts, settings } | null        —— 右侧滑出面板，两者互斥
 *
 * 互斥与叠放规则（S2 的布局按此实现，本卡只落状态）：
 * - `view` 与 `drawer` **正交**：滑出面板是主区右侧兄弟（宽屏挤压 / 窄屏覆盖），
 *   打开面板不改变当前视图，切换视图也不自动收起面板；
 * - `openChat` 是唯一的跨 store 联动：切 `view='chat'` + 选中会话 + 关闭详情/引用浮窗
 *   （浮窗是 absolute 覆盖层，和整屏聊天不能叠）。
 *
 * 持久化：只持久化 `view`（`agentboard.nav`）；`drawer` 不持久化（刷新后不该自动弹出面板）。
 * 兜底：持久化里出现未知/非法 view（旧版本遗留、手改 localStorage）一律回落 `board`。
 */
import { create } from 'zustand';
import { persist } from 'zustand/middleware';

export type NavView = 'board' | 'tree' | 'knowledge' | 'log' | 'chat';
export type NavDrawer = 'accounts' | 'settings';

export const NAV_VIEWS: readonly NavView[] = ['board', 'tree', 'knowledge', 'log', 'chat'];
export const NAV_DRAWERS: readonly NavDrawer[] = ['accounts', 'settings'];
export const DEFAULT_NAV_VIEW: NavView = 'board';
export const NAV_STORAGE_KEY = 'agentboard.nav';

export function isNavView(value: unknown): value is NavView {
  return typeof value === 'string' && (NAV_VIEWS as readonly string[]).includes(value);
}

export function isNavDrawer(value: unknown): value is NavDrawer {
  return typeof value === 'string' && (NAV_DRAWERS as readonly string[]).includes(value);
}

/** 持久化恢复用：非法/缺失一律回落默认视图 */
export function normalizeNavView(value: unknown): NavView {
  return isNavView(value) ? value : DEFAULT_NAV_VIEW;
}

export interface NavState {
  view: NavView;
  drawer: NavDrawer | null;
  /** 切视图（五入口互斥）；非法值回落默认视图 */
  setView: (view: NavView) => void;
  /** 打开滑出面板（与另一个面板互斥，不影响 view） */
  openDrawer: (drawer: NavDrawer) => void;
  closeDrawer: () => void;
  /** 再点同一入口收起；点另一个入口直接切换 */
  toggleDrawer: (drawer: NavDrawer) => void;
}

export const useNavStore = create<NavState>()(
  persist(
    (set) => ({
      view: DEFAULT_NAV_VIEW,
      drawer: null,
      setView: (view) => set({ view: normalizeNavView(view) }),
      openDrawer: (drawer) => set({ drawer }),
      closeDrawer: () => set({ drawer: null }),
      toggleDrawer: (drawer) => set((state) => ({ drawer: state.drawer === drawer ? null : drawer })),
    }),
    {
      name: NAV_STORAGE_KEY,
      version: 0,
      // drawer 不持久化：刷新后不该自动弹出面板
      partialize: (state) => ({ view: state.view }),
      merge: (persisted, current) => ({
        ...current,
        view: normalizeNavView((persisted as { view?: unknown } | undefined)?.view),
        // drawer 不持久化：恢复时一律收起（否则刷新会自动弹出面板）
        drawer: null,
      }),
    },
  ),
);

/** 非 React 场景（store 之间联动、事件回调）读取当前视图 */
export function currentNavView(): NavView {
  return useNavStore.getState().view;
}
