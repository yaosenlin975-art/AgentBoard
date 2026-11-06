/**
 * 导航状态（S1，设计稿 `Docs/designs/chat/2026-11-04-nav-sidebar-chat-view.md` §4）。
 *
 * 单一视图枚举替代 App 的 `layout + knowledgeOpen + logOpen` 三态组合：
 *   view ∈ { board, decisions, tree, knowledge, log, chat }  —— 六入口互斥（单值即互斥）
 *   drawer ∈ { accounts, settings } | null                  —— 右侧滑出面板，两者互斥
 *
 * DEC-6：`decisions` 是「待决策」视图（设计 v3 §3.7 方案 A，紧随看板、与任务同域）；
 * `decisionFocus` 仅用于深链（通知点击 / 待决策列表跳转）选中某条决策，不持久化。
 *
 * 互斥与叠放规则（S2 的布局按此实现，本卡只落状态）：
 * - `view` 与 `drawer` **正交**：滑出面板是主区右侧兄弟（宽屏挤压 / 窄屏覆盖），
 *   打开面板不改变当前视图，切换视图也不自动收起面板；
 * - `openChat` 是唯一的跨 store 联动：切 `view='chat'` + 选中会话 + 关闭详情/引用浮窗
 *   （浮窗是 absolute 覆盖层，和整屏聊天不能叠）。
 *
 * 持久化：只持久化 `view`（`agentboard.nav`）；`drawer` 不持久化（刷新后不该自动弹出面板）。
 * 兜底：持久化里出现未知/非法 view（旧版本遗留、手改 localStorage）一律回落 `board`。
 *
 * SIDEBAR-1：侧栏两形态骨架 —— `sidebarMode ∈ { expanded, collapsed }`，默认展开；
 * 本卡只落状态与切换动作，持久化策略由 SIDEBAR-2 负责（现在仍只写 `view`）。
 *
 * SIDEBAR-2：形态记忆 —— 显式切换后随 `agentboard.nav` 持久化；无存储时按视口给默认
 * （≥920 展开 / <920 收起），该默认不写盘（`sidebarModeExplicit` 只在用户切换后置真）。
 */
import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { DRAWER_ANCHOR_MIN_VIEWPORT } from '../lib/drawerAnchor';

export type NavView = 'board' | 'decisions' | 'tree' | 'knowledge' | 'log' | 'chat';
export type NavDrawer = 'accounts' | 'settings';
/** SIDEBAR-1：侧栏形态 —— 展开 176px / 收起 56px 图标栏 */
export type SidebarMode = 'expanded' | 'collapsed';

export const NAV_VIEWS: readonly NavView[] = ['board', 'decisions', 'tree', 'knowledge', 'log', 'chat'];
export const NAV_DRAWERS: readonly NavDrawer[] = ['accounts', 'settings'];
export const SIDEBAR_MODES: readonly SidebarMode[] = ['expanded', 'collapsed'];
export const DEFAULT_NAV_VIEW: NavView = 'board';
export const DEFAULT_SIDEBAR_MODE: SidebarMode = 'expanded';
export const NAV_STORAGE_KEY = 'agentboard.nav';

export function isNavView(value: unknown): value is NavView {
  return typeof value === 'string' && (NAV_VIEWS as readonly string[]).includes(value);
}

export function isNavDrawer(value: unknown): value is NavDrawer {
  return typeof value === 'string' && (NAV_DRAWERS as readonly string[]).includes(value);
}

export function isSidebarMode(value: unknown): value is SidebarMode {
  return typeof value === 'string' && (SIDEBAR_MODES as readonly string[]).includes(value);
}

/** 持久化恢复用：非法/缺失一律回落默认视图 */
export function normalizeNavView(value: unknown): NavView {
  return isNavView(value) ? value : DEFAULT_NAV_VIEW;
}

/** 持久化恢复用：非法/缺失一律回落展开（与 normalizeNavView 同风格） */
export function normalizeSidebarMode(value: unknown): SidebarMode {
  return isSidebarMode(value) ? value : DEFAULT_SIDEBAR_MODE;
}

/**
 * SIDEBAR-2：无存储时的首次默认 —— 宽屏（≥920）展开、窄屏收起。
 * 920 是窄屏浮层的唯一断点口径（`DRAWER_ANCHOR_MIN_VIEWPORT`），不另造魔法数。
 */
export function computeInitialSidebarMode(viewportWidth: number): SidebarMode {
  return viewportWidth < DRAWER_ANCHOR_MIN_VIEWPORT ? 'collapsed' : 'expanded';
}

