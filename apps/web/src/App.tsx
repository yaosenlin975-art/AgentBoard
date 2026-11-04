import { useQuery } from '@tanstack/react-query';
import { KnowledgePanel } from './components/knowledge/KnowledgePanel';
import type { Workspace } from '@agentboard/shared';
import { api } from './api/client';
import { useWsEvents } from './api/useWsEvents';
import { useAppStore } from './state/appStore';
import { useNavStore, type NavView } from './state/navStore';
import { TopBar } from './components/topbar/TopBar';
import { SideBar } from './components/shell/SideBar';
import { Board } from './components/board/Board';
import { ChangelogPanel } from './components/changelog/ChangelogPanel';
import { ChatPanel } from './components/chat/ChatPanel';
import { RightPanel } from './components/right/RightPanel';
import { VoiceInputProvider } from './components/voice/useLongPressVoice';
import type { BoardLayout } from './components/ui/ViewSwitcher';
import { useRestartStore } from './state/restartStore';

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
  const { data: workspaces } = useQuery({
    queryKey: ['workspaces'],
    queryFn: () => api.get<Workspace[]>('/api/workspaces'),
  });
  const current = (workspaces ?? []).find((w) => w.id === workspaceId) ?? null;

  // 工具条（S2c 会移除）仍接收旧 props：值从 navStore 派生，保证两处入口同一份状态
  const layout: BoardLayout = view === 'tree' ? 'tree' : 'board';
  const knowledgeOpen = view === 'knowledge';
  const logOpen = view === 'log';
  const toggleView = (target: NavView): void => setView(view === target ? 'board' : target);

  return (
    <div className="flex h-screen overflow-hidden bg-surface-page text-ink">
      <VoiceInputProvider>
        <SideBar workspace={current} />
        <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
          <TopBar workspace={current} />
          <label className="flex items-center gap-2 border-b px-4 py-2 text-sm md:hidden">工作空间
            <select aria-label="工作空间" className="min-w-0 flex-1 rounded border bg-transparent p-1" value={workspaceId ?? ''} onChange={e => useAppStore.getState().selectWorkspace(e.target.value || null)}>
              <option value="">请选择工作空间</option>{workspaces?.map(w => <option key={w.id} value={w.id}>{w.name}</option>)}
            </select>
          </label>
          <div className="relative flex min-h-0 flex-1">
            <main data-testid="main-content" className="min-w-0 flex-1 overflow-auto">
              {view === 'log' ? (
                workspaceId === null ? (
                  <p data-testid="log-view-needs-workspace" className="p-6 text-sm text-ink-3">
                    请先选择工作空间，再查看日志
                  </p>
                ) : (
                  <ChangelogPanel
                    key={workspaceId}
                    workspaceId={workspaceId}
                    layout={layout}
                    onLayout={setView}
                    onToggleKnowledge={() => toggleView('knowledge')}
                    logOpen
                    onToggleLog={() => toggleView('log')}
                  />
                )
              ) : view === 'knowledge' ? (
                <KnowledgePanel
                  key={workspaceId ?? 'common'}
                  workspaceId={workspaceId}
                  layout={layout}
                  onLayout={setView}
                  onToggleKnowledge={() => toggleView('knowledge')}
                  logOpen={logOpen}
                  onToggleLog={() => toggleView('log')}
                />
              ) : view === 'chat' ? (
                <div data-testid="chat-view" className="h-full min-h-0">
                  <ChatPanel />
                </div>
              ) : (
                <Board
                  layout={layout}
                  onLayout={setView}
                  knowledgeOpen={knowledgeOpen}
                  onToggleKnowledge={() => toggleView('knowledge')}
                  logOpen={logOpen}
                  onToggleLog={() => toggleView('log')}
                />
              )}
            </main>
            <RightPanel />
            {restarting && (
              <div
                data-testid="restart-blocker"
                aria-hidden="true"
                className="absolute inset-0 z-40 cursor-wait bg-white/40 dark:bg-neutral-950/40"
              />
            )}
          </div>
        </div>
      </VoiceInputProvider>
    </div>
  );
}
