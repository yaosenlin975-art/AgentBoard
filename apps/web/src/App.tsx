import { useQuery } from '@tanstack/react-query';
import type { Workspace } from '@agentboard/shared';
import { api } from './api/client';
import { useWsEvents } from './api/useWsEvents';
import { useAppStore } from './state/appStore';
import { TopBar } from './components/topbar/TopBar';
import { WorkspaceList } from './components/workspace/WorkspaceList';
import { Board } from './components/board/Board';
import { RightPanel } from './components/right/RightPanel';

/** 三区布局：左栏 260px 工作空间 | 中央看板 | 右侧面板 */
export default function App() {
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
      <div className="flex min-h-0 flex-1">
        <aside className="w-[260px] shrink-0 overflow-y-auto border-r border-neutral-200 bg-white dark:border-neutral-800 dark:bg-neutral-900">
          <WorkspaceList />
        </aside>
        <main className="min-w-0 flex-1 overflow-auto">
          <Board />
        </main>
        <RightPanel />
      </div>
    </div>
  );
}
