/**
 * 任务详情「依赖」区（设计 §11）：列出前置任务与被阻塞者（标题 + 状态 + 解除标记），
 * 支持在当前工作区内搜索添加前置、移除前置。解除判定只用服务端 `resolved`，不本地推断。
 * 已占用卡新增前置由服务端 409 `ISSUE_CLAIMED` 兜底，这里原样展示其中文原因。
 */
import { useState, type ReactNode } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { Issue } from '@agentboard/shared';
import { ApiError, api } from '../../api/client';
import type { DependencyRef, DependencyView } from '../../lib/dependency';
import { EmptyState } from '../ui/EmptyState';

const inputCls =
  'w-full rounded border border-neutral-300 px-2 py-1.5 text-sm outline-none focus:border-accent dark:border-neutral-700 dark:bg-neutral-800';

const MAX_VISIBLE_CANDIDATES = 30;

function errorText(error: unknown, fallback: string): string {
  if (error instanceof ApiError && error.code === 'ISSUE_CLAIMED') return `无法添加前置：${error.message}`;
  return `${fallback}：${error instanceof Error ? error.message : '未知错误'}`;
}

function DependencyRow({
  item,
  testId,
  action,
}: {
  item: DependencyRef;
  testId: string;
  action?: ReactNode;
}) {
  return (
    <li
      data-testid={testId}
      className="flex flex-wrap items-center gap-2 rounded border border-neutral-200 px-2 py-1 text-xs dark:border-neutral-800"
    >
      <span className="min-w-0 flex-1 truncate" title={item.title}>{item.title}</span>
      <span className="text-neutral-500 dark:text-neutral-400">{item.status}</span>
      <span
        data-testid={`${testId}-resolved`}
        className={item.resolved
          ? 'text-green-700 dark:text-green-400'
          : 'text-amber-700 dark:text-amber-300'}
      >
        {item.resolved ? '已解除' : '未解除'}
      </span>
      {action}
    </li>
  );
}

