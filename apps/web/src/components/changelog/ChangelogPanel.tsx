/**
 * 工作区变更日志面板（LOG03）。
 *
 * 供入口接线方以 `<ChangelogPanel workspaceId={id} onClose={...} />` 挂到任意容器（board-ui 用 Modal 包裹）：
 * - 只渲染内容，不自带标题栏/关闭按钮（标题、Esc、遮罩由外层容器负责）；
 * - 不读全局 store，切 workspace 只依赖 props，内部复位查询/筛选/草稿/编辑态；
 * - 活动区：时间轴（occurred_at DESC,id DESC 最新在顶、按本地日期分组）+ 字面搜索 + 类型筛选 + 分页 + 新增/编辑/删除（CAS）；
 * - 归档区：已移除工作区快照 → 只读时间轴，不与活动日志混排、无任何写入口。
 */
import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { WorkspaceChangeLog, WorkspaceChangeType } from '@agentboard/shared';
import { ApiError } from '../../api/client';
import { changelogApi } from '../../api/changelog';
import { BUTTON_DANGER, BUTTON_PRIMARY, BUTTON_SECONDARY, FIELD_CLASS } from '../ui/buttonStyles';
import { ChangelogTimeline } from './ChangelogTimeline';
import { ChangelogEntryForm, type ChangelogFormConflict, type ChangelogFormValues } from './ChangelogEntryForm';
import { ArchivedChangelogPanel } from './ArchivedChangelogPanel';

const PAGE = 20;
const TYPES: WorkspaceChangeType[] = ['新增', '修复', '调整', '历史'];

type EditorState =
  | { mode: 'create' }
  | { mode: 'edit'; entry: WorkspaceChangeLog };

function messageOf(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}

function isRevisionConflict(error: unknown): error is ApiError {
  return error instanceof ApiError && error.status === 409 && error.code === 'CHANGELOG_REVISION_CONFLICT';
}

export function ChangelogPanel({ workspaceId, onClose }: { workspaceId: string; onClose?: () => void }) {
  const [tab, setTab] = useState<'active' | 'archived'>('active');

  useEffect(() => {
    setTab('active');
  }, [workspaceId]);

  return (
    <div data-testid="changelog-panel" className="flex min-h-0 flex-col gap-2">
      <div role="tablist" aria-label="变更日志范围" className="flex shrink-0 gap-1.5">
        <button
          type="button"
          role="tab"
          data-testid="changelog-tab-active"
          aria-selected={tab === 'active'}
          onClick={() => setTab('active')}
          className={tab === 'active' ? BUTTON_PRIMARY : BUTTON_SECONDARY}
        >
          当前工作区
        </button>
        <button
          type="button"
          role="tab"
          data-testid="changelog-tab-archived"
          aria-selected={tab === 'archived'}
          onClick={() => setTab('archived')}
          className={tab === 'archived' ? BUTTON_PRIMARY : BUTTON_SECONDARY}
        >
          历史工作区
        </button>
      </div>
      {tab === 'active' ? (
        <ActiveChangelog workspaceId={workspaceId} onClose={onClose} />
      ) : (
        <ArchivedChangelogPanel />
      )}
    </div>
  );
}

