/**
 * 工作区日志视图（LOG03 / LOG-VIEW）。
 *
 * 原为浮窗内容（`<ChangelogPanel workspaceId onClose />` 由 Modal 包裹）；现在作为与平铺看板/任务树/知识库同级的
 * 主区域视图挂载：顶部 ViewToolbarShell（FIX-2 后不再有 ViewSwitcher，视图切换只走左栏五入口），主体左右两栏 ——
 * 左栏是按 `occurred_at DESC, id DESC` 倒序、按本地日期分组的日志列表，右栏是选中日志的详情（Markdown 正文 + 编辑/删除），
 * 默认选中最新一条；≤900px 由 `min-[901px]:` 断点退化为上下堆叠（列表在上、详情在下）。
 *
 * 保留既有能力：新建/编辑/删除（CAS）、搜索与类型筛选、分页、归档只读区、空态。
 * 查询状态只依赖 props（workspaceId），切 workspace 会复位筛选/分页/编辑态。
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { WorkspaceChangeLog, WorkspaceChangeType } from '@agentboard/shared';
import { ApiError } from '../../api/client';
import { changelogApi } from '../../api/changelog';
import { MarkdownView } from '../../lib/markdown';
import { BUTTON_DANGER, BUTTON_PRIMARY, BUTTON_SECONDARY, FIELD_CLASS } from '../ui/buttonStyles';
import { ViewToolbarShell } from '../ui/ViewToolbarShell';
import { usePrefersReducedMotion } from '../overlay/panelMotion';
import { ChangelogEntryForm, type ChangelogFormConflict, type ChangelogFormValues } from './ChangelogEntryForm';
import { groupChangelogByDay, localDateTime, sortChangelog } from './ChangelogTimeline';
import { ChangelogTypeTag } from './ChangelogTypeTag';

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

export interface ChangelogPanelProps {
  workspaceId: string;
  /** 删除成功后回调（兼容原先浮窗开合；视图形态下可省略） */
  onClose?: () => void;

}

