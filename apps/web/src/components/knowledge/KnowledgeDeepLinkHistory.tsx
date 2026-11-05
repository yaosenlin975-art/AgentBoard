import { useQuery } from '@tanstack/react-query';
import { api } from '../../api/client';
import { EmptyState } from '../ui/EmptyState';
import { Skeleton } from '../ui/Skeleton';

/**
 * BORROW-3.3（D8）：已删除页（深链/resolve 410）的历史版本列表。
 * 深链场景 scope 未知：common 优先，为空且已选工作区时再试当前项目；
 * 403（无权访问的 workspace 页）直接把错误抛给错误条呈现。
 */
export function KnowledgeDeepLinkHistory({
  pageId,
  workspaceId,
  onBack,
}: {
  pageId: string;
  workspaceId: string | null;
  onBack: () => void;
}) {
  const history = useQuery({
    queryKey: ['knowledge-deeplink-history', pageId, workspaceId],
    queryFn: async () => {
      const attempts: Array<{ scope: 'common' } | { scope: 'workspace'; workspace_id: string }> = workspaceId !== null
        ? [{ scope: 'common' }, { scope: 'workspace', workspace_id: workspaceId }]
        : [{ scope: 'common' }];
      let lastError: unknown = null;
      for (const attempt of attempts) {
        const params = new URLSearchParams({ scope: attempt.scope });
        if (attempt.scope === 'workspace') params.set('workspace_id', attempt.workspace_id);
        try {
          const res = await api.get<{ items: Array<{ revision: number; title_snapshot: string | null; change_kind: string; actor: string | null; created_at: number }> }>(`/api/knowledge/pages/${pageId}/revisions?${params}`);
          if (res.items.length > 0) return res.items;
        } catch (error) {
          lastError = error;
        }
      }
      if (lastError !== null) throw lastError;
      return [];
    },
  });

  return <div data-testid="knowledge-deeplink-history" className="flex min-h-0 flex-1 flex-col">
    <div className="flex shrink-0 items-center gap-2 py-2">
      <button type="button" data-testid="knowledge-deeplink-history-back" className="rounded px-2 py-0.5 text-xs text-accent transition-colors hover:bg-accent-soft" onClick={onBack}>
        ← 返回
      </button>
      <span className="text-xs text-ink-2">已删除页的历史版本（id：{pageId.slice(0, 8)}）</span>
    </div>
    {history.isPending && <Skeleton testId="knowledge-history-skeleton" rows={3} />}
    {history.isError && <p role="alert" className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700 dark:border-red-900 dark:bg-red-950/40 dark:text-red-300">{history.error instanceof Error ? history.error.message : '历史读取失败'}</p>}
    {!history.isPending && !history.isError && (history.data ?? []).length === 0 && (
      <EmptyState testId="knowledge-deeplink-history-empty" title="没有历史版本" hint="该页在删除前没有可追溯的修订记录" />
    )}
    {history.data !== undefined && history.data.length > 0 && (
      <ul className="divide-y divide-hairline overflow-hidden rounded-2xl border border-hairline bg-surface-card">
        {history.data.map(rev => (
          <li key={rev.revision} className="px-3 py-2.5">
            <span className="block truncate text-sm font-medium text-ink">{rev.title_snapshot ?? '（无标题快照）'}</span>
            <span className="mt-1.5 flex flex-wrap items-center gap-1.5 text-xs text-ink-3">
              <span className="tabular-nums">v{rev.revision}</span>
              <span aria-hidden>·</span>
              <span>{rev.change_kind}</span>
              {rev.actor !== null && <><span aria-hidden>·</span><span>{rev.actor}</span></>}
              <span aria-hidden>·</span>
              <span className="tabular-nums">{new Date(rev.created_at).toLocaleString()}</span>
            </span>
          </li>
        ))}
      </ul>
    )}
  </div>;
}