function ActiveChangelog({ workspaceId, onClose }: { workspaceId: string; onClose?: () => void }) {
  const queryClient = useQueryClient();
  const [draft, setDraft] = useState('');
  const [query, setQuery] = useState('');
  const [typeFilter, setTypeFilter] = useState<WorkspaceChangeType | 'all'>('all');
  const [offset, setOffset] = useState(0);
  const [editor, setEditor] = useState<EditorState | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [conflict, setConflict] = useState<ChangelogFormConflict | null>(null);
  const [reloading, setReloading] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<WorkspaceChangeLog | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  // 切 workspace：清空筛选、分页、编辑草稿与待删目标，避免跨 workspace 串数据
  useEffect(() => {
    setDraft('');
    setQuery('');
    setTypeFilter('all');
    setOffset(0);
    setEditor(null);
    setFormError(null);
    setConflict(null);
    setDeleteTarget(null);
    setDeleteError(null);
  }, [workspaceId]);

  const list = useQuery({
    queryKey: ['changelog', workspaceId, typeFilter, query, offset],
    queryFn: () =>
      changelogApi.list(workspaceId, {
        change_type: typeFilter === 'all' ? undefined : typeFilter,
        q: query === '' ? undefined : query,
        offset,
        limit: PAGE,
      }),
  });

  const refresh = (): Promise<unknown> => queryClient.invalidateQueries({ queryKey: ['changelog', workspaceId] });

  const create = useMutation({
    mutationFn: (values: ChangelogFormValues) => changelogApi.create(workspaceId, values),
    onSuccess: async () => {
      setEditor(null);
      setFormError(null);
      setConflict(null);
      await refresh();
    },
    onError: (error) => setFormError(messageOf(error, '创建失败')),
  });

  const update = useMutation({
    mutationFn: ({ entry, values }: { entry: WorkspaceChangeLog; values: ChangelogFormValues }) =>
      changelogApi.update(workspaceId, entry.id, { ...values, expected_revision: entry.revision }),
    onSuccess: async () => {
      setEditor(null);
      setFormError(null);
      setConflict(null);
      await refresh();
    },
    onError: async (error) => {
      if (isRevisionConflict(error) && editor !== null && editor.mode === 'edit') {
        setFormError(null);
        setConflict({ message: error.message, currentRevision: null });
        try {
          const latest = await changelogApi.get(workspaceId, editor.entry.id);
          setConflict({ message: error.message, currentRevision: latest.revision });
        } catch {
          setConflict({ message: error.message, currentRevision: null });
        }
        return;
      }
      setFormError(messageOf(error, '保存失败'));
    },
  });

  const remove = useMutation({
    mutationFn: (entry: WorkspaceChangeLog) => changelogApi.remove(workspaceId, entry.id, entry.revision),
    onSuccess: async () => {
      setDeleteTarget(null);
      setDeleteError(null);
      await refresh();
      onClose?.();
    },
    onError: (error) => setDeleteError(messageOf(error, '删除失败')),
  });

  const reloadLatest = async (): Promise<void> => {
    if (editor === null || editor.mode !== 'edit') return;
    setReloading(true);
    try {
      const latest = await changelogApi.get(workspaceId, editor.entry.id);
      setEditor({ mode: 'edit', entry: latest });
      setConflict(null);
      setFormError(null);
    } catch (error) {
      setFormError(messageOf(error, '读取最新版本失败'));
    } finally {
      setReloading(false);
    }
  };

  const items = list.data?.items ?? [];

  return (
    <div className="flex min-h-0 flex-col gap-2" data-testid="changelog-active">
      <div className="flex flex-wrap items-center gap-1.5">
        <button
          type="button"
          data-testid="changelog-create"
          className={BUTTON_PRIMARY}
          onClick={() => {
            setEditor({ mode: 'create' });
            setFormError(null);
            setConflict(null);
          }}
        >
          新增日志
        </button>
        <form
          className="flex min-w-0 flex-1 flex-wrap items-center gap-1.5"
          onSubmit={(event) => {
            event.preventDefault();
            setQuery(draft.trim());
            setOffset(0);
          }}
        >
          <input
            aria-label="搜索变更日志"
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            maxLength={200}
            placeholder="标题或正文关键字"
            className={`${FIELD_CLASS} min-w-0 flex-1`}
          />
          <select
            aria-label="变更日志类型"
            value={typeFilter}
            onChange={(event) => {
              setTypeFilter(event.target.value as WorkspaceChangeType | 'all');
              setOffset(0);
            }}
            className={FIELD_CLASS}
          >
            <option value="all">全部类型</option>
            {TYPES.map((type) => (
              <option key={type} value={type}>{type}</option>
            ))}
          </select>
          <button type="submit" className={BUTTON_SECONDARY}>搜索</button>
          {(query !== '' || typeFilter !== 'all') && (
            <button
              type="button"
              className={BUTTON_SECONDARY}
              onClick={() => {
                setDraft('');
                setQuery('');
                setTypeFilter('all');
                setOffset(0);
              }}
            >
              清除筛选
            </button>
          )}
        </form>
      </div>

      {editor !== null && (
        <ChangelogEntryForm
          key={editor.mode === 'edit' ? `${editor.entry.id}:${editor.entry.revision}` : 'create'}
          mode={editor.mode}
          {...(editor.mode === 'edit' ? { initial: editor.entry } : {})}
          submitting={create.isPending || update.isPending}
          error={formError}
          conflict={conflict}
          reloading={reloading}
          onCancel={() => {
            setEditor(null);
            setFormError(null);
            setConflict(null);
          }}
          onSubmit={(values) => {
            if (editor.mode === 'create') create.mutate(values);
            else update.mutate({ entry: editor.entry, values });
          }}
          onReloadLatest={() => void reloadLatest()}
        />
      )}

      {deleteTarget !== null && (
        <div
          data-testid="changelog-delete-confirm"
          className="rounded-md border border-red-300 bg-red-50 px-2.5 py-2 text-xs text-red-700 dark:border-red-800 dark:bg-red-950/40 dark:text-red-300"
        >
          <p>确认删除「{deleteTarget.title}」（当前 revision {deleteTarget.revision}）？删除后不可恢复。</p>
          {deleteError !== null && <p role="alert" data-testid="changelog-delete-error">{deleteError}</p>}
          <div className="mt-1.5 flex items-center gap-2">
            <button
              type="button"
              data-testid="changelog-delete-confirm-yes"
              className={BUTTON_DANGER}
              disabled={remove.isPending}
              onClick={() => remove.mutate(deleteTarget)}
            >
              {remove.isPending ? '删除中…' : '确认删除'}
            </button>
            <button
              type="button"
              className={BUTTON_SECONDARY}
              onClick={() => {
                setDeleteTarget(null);
                setDeleteError(null);
              }}
            >
              取消
            </button>
          </div>
        </div>
      )}

      {list.isPending && <p className="text-xs text-neutral-500 dark:text-neutral-400" role="status">加载变更日志…</p>}
      {list.isError && (
        <p role="alert" className="rounded-md border border-red-200 bg-red-50 px-2 py-1.5 text-xs text-red-700 dark:border-red-900 dark:bg-red-950/40 dark:text-red-300">
          {list.error.message}
        </p>
      )}
      {list.data !== undefined && (
        <>
          <ChangelogTimeline
            entries={items}
            emptyText={query === '' && typeFilter === 'all' ? '这个工作区还没有变更日志' : '没有匹配的变更日志'}
            onEdit={(entry) => {
              setEditor({ mode: 'edit', entry });
              setFormError(null);
              setConflict(null);
            }}
            onDelete={(entry) => {
              setDeleteTarget(entry);
              setDeleteError(null);
            }}
          />
          <div className="flex items-center gap-2">
            <button
              type="button"
              className={BUTTON_SECONDARY}
              disabled={offset === 0}
              onClick={() => setOffset(Math.max(0, offset - PAGE))}
            >
              上一页
            </button>
            <button
              type="button"
              className={BUTTON_SECONDARY}
              disabled={list.data.next_offset == null}
              onClick={() => setOffset(list.data?.next_offset ?? offset)}
            >
              下一页
            </button>
          </div>
        </>
      )}
    </div>
  );
}
