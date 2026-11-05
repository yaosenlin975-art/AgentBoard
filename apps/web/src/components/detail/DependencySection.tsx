/**
 * 任务详情「依赖」区（设计 §11 / DETAIL-D3）：
 * - 默认只占一行（前置总数 / 未解除数 / 被阻塞数 + 「暂不可领取」角标），点击展开；
 * - 展开后三组：前置任务 / 被本卡阻塞 / 关联·重复（不阻塞领取）；
 * - 空组不渲染整块空状态；搜索添加前置只在展开后出现。
 * 解除判定只用服务端 `resolved`，不本地推断；已占用卡新增前置仍由服务端 409 `ISSUE_CLAIMED` 兜底。
 */
import { useState, type ReactNode } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { Issue, IssueStatus } from '@agentboard/shared';
import { ApiError, api } from '../../api/client';
import type { DependencyRef, DependencyView } from '../../lib/dependency';

const inputCls =
  'w-full rounded border border-hairline bg-surface-card px-2 py-1 text-[11.5px] text-ink outline-none focus-visible:outline-2 focus-visible:outline-accent';

const MAX_VISIBLE_CANDIDATES = 30;

function errorText(error: unknown, fallback: string): string {
  if (error instanceof ApiError && error.code === 'ISSUE_CLAIMED') return `无法添加前置：${error.message}`;
  return `${fallback}：${error instanceof Error ? error.message : '未知错误'}`;
}

/** 行首状态圆点：只做视觉，不替代文字状态 */
function statusDotTone(status: IssueStatus): string {
  if (status === '进行中') return 'bg-accent';
  if (status === '待验收') return 'bg-ab-add';
  if (status === '已关闭') return 'bg-ink-3';
  return 'bg-amber-500';
}

function DependencyRow({
  item,
  testId,
  action,
  showResolved = false,
}: {
  item: DependencyRef;
  testId: string;
  action?: ReactNode;
  showResolved?: boolean;
}) {
  return (
    <li data-testid={testId} className="flex items-center gap-1.5 py-0.5 text-[11.5px]">
      <span
        aria-hidden
        data-testid={`${testId}-dot`}
        className={`h-1.5 w-1.5 shrink-0 rounded-full ${statusDotTone(item.status)}`}
      />
      <span className="min-w-0 flex-1 truncate text-ink-2" title={item.title}>
        {item.title}
      </span>
      <span className="shrink-0 text-[10.5px] text-ink-3">{item.status}</span>
      {showResolved && (
        <span
          data-testid={`${testId}-resolved`}
          className={item.resolved
            ? 'shrink-0 text-green-700 dark:text-green-400'
            : 'shrink-0 text-amber-700 dark:text-amber-300'}
        >
          {item.resolved ? '已解除' : '未解除'}
        </span>
      )}
      {action}
    </li>
  );
}

function removeAction(item: DependencyRef, label: string, pending: boolean, onRemove: (id: string) => void, testId: string): ReactNode {
  return (
    <button
      type="button"
      data-testid={testId}
      aria-label={`移除${label} ${item.title}`}
      disabled={pending}
      onClick={() => onRemove(item.issue_id)}
      className="shrink-0 rounded border border-hairline px-1.5 py-0.5 text-[10.5px] text-ink-3 hover:bg-accent-soft hover:text-accent disabled:opacity-40"
    >
      移除
    </button>
  );
}