export function DependencySection({ issue }: { issue: Issue }) {
  const queryClient = useQueryClient();
  const [search, setSearch] = useState('');
  const [picked, setPicked] = useState('');
  const [error, setError] = useState<string | null>(null);

  const { data: dependencies, error: loadError } = useQuery({
    queryKey: ['dependencies', issue.id],
    queryFn: () =>
      api.get<DependencyView>(
        `/api/issues/${issue.id}/dependencies?workspace_id=${encodeURIComponent(issue.workspace_id)}`,
      ),
  });
  const { data: workspaceIssues } = useQuery({
    queryKey: ['issues', issue.workspace_id],
    queryFn: () => api.get<Issue[]>(`/api/issues?workspace=${encodeURIComponent(issue.workspace_id)}`),
  });

  const blockers = dependencies?.blockers ?? [];
  const blocked = dependencies?.blocked ?? [];
  const keyword = search.trim();
  const existingBlockerIds = new Set(blockers.map((item) => item.issue_id));
  const candidates = (workspaceIssues ?? [])
    .filter((item) => item.id !== issue.id && !existingBlockerIds.has(item.id))
    .filter((item) => keyword === '' || item.title.includes(keyword))
    .slice(0, MAX_VISIBLE_CANDIDATES);
  // 选择值随筛选派生：过滤后失配时回落到首个候选，不留陈旧选择
  const selectedId = candidates.some((item) => item.id === picked) ? picked : (candidates[0]?.id ?? '');

  const refresh = async (): Promise<void> => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ['dependencies', issue.id] }),
      queryClient.invalidateQueries({ queryKey: ['issues', issue.workspace_id] }),
      queryClient.invalidateQueries({ queryKey: ['issue', issue.id] }),
    ]);
  };

  const addBlockers = useMutation({
    mutationFn: (blockerId: string) =>
      api.post<DependencyView>(`/api/issues/${issue.id}/dependencies`, {
        workspace_id: issue.workspace_id,
        blocker_issue_id: blockerId,
      }),
    onSuccess: () => {
      setError(null);
      setSearch('');
      setPicked('');
      void refresh();
    },
    onError: (e) => setError(errorText(e, '添加前置失败')),
  });

  const removeBlocker = useMutation({
    mutationFn: (blockerId: string) =>
      api.del<void>(
        `/api/issues/${issue.id}/dependencies/${blockerId}?workspace_id=${encodeURIComponent(issue.workspace_id)}`,
      ),
    onSuccess: () => {
      setError(null);
      void refresh();
    },
    onError: (e) => setError(errorText(e, '移除前置失败')),
  });

  return (
    <section data-testid="detail-dependencies" aria-label="依赖" className="space-y-2">
      <h3 className="text-sm font-semibold">依赖</h3>
      {loadError !== null && (
        <p role="alert" className="text-xs text-red-600 dark:text-red-400">
          加载依赖失败：{loadError instanceof Error ? loadError.message : '未知错误'}
        </p>
      )}

      <div className="space-y-1 text-sm">
        <p className="text-xs text-neutral-600 dark:text-neutral-300">前置任务（未解除前不可领取）</p>
        <ul data-testid="dep-blockers" className="space-y-1">
          {blockers.map((item) => (
            <DependencyRow
              key={item.issue_id}
              item={item}
              testId={`dep-blocker-${item.issue_id}`}
              action={(
                <button
                  type="button"
                  data-testid={`dep-remove-${item.issue_id}`}
                  aria-label={`移除前置 ${item.title}`}
                  disabled={removeBlocker.isPending}
                  onClick={() => removeBlocker.mutate(item.issue_id)}
                  className="rounded border border-neutral-300 px-1.5 py-0.5 text-neutral-600 hover:bg-neutral-100 disabled:opacity-40 dark:border-neutral-700 dark:text-neutral-300 dark:hover:bg-neutral-800"
                >
                  移除
                </button>
              )}
            />
          ))}
        </ul>
        {dependencies !== undefined && blockers.length === 0 && (
          <EmptyState testId="dep-blockers-empty" compact title="无前置任务" hint="在下方「添加前置」里选择阻塞本卡的任务" />
        )}
      </div>

      <div className="space-y-1 text-sm">
        <p className="text-xs text-neutral-600 dark:text-neutral-300">被阻塞的任务</p>
        <ul data-testid="dep-blocked" className="space-y-1">
          {blocked.map((item) => (
            <DependencyRow key={item.issue_id} item={item} testId={`dep-blocked-${item.issue_id}`} />
          ))}
        </ul>
        {dependencies !== undefined && blocked.length === 0 && (
          <EmptyState testId="dep-blocked-empty" compact title="没有阻塞其他任务" hint="其他任务把本卡设为前置后会出现在这里" />
        )}
      </div>

      {(['related', 'duplicate'] as const).map((group) => {
        const items = dependencies?.[group] ?? [];
        const label = group === 'related' ? '关联任务（related，不阻塞领取）' : '重复任务（duplicate，不阻塞领取）';
        const emptyHint = group === 'related' ? '把任务标为关联后会出现在这里' : '把任务标为重复后会出现在这里';
        return (
          <div key={group} className="space-y-1 text-sm" data-testid={`dep-${group}-group`}>
            <p className="text-xs text-neutral-600 dark:text-neutral-300">{label}</p>
            <ul data-testid={`dep-${group}`} className="space-y-1">
              {items.map((item) => (
                <DependencyRow
                  key={item.issue_id}
                  item={item}
                  testId={`dep-${group}-${item.issue_id}`}
                  action={(
                    <button
                      type="button"
                      data-testid={`dep-remove-${group}-${item.issue_id}`}
                      aria-label={`移除${group === 'related' ? '关联' : '重复'} ${item.title}`}
                      disabled={removeBlocker.isPending}
                      onClick={() => removeBlocker.mutate(item.issue_id)}
                      className="rounded border border-neutral-300 px-1.5 py-0.5 text-neutral-600 hover:bg-neutral-100 disabled:opacity-40 dark:border-neutral-700 dark:text-neutral-300 dark:hover:bg-neutral-800"
                    >
                      移除
                    </button>
                  )}
                />
              ))}
            </ul>
            {dependencies !== undefined && items.length === 0 && (
              <p data-testid={`dep-${group}-empty`} className="text-xs text-ink-3">{emptyHint}</p>
            )}
          </div>
        );
      })}

      <div className="space-y-1 rounded border border-dashed border-neutral-300 p-2 dark:border-neutral-700">
        <label className="block text-xs text-neutral-600 dark:text-neutral-300">
          <span className="mb-1 block">添加前置（当前工作区内搜索）</span>
          <input
            data-testid="dep-search"
            aria-label="搜索前置任务"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="按标题筛选"
            className={inputCls}
          />
        </label>
        <div className="flex flex-wrap items-center gap-2">
          <select
            data-testid="dep-candidate"
            aria-label="选择前置任务"
            value={selectedId}
            onChange={(e) => setPicked(e.target.value)}
            className={`${inputCls} min-w-0 flex-1`}
          >
            {candidates.length === 0 && <option value="">没有可选任务</option>}
            {candidates.map((item) => (
              <option key={item.id} value={item.id}>{item.title}</option>
            ))}
          </select>
          <button
            type="button"
            data-testid="dep-add"
            onClick={() => addBlockers.mutate(selectedId)}
            disabled={selectedId === '' || addBlockers.isPending}
            title={issue.claimed_by !== null ? '占用中新增前置会被服务端拒绝（需先 release）' : undefined}
            className="rounded bg-accent px-2.5 py-1.5 text-xs font-medium text-accent-ink hover:opacity-90 disabled:opacity-40"
          >
            添加前置
          </button>
        </div>
        {error !== null && (
          <p role="alert" data-testid="dep-error" className="text-xs text-red-600 dark:text-red-400">{error}</p>
        )}
      </div>
    </section>
  );
}
