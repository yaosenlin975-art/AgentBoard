import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { KnowledgePanel } from './components/knowledge/KnowledgePanel';
import type { Workspace } from '@agentboard/shared';
import { api } from './api/client';
import { useWsEvents } from './api/useWsEvents';
import { useAppStore } from './state/appStore';
import { TopBar } from './components/topbar/TopBar';
import { Board } from './components/board/Board';
import { RightPanel } from './components/right/RightPanel';
import type { BoardLayout } from './components/ui/ViewSwitcher';

/**
 * 布局（PANEL-FLOAT）：TopBar + 主内容（看板 / 知识）。
 * 左右两栏改为 absolute 浮窗，不再是 flex 兄弟节点 → 开合前后主内容宽度不变。
 * 左浮窗（工作空间列表）由 TopBar「工作空间」按钮在按钮正下方展开；右浮窗（详情/聊天）贴右。
 */
export default function App() {
  const [knowledgeOpen, setKnowledgeOpen] = useState(false);
  const [layout, setLayout] = useState<BoardLayout>('board');
  useWsEvents();
  const workspaceId = useAppStore((s) => s.workspaceId);
  const { data: workspaces } = useQuery({
    queryKey: ['workspaces'],
    queryFn: () => api.get<Workspace[]>('/api/workspaces'),
  });
  const current = (workspaces ?? []).find((w) => w.id === workspaceId) ?? null;

  return (
    <div className="flex h-screen flex-col overflow-hidden bg-neutral-50 text-neutral-900 dark:bg-neutral-950 dark:text-neutral-100">
      <TopBar workspace={current} />
      <label className="flex items-center gap-2 border-b px-4 py-2 text-sm md:hidden">工作空间
        <select aria-label="工作空间" className="min-w-0 flex-1 rounded border bg-transparent p-1" value={workspaceId ?? ''} onChange={e => useAppStore.getState().selectWorkspace(e.target.value || null)}>
          <option value="">请选择工作空间</option>{workspaces?.map(w => <option key={w.id} value={w.id}>{w.name}</option>)}
        </select>
      </label>
      <div className="relative flex min-h-0 flex-1">
        <main data-testid="main-content" className="min-w-0 flex-1 overflow-auto">
          {knowledgeOpen ? (
            <KnowledgePanel
              key={workspaceId ?? 'common'}
              workspaceId={workspaceId}
              layout={layout}
              onLayout={setLayout}
              onToggleKnowledge={() => setKnowledgeOpen(false)}
            />
          ) : (
            <Board
              layout={layout}
              onLayout={setLayout}
              knowledgeOpen={false}
              onToggleKnowledge={() => setKnowledgeOpen(true)}
            />
          )}
        </main>
        <RightPanel />
      </div>
    </div>
  );
}