export function DependencySection({ issue }: { issue: Issue }) {
  const queryClient = useQueryClient();
  const [expanded, setExpanded] = useState(false);
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
  const related = dependencies?.related ?? [];
  const duplicate = dependencies?.duplicate ?? [];

  // 摘要优先用依赖接口的实际列表；未返回时回落到 Issue 投影，避免首屏空一行
  const blockerTotal = dependencies !== undefined ? blockers.length : (issue.blocked_by_count ?? 0);
  const openCount = dependencies !== undefined
    ? blockers.filter((item) => !item.resolved).length
    : (issue.blocked_by_open_count ?? 0);
  const blockedTotal = blocked.length;

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

  const summaryTone = openCount > 0
    ? 'border-amber-600/30 bg-amber-500/10 text-amber-700 dark:text-amber-300'
    : 'border-hairline bg-surface-raised text-ink-2 hover:border-accent';

  return (
    <section data-testid="detail-dependencies" aria-label="依赖" className="space-y-1">
      <button
        type="button"
        data-testid="dep-summary"
        aria-expanded={expanded}
        aria-controls="dep-body"
        onClick={() => setExpanded((current) => !current)}
        className={`flex w-full items-center justify-between gap-2 rounded border px-2 py-1.5 text-left text-[11.5px] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent ${summaryTone}`}
      >
        <span className="flex min-w-0 flex-wrap items-center gap-1.5">
          <span className="truncate">
            前置 {blockerTotal} · {openCount} 项未解除 · 阻塞 {blockedTotal}
          </span>
          {openCount > 0 && (
            <span
              data-testid="dep-summary-badge"
              className="shrink-0 rounded-full border border-amber-600/40 px-1.5 py-0.5 text-[10px] font-medium text-amber-700 dark:text-amber-300"
            >
              暂不可领取
            </span>
          )}
        </span>
        <span className="shrink-0 text-[10.5px] text-ink-3">{expanded ? '收起' : '展开'}</span>
      </button>

      {loadError !== null && (
        <p role="alert" className="text-xs text-red-600 dark:text-red-400">
          加载依赖失败：{loadError instanceof Error ? loadError.message : '未知错误'}
        </p>
      )}

      <div
        id="dep-body"
        data-testid="dep-body"
        className={`grid transition-[grid-template-rows] duration-[160ms] ease-[cubic-bezier(0.2,0,0,1)] motion-reduce:duration-[1ms] ${
          expanded ? 'grid-rows-[1fr]' : 'grid-rows-[0fr]'
        }`}
      >
        <div className="min-h-0 overflow-hidden" inert={expanded ? undefined : true}>
          <div className="space-y-2 pt-1">
            {blockers.length > 0 && (
              <div data-testid="dep-blockers-group" className="space-y-0.5">
                <p className="text-[10.5px] text-ink-3">前置任务（未解除前不可领取）</p>
                <ul data-testid="dep-blockers" className="space-y-0.5">
                  {blockers.map((item) => (
                    <DependencyRow
                      key={item.issue_id}
                      item={item}
                      testId={`dep-blocker-${item.issue_id}`}
                      showResolved
                      action={removeAction(item, '前置', removeBlocker.isPending, removeBlocker.mutate, `dep-remove-${item.issue_id}`)}
                    />
                  ))}
                </ul>
              </div>
            )}

            {blocked.length > 0 && (
              <div data-testid="dep-blocked-group" className="space-y-0.5">
                <p className="text-[10.5px] text-ink-3">被本卡阻塞</p>
                <ul data-testid="dep-blocked" className="space-y-0.5">
                  {blocked.map((item) => (
                    <DependencyRow key={item.issue_id} item={item} testId={`dep-blocked-${item.issue_id}`} />
                  ))}
                </ul>
              </div>
            )}

            {related.length + duplicate.length > 0 && (
              <div data-testid="dep-relations-group" className="space-y-0.5">
                <p className="text-[10.5px] text-ink-3">关联·重复（不阻塞领取）</p>
                {related.length > 0 && (
                  <ul data-testid="dep-related" className="space-y-0.5">
                    {related.map((item) => (
                      <DependencyRow
                        key={item.issue_id}
                        item={item}
                        testId={`dep-related-${item.issue_id}`}
                        action={removeAction(item, '关联', removeBlocker.isPending, removeBlocker.mutate, `dep-remove-related-${item.issue_id}`)}
                      />
                    ))}
                  </ul>
                )}
                {duplicate.length > 0 && (
                  <ul data-testid="dep-duplicate" className="space-y-0.5">
                    {duplicate.map((item) => (
                      <DependencyRow
                        key={item.issue_id}
                        item={item}
                        testId={`dep-duplicate-${item.issue_id}`}
                        action={removeAction(item, '重复', removeBlocker.isPending, removeBlocker.mutate, `dep-remove-duplicate-${item.issue_id}`)}
                      />
                    ))}
                  </ul>
                )}
              </div>
            )}

            <div className="space-y-1 rounded border border-dashed border-hairline p-2">
              <label className="block text-[10.5px] text-ink-3">
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
                  className="rounded bg-accent px-2.5 py-1 text-[11px] font-medium text-accent-ink hover:opacity-90 disabled:opacity-40"
                >
                  添加前置
                </button>
              </div>
              {error !== null && (
                <p role="alert" data-testid="dep-error" className="text-xs text-red-600 dark:text-red-400">{error}</p>
              )}
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
