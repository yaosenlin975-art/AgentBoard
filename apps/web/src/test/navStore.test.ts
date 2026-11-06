/**
 * S1 状态模型：五视图 + 右滑出面板的互斥/正交/持久化/兜底，以及 openChat 跨 store 联动。
 * 矩阵见卡评论；每个编号对应用例名里的 [n]。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_NAV_VIEW,
  DEFAULT_SIDEBAR_MODE,
  NAV_STORAGE_KEY,
  NAV_VIEWS,
  SIDEBAR_MODES,
  computeInitialSidebarMode,
  currentNavView,
  isNavDrawer,
  isNavView,
  isSidebarMode,
  normalizeNavView,
  normalizeSidebarMode,
  useNavStore,
} from '../state/navStore';
import { usePanelStore } from '../state/panelStore';

function resetNav(): void {
  useNavStore.setState({
    view: DEFAULT_NAV_VIEW,
    drawer: null,
    sidebarMode: DEFAULT_SIDEBAR_MODE,
    sidebarModeExplicit: false,
    chatOrigin: null,
    decisionFocus: null,
  });
}

function persistedState(): Record<string, unknown> {
  const raw = localStorage.getItem(NAV_STORAGE_KEY);
  return raw ? ((JSON.parse(raw) as { state?: Record<string, unknown> }).state ?? {}) : {};
}

beforeEach(() => {
  localStorage.clear();
  resetNav();
  usePanelStore.setState({
    view: null,
    issueId: null,
    sessionId: null,
    chatSession: null,
    unread: {},
    refPanel: null,
    chatDrafts: {},
    rightOpen: false,
  });
});

describe('视图枚举与守卫', () => {
  it('[0] 六视图枚举固定，默认 board', () => {
    expect(NAV_VIEWS).toEqual(['board', 'decisions', 'tree', 'knowledge', 'log', 'chat']);
    expect(useNavStore.getState().view).toBe('board');
    expect(DEFAULT_NAV_VIEW).toBe('board');
  });

  it('[0b] isNavView / isNavDrawer / normalizeNavView 的边界', () => {
    expect(isNavView('chat')).toBe(true);
    expect(isNavView('detail')).toBe(false); // RightPanel 的浮窗视图不属于导航视图
    expect(isNavView(undefined)).toBe(false);
    expect(isNavDrawer('accounts')).toBe(true);
    expect(isNavDrawer('settings')).toBe(true);
    expect(isNavDrawer('board')).toBe(false);
    expect(normalizeNavView('log')).toBe('log');
    expect(normalizeNavView('nope')).toBe('board');
    expect(normalizeNavView(null)).toBe('board');
  });
});

describe('侧栏两形态（SIDEBAR-1）', () => {
  it('[S1] 默认展开；枚举与归一守卫', () => {
    expect(SIDEBAR_MODES).toEqual(['expanded', 'collapsed']);
    expect(DEFAULT_SIDEBAR_MODE).toBe('expanded');
    expect(useNavStore.getState().sidebarMode).toBe('expanded');
    expect(isSidebarMode('collapsed')).toBe(true);
    expect(isSidebarMode('rail')).toBe(false);
    expect(isSidebarMode(undefined)).toBe(false);
    expect(normalizeSidebarMode('collapsed')).toBe('collapsed');
    expect(normalizeSidebarMode('weird')).toBe('expanded');
    expect(normalizeSidebarMode(null)).toBe('expanded');
  });

  it('[S2] toggleSidebar 双向切换；setSidebarMode 非法值回落展开', () => {
    useNavStore.getState().toggleSidebar();
    expect(useNavStore.getState().sidebarMode).toBe('collapsed');
    useNavStore.getState().toggleSidebar();
    expect(useNavStore.getState().sidebarMode).toBe('expanded');

    useNavStore.getState().setSidebarMode('collapsed');
    expect(useNavStore.getState().sidebarMode).toBe('collapsed');
    useNavStore.getState().setSidebarMode('weird' as never);
    expect(useNavStore.getState().sidebarMode).toBe('expanded');
  });

  it('[S3] 未显式切换形态时，任何写入都不落 sidebarMode', () => {
    useNavStore.getState().setView('tree');
    expect(persistedState().view).toBe('tree');
    expect(persistedState()).not.toHaveProperty('sidebarMode');
  });

  it('[S4] 显式切换后写盘，rehydrate 恢复形态', async () => {
    useNavStore.getState().toggleSidebar();
    expect(useNavStore.getState().sidebarMode).toBe('collapsed');
    expect(persistedState().sidebarMode).toBe('collapsed');

    await useNavStore.persist.rehydrate();
    expect(useNavStore.getState().sidebarMode).toBe('collapsed');
    expect(useNavStore.getState().sidebarModeExplicit).toBe(true);
  });

  it('[S5] 持久化里的非法形态回落展开', async () => {
    localStorage.setItem(NAV_STORAGE_KEY, JSON.stringify({ state: { sidebarMode: 'rail' }, version: 0 }));
    await useNavStore.persist.rehydrate();
    expect(useNavStore.getState().sidebarMode).toBe('expanded');
  });

  it('[S6] 旧数据没有 sidebarMode 时保留当前视口默认，且不标记显式', async () => {
    useNavStore.setState({ sidebarMode: 'collapsed', sidebarModeExplicit: false });
    localStorage.setItem(NAV_STORAGE_KEY, JSON.stringify({ state: { view: 'log' }, version: 0 }));
    await useNavStore.persist.rehydrate();
    expect(useNavStore.getState().view).toBe('log');
    expect(useNavStore.getState().sidebarMode).toBe('collapsed');
    expect(useNavStore.getState().sidebarModeExplicit).toBe(false);
  });

  it('[S7] 首次默认按 920 断点：≥920 展开，<920 收起', () => {
    expect(computeInitialSidebarMode(1280)).toBe('expanded');
    expect(computeInitialSidebarMode(920)).toBe('expanded');
    expect(computeInitialSidebarMode(919)).toBe('collapsed');
  });
});

describe('侧栏形态首次进入（SIDEBAR-2）', () => {
  it('[S8] 清空存储 + 视口 <920：首次进入为收起且不产生 sidebarMode', async () => {
    const original = window.innerWidth;
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 800 });
    vi.resetModules();
    try {
      const mod = await import('../state/navStore');
      expect(mod.useNavStore.getState().sidebarMode).toBe('collapsed');
      const raw = localStorage.getItem(NAV_STORAGE_KEY);
      const state = raw ? ((JSON.parse(raw) as { state?: Record<string, unknown> }).state ?? {}) : {};
      expect(state).not.toHaveProperty('sidebarMode');
    } finally {
      Object.defineProperty(window, 'innerWidth', { configurable: true, value: original });
      vi.resetModules();
    }
  });
});

describe('视图互斥切换（单值即互斥）', () => {
  it('[1-4] 从 board 切到四个其它视图', () => {
    for (const view of ['tree', 'knowledge', 'log', 'chat'] as const) {
      useNavStore.getState().setView(view);
      expect(useNavStore.getState().view).toBe(view);
      expect(currentNavView()).toBe(view);
    }
  });

  it('[5] 从非默认视图切回 board', () => {
    useNavStore.getState().setView('log');
    useNavStore.getState().setView('board');
    expect(useNavStore.getState().view).toBe('board');
  });

  it('[6] 非法视图值回落 board（不写入脏值）', () => {
    useNavStore.getState().setView('chat');
    // 运行时可能有旧值/外部写入，强制喂一个非法值
    useNavStore.getState().setView('detail' as never);
    expect(useNavStore.getState().view).toBe('board');
  });

  it('[6b] DEC-6 深链：focusDecision 切到待决策并选中；切走即清空', () => {
    useNavStore.getState().setView('log');
    useNavStore.getState().focusDecision('dec-1');
    expect(useNavStore.getState()).toMatchObject({ view: 'decisions', decisionFocus: 'dec-1' });

    // 留在待决策视图内重复设置不会丢焦点
    useNavStore.getState().setView('decisions');
    expect(useNavStore.getState().decisionFocus).toBe('dec-1');

    // 切走清空，避免下次进入莫名高亮
    useNavStore.getState().setView('board');
    expect(useNavStore.getState().decisionFocus).toBeNull();
  });
});

describe('右滑出面板：互斥、收起、与视图正交', () => {
  it('[7] 打开账号面板', () => {
    useNavStore.getState().openDrawer('accounts');
    expect(useNavStore.getState().drawer).toBe('accounts');
  });

  it('[8] 打开设置面板会替换账号面板（两者互斥）', () => {
    useNavStore.getState().openDrawer('accounts');
    useNavStore.getState().openDrawer('settings');
    expect(useNavStore.getState().drawer).toBe('settings');
  });

  it('[9] 再点同一入口收起', () => {
    useNavStore.getState().openDrawer('accounts');
    useNavStore.getState().toggleDrawer('accounts');
    expect(useNavStore.getState().drawer).toBeNull();
  });

  it('[10] 点另一个入口直接切换', () => {
    useNavStore.getState().openDrawer('accounts');
    useNavStore.getState().toggleDrawer('settings');
    expect(useNavStore.getState().drawer).toBe('settings');
  });

  it('[11] closeDrawer 收起任意面板', () => {
    useNavStore.getState().openDrawer('settings');
    useNavStore.getState().closeDrawer();
    expect(useNavStore.getState().drawer).toBeNull();
  });

  it('[12] 面板与视图正交：切视图不收起面板、开面板不改视图', () => {
    useNavStore.getState().setView('tree');
    useNavStore.getState().openDrawer('settings');
    expect(useNavStore.getState()).toMatchObject({ view: 'tree', drawer: 'settings' });

    useNavStore.getState().setView('log');
    expect(useNavStore.getState()).toMatchObject({ view: 'log', drawer: 'settings' });

    useNavStore.getState().closeDrawer();
    expect(useNavStore.getState()).toMatchObject({ view: 'log', drawer: null });
  });
});

describe('持久化与兜底', () => {
  it('[13] 恢复持久化的视图（刷新回到同一视图）', async () => {
    localStorage.setItem(NAV_STORAGE_KEY, JSON.stringify({ state: { view: 'knowledge' }, version: 0 }));
    await useNavStore.persist.rehydrate();
    expect(useNavStore.getState().view).toBe('knowledge');
  });

  it('[14] 持久化里的非法视图回落 board', async () => {
    localStorage.setItem(NAV_STORAGE_KEY, JSON.stringify({ state: { view: 'chat-fullscreen' }, version: 0 }));
    await useNavStore.persist.rehydrate();
    expect(useNavStore.getState().view).toBe('board');
  });

  it('[14b] 持久化缺失 state 也不崩，回落 board', async () => {
    localStorage.setItem(NAV_STORAGE_KEY, JSON.stringify({ version: 0 }));
    await useNavStore.persist.rehydrate();
    expect(useNavStore.getState().view).toBe('board');
  });

  it('[15] drawer 不持久化（刷新后不自动弹面板）', async () => {
    useNavStore.getState().setView('tree');
    useNavStore.getState().openDrawer('accounts');
    const persisted = JSON.parse(localStorage.getItem(NAV_STORAGE_KEY) ?? '{}') as { state?: Record<string, unknown> };
    expect(persisted.state?.view).toBe('tree');
    expect(persisted.state).not.toHaveProperty('drawer');

    await useNavStore.persist.rehydrate();
    expect(useNavStore.getState()).toMatchObject({ view: 'tree', drawer: null });
  });
});

describe('openChat 跨 store 联动（设计稿 §4 跳转联动）', () => {
  it('[16] openChat：切 navStore 到 chat + 选中会话 + 关闭详情浮窗（S2b 整屏化）', () => {
    useNavStore.getState().setView('board');
    usePanelStore.getState().openDetail('issue-1');
    expect(usePanelStore.getState().view).toBe('detail');

    usePanelStore.getState().openChat('sess-1');

    expect(useNavStore.getState().view).toBe('chat');
    // NAV-CHAT-EXIT：记住来源视图，退出聊天回看板
    expect(useNavStore.getState().chatOrigin).toBe('board');
    expect(usePanelStore.getState()).toMatchObject({
      // S2b：聊天整屏化 —— 面板视图清空收起，detail/ref 浮窗计数 0
      view: null,
      sessionId: 'sess-1',
      issueId: null,
      refPanel: null,
      rightOpen: false,
    });
  });

  it('[16b] 从引用浮窗跳聊天同样关闭浮窗', () => {
    useNavStore.getState().setView('knowledge');
    usePanelStore.getState().openRef({ kind: 'knowledge', id: 'kp-1', title: 'BOM 守卫' });

    usePanelStore.getState().openChat('sess-2');

    expect(useNavStore.getState().view).toBe('chat');
    expect(usePanelStore.getState().refPanel).toBeNull();
    expect(usePanelStore.getState().view).toBeNull();
    expect(usePanelStore.getState().rightOpen).toBe(false);
    // 来源是知识库：退出聊天应回知识库
    useNavStore.getState().exitChat();
    expect(useNavStore.getState().view).toBe('knowledge');
  });

  it('[17] openDetail 不改导航视图（详情仍是浮窗）', () => {
    useNavStore.getState().setView('tree');
    usePanelStore.getState().openDetail('issue-2');
    expect(useNavStore.getState().view).toBe('tree');
    expect(usePanelStore.getState().view).toBe('detail');
  });

  it('[18] openRef 不改导航视图', () => {
    useNavStore.getState().setView('log');
    usePanelStore.getState().openRef({ kind: 'log', id: 'log-1', title: '日志' });
    expect(useNavStore.getState().view).toBe('log');
  });

  it('[19] 关闭浮窗不动导航视图', () => {
    useNavStore.getState().setView('knowledge');
    usePanelStore.getState().openDetail('issue-3');
    usePanelStore.getState().clearView();
    expect(useNavStore.getState().view).toBe('knowledge');
    expect(usePanelStore.getState().view).toBeNull();
  });
});
