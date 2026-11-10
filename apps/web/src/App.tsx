import { lazy, Suspense, useEffect, useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { parseKnowledgeDeepLink } from './lib/knowledgeDeepLink';
import type { Workspace } from '@agentboard/shared';
import { api } from './api/client';
import { useWsEvents } from './api/useWsEvents';
import { useAppStore } from './state/appStore';
import { useNavStore, type NavView } from './state/navStore';
import { isChatExitKey } from './state/navStore';
import { SideBar } from './components/shell/SideBar';
import { WindowTitleBar } from './components/shell/WindowTitleBar';
import { Board } from './components/board/Board';
import { DecisionNotifier } from './components/decisions/DecisionNotifier';
import { VoiceInputProvider } from './components/voice/useLongPressVoice';
import { useRestartStore } from './state/restartStore';

// WEB-BUNDLE（3451075e）：重视图改成动态导入，避免它们进首屏 modulepreload。
// 只改加载时机，不改加载图：这些模块原本就只由主区/抽屉/右栏渲染，切换视图时才拉取。
const KnowledgePanel = lazy(() =>
  import('./components/knowledge/KnowledgePanel').then((m) => ({ default: m.KnowledgePanel })),
);
const ChatView = lazy(() => import('./components/chat/ChatView').then((m) => ({ default: m.ChatView })));
const DrawerPanel = lazy(() => import('./components/drawer/DrawerPanel').then((m) => ({ default: m.DrawerPanel })));
const RightPanel = lazy(() => import('./components/right/RightPanel').then((m) => ({ default: m.RightPanel })));
const DecisionsView = lazy(() =>
  import('./components/decisions/DecisionsView').then((m) => ({ default: m.DecisionsView })),
);
const ChangelogPanel = lazy(() =>
  import('./components/changelog/ChangelogPanel').then((m) => ({ default: m.ChangelogPanel })),
);

/** 动态视图加载中的占位（每次切换视图时出现一次） */
const viewLoading = (
  <p data-testid="view-loading" className="p-6 text-sm text-ink-3">
    加载中…
  </p>
);

/**
 * 布局（导航重构 S2a）：左栏 SideBar + 主内容。
 *
 * 视图状态权威是 `useNavStore.view`（S1）——本组件不再有 `layout/knowledgeOpen/logOpen` 三态，
 * 左栏入口与工具条里的 ViewSwitcher 都写同一份 store，避免双层导航各持一份状态。
 * 顶栏（TopBar）与 drawer 的移除/接入归 S2c；聊天从浮窗迁到主区整屏归 S2b（本卡先渲染在主区）。
 * 左右两栏（工作区列表、任务详情/引用）仍是 absolute 浮窗，开合不改变主内容宽度。
 */
export default function App() {
  // 重启期间用透明遮罩挡住整个应用，阻断所有写操作入口（SYSTEM-RESTART）
  const restarting = useRestartStore((s) => s.restarting);
  useWsEvents();
  const workspaceId = useAppStore((s) => s.workspaceId);
  const view = useNavStore((s) => s.view);
  const setView = useNavStore((s) => s.setView);
  const chatOrigin = useNavStore((s) => s.chatOrigin);
  const exitChat = useNavStore((s) => s.exitChat);
  // BORROW-3.2：知识深链（/k/:id/:slug 与 ?kb=<id>）——挂载时读一次 URL，切知识视图并传面板定位；
  // 刷新后 URL 不清除（?kb= 保留语义），每次挂载重新解析
  const deepLink = useMemo(() => parseKnowledgeDeepLink(window.location.href), []);
  useEffect(() => {
    if (deepLink) setView('knowledge');
  }, [deepLink, setView]);
  const CHAT_EXIT_LABEL: Record<NavView, string> = {
    board: '看板',
    decisions: '待决策',
    tree: '任务树',
    knowledge: '知识库',
    log: '日志',
    chat: '聊天',
  };

  // NAV-CHAT-EXIT：整屏聊天下 Esc / Ctrl(Cmd)+[ 退出回来源视图；有弹窗时让弹窗先处理
  // S4：drawer 打开时 Esc 先关抽屉（挤压态 drawer 是 role="region" 不是 dialog，必须显式避让）
  useEffect(() => {
    if (view !== 'chat') return undefined;
    const onKey = (event: KeyboardEvent): void => {
      if (!isChatExitKey(event)) return;
      if (useNavStore.getState().drawer !== null) return;
      if (document.querySelector('[role="dialog"]') !== null) return;
      event.preventDefault();
      exitChat();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [view, exitChat]);
  const { data: workspaces } = useQuery({
    queryKey: ['workspaces'],
    queryFn: () => api.get<Workspace[]>('/api/workspaces'),
  });
  const current = (workspaces ?? []).find((w) => w.id === workspaceId) ?? null;


  return (
    <div className="flex h-screen flex-col overflow-hidden bg-surface-page text-ink">
      {/* WINTITLE-01：桌面壳无边框窗口的自绘标题栏；浏览器里返回 null，不占布局 */}
      <WindowTitleBar />
      <VoiceInputProvider>
        <div className="flex min-h-0 min-w-0 flex-1 overflow-hidden">
          <SideBar workspace={current} />
          <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
            {/* NAV-TOPBAR-01：顶栏已移除；FIX-1：窄屏也不再保留工作空间 select（由左栏承担） */}
            {/* DEC-7：待决策汇总条 + 常驻 toast（通知失败时的可靠通道），无待决策时零占位 */}
            <DecisionNotifier />
            <div className="relative flex min-h-0 flex-1">
              <main data-testid="main-content" className="min-w-0 flex-1 overflow-auto">
                {view === 'decisions' ? (
                  <Suspense fallback={viewLoading}>
                    <DecisionsView />
                  </Suspense>
                ) : view === 'log' ? (
                  workspaceId === null ? (
                    <p data-testid="log-view-needs-workspace" className="p-6 text-sm text-ink-3">
                      请先选择工作空间，再查看日志
                    </p>
                  ) : (
                    <Suspense fallback={viewLoading}>
                      <ChangelogPanel
                        key={workspaceId}
                        workspaceId={workspaceId}
                      />
                    </Suspense>
                  )
                ) : view === 'knowledge' ? (
                  <Suspense fallback={viewLoading}>
                    <KnowledgePanel
                      key={workspaceId ?? 'common'}
                      workspaceId={workspaceId}
                      workspaceName={current?.name ?? null}
                      deepLinkPageId={deepLink?.pageId ?? null}
                    />
                  </Suspense>
                ) : view === 'chat' ? (
                  // FIX-2：聊天是普通第五视图——不再有可视退出栏；离开走左栏其它入口，
                  // 快捷键 Esc / Ctrl(Cmd)+[ 仍保留（lead 裁定：只删可视出口，保留键盘出口）。
                  // Suspense 放在外层容器内：`chat-view` 容器保持同步渲染（视图骨架不闪）。
                  <div data-testid="chat-view" className="flex h-full min-h-0 flex-col">
                    <div className="min-h-0 flex-1">
                      <Suspense fallback={viewLoading}>
                        <ChatView />
                      </Suspense>
                    </div>
                  </div>
                ) : (
                  <Board />
                )}
              </main>
              {/* S2c：右侧滑出面板（账号/设置）——宽屏挤压主区，窄屏覆盖并锁 body 滚动 */}
              <Suspense fallback={null}>
                <DrawerPanel />
                <RightPanel />
              </Suspense>
              {restarting && (
                <div
                  data-testid="restart-blocker"
                  aria-hidden="true"
                  className="absolute inset-0 z-40 cursor-wait bg-white/40 dark:bg-neutral-950/40"
                />
              )}
            </div>
          </div>
        </div>
      </VoiceInputProvider>
    </div>
  );
}
