import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { KnowledgePanel } from './components/knowledge/KnowledgePanel';
import type { Workspace } from '@agentboard/shared';
import { api } from './api/client';
import { useWsEvents } from './api/useWsEvents';
import { useAppStore } from './state/appStore';
import { TopBar } from './components/topbar/TopBar';
import { Board } from './components/board/Board';
import { ChangelogPanel } from './components/changelog/ChangelogPanel';
import { RightPanel } from './components/right/RightPanel';
import type { BoardLayout } from './components/ui/ViewSwitcher';
import { useRestartStore } from './state/restartStore';

/**
 * 布局（PANEL-FLOAT / LOG-VIEW）：TopBar + 主内容（平铺看板 / 任务树 / 知识库 / 日志）。
 * 左右两栏改为 absolute 浮窗，不再是 flex 兄弟节点 → 开合前后主内容宽度不变。
 * 左浮窗（工作空间列表）由 TopBar「工作空间」按钮在按钮正下方展开；右浮窗（详情/聊天）贴右。
 * 日志（LOG-VIEW）与知识库同为主区域视图，三态互斥，入口在 ViewSwitcher（知识库右侧的「日志」）。
 */
export default function App() {
  const [knowledgeOpen, setKnowledgeOpen] = useState(false);
  const [logOpen, setLogOpen] = useState(false);
  const [layout, setLayout] = useState<BoardLayout>('board');
  // 重启期间用透明遮罩挡住整个应用，阻断所有写操作入口（SYSTEM-RESTART）
  const restarting = useRestartStore((s) => s.restarting);
  useWsEvents();
  const workspaceId = useAppStore((s) => s.workspaceId);
  const { data: workspaces } = useQuery({
    queryKey: ['workspaces'],
    queryFn: () => api.get<Workspace[]>('/api/workspaces'),
  });
  const current = (workspaces ?? []).find((w) => w.id === workspaceId) ?? null;

  // 四个视图互斥：任一视图激活时关掉另外两个
  const changeLayout = (next: BoardLayout): void => {
    setKnowledgeOpen(false);
    setLogOpen(false);
    setLayout(next);
  };
  const toggleKnowledge = (): void => {
    setLogOpen(false);
    setKnowledgeOpen((open) => !open);
  };
  const toggleLog = (): void => {
    setKnowledgeOpen(false);
    setLogOpen((open) => !open);
  };

  return (
    <div className="flex h-screen flex-col overflow-hidden bg-surface-page text-ink">
      <TopBar workspace={current} />
      <label className="flex items-center gap-2 border-b px-4 py-2 text-sm md:hidden">工作空间
        <select aria-label="工作空间" className="min-w-0 flex-1 rounded border bg-transparent p-1" value={workspaceId ?? ''} onChange={e => useAppStore.getState().selectWorkspace(e.target.value || null)}>
          <option value="">请选择工作空间</option>{workspaces?.map(w => <option key={w.id} value={w.id}>{w.name}</option>)}
        </select>
      </label>
      <div className="relative flex min-h-0 flex-1">
        <main data-testid="main-content" className="min-w-0 flex-1 overflow-auto">
          {logOpen ? (
            workspaceId === null ? (
              <p data-testid="log-view-needs-workspace" className="p-6 text-sm text-neutral-500 dark:text-neutral-400">
                请先选择工作空间，再查看日志
              </p>
            ) : (
              <ChangelogPanel
                key={workspaceId}
                workspaceId={workspaceId}
                layout={layout}
                onLayout={changeLayout}
                onToggleKnowledge={toggleKnowledge}
                logOpen
                onToggleLog={toggleLog}
              />
            )
          ) : knowledgeOpen ? (
            <KnowledgePanel
              key={workspaceId ?? 'common'}
              workspaceId={workspaceId}
              layout={layout}
              onLayout={changeLayout}
              onToggleKnowledge={toggleKnowledge}
              logOpen={false}
              onToggleLog={toggleLog}
            />
          ) : (
            <Board
              layout={layout}
              onLayout={changeLayout}
              knowledgeOpen={false}
              onToggleKnowledge={toggleKnowledge}
              logOpen={false}
              onToggleLog={toggleLog}
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
  );
}