export function ChangelogPanel({
  workspaceId,
  onClose,

}: ChangelogPanelProps) {

  return (
    <section
      aria-label="工作区日志"
      data-testid="changelog-panel"
      className="flex h-full min-h-0 flex-col bg-surface-page text-ink"
    >
      {/* TOOLBAR-BLANK：壳内已无控件，空壳会渲染约 40px 空白带 → 不再挂 ViewToolbarShell；
          log-toolbar-controls 锚点迁到内容区顶部（sr-only 零高，测试仍可定位）。 */}
      <span data-testid="log-toolbar-controls" aria-hidden="true" className="sr-only" />

      <div className="flex min-h-0 flex-1 flex-col gap-2 p-3">
        {/* LOG-HEAD-REMOVE：标题与「当前/历史工作区」切换已移除，直接给日志内容（首个元素不再留大片空白） */}
        <ActiveChangelog workspaceId={workspaceId} onClose={onClose} />
      </div>
    </section>
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
  const [selectedId, setSelectedId] = useState<string | null>(null);

  // 切 workspace：清空筛选、分页、编辑草稿、选中项与待删目标，避免跨 workspace 串数据
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
    setSelectedId(null);
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
      setSelectedId(null);
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
  const sorted = useMemo(() => sortChangelog(items), [items]);
  const groups = useMemo(() => groupChangelogByDay(sorted), [sorted]);
  // 默认选中最新一条；选中项被筛选掉或删除后自动回落到最新
  const selected = sorted.find((item) => item.id === selectedId) ?? sorted[0] ?? null;
  const emptyText = query === '' && typeFilter === 'all' ? '这个工作区还没有变更日志' : '没有匹配的变更日志';

  /** 右侧滚动容器（LOG-SCROLL）：全部日志连续渲染，点击左列表滚动定位 */
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const reducedMotion = usePrefersReducedMotion();
  /** 点击跳转后短暂锁定选中：平滑滚动途中 observer 会把"视口顶部那条"设成选中，点了 A 却高亮 B 很别扭 */
  const selectionLockUntil = useRef(0);

  const scrollToEntry = (id: string): void => {
    setSelectedId(id);
    selectionLockUntil.current = Date.now() + 800;
    const target = scrollRef.current?.querySelector<HTMLElement>(`[data-changelog-id="${id}"]`) ?? null;
    if (target === null) return;
    // reduced-motion 命中时即时跳转，不做平滑滚动
    target.scrollIntoView({ behavior: reducedMotion ? 'auto' : 'smooth', block: 'start' });
  };

  /**
   * 选中项随滚动位置更新：用 IntersectionObserver 而不是监听 scroll 手算偏移。
   * 理由：①不需要节流/防抖就能拿到「哪几条在视口内」；②不与平滑滚动打架（scroll 事件在平滑滚动期间高频但位置一直在变）；
   * ③列表重排时观察器随 effect 重建即可，逻辑比手写 offsetTop 比较更短。rootMargin 下沿留 60%，让视口顶部那条稳定胜出。
   */
  useEffect(() => {
    const container = scrollRef.current;
    if (container === null || typeof IntersectionObserver === 'undefined') return;
    const nodes = [...container.querySelectorAll<HTMLElement>('[data-changelog-id]')];
    if (nodes.length === 0) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (Date.now() < selectionLockUntil.current) return;
        const visible = entries
          .filter((entry) => entry.isIntersecting)
          .map((entry) => entry.target.getAttribute('data-changelog-id'))
          .filter((id): id is string => id !== null);
        if (visible.length === 0) return;
        // 文档顺序最靠前的那条 = 当前视口顶部可见的日志
        const next = sorted.find((item) => visible.includes(item.id));
        if (next !== undefined) setSelectedId(next.id);
      },
      { root: container, rootMargin: '0px 0px -60% 0px', threshold: 0 },
    );
    for (const node of nodes) observer.observe(node);
    return () => observer.disconnect();
  }, [sorted]);

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-2" data-testid="changelog-active">
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

      {list.isPending && <p className="text-xs text-ink-3" role="status">加载变更日志…</p>}
      {list.isError && (
        <p role="alert" className="rounded-md border border-red-200 bg-red-50 px-2 py-1.5 text-xs text-red-700 dark:border-red-900 dark:bg-red-950/40 dark:text-red-300">
          {list.error.message}
        </p>
      )}
      {list.data !== undefined && (
        <div
          data-testid="changelog-split"
          className="grid min-h-0 flex-1 grid-cols-1 gap-2 min-[901px]:grid-cols-[minmax(200px,300px)_minmax(0,1fr)] min-[901px]:overflow-hidden"
        >
          <div
            data-testid="changelog-list-pane"
            className="flex min-h-0 flex-col gap-2 overflow-hidden rounded-xl border border-hairline bg-surface-card p-2"
          >
            {sorted.length === 0 ? (
              <p
                data-testid="changelog-empty"
                className="rounded-md border border-dashed border-hairline px-3 py-8 text-center text-sm text-ink-3"
              >
                {emptyText}
              </p>
            ) : (
              /* LOG-PAGER：列表自己是唯一滚动容器，分页条留在滚动区外（否则 mt-auto 只把它推到内容末尾，
                 滚动时漂到条目中间）。 */
              <ol data-testid="changelog-list" aria-label="日志列表" className="min-h-0 flex-1 space-y-3 overflow-auto">
                {groups.map((group) => (
                  <li key={group.day} data-testid={`changelog-day-${group.day}`}>
                    <h3 className="mb-1 text-[11px] font-semibold text-ink-3">{group.day}</h3>
                    <ul className="space-y-1">
                      {group.entries.map((item) => {
                        const isSelected = selected?.id === item.id;
                        return (
                          <li key={item.id}>
                            <button
                              type="button"
                              data-testid={`changelog-entry-${item.id}`}
                              aria-current={isSelected ? 'true' : undefined}
                              onClick={() => scrollToEntry(item.id)}
                              className={`block w-full rounded px-1.5 py-1 text-left text-xs ab-transition ${
                                isSelected
                                  ? 'bg-accent-soft font-medium text-ink'
                                  : 'text-ink-2 hover:bg-surface-raised  '
                              }`}
                            >
                              <span className="flex items-center gap-1">
                                <ChangelogTypeTag type={item.change_type} />
                                <span className="truncate">{item.title}</span>
                              </span>
                              <span className="mt-0.5 block text-[11px] text-ink-3">
                                {localDateTime(item.occurred_at)}
                              </span>
                            </button>
                          </li>
                        );
                      })}
                    </ul>
                  </li>
                ))}
              </ol>
            )}
            {/* LOG-PAGER：分页条是 pane 的最后一个子元素（滚动区之外）+ shrink-0，滚动时位置不变；
                空态（sorted.length === 0）不渲染分页条，避免悬空按钮。 */}
            {sorted.length > 0 && (
              <div
                data-testid="changelog-pager"
                className="flex shrink-0 items-center gap-2 border-t border-hairline pt-2"
              >
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
            )}
          </div>

          <div
            ref={scrollRef}
            data-testid="changelog-scroll"
            className="min-h-0 overflow-auto rounded-xl border border-hairline bg-surface-card"
          >
            {sorted.length === 0 ? (
              <p data-testid="changelog-empty-doc" className="px-3 py-8 text-center text-sm text-ink-3">
                {emptyText}
              </p>
            ) : (
              groups.map((group) => (
                <section
                  key={group.day}
                  data-testid={`changelog-doc-group-${group.day}`}
                  className="border-b border-hairline last:border-b-0"
                >
                  <h3 className="sticky top-0 z-10 border-b border-hairline bg-surface-card/95 px-3 py-1 text-[11px] font-semibold text-ink-3 backdrop-blur">
                    {group.day}
                  </h3>
                  {group.entries.map((item) => {
                    const isSelected = selected?.id === item.id;
                    return (
                      <article
                        key={item.id}
                        data-testid={`changelog-doc-${item.id}`}
                        data-changelog-id={item.id}
                        aria-current={isSelected ? 'true' : undefined}
                        className={`flex flex-col gap-1.5 border-t border-hairline px-3 py-2 transition-colors first:border-t-0 ${
                          isSelected ? 'bg-accent-soft' : ''
                        }`}
                      >
                        <header className="flex flex-wrap items-center gap-1.5">
                          <ChangelogTypeTag type={item.change_type} />
                          <span className="text-xs text-ink-3">{localDateTime(item.occurred_at)}</span>
                          <span className="ml-auto text-xs text-ink-3">rev:{item.revision}</span>
                        </header>
                        <h2 data-testid={`changelog-doc-title-${item.id}`} className="break-words text-sm font-semibold">
                          {item.title}
                        </h2>
                        <div data-testid={`changelog-doc-body-${item.id}`} className="break-words">
                          <MarkdownView compact>{item.body_md}</MarkdownView>
                        </div>
                        <footer className="flex flex-wrap items-center gap-2 text-xs text-ink-3">
                          <span>{item.updated_by === 'user' ? '用户' : item.updated_by}</span>
                          <span>更新 {localDateTime(item.updated_at)}</span>
                          <span className="ml-auto flex items-center gap-1.5">
                            <button
                              type="button"
                              aria-label={`编辑日志：${item.title}`}
                              onClick={() => {
                                setEditor({ mode: 'edit', entry: item });
                                setFormError(null);
                                setConflict(null);
                              }}
                              className={BUTTON_SECONDARY}
                            >
                              编辑
                            </button>
                            <button
                              type="button"
                              aria-label={`删除日志：${item.title}`}
                              onClick={() => {
                                setDeleteTarget(item);
                                setDeleteError(null);
                              }}
                              className={BUTTON_DANGER}
                            >
                              删除
                            </button>
                          </span>
                        </footer>
                      </article>
                    );
                  })}
                </section>
              ))
            )}
          </div>
        </div>
      )}
    </div>
  );
}


