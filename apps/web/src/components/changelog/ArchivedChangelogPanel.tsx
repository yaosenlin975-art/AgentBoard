/**
 * 已移除工作区的变更日志（LOG03 归档区，只读）。
 * 数据源：`GET /api/changelog/archived-workspaces` → `.../:originWorkspaceId/entries`；
 * 只按显式 origin_workspace_id 读取，不混入活动工作区列表，也不提供任何写操作。
 */
import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { ArchivedWorkspaceChangeLogSummary, WorkspaceChangeType } from '@agentboard/shared';
import { changelogApi } from '../../api/changelog';
import { BUTTON_SECONDARY, FIELD_CLASS } from '../ui/buttonStyles';
import { ChangelogTimeline, localDateTime } from './ChangelogTimeline';

const PAGE = 20;
const TYPES: WorkspaceChangeType[] = ['新增', '修复', '调整', '历史'];

export function ArchivedChangelogPanel() {
  const [offset, setOffset] = useState(0);
  const [selected, setSelected] = useState<ArchivedWorkspaceChangeLogSummary | null>(null);
  const [draft, setDraft] = useState('');
  const [query, setQuery] = useState('');
  const [typeFilter, setTypeFilter] = useState<WorkspaceChangeType | 'all'>('all');
  const [entryOffset, setEntryOffset] = useState(0);

  const workspaces = useQuery({
    queryKey: ['changelog', 'archived', offset],
    queryFn: () => changelogApi.archivedWorkspaces({ offset, limit: PAGE }),
  });

  // 切换归档工作区时清空该工作区的筛选与分页
  useEffect(() => {
    setDraft('');
    setQuery('');
    setTypeFilter('all');
    setEntryOffset(0);
  }, [selected?.origin_workspace_id]);

  const entries = useQuery({
    queryKey: ['changelog', 'archived', selected?.origin_workspace_id ?? '', typeFilter, query, entryOffset],
    queryFn: () =>
      changelogApi.archivedEntries(selected!.origin_workspace_id, {
        change_type: typeFilter === 'all' ? undefined : typeFilter,
        q: query === '' ? undefined : query,
        offset: entryOffset,
        limit: PAGE,
      }),
    enabled: selected !== null,
  });

  const items = workspaces.data?.items ?? [];

  return (
    <div data-testid="changelog-archived" className="space-y-3">
      <p className="text-xs text-ink-3">
        已移除工作区仍保留变更日志（只读），工作区名称与路径为移除时的快照。
      </p>

      {workspaces.isPending && <p className="text-xs text-ink-3" role="status">加载归档工作区…</p>}
      {workspaces.isError && (
        <p role="alert" className="rounded-md border border-red-200 bg-red-50 px-2 py-1.5 text-xs text-red-700 dark:border-red-900 dark:bg-red-950/40 dark:text-red-300">
          {workspaces.error.message}
        </p>
      )}
      {!workspaces.isPending && !workspaces.isError && items.length === 0 && (
        <p data-testid="changelog-archived-empty" className="rounded-md border border-dashed border-hairline px-3 py-6 text-center text-xs text-ink-3">
          没有已移除工作区的变更日志
        </p>
      )}

      {items.length > 0 && (
        <ul className="divide-y divide-hairline overflow-hidden rounded-md border border-hairline">
          {items.map((workspace) => {
            const isSelected = selected?.origin_workspace_id === workspace.origin_workspace_id;
            return (
              <li key={workspace.origin_workspace_id}>
                <button
                  type="button"
                  data-testid={`changelog-archived-workspace-${workspace.origin_workspace_id}`}
                  aria-current={isSelected ? 'true' : undefined}
                  onClick={() => setSelected(workspace)}
                  className={`block w-full px-3 py-2 text-left text-sm ${isSelected ? 'bg-accent-soft ' : 'hover:bg-surface-page '}`}
                >
                  <span className="block truncate font-medium text-ink">{workspace.origin_workspace_name}</span>
                  <span className="block truncate text-xs text-ink-3">{workspace.origin_workspace_path}</span>
                  <span className="mt-0.5 block text-xs text-ink-3">
                    {workspace.entry_count} 条 · 最近 {localDateTime(workspace.last_occurred_at)}
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      )}

      <div className="flex items-center gap-2">
        <button type="button" className={BUTTON_SECONDARY} disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - PAGE))}>
          上一页
        </button>
        <button
          type="button"
          className={BUTTON_SECONDARY}
          disabled={workspaces.data?.next_offset == null}
          onClick={() => setOffset(workspaces.data?.next_offset ?? offset)}
        >
          下一页
        </button>
      </div>

      {selected !== null && (
        <section data-testid="changelog-archived-entries" className="space-y-2 border-t border-hairline pt-3">
          <h3 className="text-sm font-semibold text-ink">
            {selected.origin_workspace_name}（只读）
          </h3>
          <form
            className="flex flex-wrap items-center gap-2"
            onSubmit={(event) => {
              event.preventDefault();
              setQuery(draft.trim());
              setEntryOffset(0);
            }}
          >
            <input
              aria-label="搜索归档日志"
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              placeholder="标题或正文关键字"
              className={`${FIELD_CLASS} min-w-0 flex-1`}
            />
            <select
              aria-label="归档日志类型"
              value={typeFilter}
              onChange={(event) => {
                setTypeFilter(event.target.value as WorkspaceChangeType | 'all');
                setEntryOffset(0);
              }}
              className={FIELD_CLASS}
            >
              <option value="all">全部类型</option>
              {TYPES.map((type) => (
                <option key={type} value={type}>{type}</option>
              ))}
            </select>
            <button type="submit" className={BUTTON_SECONDARY}>筛选</button>
          </form>

          {entries.isPending && <p className="text-xs text-ink-3" role="status">加载归档日志…</p>}
          {entries.isError && (
            <p role="alert" className="rounded-md border border-red-200 bg-red-50 px-2 py-1.5 text-xs text-red-700 dark:border-red-900 dark:bg-red-950/40 dark:text-red-300">
              {entries.error.message}
            </p>
          )}
          {entries.data !== undefined && (
            <>
              <ChangelogTimeline
                entries={entries.data.items}
                readonly
                emptyText={query === '' && typeFilter === 'all' ? '该工作区没有变更日志' : '没有匹配的归档日志'}
              />
              <div className="flex items-center gap-2">
                <button type="button" className={BUTTON_SECONDARY} disabled={entryOffset === 0} onClick={() => setEntryOffset(Math.max(0, entryOffset - PAGE))}>
                  上一页
                </button>
                <button
                  type="button"
                  className={BUTTON_SECONDARY}
                  disabled={entries.data.next_offset == null}
                  onClick={() => setEntryOffset(entries.data?.next_offset ?? entryOffset)}
                >
                  下一页
                </button>
              </div>
            </>
          )}
        </section>
      )}
    </div>
  );
}
