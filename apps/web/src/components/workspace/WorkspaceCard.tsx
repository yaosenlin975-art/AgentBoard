import { useQuery } from '@tanstack/react-query';
import type { Issue, IssueStatus, Workspace } from '@agentboard/shared';
import { api } from '../../api/client';
import { useAppStore } from '../../state/appStore';

const STATUS_ORDER: IssueStatus[] = ['待规划', '进行中', '待验收', '已关闭'];

/** 单卡片：名称/路径/四列统计（统计经 GET /api/issues?workspace= 前端聚合） */
export function WorkspaceCard({ workspace }: { workspace: Workspace }) {
  const selected = useAppStore((s) => s.workspaceId === workspace.id);
  const selectWorkspace = useAppStore((s) => s.selectWorkspace);
  const { data: issues } = useQuery({
    queryKey: ['issues', workspace.id],
    queryFn: () => api.get<Issue[]>(`/api/issues?workspace=${encodeURIComponent(workspace.id)}`),
  });

  const counts = new Map<IssueStatus, number>(STATUS_ORDER.map((s) => [s, 0]));
  for (const issue of issues ?? []) {
    counts.set(issue.status, (counts.get(issue.status) ?? 0) + 1);
  }

  return (
    <div role="listitem">
      <button
        type="button"
        data-testid={`workspace-card-${workspace.id}`}
        aria-pressed={selected}
        onClick={() => selectWorkspace(workspace.id)}
        className={`mb-2 w-full rounded-md border p-3 text-left transition ${
          selected
            ? 'border-blue-500 bg-blue-50 dark:border-blue-500 dark:bg-blue-950/40'
            : 'border-neutral-200 hover:bg-neutral-50 dark:border-neutral-800 dark:hover:bg-neutral-900'
        }`}
      >
        <div className="truncate text-sm font-medium">{workspace.name}</div>
        <div
          className="truncate text-xs text-neutral-500 dark:text-neutral-400"
          title={workspace.path}
        >
          {workspace.path}
        </div>
        <div className="mt-2 grid grid-cols-4 gap-1 text-center text-[11px]">
          {STATUS_ORDER.map((status) => (
            <div
              key={status}
              data-testid={`stat-${status}`}
              className="rounded bg-neutral-100 py-1 dark:bg-neutral-800"
            >
              <div className="font-semibold">{counts.get(status) ?? 0}</div>
              <div className="text-neutral-500 dark:text-neutral-400">{status}</div>
            </div>
          ))}
        </div>
      </button>
    </div>
  );
}