export interface NavState {
  view: NavView;
  drawer: NavDrawer | null;
  /** SIDEBAR-1：侧栏形态（默认按视口；显式切换后持久化，见 SIDEBAR-2） */
  sidebarMode: SidebarMode;
  /** SIDEBAR-2：用户是否显式切过形态 —— 只有显式切换才把 sidebarMode 写盘 */
  sidebarModeExplicit: boolean;
  /** 显式设定侧栏形态（非法值回落展开） */
  setSidebarMode: (mode: SidebarMode) => void;
  /** 展开 ↔ 收起 */
  toggleSidebar: () => void;
  /** NAV-CHAT-EXIT：进入整屏聊天前所在的视图（退出时回到它；null = 无来源 → board） */
  chatOrigin: NavView | null;
  /** DEC-6 深链：待决策视图要选中的决策 id（切走即清空；不持久化） */
  decisionFocus: string | null;
  /** 切视图（六入口互斥）；非法值回落默认视图。切到 chat 记来源，切到其它视图清来源 */
  setView: (view: NavView) => void;
  /** DEC-6 深链：切到待决策视图并选中一条决策（通知点击 / 列表跳转） */
  focusDecision: (decisionId: string | null) => void;
  /** NAV-CHAT-EXIT：退出整屏聊天，回到来源视图（来源缺失/非法 → board） */
  exitChat: () => void;
  /** 打开滑出面板（与另一个面板互斥，不影响 view） */
  openDrawer: (drawer: NavDrawer) => void;
  closeDrawer: () => void;
  /** 再点同一入口收起；点另一个入口直接切换 */
  toggleDrawer: (drawer: NavDrawer) => void;
}

/** 退出聊天的合法来源：必须是 chat 之外的已知视图 */
function normalizeChatOrigin(value: unknown): NavView | null {
  return isNavView(value) && value !== 'chat' ? value : null;
}

/**
 * NAV-CHAT-EXIT：是否「退出聊天」的快捷键。
 * 绑定：`Esc` 与 `Ctrl/Cmd + [`（与浏览器「后退」同键位，符合整屏视图的直觉）；带 Alt 一律不算。
 */
export function isChatExitKey(event: { key: string; ctrlKey?: boolean; metaKey?: boolean; altKey?: boolean }): boolean {
  if (event.altKey === true) return false;
  if (event.key === 'Escape') return true;
  return event.key === '[' && (event.ctrlKey === true || event.metaKey === true);
}

export const useNavStore = create<NavState>()(
  persist(
    (set) => ({
      view: DEFAULT_NAV_VIEW,
      drawer: null,
      // SIDEBAR-2：创建时只读视口，不调用 set，避免无存储时把临时默认固化进 localStorage
      sidebarMode:
        typeof window === 'undefined' ? DEFAULT_SIDEBAR_MODE : computeInitialSidebarMode(window.innerWidth),
      sidebarModeExplicit: false,
      chatOrigin: null,
      decisionFocus: null,
      setSidebarMode: (mode) =>
        set({ sidebarMode: normalizeSidebarMode(mode), sidebarModeExplicit: true }),
      toggleSidebar: () =>
        set((state) => ({
          sidebarMode: state.sidebarMode === 'expanded' ? 'collapsed' : 'expanded',
          sidebarModeExplicit: true,
        })),
      setView: (view) =>
        set((state) => {
          const next = normalizeNavView(view);
          if (next === 'chat') {
            // 已在聊天里重复进入：保留最初的来源视图
            return {
              view: next,
              chatOrigin: state.view === 'chat' ? state.chatOrigin : state.view,
              decisionFocus: null,
            };
          }
          // 离开待决策视图时清空深链选中（保留焦点会让下次进入莫名高亮一条）
          return { view: next, chatOrigin: null, decisionFocus: next === 'decisions' ? state.decisionFocus : null };
        }),
      focusDecision: (decisionId) => set({ view: 'decisions', decisionFocus: decisionId }),
      exitChat: () => set((state) => ({ view: normalizeChatOrigin(state.chatOrigin) ?? DEFAULT_NAV_VIEW, chatOrigin: null })),
      openDrawer: (drawer) => set({ drawer }),
      closeDrawer: () => set({ drawer: null }),
      toggleDrawer: (drawer) => set((state) => ({ drawer: state.drawer === drawer ? null : drawer })),
    }),
    {
      name: NAV_STORAGE_KEY,
      version: 0,
      // drawer / chatOrigin / decisionFocus 都不持久化：刷新后不该自动弹出面板或高亮旧决策
      // SIDEBAR-2：只有用户显式切过形态才写 sidebarMode（视口默认不落盘）
      partialize: (state) => ({
        view: state.view,
        ...(state.sidebarModeExplicit ? { sidebarMode: state.sidebarMode } : {}),
      }),
      merge: (persisted, current) => {
        const saved = (persisted ?? {}) as { view?: unknown; sidebarMode?: unknown };
        // 旧数据没有 sidebarMode：保留按当前视口算出的默认，并视为「未显式设置」
        const hasSavedMode = saved.sidebarMode !== undefined;
        return {
          ...current,
          view: normalizeNavView(saved.view),
          sidebarMode: hasSavedMode ? normalizeSidebarMode(saved.sidebarMode) : current.sidebarMode,
          sidebarModeExplicit: hasSavedMode,
          // drawer 不持久化：恢复时一律收起（否则刷新会自动弹出面板）
          drawer: null,
          chatOrigin: null,
          decisionFocus: null,
        };
      },
    },
  ),
);

/** 非 React 场景（store 之间联动、事件回调）读取当前视图 */
export function currentNavView(): NavView {
  return useNavStore.getState().view;
}
